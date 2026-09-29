// Haiku-Laufzeit: Warteschlange, Zeitlimit, Tages-Budget, Aufruf-Protokoll, Motor-Wahl und
// Einmal-Token für die MCP-Brücke. Alles, was Haiku tut, läuft hier durch — nichts daran vorbei.
import { randomBytes } from "node:crypto";
import type { HaikuCallKind, HaikuEngineKind, HaikuEngineState, HaikuErrorCode, HaikuSettings, HaikuSource, HaikuStatus, HaikuUsage, NyxChannel } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { haikuCalls } from "../db/schema.js";
import type { ApiEngine } from "./apiEngine.js";
import { ENGINE_REASON, EngineTimeoutError, looksLikeAuthError, type EngineAvailability, type HaikuEngine, type ToolDef, type ToolScope } from "./engine.js";
import { localDay, loadHaikuSettings, usageForDay, usageForKind } from "./settings.js";
import { extractSources, stripMarkersForStream } from "./sources.js";
import { ToolDeniedError, type IdeaRepo, type ToolContext, type ToolRegistry } from "./tools.js";
import type { McpServerSpec } from "../mcp/client.js";
import { PROMPT_IMPROVE_EFFORT, PROMPT_IMPROVE_MODEL, type ModelRole } from "@nyxos/shared";
import type { EngineEffort } from "./engine.js";
import { insideAppApi } from "../nyx/appApi/internal.js";
import { greetingNameOf } from "../nyx/profile.js";
import { LANGUAGE_RULE_HEAD } from "../nyx/prompt.js";
import { getLang, t } from "@nyxos/shared";

export type RuntimeEvent =
  | { type: "status"; status: "queued" | "thinking" | "tool"; tool?: string; position?: number }
  | { type: "delta"; text: string }
  | { type: "final"; rawText: string; text: string; sources: HaikuSource[]; estimate: boolean; usage: HaikuUsage; callId: number; claudeSessionId: string | null; toolCalls?: string[] }
  | { type: "error"; code: HaikuErrorCode; message: string; callId: number | null };
export type RuntimeErrorEvent = Extract<RuntimeEvent, { type: "error" }>;

export interface AskOptions {
  kind: HaikuCallKind;
  scope: ToolScope;
  systemPrompt: string;
  prompt: string;
  resumeSessionId?: string | null;
  threadId?: number | null;
  ideaLink?: ToolContext["ideaLink"];
  signal?: AbortSignal;
  /** eigene Warteschlange statt Nyx' gemeinsamer (z. B. „prompt“ für „Prompt verbessern“). */
  lane?: string;
  /** Ohne Denkpause laufen (s. `EngineRequest.thinking`); Standard: {@link thinkingFor}. */
  thinking?: boolean;
  /** Rolle für die Modellwahl (z. B. "nyx.voice" für Sprach-Antworten). Fehlt sie, folgt sie aus `kind`. */
  role?: ModelRole | null;
  /** Nachricht, auf die der Lauf antwortet (Herkunft im Gedächtnis). */
  messageId?: number | null;
  /** (`behaviorHints`): Obergrenze Ausgabe-Tokens – der API-Motor hält sie ein, das CLI kennt keine. */
  maxTokens?: number;
  /**
   * Werkzeuge, die dieser Lauf weder sieht noch aufrufen darf – z. B. die Browser-Steuerung
   * (`ui_*`), wenn der Nutzer über Telegram schreibt und gar nicht vor NyxOS sitzt.
   */
  withoutTools?: readonly string[];
  /** eigenes Zeitlimit für diesen Lauf (z. B. Sonnet mit hoher Denkstufe); Standard aus den Einstellungen. */
  timeoutMs?: number;
  /** app_api: Kanal, über den der Nutzer SELBST gefragt hat (nur `runNyxTurn` setzt ihn). Fehlt er, gilt der Lauf
   * als automatisch – Werkzeuge dürfen dann nur lesen. */
  channel?: NyxChannel | null;
  /** The user's own words of this turn (without history or notes) — only `runNyxTurn` sets it (demo answers). */
  question?: string;
  /** Für Aufrufe ohne Budget-Grenze nicht vorgesehen — jeder Lauf zählt. */
}

interface RunGrant {
  scope: ToolScope;
  ideaLink: ToolContext["ideaLink"];
  expiresAt: number;
  callId: number;
  toolCalls: string[];
  /** vom Server gesetzter Lauf-Kontext für die Werkzeuge. */
  threadId: number | null;
  messageId: number | null;
  kind: HaikuCallKind;
  channel: NyxChannel | null;
  /** Für diesen Lauf gesperrte Werkzeuge (s. `AskOptions.withoutTools`). */
  denied: ReadonlySet<string>;
}

/** Prüfstand: ein Werkzeug-Aufruf mit Eingabe, Dauer und Ergebnis-Größe — zum Nachvollziehen, ob Haiku ein
 * Werkzeug richtig benutzt. Nur im Speicher (die letzten {@link TRACE_KEEP} Läufe), nie Inhalte ins Log. */
export interface ToolTraceEntry {
  name: string;
  args: unknown;
  ok: boolean;
  error: string | null;
  ms: number;
  /** Länge des Ergebnisses als JSON (Zeichen) — zeigt, wie viel Kontext ein Werkzeug-Aufruf kostet. */
  resultChars: number;
}

export interface CallTrace {
  tools: ToolTraceEntry[];
  contextTokens: number | null;
}

const TRACE_KEEP = 300;

/** Prüfstand: Briefing und Recap formulieren nur fertige Fakten um — mit Denkpause dauerte das
 * 36–71 s und kostete 5–9 Tsd. Ausgabe-Tokens, ohne ≈ die Hälfte. */
export function thinkingFor(kind: HaikuCallKind, env: NodeJS.ProcessEnv = process.env): boolean {
  if (kind === "briefing" || kind === "recap" || kind === "idee") return false;
  // Für den Prüfstand-Vergleich (A/B) auch im Chat abschaltbar; Standard: an.
  return env.NYXOS_HAIKU_CHAT_THINKING !== "0";
}

export interface HaikuRuntimeOptions {
  db: Db;
  tools: ToolRegistry;
  cliEngine: HaikuEngine | null;
  apiEngine: ApiEngine | null;
  ideas?: IdeaRepo | null;
  concurrency?: number;
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  onInboxChange?: () => void;
  onStatusChange?: () => void;
  /**
   * Motor je Lauf. Liefert einen Fremd-Anbieter-Motor, wenn der Rolle des Laufs einer zugeordnet ist,
   * sonst `null` (= bisheriger Weg über `settings.engine`). Wirft mit einfachen Worten, wenn der Anbieter fehlt.
   */
  engineForRun?: (kind: HaikuCallKind, role: ModelRole | null | undefined) => Promise<HaikuEngine | null>;
  /** eingeschaltete MCP-Konnektoren (nur für scope "full" – nie für Ideen-Links von außen). */
  connectors?: () => Promise<McpServerSpec[]>;
}

/** Hält Text zurück, der gerade einen Marker `[[…` beginnt, bis er vollständig ist. */
class MarkerStreamFilter {
  private pending = "";
  push(chunk: string): string {
    this.pending += chunk;
    const open = this.pending.lastIndexOf("[[");
    const close = this.pending.lastIndexOf("]]");
    let emitUpTo = this.pending.length;
    if (open > close) emitUpTo = open;
    else if (this.pending.endsWith("[")) emitUpTo = this.pending.length - 1;
    const out = this.pending.slice(0, emitUpTo);
    this.pending = this.pending.slice(emitUpTo);
    return stripMarkersForStream(out);
  }
}

/** Rollen mit fest verdrahtetem Modell + Denkstufe. Sie laufen NUR über das Claude-Programm, und das Ergebnis
 * muss wirklich von diesem Modell kommen – sonst ehrlicher Fehler statt stillem Haiku (älterer Nyx-Motor ohne
 * `--model`-Weitergabe, Reserve-Motor). */
const FIXED_ROLE_MODELS: Partial<Record<ModelRole, { model: string; effort: EngineEffort; label: string }>> = {
  "prompt.improve": { model: PROMPT_IMPROVE_MODEL, effort: PROMPT_IMPROVE_EFFORT, label: "Sonnet 5" },
};

export function fixedModelFor(role: ModelRole | null | undefined): { model: string; effort: EngineEffort; label: string } | null {
  return (role && FIXED_ROLE_MODELS[role]) || null;
}

/** Hat der Lauf wirklich das verlangte Modell benutzt? (Kennungen können Zusätze tragen, z. B. „[1m]“.) */
export function ranWithModel(required: string, used: (string | null | undefined)[]): boolean {
  return used.some((m) => typeof m === "string" && m.startsWith(required));
}

class WrongModelError extends Error {
  constructor(
    readonly label: string,
    readonly used: string | null,
  ) {
    super(t("Lauf nicht mit {label} ({used})", { label, used: used ?? t("unbekannt") }));
  }
}

/** So lange gilt „Token abgelehnt“, wenn der Motor nicht neu angebunden wird (danach wird wieder probiert). */
const AUTH_REJECTED_MS = 5 * 60_000;

export interface EngineView extends Omit<EngineAvailability, "state"> {
  state: HaikuEngineState;
}

export class HaikuRuntime {
  private running = 0;
  /** letzter Lauf scheiterte an der Anmeldung (Token abgelaufen/falsch). */
  private authRejected: { at: number; epoch: string | null } | null = null;
  private readonly waiters: (() => void)[] = [];
  private readonly grants = new Map<string, RunGrant>();
  private readonly traces = new Map<number, CallTrace>();
  private ideas: IdeaRepo | null;
  lastRundgang: HaikuStatus["lastRundgang"] = null;
  /** Nyx-Kern (Gedächtnis, Plan, geplante Aufgaben, Meldungen) – von routes/haiku.ts gesetzt.
   * (Telegram) erreicht darüber `nyx.notifier.registerChannel("telegram", …)` und `nyx.compact(threadId)`. */
  nyx: import("../nyx/index.js").NyxCore | null = null;
  /** Von routes/haiku.ts gesetzt, sobald Brücke/P4 verfügbar sind (Begleitung + Rundgang-Zusätze). */
  auftrag: { watch: () => Promise<number>; rundgangExtras: () => Promise<void> } | null = null;
  /** Demo: extra rule appended to every system prompt (invented data, look only). */
  systemNote: string | null = null;

  constructor(private readonly opts: HaikuRuntimeOptions) {
    this.ideas = opts.ideas ?? null;
  }

  /** Modellwahl je Rolle + Konnektoren (hängt `routes/models.ts` nach dem Aufbau ein). */
  useModels(hooks: Pick<HaikuRuntimeOptions, "engineForRun" | "connectors">): void {
    Object.assign(this.opts, hooks);
  }

  get db(): Db {
    return this.opts.db;
  }
  get tools(): ToolRegistry {
    return this.opts.tools;
  }
  setIdeaRepo(repo: IdeaRepo | null): void {
    this.ideas = repo;
  }
  get ideaRepo(): IdeaRepo | null {
    return this.ideas;
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  private get concurrency(): number {
    return Math.max(1, this.opts.concurrency ?? 1);
  }

  queueState(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiters.length };
  }

  engineFor(kind: HaikuEngineKind): HaikuEngine | null {
    if (kind === "claude-cli") return this.opts.cliEngine;
    if (kind === "api") return this.opts.apiEngine;
    return null;
  }

  /** ehrlicher Motor-Zustand (bereit · wartet auf Token · aus · Fehler) mit Grund in einfachen Worten. */
  async engineView(kind: HaikuEngineKind): Promise<EngineView> {
    if (kind === "off") return { ok: false, state: "off", reason: t(ENGINE_REASON.off), model: null };
    const engine = this.engineFor(kind);
    if (!engine) return { ok: false, state: "waiting_token", reason: kind === "api" ? t(ENGINE_REASON.reserveMissing) : t(ENGINE_REASON.cliMissingLocal), model: null };
    const avail = await engine.available();
    const rejected = this.authRejected;
    if (avail.ok && rejected) {
      const stale = Date.now() - rejected.at > AUTH_REJECTED_MS || (engine.epoch ?? null) !== rejected.epoch;
      if (stale) this.authRejected = null;
      else return { ...avail, ok: false, state: "waiting_token", reason: t(ENGINE_REASON.tokenRejected) };
    }
    return { ...avail, state: avail.state ?? (avail.ok ? "ready" : "error") };
  }

  async status(): Promise<HaikuStatus> {
    const settings = await loadHaikuSettings(this.db);
    // hat der Chat einen Fremd-Anbieter, zeigt der Status dessen Zustand + Modell (sonst der bisherige Motor).
    const chatEngine = settings.engine !== "off" && this.opts.engineForRun ? await this.opts.engineForRun("chat", null).catch(() => null) : null;
    const chatAvail = chatEngine ? await chatEngine.available() : null;
    const view: EngineView = chatAvail ? { ...chatAvail, state: chatAvail.state ?? (chatAvail.ok ? "ready" : "error") } : await this.engineView(settings.engine);
    const day = localDay(this.now());
    const usage = await usageForDay(this.db, day, this.now());
    return {
      settings,
      engine: { kind: chatEngine ? chatEngine.kind : settings.engine, state: view.state, available: view.ok, reason: view.reason, model: view.model },
      reserve: this.opts.apiEngine?.publicInfo ?? { configured: false, baseUrl: null, model: null },
      today: { day, calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd, budgetUsd: settings.dailyBudgetUsd },
      queue: this.queueState(),
      lastRundgang: this.lastRundgang,
    };
  }

  // ─── MCP-Brücke: Einmal-Token je Lauf ───

  grantFor(token: string): RunGrant | null {
    const g = this.grants.get(token);
    if (!g) return null;
    if (g.expiresAt < Date.now()) {
      this.grants.delete(token);
      return null;
    }
    return g;
  }

  async callToolWithToken(token: string, name: string, args: unknown): Promise<unknown> {
    const g = this.grantFor(token);
    if (!g) throw new Error(t("Lauf-Token ungültig oder abgelaufen"));
    return this.callTool(g, name, args);
  }

  private traceFor(callId: number): CallTrace {
    let trace = this.traces.get(callId);
    if (!trace) {
      trace = { tools: [], contextTokens: null };
      this.traces.set(callId, trace);
      // Map behält die Einfüge-Reihenfolge: das älteste zuerst verwerfen.
      while (this.traces.size > TRACE_KEEP) this.traces.delete(this.traces.keys().next().value as number);
    }
    return trace;
  }

  /** Werkzeug-Aufrufe (mit Eingaben) und Kontextgröße eines Laufs, solange er im Speicher ist. */
  callTrace(callId: number): CallTrace | null {
    return this.traces.get(callId) ?? null;
  }

  /** Werkzeuge, die ein Lauf sieht: Umfang minus die für ihn gesperrten. */
  private toolNamesFor(g: RunGrant): string[] {
    return this.tools.namesFor(g.scope).filter((n) => !g.denied.has(n));
  }

  /** Beschreibungen für Motoren ohne MCP bzw. `tools/list` des MCP-Proxys – ebenso ohne gesperrte Werkzeuge. */
  toolDefsFor(g: RunGrant): ToolDef[] {
    return this.tools.listFor(g.scope).filter((d) => !g.denied.has(d.name));
  }

  private async callTool(g: RunGrant, name: string, args: unknown): Promise<unknown> {
    // Gesperrt für diesen Lauf: wie ein Werkzeug außerhalb des Umfangs (egal, was das Modell versucht).
    if (g.denied.has(name)) {
      this.traceFor(g.callId).tools.push({ name, args, ok: false, error: "für diesen Lauf gesperrt", ms: 0, resultChars: 0 });
      throw new ToolDeniedError(name, g.scope);
    }
    g.toolCalls.push(name);
    const trace = this.traceFor(g.callId);
    const started = Date.now();
    try {
      const result = await this.tools.call(g.scope, name, args, {
        db: this.db,
        scope: g.scope,
        ideaLink: g.ideaLink,
        ideas: this.ideas,
        onInboxChange: this.opts.onInboxChange,
        threadId: g.threadId,
        messageId: g.messageId,
        kind: g.kind,
        channel: g.channel,
        callId: g.callId,
      });
      trace.tools.push({ name, args, ok: true, error: null, ms: Date.now() - started, resultChars: JSON.stringify(result ?? null).length });
      return result;
    } catch (e) {
      trace.tools.push({ name, args, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), ms: Date.now() - started, resultChars: 0 });
      throw e;
    }
  }

  // ─── Warteschlange ───

  /** eigene Spur (z. B. „prompt“ – Sonnet denkt bis zu 180 s): ein Lauf je Spur, blockiert Nyx' Chat/Stimme nicht. */
  private readonly lanes = new Map<string, { running: boolean; waiters: (() => void)[] }>();

  private async acquireLane(lane: string, onQueued: (pos: number) => void): Promise<() => void> {
    let l = this.lanes.get(lane);
    if (!l) this.lanes.set(lane, (l = { running: false, waiters: [] }));
    const state = l;
    if (!state.running) state.running = true;
    else {
      onQueued(state.waiters.length + 1);
      await new Promise<void>((r) => state.waiters.push(r));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) next();
      else state.running = false;
    };
  }

  private async acquire(onQueued: (pos: number) => void, lane?: string): Promise<() => void> {
    // app_api: ein Weg, den Nyx gerade aufruft, fragt selbst ein Modell (z. B. „Nyx fragen“) – nicht anstellen,
    // sonst wartet er auf die Runde, die auf ihn wartet (Verklemmung bis zur Zeitgrenze). Budget gilt weiter.
    if (insideAppApi()) return () => {};
    if (lane) return this.acquireLane(lane, onQueued);
    if (this.running < this.concurrency) {
      this.running++;
    } else {
      onQueued(this.waiters.length + 1);
      await new Promise<void>((r) => this.waiters.push(r));
    }
    let released = false;
    this.opts.onStatusChange?.();
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.running--;
      this.opts.onStatusChange?.();
    };
  }

  private async logCall(values: Partial<typeof haikuCalls.$inferInsert> & { kind: string; engine: string }): Promise<number> {
    const [row] = await this.db.insert(haikuCalls).values(values).returning({ id: haikuCalls.id });
    return (row as { id: number }).id;
  }

  /**
   * Alle Prüfungen VOR einem Lauf: Motor da und bereit, Tages- und Teilbudget (Budget-Absagen werden protokolliert).
   * der Chat fragt das vorab (`preflight`), damit bei nicht bereitem Motor kein leerer Faden entsteht.
   */
  private async gate(
    kind: HaikuCallKind,
    threadId: number | null,
    role?: ModelRole | null,
    checkBudget = true,
  ): Promise<{ ok: true; engine: HaikuEngine; avail: EngineAvailability; settings: HaikuSettings } | { ok: false; event: RuntimeErrorEvent }> {
    //: Skills entstehen nur in einer eigenen Opus-5.5-Session, nie über diesen Motor –
    // sonst liefe der Lauf still mit Haiku.
    if (role === "skills.create") {
      return { ok: false, event: { type: "error", code: "not_ready", message: t("Skills werden immer mit Opus 5.5 in einer eigenen Claude-Session erstellt – nie über Nyx' Motor."), callId: null } };
    }
    const settings: HaikuSettings = await loadHaikuSettings(this.db);
    // Rolle mit Fremd-Anbieter → dessen Motor (Haiku „aus“ schaltet trotzdem alles ab).
    let chosen: HaikuEngine | null = null;
    if (settings.engine !== "off" && this.opts.engineForRun) {
      try {
        chosen = await this.opts.engineForRun(kind, role);
      } catch (e) {
        return { ok: false, event: { type: "error", code: "not_ready", message: e instanceof Error ? e.message : t("Der gewählte Anbieter ist gerade nicht nutzbar."), callId: null } };
      }
    }
    const engine = chosen ?? this.engineFor(settings.engine);
    const fixed = fixedModelFor(role);
    if (fixed && engine && engine.kind !== "claude-cli") {
      return { ok: false, event: { type: "error", code: "not_ready", message: t("Das geht nur mit {label} über das Claude-Programm – der Reserve-Motor ist gerade eingestellt. Stell Nyx in den Einstellungen auf „Claude-Programm“.", { label: fixed.label }), callId: null } };
    }
    if (!engine) {
      return {
        ok: false,
        event:
          settings.engine === "off"
            ? { type: "error", code: "disabled", message: t(ENGINE_REASON.off), callId: null }
            : { type: "error", code: "not_ready", message: settings.engine === "api" ? t(ENGINE_REASON.reserveMissing) : t(ENGINE_REASON.cliMissingLocal), callId: null },
      };
    }
    // „Token abgelehnt“ sperrt hier NICHT: ein neuer Versuch (z. B. „Motor testen“) soll heilen können.
    const avail = await engine.available();
    if (!avail.ok) return { ok: false, event: { type: "error", code: "not_ready", message: avail.reason ?? t(ENGINE_REASON.cliBroken), callId: null } };
    if (!checkBudget) return { ok: true, engine, avail, settings };
    const day = localDay(this.now());
    const used = await usageForDay(this.db, day, this.now());
    if (used.costUsd >= settings.dailyBudgetUsd) {
      const callId = await this.logCall({ kind, engine: engine.kind, model: avail.model, status: "budget", threadId, error: `Tages-Budget ${settings.dailyBudgetUsd} USD erreicht`, endedAt: this.now().toISOString() });
      return { ok: false, event: { type: "error", code: "budget", message: t("Tages-Budget erreicht ({used} von {budget} USD).", { used: used.costUsd.toFixed(3), budget: settings.dailyBudgetUsd.toFixed(2) }), callId } };
    }
    // (7): Ideen-Links haben ein eigenes Teilbudget – Fremde können des Nutzers Haiku nicht leerfragen.
    if (kind === "idealink") {
      const share = (settings.dailyBudgetUsd * settings.ideaLinkBudgetPercent) / 100;
      const spent = await usageForKind(this.db, "idealink", day);
      if (spent >= share) {
        const callId = await this.logCall({ kind, engine: engine.kind, model: avail.model, status: "budget", threadId, error: `Teilbudget Ideen-Links ${share.toFixed(3)} USD erreicht`, endedAt: this.now().toISOString() });
        return { ok: false, event: { type: "error", code: "budget", message: t("Teilbudget der Ideen-Links erreicht ({spent} von {share} USD).", { spent: spent.toFixed(3), share: share.toFixed(3) }), callId } };
      }
    }
    return { ok: true, engine, avail, settings };
  }

  /** würde ein Lauf jetzt sofort abgelehnt? Dann genau der Fehler, den `ask` melden würde – sonst `null`. */
  async preflight(kind: HaikuCallKind, role?: ModelRole | null, opts: { budget?: boolean } = {}): Promise<RuntimeErrorEvent | null> {
    // mit der Rolle des Laufs – sonst prüfte der Vorab-Check den Standard-Motor, während der
    // Lauf auf einen zugewiesenen, nicht erreichbaren Anbieter geht (Faden mit Frage, aber ohne Antwort).
    // `budget: false`: only "is a model set up and reachable?" (status displays; no budget row in the call log).
    const g = await this.gate(kind, null, role, opts.budget ?? true);
    return g.ok ? null : g.event;
  }

  /** Name des Nutzers und Antwort-Sprache an jeden System-Prompt hängen (nicht bei Ideen-Links: dort spricht
   * Nyx mit einer fremden Person). Regelt der Prompt die Sprache schon selbst (Nyx-Chat), bleibt es beim Namen. */
  private async withUserContext(systemPrompt: string, kind: HaikuCallKind): Promise<string> {
    if (kind === "idealink") return systemPrompt;
    const extra: string[] = [];
    if (this.systemNote) extra.push(this.systemNote);
    const name = (await greetingNameOf(this.db).catch(() => null))?.replace(/\s+/g, " ").trim().slice(0, 80);
    if (name) extra.push(`Der Nutzer heißt ${name}.`);
    if (!systemPrompt.includes(LANGUAGE_RULE_HEAD)) extra.push(getLang() === "en" ? "Answer in English." : "Antworte auf Deutsch.");
    return extra.length > 0 ? `${systemPrompt}\n\n${extra.join("\n")}` : systemPrompt;
  }

  /** Ein Haiku-Lauf mit allem Drumherum. Liefert Ereignisse für das Streaming (Chat) und am Ende `final`. */
  async *ask(o: AskOptions): AsyncGenerator<RuntimeEvent> {
    const g = await this.gate(o.kind, o.threadId ?? null, o.role);
    if (!g.ok) {
      yield g.event;
      return;
    }
    const { engine, avail, settings } = g;
    const fixed = fixedModelFor(o.role);

    const queued: RuntimeEvent[] = [];
    const release = await this.acquire((pos) => queued.push({ type: "status", status: "queued", position: pos }), o.lane);
    // Whoever gave up while waiting in the queue (e.g. a notification sent on without Nyx after 8 s) starts no run
    // any more – otherwise it costs budget and blocks the lane for the next ones.
    if (o.signal?.aborted) {
      release();
      yield { type: "error", code: "timeout", message: t("Abgebrochen, bevor der Lauf begann."), callId: null };
      return;
    }
    for (const q of queued) yield q;
    const started = Date.now();
    const callId = await this.logCall({ kind: o.kind, engine: engine.kind, model: fixed?.model ?? avail.model, status: "running", threadId: o.threadId ?? null });
    const token = randomBytes(24).toString("hex");
    const timeoutMs = o.timeoutMs ?? settings.timeoutSeconds * 1000;
    const grant: RunGrant = {
      scope: o.scope,
      ideaLink: o.ideaLink ?? null,
      expiresAt: Date.now() + timeoutMs + 30_000,
      callId,
      toolCalls: [],
      threadId: o.threadId ?? null,
      messageId: o.messageId ?? null,
      kind: o.kind,
      channel: o.channel ?? null,
      denied: new Set(o.withoutTools ?? []),
    };
    this.grants.set(token, grant);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const filter = new MarkerStreamFilter();
    let raw = "";
    let finalEvent: Extract<import("./engine.js").EngineEvent, { type: "result" }> | null = null;
    let claudeSessionId: string | null = null;
    try {
      yield { type: "status", status: "thinking" };
      const tools = this.toolNamesFor(grant);
      // Konnektoren nur für des Nutzers eigene Läufe (scope "full"); ein Fehler hier hält Nyx nicht auf.
      const mcpServers = o.scope === "full" && this.opts.connectors ? await this.opts.connectors().catch(() => []) : [];
      for await (const ev of engine.run({
        mcpServers,
        kind: o.kind,
        systemPrompt: await this.withUserContext(o.systemPrompt, o.kind),
        prompt: o.prompt,
        ...(o.question !== undefined ? { question: o.question } : {}),
        resumeSessionId: o.resumeSessionId ?? null,
        scope: o.scope,
        runToken: token,
        tools,
        toolDefs: this.toolDefsFor(grant),
        callTool: (name, args) => this.callTool(grant, name, args),
        timeoutMs,
        thinking: o.thinking ?? thinkingFor(o.kind),
        maxTokens: o.maxTokens,
        ...(fixed ? { model: fixed.model, effort: fixed.effort } : {}),
        signal: ctrl.signal,
      })) {
        if (ev.type === "session") claudeSessionId = ev.sessionId;
        else if (ev.type === "tool") yield { type: "status", status: "tool", tool: ev.name };
        else if (ev.type === "delta") {
          raw += ev.text;
          const out = filter.push(ev.text);
          if (out) yield { type: "delta", text: out };
        } else if (ev.type === "result") finalEvent = ev;
      }
      if (!finalEvent) throw new Error(t("Motor lieferte kein Ergebnis"));
      if (finalEvent.isError) throw new Error(finalEvent.error ?? t("Motor meldete einen Fehler"));
      if (fixed && !ranWithModel(fixed.model, [finalEvent.model, ...(finalEvent.models ?? [])])) throw new WrongModelError(fixed.label, finalEvent.model);
      const text = finalEvent.text || raw;
      const extracted = await extractSources(this.db, text);
      const usage: HaikuUsage = { inputTokens: finalEvent.usage.inputTokens, outputTokens: finalEvent.usage.outputTokens, costUsd: finalEvent.usage.costUsd, durationMs: Date.now() - started };
      await this.db
        .update(haikuCalls)
        .set({
          status: "ok",
          model: finalEvent.model ?? avail.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: finalEvent.usage.cacheReadTokens,
          costUsd: usage.costUsd,
          durationMs: usage.durationMs,
          toolCalls: grant.toolCalls,
          endedAt: this.now().toISOString(),
        })
        .where(eq(haikuCalls.id, callId));
      this.authRejected = null;
      this.traceFor(callId).contextTokens = finalEvent.usage.contextTokens ?? null;
      //: eine Antwort aus Werkzeug-Daten (z. B. `lage`) ist keine „Einschätzung“, auch wenn
      // kein Quellen-Marker darin steht. Einschätzung = weder geprüfte Quelle noch ein Werkzeug benutzt.
      const estimate = extracted.sources.length === 0 && grant.toolCalls.length === 0;
      yield { type: "final", rawText: text, text: extracted.text, sources: extracted.sources, estimate, usage, callId, claudeSessionId: finalEvent.sessionId ?? claudeSessionId, toolCalls: [...grant.toolCalls] };
    } catch (e) {
      const timeout = e instanceof EngineTimeoutError;
      const message = e instanceof Error ? e.message : String(e);
      await this.db
        .update(haikuCalls)
        .set({ status: timeout ? "timeout" : ctrl.signal.aborted ? "cancelled" : "error", error: message.slice(0, 1000), durationMs: Date.now() - started, toolCalls: grant.toolCalls, endedAt: this.now().toISOString() })
        .where(eq(haikuCalls.id, callId));
      this.opts.log?.("haiku-fehler", { kind: o.kind, error: message.slice(0, 300) });
      if (!timeout && looksLikeAuthError(message)) {
        this.authRejected = { at: Date.now(), epoch: engine.epoch ?? null };
        this.opts.onStatusChange?.();
      }
      const wrong = e instanceof WrongModelError;
      if (wrong) this.opts.log?.("falsches-modell", { kind: o.kind, used: e.used });
      yield {
        type: "error",
        code: timeout ? "timeout" : "engine",
        message: timeout ? message : wrong ? t("Der Nyx-Motor hat nicht mit {label} geantwortet, sondern mit {used}. Ich nehme kein anderes Modell – der Motor braucht das nächste Deploy.", { label: e.label, used: e.used ?? t("einem anderen Modell") }) : t("Nyx konnte nicht antworten."),
        callId,
      };
    } finally {
      this.grants.delete(token);
      o.signal?.removeEventListener("abort", onAbort);
      release();
    }
  }

  /** Nicht-streamender Lauf (Briefing, Recap, Rundgang, Antworten): sammelt nur das Endergebnis. */
  async run(o: AskOptions): Promise<Extract<RuntimeEvent, { type: "final" }> | Extract<RuntimeEvent, { type: "error" }>> {
    let last: RuntimeEvent | null = null;
    for await (const ev of this.ask(o)) if (ev.type === "final" || ev.type === "error") last = ev;
    return (last as Extract<RuntimeEvent, { type: "final" | "error" }>) ?? { type: "error", code: "engine", message: t("kein Ergebnis"), callId: null };
  }

  /** Welche Werkzeuge ein abgeschlossener Lauf benutzt hat (aus dem Protokoll). */
  async lastToolCalls(callId: number): Promise<string[]> {
    const [row] = await this.db.select({ t: haikuCalls.toolCalls }).from(haikuCalls).where(eq(haikuCalls.id, callId)).limit(1);
    return row?.t ?? [];
  }

  async recentCalls(limit: number) {
    return this.db.select().from(haikuCalls).orderBy(sql`${haikuCalls.id} desc`).limit(limit);
  }
}
