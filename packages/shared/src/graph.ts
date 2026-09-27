import { z } from "zod";

/**
 * PG „Gehirn": gemeinsame Typen für den Wissens-Graphen (Server `apps/server/src/graph/…`,
 * Web `apps/web/src/features/brain/…`, Brücke `apps/bridge/src/vault/…`).
 *
 * Knoten-IDs sind global eindeutig und tragen ihre Art als Präfix (`session:claude:<uuid>`,
 * `note:<relativer Pfad>`, `baustelle:<slug>`, …), damit Quellen unabhängig voneinander Kanten
 * auf Knoten anderer Quellen ziehen können (z. B. Vault-Notiz → Session).
 */

export const GRAPH_NODE_TYPES = [
  "session",
  "subagent",
  "baustelle",
  "art",
  "file",
  "note",
  "bug",
  "task",
  "idea",
  "finding",
  "decision",
  "question",
  "problem",
  "commit",
  "branch",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export const GRAPH_NODE_TYPE_LABELS: Record<GraphNodeType, string> = {
  session: "Sessions",
  subagent: "Sub-Agenten",
  baustelle: "Baustellen",
  art: "Arten",
  file: "Dateien",
  note: "Obsidian-Notizen",
  bug: "Bugs",
  task: "Aufgaben",
  idea: "Ideen",
  finding: "Audit-Befunde",
  decision: "Entscheidungen",
  question: "Fragen",
  problem: "Probleme",
  commit: "Commits",
  branch: "Zweige",
};

export function isGraphNodeType(v: unknown): v is GraphNodeType {
  return typeof v === "string" && (GRAPH_NODE_TYPES as readonly string[]).includes(v);
}

export const GRAPH_LINK_KINDS = [
  "parent", // Eltern-Session ↔ Kind (Sub-Agent / Codex-Unter-Session)
  "baustelle", // Session ↔ Baustelle
  "art", // Baustelle/Session ↔ Art
  "shared_files", // Sessions mit gemeinsam geschriebenen Dateien (Gewicht = Anzahl)
  "touched_file", // Session ↔ Datei (nur mit include=files)
  "wikilink", // Notiz ↔ Notiz ([[Wiki-Link]])
  "note_session", // Notiz nennt Session-ID bzw. Session schrieb die Notiz
  "entry_link", // Eintrag ↔ Eintrag/Session (`links`)
  "idea_task", // Idee → Aufgabe
  "commit", // Session ↔ Commit, Commit ↔ Zweig
] as const;
export type GraphLinkKind = (typeof GRAPH_LINK_KINDS)[number];

/** Worauf ein Knoten in der restlichen NyxOS zeigt (Seitenblatt, Doppelklick = öffnen). */
export type GraphRef =
  | { kind: "session"; sessionKey: string; sessionId: string; tool: string; art: string; baustelleSlug: string | null }
  | { kind: "note"; path: string | null; vault?: string }
  | { kind: "baustelle"; slug: string }
  | { kind: "art"; art: string }
  | { kind: "file"; path: string }
  | { kind: "entry"; id: string; entryKind: string }
  | { kind: "commit"; sha: string; repo: string }
  | { kind: "branch"; name: string; repo: string };

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  /** Feinere Gruppe innerhalb der Art (Notiz: Ordner; Session: Art; Datei: Oberordner). */
  group: string;
  /** Anzahl Kanten (nach Zusammenführen aller Quellen, ohne Duplikate). */
  degree: number;
  /** Zustand (Session: läuft/wartet/…/geschlossen; Notiz: `unresolved` bei nur verlinktem Ziel). */
  state?: string | null;
  /** Zeitbezug (Session: letzte Aktivität; Notiz: Änderungszeit; Eintrag/Commit: Zeitpunkt). */
  ts?: string | null;
  /** true = Session ist geschlossen oder beendet (Archiv-Filter). */
  archived?: boolean;
  /** Code-Notiz aus einer Fremd-Bibliothek → Paketname (z. B. `swift-nio`), sonst fehlt es. */
  lib?: string | null;
  ref: GraphRef;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: GraphLinkKind;
  weight: number;
}

export interface GraphStats {
  nodes: number;
  links: number;
  orphans: number;
  byType: Partial<Record<GraphNodeType, number>>;
  byKind: Partial<Record<GraphLinkKind, number>>;
  builtAt: string;
  buildMs: number;
  /** Welche Quellen Daten geliefert haben (z. B. `sessions`, `vault`, `entries`, `git`). */
  sources: string[];
}

export interface GraphResponse {
  version: number;
  nodes: GraphNode[];
  links: GraphLink[];
  stats: GraphStats;
}

export interface GraphLocalResponse extends GraphResponse {
  center: string;
  depth: number;
}

/** längster Textauszug in einer Info-Karte (Zeichen). */
export const GRAPH_EXCERPT_MAX = 600;

/** Info-Karte zu einem Knoten (`GET /api/graph/node/:id`). */
export interface GraphNodeDetail {
  id: string;
  type: GraphNodeType;
  title: string;
  /** Kurze Fakten, schon deutsch beschriftet (Label, Wert). */
  facts: Array<[string, string]>;
  /** Haupt-Auszug: Notiz-Anfang, letzte Nachricht, Beschreibung … (höchstens `GRAPH_EXCERPT_MAX`). */
  excerpt: { label: string; text: string } | null;
  /** Zweiter Auszug (Session: erster Auftrag). */
  extra: { label: string; text: string } | null;
  tags: string[];
}

/** Kleines Delta über `/live` (statt Neuaufbau im Browser). */
export interface GraphDeltaMessage {
  type: "graph";
  fromVersion: number;
  version: number;
  addNodes: GraphNode[];
  updateNodes: GraphNode[];
  removeNodes: string[];
  addLinks: GraphLink[];
  removeLinks: Array<Pick<GraphLink, "source" | "target" | "kind">>;
}

export const linkKey = (l: Pick<GraphLink, "source" | "target" | "kind">) => `${l.kind}|${l.source}|${l.target}`;

// ---------------------------------------------------------------------------------------------
// Vault-Einlesen (Brücke → Server, `POST /ingest/vault`). Nur Metadaten und Links, kein Volltext.
// ---------------------------------------------------------------------------------------------

export const VAULT_INGEST_MAX_NOTES = 1000;

export const VaultNoteSchema = z.object({
  /** Pfad relativ zur Vault-Wurzel, POSIX-Trenner, mit `.md`. */
  path: z.string().min(1).max(1024),
  /** Anzeigename wie Obsidian: Dateiname ohne `.md`. */
  title: z.string().max(512),
  /** Erste Überschrift oder Frontmatter-`title` (für das Seitenblatt), sonst null. */
  heading: z.string().max(512).nullable(),
  /** Ordner relativ zur Wurzel (`""` = Wurzel). */
  folder: z.string().max(1024),
  tags: z.array(z.string().max(200)).max(500),
  /** Link-Ziele, wie geschrieben, ohne `|Alias` und `#Überschrift` (z. B. `04 Planung/X` oder `X`). */
  links: z.array(z.string().max(1024)).max(10_000),
  /** Session-IDs (UUIDs), die im Text genannt werden. */
  mentions: z.array(z.string().max(100)).max(1000),
  mtime: z.iso.datetime({ offset: true }),
  size: z.number().int().nonnegative(),
  /** Anfang der Notiz als reiner Text (ohne Frontmatter/Code), für die Info-Karte. Fehlt bei älteren Brücken. */
  excerpt: z.string().max(600).nullable().optional(),
  /** Quelldatei einer Code-Notiz (Frontmatter `path`, relativ zum Repo). Fehlt bei älteren Brücken. */
  source: z.string().max(1024).nullable().optional(),
});
export type VaultNote = z.infer<typeof VaultNoteSchema>;

export const VaultIngestSchema = z.object({
  /** Absolute Vault-Wurzel auf dem Rechner (für den Abgleich „Session schrieb Notiz" über `session_files`). */
  root: z.string().min(1).max(1024),
  /** Kennung des letzten vollständigen Abgleichs; Deltas tragen die Kennung des letzten vollen Laufs. */
  syncId: z.string().min(1).max(100),
  mode: z.enum(["full", "delta"]),
  notes: z.array(VaultNoteSchema).max(VAULT_INGEST_MAX_NOTES),
  deleted: z.array(z.string().min(1).max(1024)).max(10_000).default([]),
  /** Nur bei `mode: "full"`: letzter Teil des Laufs → Server löscht Notizen anderer Läufe. */
  done: z.boolean().default(true),
});
export type VaultIngest = z.infer<typeof VaultIngestSchema>;
