import { z } from "zod";
import { WORKTREE_DIR } from "./git.js";

/**
 * gemeinsame Typen für Aufgaben/Bugs/Audit/Ideen/Entscheidungen/Fragen/Probleme (Server-Routen
 * `apps/server/src/routes/entries.ts`, Web-Features `apps/web/src/features/{tasks,ideas}`, MCP
 * `apps/mcp`). Eine Quelle der Wahrheit für gültige `kind`/`stage`-Werte (wie `art.ts` für Sessions).
 */
export const ENTRY_KINDS = ["bug", "aufgabe", "audit", "idee", "entscheidung", "frage", "problem"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const EntryKindSchema = z.enum(ENTRY_KINDS);

/** Ideen-Stufen + Aufgaben-Stufen. Eine Spalte für beide Verläufe, `kind`
 * entscheidet, welcher Verlauf gilt — "In Aufgaben übernehmen" wechselt kind weg von 'idee'. */
export const IDEA_STAGES = ["eingang", "in_klaerung", "konzept_fertig"] as const;
export const TASK_STAGES = ["geplant", "startklar", "laeuft", "pruefen", "erledigt"] as const;
export const ENTRY_STAGES = [...IDEA_STAGES, ...TASK_STAGES] as const;
export type EntryStage = (typeof ENTRY_STAGES)[number];
export const EntryStageSchema = z.enum(ENTRY_STAGES);

export const ENTRY_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type EntryPriority = (typeof ENTRY_PRIORITIES)[number];

export const LINK_OBJECT_TYPES = ["entry", "session", "file", "commit", "doc"] as const;
export type LinkObjectType = (typeof LINK_OBJECT_TYPES)[number];

export interface MaturityCheckPoint {
  key: "ziel_abnahme" | "dateibereich" | "keine_offene_entscheidung" | "vorgaenger_abgenommen" | "kein_konflikt" | "budget_passt";
  label: string;
  passed: boolean;
  reason: string;
}

export interface MaturityResult {
  points: MaturityCheckPoint[];
  passed: boolean;
  passedCount: number;
  totalCount: number;
}

export interface Subtask {
  id: number;
  entryId: number;
  title: string;
  weight: number;
  done: boolean;
  doneBySessionKey: string | null;
  doneAt: string | null;
  createdAt: string;
}

export interface EntryLink {
  id: number;
  fromType: LinkObjectType;
  fromId: string;
  toType: LinkObjectType;
  toId: string;
  relation: string;
  createdAt: string;
  /** Angereichert für die Anzeige (Titel des Ziels), vom Server berechnet — nie roh aus der DB. */
  label?: string;
  /** "out" = dieser Eintrag ist `from*`, "in" = er ist `to*` (Großansicht zeigt beide Richtungen). */
  direction?: "in" | "out";
}

export interface EntryEvent {
  id: number;
  entryId: number;
  ts: string;
  kind: string;
  source: string;
  data: Record<string, unknown>;
}

export interface Entry {
  id: number;
  kind: EntryKind;
  title: string;
  description: string | null;
  stage: EntryStage;
  priority: EntryPriority | null;
  baustelle: { slug: string; label: string } | null;
  progressPercent: number;
  progressDoneWeight: number;
  progressTotalWeight: number;
  maturity: MaturityResult | null;
  maturityCheckedAt: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Quelle gibt es nicht mehr (GOAL.md gelöscht, Idee im Postfach archiviert …) — der
   * Eintrag bleibt, wird nur markiert. `null` = Quelle ist da (oder Eintrag ohne Quelle). */
  sourceRemovedAt: string | null;
  fileScope: string[];
  modelSuggestion: string | null;
  estimate: string | null;
  worktreePath: string | null;
  gitBranch: string | null;
  tmuxName: string | null;
  startedSessionKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntryDetail {
  entry: Entry;
  subtasks: Subtask[];
  links: EntryLink[];
  events: EntryEvent[];
  docs: { path: string; updatedAt: string }[];
}

// ---------------------------------------------------------------------------
// MCP-/API-Eingaben (zod, damit Server und MCP-Anschluss dieselbe Prüfung teilen)
// ---------------------------------------------------------------------------

export const CreateEntrySchema = z.object({
  kind: z.enum(["bug", "idee", "frage", "problem"]), // eintrag_anlegen nur für diese vier Arten
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  priority: z.enum(ENTRY_PRIORITIES).optional(),
  baustelleSlug: z.string().optional(),
  baustelleLabel: z.string().optional(),
  fileScope: z.array(z.string()).optional(),
  subtasks: z.array(z.string().min(1)).optional(),
});
export type CreateEntryInput = z.infer<typeof CreateEntrySchema>;

export const ReportProgressSchema = z.object({
  entryId: z.number().int().positive(),
  note: z.string().min(1).max(2000),
});

export const CompleteSubtaskSchema = z.object({
  entryId: z.number().int().positive(),
  subtaskId: z.number().int().positive().optional(),
  subtaskTitle: z.string().min(1).optional(),
});

export const AskQuestionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  blocksEntryId: z.number().int().positive().optional(),
});

export const LinkEntrySchema = z.object({
  fromType: z.enum(LINK_OBJECT_TYPES),
  fromId: z.string().min(1),
  toType: z.enum(LINK_OBJECT_TYPES),
  toId: z.string().min(1),
  relation: z.string().min(1).max(60),
});

export const SearchEntriesSchema = z.object({
  q: z.string().max(200).optional(),
  kind: EntryKindSchema.optional(),
  stage: EntryStageSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Import-Quellen, die die Brücke schickt (GOAL.md-Aufträge, Audit-Maßnahmenplan)
// ---------------------------------------------------------------------------

/** Repo-relative Ordner (ab dem Projekt-Ordner), in denen GOAL.md-Aufträge gesucht werden. `"."` =
 * der ganze Projekt-Ordner. Arbeitskopien (`.worktrees/**`) und Abhängigkeiten zählen nie mit (s.
 * `ENTRY_SOURCE_SKIP_DIRS`) — sonst zählt derselbe Auftrag mehrfach. */
export const ENTRY_SOURCE_GOAL_DIRS = ["."] as const;
/** Audit-Befunde: jede `MASSNAHMENPLAN.md` unter diesem Ordner (`"."` = ganzer Projekt-Ordner). */
export const ENTRY_SOURCE_AUDIT_DIR = ".";
export const ENTRY_SOURCE_AUDIT_FILE = "MASSNAHMENPLAN.md";
/** Ein `BERICHT.md` direkt neben einer `GOAL.md` heißt „Auftrag abgeschlossen“. Die Brücke
 * schickt ihn mit, der Import setzt den Auftrag darauf einmalig auf „Erledigt“ (s. `entries/import.ts`). */
export const ENTRY_SOURCE_REPORT_FILE = "BERICHT.md";
export const ENTRY_SOURCES_MAX_FILES = 2000;
/** Obergrenze je Datei (Zeichen). Größere Dateien schickt die Brücke nicht (Fehler statt Kürzen). */
export const ENTRY_SOURCE_MAX_CHARS = 2_000_000;

/** Ordner, die beim Suchen nach Quelldateien nie betreten werden (Brücke und Server). */
export const ENTRY_SOURCE_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".build",
  "DerivedData",
  ".claude",
  ".obsidian",
  ".trash",
  WORKTREE_DIR,
]);

const underDir = (rel: string, dir: string) => dir === "." || rel.startsWith(`${dir}/`);

/** Welche Art Import-Quelle ist dieser repo-relative Pfad? `null` = keine (wird abgelehnt/übersprungen).
 * Eine Stelle für Brücke (was wird geschickt) und Server (was wird angenommen). */
export function entrySourceKind(rel: string): "goal" | "audit" | "report" | null {
  if (!rel || rel.startsWith("/") || rel.includes("\\")) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || ENTRY_SOURCE_SKIP_DIRS.has(p))) return null;
  const name = parts[parts.length - 1];
  if (name === "GOAL.md" && ENTRY_SOURCE_GOAL_DIRS.some((d) => underDir(rel, d))) return "goal";
  if (name === ENTRY_SOURCE_AUDIT_FILE && underDir(rel, ENTRY_SOURCE_AUDIT_DIR)) return "audit";
  if (name === ENTRY_SOURCE_REPORT_FILE && ENTRY_SOURCE_GOAL_DIRS.some((d) => underDir(rel, d))) return "report";
  return null;
}

export const EntrySourceFileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(ENTRY_SOURCE_MAX_CHARS),
});

/** `POST /ingest/entry-sources` (Maschinen-Token). Immer die VOLLE Liste der Quelldateien. `complete`
 * nur, wenn die Brücke alle Ordner ohne Lesefehler durchsucht hat — nur dann darf der Server
 * fehlende Dateien als „Quelle entfernt“ markieren. */
export const EntrySourcesIngestSchema = z.object({
  complete: z.boolean(),
  scannedAt: z.iso.datetime({ offset: true }),
  files: z.array(EntrySourceFileSchema).max(ENTRY_SOURCES_MAX_FILES),
  errors: z.array(z.string().max(300)).max(50).default([]),
});
export type EntrySourcesIngest = z.infer<typeof EntrySourcesIngestSchema>;

/** Zustand einer Import-Quelle für die Oberfläche (`GET /api/entries/import/status`).
 * - `ok`: importiert · `leer`: Quelle erreichbar, aber nichts drin · `wartet`: noch nie geliefert
 * - `kein_zugang`: Leserecht fehlt · `aus`: hier nicht angebunden · `fehler`: letzter Lauf ging schief */
export type EntryImportState = "ok" | "leer" | "wartet" | "kein_zugang" | "aus" | "fehler";

export interface EntryImportSourceStatus {
  state: EntryImportState;
  /** Einfacher deutscher Satz (keine Technik-Meldung), z. B. „Die Brücke hat die Dateien noch nicht geschickt.“ */
  message: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  /** Nur `dateien`: wann die Brücke zuletzt geliefert hat. */
  lastDeliveryAt: string | null;
  counts: Record<string, number>;
}

export interface EntryImportStatus {
  dateien: EntryImportSourceStatus;
}
