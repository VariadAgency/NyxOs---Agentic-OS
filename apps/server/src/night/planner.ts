// Nachtmodus — Planer/Steuerlogik. Kennt keine tmux-/Worktree-Details: Start läuft über
// `SessionStarter` (Schnittstelle aus `@nyxos/shared`, die P3/Mac bzw. P7/Haiku-Startkette später
// erfüllen; `FakeSessionStarter` in `apps/server/test/p8/fakes.ts` erfüllt dieselbe Form für Tests
// und für diesen Bericht). Der Planer selbst kennt auch keine Aufgaben-Tabelle —
// `NightReadyTask[]` kommt von außen (P4 später aus `entries`, hier aus einem Fake/einer Liste).
import type { MacAvailability, NightBudget, NightReadyTask, NightSettings, SessionStarter } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { nightRuns } from "../db/schema.js";
import { isWithinWindow } from "./window.js";

interface RunningEntry {
  id: number;
  taskId: string;
  runsOn: NightReadyTask["runsOn"];
  sessionKey: string;
  startedAt: number;
}

export interface PlannerTickResult {
  started: string[];
  stopped: Array<{ taskId: string; reason: string }>;
  skippedMacUnavailable: string[];
  atCapacity: boolean;
  outsideWindow: boolean;
}

/**
 * Ein Tick prüft laufende Aufträge gegen die Grenzen (Zeit, Token, Fenster-Ende) und startet neue,
 * solange Fenster + Parallel- + Nacht-Budget-Grenze das zulassen.
 * Zustandsfrei zwischen Ticks bis auf `running` (im Prozess) + `night_runs` (DB, überlebt Neustart:
 * ein Neustart des Servers liest laufende Zeilen nicht automatisch wieder ein — s. Bericht "offene
 * Punkte", das ist außerhalb von P8s Zeitrahmen).
 */
export class NightPlanner {
  private readonly running: RunningEntry[] = [];
  /** Tokens aller in dieser Nacht schon BEENDETEN Aufträge (für die 15-%-Grenze über die ganze Nacht). */
  private nightTokensUsed = 0;
  private windowOpenSince: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly starter: SessionStarter,
    private readonly macAvailability: MacAvailability,
    private readonly settings: NightSettings,
    /** Wochenlimit in Tokens (P6-Daten) — 0 = Grenze nicht prüfen (z. B. während P6 noch nicht liefert). */
    private readonly weeklyLimitTokens: number,
  ) {}

  private budget(): NightBudget {
    return this.settings.budget;
  }

  private nightCapTokens(): number {
    return Math.floor(this.weeklyLimitTokens * this.budget().maxWeeklyFractionPerNight);
  }

  async tick(now: Date, queue: NightReadyTask[]): Promise<PlannerTickResult> {
    const result: PlannerTickResult = { started: [], stopped: [], skippedMacUnavailable: [], atCapacity: false, outsideWindow: false };
    const inWindow = isWithinWindow(this.settings.window, now);

    if (inWindow && this.windowOpenSince === null) this.windowOpenSince = now.getTime();
    if (!inWindow) this.windowOpenSince = null;

    // 1. Laufende Aufträge gegen harte Grenzen prüfen — auch außerhalb des Fensters (Fensterende ist
    //    selbst ein Abbruchgrund, s. u.), harte Grenzen gelten unabhängig von der Uhrzeit.
    for (const entry of [...this.running]) {
      const tokensUsed = await this.starter.tokensUsed(entry.sessionKey);
      const minutesRunning = (now.getTime() - entry.startedAt) / 60_000;
      let reason: string | null = null;
      if (!inWindow) reason = "fenster_ende";
      else if (tokensUsed >= this.budget().hardTokenLimitPerTask) reason = "token_grenze";
      else if (minutesRunning >= this.budget().hardTimeLimitMinutesPerTask) reason = "zeit_grenze";
      if (reason) {
        await this.stopEntry(entry, reason, tokensUsed, now);
        result.stopped.push({ taskId: entry.taskId, reason });
      }
    }

    result.outsideWindow = !inWindow;
    if (!inWindow) return result;

    // 2. Neue Aufträge starten, solange Parallel- + Nacht-Budget-Grenze und Fenster das zulassen.
    const cap = this.nightCapTokens();
    for (const task of queue) {
      if (this.running.length >= this.budget().maxParallelOpus) {
        result.atCapacity = true;
        break;
      }
      if (cap > 0 && this.nightTokensUsed + task.estimatedTokens > cap) {
        result.atCapacity = true;
        break;
      }
      if (task.runsOn === "mac" && !(await this.macAvailability.isAwakeAndPowered())) {
        // Mac-Auftrag bleibt in der Schlange, Server-Aufträge laufen trotzdem weiter
        // (die Schleife macht beim nächsten Server-tauglichen Auftrag einfach weiter).
        result.skippedMacUnavailable.push(task.taskId);
        continue;
      }
      const started = await this.starter.start(task);
      const [row] = await this.db
        .insert(nightRuns)
        .values({ taskId: task.taskId, title: task.title, runsOn: task.runsOn, status: "running", sessionKey: started.sessionKey, startedAt: now.toISOString() })
        .returning({ id: nightRuns.id });
      if (!row) throw new Error("night_runs-Zeile konnte nicht angelegt werden");
      this.running.push({ id: row.id, taskId: task.taskId, runsOn: task.runsOn, sessionKey: started.sessionKey, startedAt: now.getTime() });
      result.started.push(task.taskId);
    }
    return result;
  }

  private async stopEntry(entry: RunningEntry, reason: string, tokensUsed: number, now: Date): Promise<void> {
    await this.starter.stop(entry.sessionKey, reason);
    const status = reason === "token_grenze" ? "stopped_budget" : reason === "zeit_grenze" ? "stopped_time" : "done";
    await this.db
      .update(nightRuns)
      .set({ status, tokensUsed, endedAt: now.toISOString(), stopReason: reason })
      .where(eq(nightRuns.id, entry.id));
    this.nightTokensUsed += tokensUsed;
    const idx = this.running.indexOf(entry);
    if (idx >= 0) this.running.splice(idx, 1);
  }

  runningTaskIds(): string[] {
    return this.running.map((r) => r.taskId);
  }
}
