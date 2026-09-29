/**
 * Session-Zustände. Eine reine, getestete Funktion:
 * Eingabe sind nur schon vorhandene Spalten der Session-Zeile plus die aktuelle Zeit,
 * Ausgabe ist immer einer der fünf P2-Zustände oder `null`.
 *
 * `null` heißt: kein P2-Zustand zutreffend — das betrifft nur sauber beendete Sessions
 * (Prozess weg, aber mit abgeschlossener Runde oder mit `SessionEnd`-Hook). Für die bleibt
 * der bestehende P1-Status `sessions.status = "ended"` die Wahrheit; es wird bewusst kein
 * neuer, in P2 nicht vorgesehener Zustand dafür erfunden.
 *
 * Reserviert, aber in P2 nie das Ergebnis dieser Funktion: `done_suggested` (Haiku-
 * Vorschlag „fertig?"), `conflict` (Kollisionserkennung).
 */
import { DEFAULT_CRASHED_MAX_HOURS, isOrphanedSession, type OrphanInput } from "@nyxos/shared";

export type ComputedSessionState = "running" | "waiting" | "idle" | "crashed" | "closed";
export const RESERVED_SESSION_STATES = ["done_suggested", "conflict"] as const;

/** Ab dieser Stille (seit `lastActivityAt`, Prozess läuft, Runde offen) gilt eine Session als „ruht". */
export const IDLE_AFTER_MS = 30 * 60 * 1000;

/** Standard-Altersgrenze für „abgestürzt“ (einstellbar, s. `state-settings.ts`). */
export const DEFAULT_CRASHED_MAX_MS = DEFAULT_CRASHED_MAX_HOURS * 3_600_000;

export interface StateOptions {
  /** Nach so langer Zeit ohne Prozess (seit `lastActivityAt`) ist eine Session nicht mehr „abgestürzt“, sondern beendet. */
  crashedMaxMs?: number;
}

export interface SessionStateRow {
  /** P1-Status: "running" = Prozess lebt (Hook/Lebenszeichen), "ended" = Prozess weg. */
  status: string;
  /** true = aktuelle Runde läuft noch; false = letztes Signal war Stop/Notification/task_complete. */
  turnOpen: boolean;
  /** Zeitpunkt eines echten `SessionEnd`-Hooks, sonst null (unterscheidet sauberes Ende vom Absturz). */
  sessionEndReceivedAt: string | null;
  /** Letzte Aktivität irgendeiner Art (für die 30-Minuten-Ruhe-Schwelle). */
  lastActivityAt: string | null;
  /** Nur durch `POST /api/sessions/:id/close` gesetzt. */
  closedAt: string | null;
  /** Schritt 5: tmux-Bildschirm zeigt eine Freigabe-Frage/Eingabe-Aufforderung. Nur ein
   * Zusatzsignal — wirkt nur, solange der Prozess lebt, und nie gegen „geschlossen". */
  screenWaiting?: boolean | null;
}

/**
 * Berechnet den P2-Zustand einer Session. Reihenfolge (jede Stufe hat Vorrang vor der nächsten):
 * 1. geschlossen (closedAt gesetzt) — schlägt alles andere
 * 2. Prozess weg (status !== "running"):
 *    - ohne SessionEnd-Hook UND letzte Runde offen → abgestürzt — aber nur bis `crashedMaxMs` (
 *      Standard 12 h) nach der letzten Aktivität; danach beendet (null), sonst zählt ein Absturz von vor
 *      33 Tagen ewig als „braucht dich“
 *    - sonst (Runde war zu, oder SessionEnd kam) → kein P2-Zustand (null), P1-Status "ended" bleibt
 * 3. Prozess lebt:
 *    - Runde geschlossen (Stop/Notification/task_complete) → wartet auf dich
 *    - Runde offen, seit ≥ 30 Min keine Aktivität → ruht
 *    - sonst → läuft
 */
export function computeSessionState(row: SessionStateRow, now: number, opts: StateOptions = {}): ComputedSessionState | null {
  if (row.closedAt !== null) return "closed";

  const processAlive = row.status === "running";
  if (!processAlive) {
    const crashed = row.sessionEndReceivedAt === null && row.turnOpen;
    if (!crashed) return null;
    const last = row.lastActivityAt === null ? null : Date.parse(row.lastActivityAt);
    const maxAge = opts.crashedMaxMs ?? DEFAULT_CRASHED_MAX_MS;
    if (last !== null && !Number.isNaN(last) && now - last >= maxAge) return null;
    return "crashed";
  }

  if (!row.turnOpen || row.screenWaiting === true) return "waiting";

  const last = row.lastActivityAt === null ? null : Date.parse(row.lastActivityAt);
  if (last !== null && !Number.isNaN(last) && now - last >= IDLE_AFTER_MS) return "idle";
  return "running";
}

/**
 * (Audit Punkt 2): „verwaist“ ist KEIN gespeicherter Zustand, sondern eine Lesart von „wartet“:
 * eine Session, die seit > 1 Tag „wartet“, aber nie eine Nachricht hatte (Terminal gestartet, nie benutzt).
 * Sie zählt nicht zu „wartet auf dich“. Dieselbe Regel (`isOrphanedSession` in `@nyxos/shared`) nutzt die
 * Web-App für Karte, Reiter und Chat – so stimmen Überblick, Briefing und Sessions-Seite überein.
 */
export function isOrphaned(row: OrphanInput, now: number): boolean {
  return isOrphanedSession(row, now);
}

/** Hook-Namen (Claude wie Codex), die eine neue Runde eröffnen bzw. wieder öffnen. */
export const TURN_OPEN_HOOK_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);
/** Hook-Namen, nach denen der Nutzer gefragt ist: Runde ist zu, „wartet auf dich". */
export const TURN_WAITING_HOOK_EVENTS = new Set(["Stop", "Notification"]);

/** Minimale Form eines Events, wie sie sowohl aus dem Ingest-Pfad als auch aus `session_events` kommt. */
export interface TurnSignalEvent {
  kind: string;
  source: string;
  data: unknown;
}

/**
 * Liest aus einem einzelnen Event, ob es die aktuelle Runde öffnet (`true`), schließt (`false`)
 * oder gar kein Runden-Signal ist (`null`). Eine reine Funktion, damit der Live-Pfad (`insertEvents`
 * in `store.ts`) und die Rückrechnung (`backfillStates`) dieselbe Ableitung benutzen, statt sie zu
 * verdoppeln. Codex `turn_aborted` (Abbruch durch den Nutzer) schließt die Runde wie `turn_end`.
 */
export function deriveTurnSignal(e: TurnSignalEvent): boolean | null {
  if (e.source === "hook") {
    const hook = (e.data as Record<string, unknown> | null)?.event;
    if (typeof hook !== "string") return null;
    // nach jeder Komprimierung meldet Claude Code `SessionStart` mit `source: "compact"`.
    // Das ist KEINE neue Runde: bei „/compact“ steht Claude danach wieder an der Eingabe (die Runde schließt
    // die Komprimierung selbst, s. unten), bei der automatischen arbeitet es in der offenen Runde weiter.
    if (hook === "SessionStart" && (e.data as Record<string, unknown>).source === "compact") return null;
    // „/clear“ beginnt eine NEUE, leere Session (`SessionStart` mit `source: "clear"`) – Claude
    // steht dort an der Eingabe, es kommt kein Stop-Hook. Sonst stünde sie bis zur ersten Frage auf „läuft“.
    // genauso beim Start (`startup`) und Fortsetzen (`resume`) – Claude wartet an der Eingabe,
    // erst `UserPromptSubmit` (die erste Frage) öffnet die Runde.
    if (hook === "SessionStart" && ["clear", "startup", "resume"].includes(String((e.data as Record<string, unknown>).source))) return false;
    if (TURN_OPEN_HOOK_EVENTS.has(hook)) return true;
    if (TURN_WAITING_HOOK_EVENTS.has(hook)) return false;
    return null;
  }
  if (e.kind === "turn_start") return true;
  if (e.kind === "turn_end" || e.kind === "turn_aborted") return false;
  // „/compact“ (vom Nutzer, auch über den Knopf „Kontext komprimieren“) ist ein lokaler
  // Befehl – danach kommt kein Stop-Hook, Claude wartet aber wieder auf Eingabe. Die Komprimierungs-Zeile
  // im Verlauf mit `trigger: "manual"` schließt die Runde. Automatische Komprimierung (`auto`) ändert nichts.
  if (e.kind === "compaction" && (e.data as Record<string, unknown> | null)?.trigger === "manual") return false;
  return null;
}
