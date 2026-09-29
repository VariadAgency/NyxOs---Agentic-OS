// EINE Regel „lebt gerade“ für Konflikte und offene Fragen. Dieselbe Zustandsquelle wie
// der Schnappschuss (`overview/snapshot.ts`): die Spalte `sessions.state`, die `computeSessionState`
// pflegt (C1-Altersgrenze inklusive). Lebendig = läuft, wartet oder ruht — nicht beendet (state null),
// nicht abgestürzt, nicht geschlossen — und es zählt mit (`countedSession`): nicht archiviert und keine
// automatisch erkannte Test-Session (Probe, Selbsttest, Haiku-Lauf). Test-Sessions laufen in
// eigenen Ordnern/Worktrees oder nur lesend; eine Konflikt-Frage „A zuerst / B zuerst“ mit einem Prüflauf
// wäre Lärm, den der Nutzer nicht sinnvoll beantworten kann. Bewusst temporär gestartete („manual“) zählen.
//
// Eigene Datei statt Erweiterung von `visible.ts`, damit parallele Pakete dort nicht kollidieren.
import { and, inArray, isNull, type SQL } from "drizzle-orm";
import { sessions } from "./schema.js";
import { countedSession } from "./visible.js";

export const LIVE_SESSION_STATES = ["running", "waiting", "idle"] as const;

/** Reine Prüfung für schon geladene Zeilen (gleiche Regel wie `liveSession`). */
export function isLiveSession(row: { state: string | null; closedAt: string | null; archivedAt?: string | null; temporaryReason?: string | null }): boolean {
  return isCountedSession(row) && row.closedAt === null && (LIVE_SESSION_STATES as readonly string[]).includes(row.state ?? "");
}

/** Reine Fassung von `countedSession` für schon geladene Zeilen. */
export function isCountedSession(row: { archivedAt?: string | null; temporaryReason?: string | null }): boolean {
  const reason = row.temporaryReason ?? null;
  return (row.archivedAt ?? null) === null && (reason === null || reason === "manual");
}

/** Drizzle-Bedingung: Session lebt gerade. */
export const liveSession: SQL = and(isNull(sessions.closedAt), countedSession, inArray(sessions.state, [...LIVE_SESSION_STATES])) as SQL;
