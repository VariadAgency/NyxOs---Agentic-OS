// Nachtmodus + Server-Runner. Vertrag zwischen Server (`apps/server/src/night`) und Web
// (`apps/web/src/features/night`). Der Planer selbst braucht keine Aufgaben-Tabelle aus P4 — er
// liest nur eine dünne `NightReadyTask`-Sicht (Schnittstelle unten), die P4 später aus `entries`
// füllt; bis dahin (und in Tests) liefert ein Fake dieselbe Form.
import { z } from "zod";

/** "läuft_auf": iOS-Aufträge nur auf dem Rechner (Xcode), alles andere auf dem Server. */
export const RunsOnSchema = z.enum(["server", "mac"]);
export type RunsOn = z.infer<typeof RunsOnSchema>;

export const NightWindowSchema = z.object({
  /** "HH:MM", z. B. "23:00" */
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});
export type NightWindow = z.infer<typeof NightWindowSchema>;

/** Standardwerte (Vorschläge, vom Nutzer einmal zu bestätigen). */
export const NightBudgetSchema = z.object({
  maxParallelOpus: z.number().int().min(1).max(10),
  /** Anteil des Wochenlimits (0–1), der pro Nacht höchstens verbraucht werden darf (P6-Daten). */
  maxWeeklyFractionPerNight: z.number().min(0).max(1),
  /** Harte Grenze je Auftrag — beendet den Auftrag sauber, sobald überschritten. */
  hardTokenLimitPerTask: z.number().int().positive(),
  hardTimeLimitMinutesPerTask: z.number().int().positive(),
});
export type NightBudget = z.infer<typeof NightBudgetSchema>;

export const DEFAULT_NIGHT_WINDOW: NightWindow = { start: "23:00", end: "07:00" };
export const DEFAULT_NIGHT_BUDGET: NightBudget = {
  maxParallelOpus: 2,
  maxWeeklyFractionPerNight: 0.15,
  hardTokenLimitPerTask: 2_000_000,
  hardTimeLimitMinutesPerTask: 240,
};

export const NightSettingsSchema = z.object({
  window: NightWindowSchema,
  budget: NightBudgetSchema,
  /** Aus dem Morgen-Briefing: "Alles freigeben" setzt das für die kommende Nacht. */
  allApproved: z.boolean(),
});
export type NightSettings = z.infer<typeof NightSettingsSchema>;

/** Dünne Sicht auf eine "Für Nacht freigegeben"-Aufgabe — P4 füllt das aus `entries`; der Planer
 * selbst kennt keine Aufgaben-Tabelle (Schnittstelle statt Kopplung, s. Datei-Kopf). */
export const NightReadyTaskSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  runsOn: RunsOnSchema,
  /** grobe Vorab-Schätzung (P4 Reife-Check/Budget-Feld) — reine Planungsgröße, keine harte Grenze. */
  estimatedTokens: z.number().int().nonnegative(),
  goalPath: z.string(),
});
export type NightReadyTask = z.infer<typeof NightReadyTaskSchema>;

export const NightRunStatusSchema = z.enum(["queued", "running", "done", "stopped_budget", "stopped_time", "waiting_mac", "failed"]);
export type NightRunStatus = z.infer<typeof NightRunStatusSchema>;

export interface NightRunRow {
  id: number;
  taskId: string;
  title: string;
  runsOn: RunsOn;
  status: NightRunStatus;
  sessionKey: string | null;
  tokensUsed: number;
  startedAt: string | null;
  endedAt: string | null;
  stopReason: string | null;
}

/** Ergebnis eines gestarteten Auftrags — was `SessionStarter.start()` zurückgibt. */
export interface StartedSession {
  sessionKey: string;
  worktreePath: string;
  branch: string;
}

/**
 * Schnittstelle, die P3 (tmux/Terminal auf dem Rechner) und P7 (Haiku-Start-Kette, "Starte A02") später
 * erfüllen — der Nachtmodus-Planer ruft nur `start`/`isRunning`/`stop` auf, kennt tmux/Worktree-
 * Details nicht. `FakeSessionStarter` (im Server-Testcode) erfüllt dieselbe Form für Tests, solange
 * nicht so weit sind (GOAL: "Start über eine Schnittstelle, die P3/P7 später erfüllen").
 */
export interface SessionStarter {
  start(task: NightReadyTask): Promise<StartedSession>;
  isRunning(sessionKey: string): Promise<boolean>;
  /** Sauberer Abbruch (Budget/Uhrzeit erreicht) — Stand sichern, Bericht, Session beenden. */
  stop(sessionKey: string, reason: string): Promise<void>;
  /** Verbrauchte Tokens seit Start (für die harte Grenze je Auftrag). */
  tokensUsed(sessionKey: string): Promise<number>;
}

/** Meldet, ob der Rechner gerade für einen Mac-Auftrag zur Verfügung steht (wach + am Strom). Die
 * Brücke füllt das später über `/api/machines`; ein Fake reicht für Tests 3. */
export interface MacAvailability {
  isAwakeAndPowered(): Promise<boolean>;
}
