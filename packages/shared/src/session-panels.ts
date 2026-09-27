// Typen der Session-Seitenpanels (Geänderte Dateien, Reiter „Änderungen", Agenten-
// Kacheln, Bezüge „erledigt/behoben/offen/vergleichbar"). Alle Werte kommen aus dem Archiv der
// Session (Server-Digest je Verlaufsdatei, s. `apps/server/src/session-digest.ts`) bzw. aus der DB —
// nie geschätzt. Fehlt eine Angabe, ist sie `null` (die Web-App zeigt dann „keine Angabe").
import type { AgentVerdict } from "./agents.js";
import type { Tool } from "./events.js";

/** Tokens eines Agenten bzw. einer Verlaufsdatei (dieselbe Zählweise wie `sessions.tokens`). */
export interface AgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

/** Eine geschriebene Datei mit Zahlen aus dem Verlauf. `edits`/`added`/`removed` sind `null`, wenn
 * das Archiv (noch) keine Angabe hergibt — z. B. Datei nur aus `session_files` bekannt. */
export interface ChangeFileStat {
  path: string;
  edits: number | null;
  added: number | null;
  removed: number | null;
  lastTs: string | null;
  /** Sub-Agenten, die diese Datei geändert haben (leer = nur die Haupt-Session). */
  agentIds: string[];
}

export interface ChangeSnippetLine {
  kind: "+" | "-";
  text: string;
}

export interface ChangeFileHit extends ChangeFileStat {
  /** Trifft die Suche den Pfad selbst? */
  matchedPath: boolean;
  /** Anzahl Treffer im geänderten Inhalt (Zeilen). */
  contentMatches: number;
  /** Bis zu drei Beispiel-Zeilen mit Treffer (nur bei Suche). */
  snippets: ChangeSnippetLine[];
}

/** `GET /api/sessions/:id/changes[?q=]` */
export interface SessionChangesResponse {
  files: ChangeFileHit[];
  /** Alle geschriebenen Dateien der Session (Nenner für „x von y"). */
  total: number;
  query: string | null;
}

/** Eine einzelne Änderung an einer Datei (Klick auf eine Datei im Reiter „Änderungen"). */
export interface FileChangeOp {
  ts: string | null;
  tool: string;
  agentId: string | null;
  added: number;
  removed: number;
  /** Geänderte Zeilen, entfernte zuerst; auf `FILE_OP_LINES_MAX` begrenzt (`truncated`). */
  lines: ChangeSnippetLine[];
  truncated: boolean;
}

/** `GET /api/sessions/:id/changes/file?path=` */
export interface SessionFileChangesResponse {
  path: string;
  ops: FileChangeOp[];
  /** Alle Änderungen dieser Datei (die Liste zeigt höchstens die letzten 50). */
  total: number;
}

export const FILE_OP_LINES_MAX = 80;

/** Eine Agenten-Kachel (klein). */
export interface SessionAgentSummary {
  id: string;
  tool: Tool;
  name: string | null;
  type: string | null;
  /** Codex: eigene Kind-Session (zum Öffnen), Claude: `null`. */
  sessionKey: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  toolCalls: number;
  tokens: AgentTokens | null;
  filesWritten: number;
  verdict: AgentVerdict | null;
  /** Ohne archivierten Verlauf gibt es nur Name/Typ (z. B. Agent läuft gerade erst an). */
  hasTranscript: boolean;
}

export interface AgentToolCount {
  name: string;
  count: number;
}

/** Große Kachel: `GET /api/sessions/:id/agents/:agentId` */
export interface SessionAgentDetail extends SessionAgentSummary {
  /** Auftrag (erste Nachricht an den Agenten), ungekürzt. */
  prompt: string | null;
  /** Letzte Antwort des Agenten (sein Ergebnis), ungekürzt. */
  result: string | null;
  tools: AgentToolCount[];
  toolErrors: number;
  files: ChangeFileStat[];
}

export interface SessionAgentsResponse {
  agents: SessionAgentSummary[];
}

/** Wie sicher ein Treffer in „Erfolgreich behoben" ist. */
export type OutcomeConfidence = "sicher" | "wahrscheinlich" | "moeglich";

export type OutcomeKind = "todo" | "agent" | "commit" | "entry" | "subtask" | "test";

export type OutcomeLink =
  | { type: "entry"; id: number }
  | { type: "agent"; id: string }
  | { type: "session"; sessionKey: string; art: string; baustelle: { slug: string; label: string } | null }
  | null;

export interface OutcomeItem {
  id: string;
  kind: OutcomeKind;
  title: string;
  /** Zusatz in einfachen Worten (z. B. Commit-Kennung, Test-Befehl, Agenten-Urteil). */
  detail: string | null;
  ts: string | null;
  confidence: OutcomeConfidence;
  /** Warum das hier steht, in einem Satz („Commit mit ‚fix' in der Nachricht"). */
  why: string;
  link: OutcomeLink;
}

export interface SimilarSession {
  sessionKey: string;
  sessionId: string;
  title: string | null;
  tool: Tool;
  state: string | null;
  art: string;
  baustelle: { slug: string; label: string } | null;
  lastActivityAt: string | null;
  score: number;
  /** Gründe in einfachen Worten („3 gemeinsame Dateien", „gleiche Baustelle", „ähnlicher Titel"). */
  reasons: string[];
  sharedFiles: string[];
}

/** `GET /api/sessions/:id/outcomes` */
export interface SessionOutcomesResponse {
  done: OutcomeItem[];
  fixed: OutcomeItem[];
  open: OutcomeItem[];
  similar: SimilarSession[];
  /** Kennzahlen der Session für die Kopfzeile des Reiters. */
  stats: { commits: number; testRuns: number; agentsFinished: number; agentsTotal: number };
}
