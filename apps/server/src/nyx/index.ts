// Nyx-Kern: hält Gedächtnis-Abbild, Plan, geplante Aufgaben, Meldungen, Nebenläufe (Lernprüfung,
// Verdichtung) zusammen und hängt die neuen Werkzeuge in das bestehende Haiku-Register. Erreichbar über
// `runtime.nyx` (N2 Tab-API, N4 Telegram: `notifier.registerChannel`, `compact`).
import type { HaikuStreamEvent, NyxAnswerLength, NyxChannel, NyxStateEvent } from "@nyxos/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { haikuMessages, haikuThreads } from "../db/schema.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import type { LiveHub } from "../live.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { AUTO_COMPACT_MESSAGES, compactThread, type CompactResult } from "./compaction.js";
import { publishNyxState } from "./live.js";
import { listMemory, renderMemoryBlock } from "./memory.js";
import { NyxNotifier } from "./notify.js";
import { loadNyxProfile } from "./personaDefault.js";
import { buildNyxSystemPrompt } from "./prompt.js";
import { BackgroundLane, REVIEW_EVERY_TURNS, reviewThread } from "./review.js";
import { NyxScheduleRunner } from "./schedules.js";
import { registerNyxTools } from "./tools.js";
import { runNyxTurn, type NyxTurnInput } from "./turn.js";

export interface NyxCoreDeps {
  db: Db;
  hub: LiveHub;
  runtime: HaikuRuntime;
  bridgeHub: BridgeHub | null;
  archiveDir: string | null;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export class NyxCore {
  readonly notifier: NyxNotifier;
  readonly runner: NyxScheduleRunner;
  readonly lane = new BackgroundLane();
  private serverSnapshotFn: (() => Promise<unknown>) | null = null;

  constructor(private readonly deps: NyxCoreDeps) {
    this.notifier = new NyxNotifier(deps.db, deps.hub, deps.log);
    this.runner = new NyxScheduleRunner({ runtime: deps.runtime, notifier: this.notifier, systemPrompt: () => this.systemPrompt({ channel: "web" }), log: deps.log });
    registerNyxTools(deps.runtime.tools, {
      hub: deps.hub,
      bridgeHub: deps.bridgeHub,
      archiveDir: deps.archiveDir,
      runner: () => this.runner,
      telegramReady: () => this.notifier.channelReady("telegram"),
      serverSnapshot: () => this.serverSnapshotFn?.() ?? null,
    });
  }

  get archiveDir(): string | null {
    return this.deps.archiveDir;
  }

  /** app.ts: Server-Tab-Stand für das Werkzeug `server_lage` (erst nach `registerServerRoutes` verfügbar). */
  setServerSnapshot(fn: (() => Promise<unknown>) | null): void {
    this.serverSnapshotFn = fn;
  }

  /** Aktuelles Gedächtnis als Prompt-Block (zum Einfrieren beim Anlegen eines Fadens). */
  async freezeMemory(): Promise<string> {
    return renderMemoryBlock(await listMemory(this.deps.db));
  }

  /** System-Prompt eines Nyx-Laufs; ohne `memoryBlock` mit dem aktuellen Gedächtnis (geplante Aufgaben, Selbsttest). */
  async systemPrompt(o: { channel: NyxChannel; memoryBlock?: string | null; withoutTools?: readonly string[]; length?: NyxAnswerLength }): Promise<string> {
    const without = new Set(o.withoutTools ?? []);
    return buildNyxSystemPrompt({
      memoryBlock: o.memoryBlock ?? (await this.freezeMemory()),
      tools: this.deps.runtime.tools.namesFor("full").filter((n) => !without.has(n)),
      channel: o.channel,
      profile: await loadNyxProfile(this.deps.db),
      telegram: await this.notifier.channelReady("telegram"),
      ...(o.length ? { length: o.length } : {}),
    });
  }

  /** Zustand für Tab, Begleiter und Telegram (`nyx.state`) – geprüft und gemerkt über `publishNyxState`. */
  state(ev: NyxStateEvent): void {
    if (!publishNyxState(this.deps.hub, ev)) this.deps.log("nyx-zustand-ungueltig", { state: ev.state, tool: ev.tool });
  }

  /**
   * Eine Nyx-Runde für Kanäle außerhalb des Web-Chats (Telegram, Stimme) – derselbe Weg wie
   * `POST /api/haiku/chat` (`nyx/turn.ts`). des Nutzers Runde geht vor: ein Nebenlauf wird abgebrochen.
   */
  async *ask(input: NyxTurnInput): AsyncGenerator<HaikuStreamEvent> {
    await this.lane.yieldToUser();
    yield* runNyxTurn({ db: this.deps.db, runtime: this.deps.runtime, nyx: this, notify: (what) => this.deps.hub.broadcast({ type: "haiku", what }) }, input);
  }

  /** Befehl „verdichten“ (Chat, Telegram `/compact`, Knopf). */
  async compact(threadId: number, focus?: string | null): Promise<CompactResult> {
    await this.lane.yieldToUser();
    this.state({ state: "thinking", detail: "verdichten", threadId });
    try {
      return await compactThread(this.deps.runtime, threadId, { focus });
    } finally {
      this.state({ state: "idle", threadId });
    }
  }

  /**
   * Nach jeder beantworteten Runde: Zähler für die Lernprüfung (Reset, wenn Nyx selbst `memory` benutzt hat),
   * dann höchstens EIN Nebenlauf – Lernprüfung (alle {@link REVIEW_EVERY_TURNS} Runden) oder Verdichtung (langer Faden).
   */
  async afterTurn(threadId: number, toolCalls: string[]): Promise<"review" | "compact" | null> {
    const db = this.deps.db;
    const usedMemory = toolCalls.includes("memory");
    const [t] = await db
      .update(haikuThreads)
      .set({ turnsSinceMemory: usedMemory ? 0 : sql`${haikuThreads.turnsSinceMemory} + 1` })
      .where(eq(haikuThreads.id, threadId))
      .returning({ turns: haikuThreads.turnsSinceMemory, upto: haikuThreads.summaryUptoId, topic: haikuThreads.topic });
    if (!t) return null;
    if (t.turns >= REVIEW_EVERY_TURNS) {
      if (this.lane.run((signal) => reviewThread(this.deps.runtime, threadId, signal), this.deps.log)) return "review";
      return null;
    }
    const [c] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(haikuMessages)
      .where(and(eq(haikuMessages.threadId, threadId), t.upto ? gt(haikuMessages.id, t.upto) : undefined));
    if ((c?.n ?? 0) > AUTO_COMPACT_MESSAGES) {
      if (this.lane.run((signal) => compactThread(this.deps.runtime, threadId, { signal }), this.deps.log)) return "compact";
    }
    return null;
  }

  /** Ein Nyx-Werkzeug direkt ausführen (Knöpfe im Tab, Telegram) – gleiche Umfangs-Prüfung wie im Lauf. */
  async callTool(name: string, args: unknown, threadId: number | null = null): Promise<unknown> {
    return this.deps.runtime.tools.call("full", name, args, { db: this.deps.db, scope: "full", ideaLink: null, ideas: null, threadId, kind: "chat" });
  }

  /** Minutentakt (aus `haiku/scheduler.ts`): geplante Aufgaben. */
  async tick(now = new Date()): Promise<void> {
    await this.runner.tick(now);
  }
}
