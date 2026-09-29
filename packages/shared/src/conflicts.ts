// Konflikte-Tab — Kollisionskarte (wer schreibt/liest welche Datei) + Reservierungen.

export interface Reservation {
  id: number;
  pathGlob: string;
  label: string;
  sessionKey: string | null;
  createdAt: string;
  until: string | null;
}

/** „past“ = mehrere Sessions haben die Datei geändert, aber höchstens eine lebt noch —
 * ein Rückblick, keine Frage an den Nutzer (für beendete Sessions gibt es nichts mehr zu entscheiden). */
export type CollisionState = "ok" | "shared-read" | "conflict" | "past";

export interface CollisionParty {
  sessionKey: string;
  title: string | null;
  /** Für die Großansicht ("Zeiten") — erster Schreib-/Lesezugriff auf den Pfad. */
  firstSeenAt: string;
  /** Session läuft, wartet oder ruht gerade (`db/live.ts`). Fehlt = unbekannt (ältere Daten) → zählt als lebendig. */
  alive?: boolean;
}

export interface CollisionEntry {
  path: string;
  writers: CollisionParty[];
  readers: CollisionParty[];
  reservation: Reservation | null;
  state: CollisionState;
  reason: string | null;
}

export interface ReservationCheckResult {
  blocked: boolean;
  reason: string | null;
  conflictingReservation: Reservation | null;
}

export interface ConflictsSnapshot {
  collisionMap: CollisionEntry[];
  reservations: Reservation[];
  generatedAt: string;
}

// ── Zusammenfassung statt ganzer Karte, Entscheidungen, Vergleich ──────────────────

/** Wie dringend: grob nach Zahl der betroffenen Dateien und Sessions. */
export type ConflictSeverity = "high" | "medium" | "low";

/** Additiver Zustand einer Entscheidung (Tabelle `conflict_dismissals`). */
export type DecisionDismissal = "ignored" | "done";

export interface DecisionSession {
  sessionKey: string;
  title: string | null;
  tool: string | null;
  /** Läuft in der NyxOS (tmux, Terminal im Browser) — nur dann kann sie angehalten werden bzw. einen Hinweis bekommen. */
  inNyxOS: boolean;
  /** Wie viele der Konflikt-Dateien dieser Entscheidung diese Session schreibt. */
  fileCount: number;
}

/**
 * Eine Entscheidung = ein Ordner-Bereich, in dem dieselben Sessions gleichzeitig schreiben
 * (`together`), oder eine Session, die in einen fremd reservierten Bereich schreibt (`reserved-area`).
 * Viele Dateien, aber eine Frage an den Nutzer.
 */
export interface ConflictDecision {
  /** Stabiler Schlüssel (Ordner + beteiligte Sessions) — ändert sich, wenn eine weitere Session dazukommt. */
  key: string;
  kind: "together" | "reserved-area";
  /** Gruppen-Schlüssel (`folderKey`), z. B. "App/docs/audit-2026-09". */
  folder: string;
  /** Bereich für eine Reservierung (gemeinsamer Ordner + `/**` bzw. die eine Datei); null = Dateien liegen zu verstreut. */
  areaGlob: string | null;
  sessions: DecisionSession[];
  fileCount: number;
  samplePaths: string[];
  severity: ConflictSeverity;
  status: "open" | "reserved" | DecisionDismissal;
  /** Deckende Reservierung (bei `reserved`) bzw. die unterlaufene (bei `reserved-area`). */
  reservation: Reservation | null;
  latestAt: string | null;
}

export interface ConflictGroupSummary {
  key: string;
  fileCount: number;
  conflictCount: number;
  sharedReadCount: number;
  /** Dateien, die nur beendete Sessions gemeinsam geändert haben (Rückblick). */
  pastCount: number;
  severity: ConflictSeverity | null;
  /** Schreibende Sessions im Ordner (höchstens 8), `writerCount` = alle. */
  writers: { sessionKey: string; title: string | null }[];
  writerCount: number;
  latestAt: string | null;
}

export interface ConflictsSummary {
  /** Stand der Daten (auch ETag) — gleich, solange sich nichts geändert hat. */
  version: string;
  generatedAt: string;
  bridgeOnline: boolean;
  totals: { files: number; conflicts: number; sharedRead: number; groups: number; openDecisions: number; past: number };
  decisions: ConflictDecision[];
  groups: ConflictGroupSummary[];
  reservations: Reservation[];
}

export interface ConflictEntriesPage {
  total: number;
  offset: number;
  limit: number;
  entries: CollisionEntry[];
}

/** Eine Zeile einer Änderung (Diff). `oldNo`/`newNo` = Zeilennummer vorher/nachher. */
export interface DiffLine {
  kind: "ctx" | "add" | "del" | "hunk";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  lines: DiffLine[];
}

/** eine Änderung einer Session an einer Datei (aus dem Verlauf: Edit/Write bzw. Codex-Patch). */
export interface FileEdit {
  at: string | null;
  tool: string;
  kind: "edit" | "write" | "create" | "patch" | "delete";
  /** true = Zeilennummern sind echt (aus der Datei), false = nur relativ zum Ausschnitt. */
  exactLines: boolean;
  lines: DiffLine[];
  truncated: boolean;
}

export interface SessionFileChanges {
  sessionKey: string;
  title: string | null;
  tool: string | null;
  edits: FileEdit[];
  /** Verlauf liegt (noch) nicht auf dem Server. */
  missingArchive: boolean;
}

export interface FileChangesResponse {
  path: string;
  sessions: SessionFileChanges[];
}

export interface GitCompareCommit {
  sha: string;
  short: string;
  author: string;
  at: string;
  subject: string;
}

export interface GitCompareResponse {
  repoRoot: string;
  relPath: string;
  commits: GitCompareCommit[];
  from: string | null;
  /** null = Arbeitskopie (aktueller, noch nicht gespeicherter Stand). */
  to: string | null;
  files: DiffFile[];
  truncated: boolean;
  /** Datei ist in keinem Commit (neu, noch nicht hinzugefügt). */
  untracked: boolean;
}
