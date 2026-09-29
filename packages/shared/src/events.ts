import { z } from "zod";
import { t } from "./i18n/index.js";
import { TerminalInfoSchema } from "./terminal.js";

/** Werkzeug, aus dem eine Session stammt. */
export const ToolSchema = z.enum(["claude", "codex"]);
export type Tool = z.infer<typeof ToolSchema>;

/** Normalisierte Art eines Events, unabhängig vom Werkzeug. */
export const EventKindSchema = z.enum([
  "session_meta",
  "prompt",
  "assistant",
  "thinking",
  "tool_call",
  "tool_result",
  "subagent",
  "system",
  "attachment",
  "compaction",
  "turn_start",
  "turn_end",
  "turn_aborted",
  "hook",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

const isoDate = z.iso.datetime({ offset: true });

/**
 * Ein einzelnes Ereignis einer Session. Die `id` ist deterministisch
 * (aus Zeilen-UUID, Item-ID oder Byte-Position abgeleitet), damit ein
 * erneutes Senden nie doppelte Einträge erzeugt.
 */
export const SessionEventSchema = z.object({
  id: z.string().min(1).max(200),
  tool: ToolSchema,
  sessionId: z.string().min(1).max(100),
  ts: isoDate,
  kind: EventKindSchema,
  source: z.enum(["file", "hook"]),
  data: z.record(z.string(), z.unknown()),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const TokenTotalsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type TokenTotals = z.infer<typeof TokenTotalsSchema>;

export const SubagentInfoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  type: z.string().nullable(),
});
export type SubagentInfo = z.infer<typeof SubagentInfoSchema>;

/** Tokens der letzten Antwort (Grundlage für `contextPct` — Input + Cache-Lesen +
 * Cache-Schreiben dieser einen Antwort, nicht die Summe der Session). */
export const LastUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
});
export type LastUsage = z.infer<typeof LastUsageSchema>;

/** Verdichteter Zustand einer Session, berechnet aus ihrer Verlaufsdatei. */
export const SessionSummarySchema = z.object({
  tool: ToolSchema,
  sessionId: z.string().min(1).max(100),
  parentSessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  title: z.string().nullable(),
  titleSource: z.enum(["custom", "ai", "summary", "index", "command", "prompt"]).nullable(),
  startedAt: isoDate.nullable(),
  lastActivityAt: isoDate.nullable(),
  models: z.array(z.string()),
  tokens: TokenTotalsSchema,
  toolCalls: z.record(z.string(), z.number().int().nonnegative()),
  filesWritten: z.array(z.string()),
  filesRead: z.array(z.string()),
  subagents: z.array(SubagentInfoSchema),
  gitBranch: z.string().nullable(),
  cliVersion: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
  parseErrors: z.number().int().nonnegative(),
  limits: z.unknown().nullable(),
  /** Tokens der letzten Antwort (für `contextPct`), das Modell dieser Antwort und — nur
   * Codex — das von der Session selbst gemeldete Kontextfenster (`token_count.model_context_window`).
   * `null`, solange keine Antwort mit Nutzung gesehen wurde. Additiv mit `.default(null)`, damit
   * ältere/fremde Sender (und bestehende Test-Fixtures) ohne diese Felder gültig bleiben. */
  lastUsage: LastUsageSchema.nullable().default(null),
  lastUsageModel: z.string().nullable().default(null),
  modelContextWindow: z.number().int().positive().nullable().default(null),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** Lebenszeichen einer Session: läuft sie gerade? */
export const SessionStateSchema = z.object({
  tool: ToolSchema,
  sessionId: z.string().min(1).max(100),
  running: z.boolean(),
  observedAt: isoDate,
});
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * Ein Eintrag der Sende-Warteschlange der Brücke. Alle Arten laufen
 * durch denselben Puffer, damit offline nichts verloren geht.
 */
export const IngestItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: SessionEventSchema }),
  z.object({ type: z.literal("summary"), summary: SessionSummarySchema }),
  z.object({ type: z.literal("state"), state: SessionStateSchema }),
  // tmux-Zuordnung + „kann angehängt werden" + Bildschirm-Signal „wartet".
  z.object({ type: z.literal("terminal"), terminal: TerminalInfoSchema }),
]);
export type IngestItem = z.infer<typeof IngestItemSchema>;

export const IngestBatchSchema = z.object({
  items: z.array(IngestItemSchema).min(1).max(1000),
});
export type IngestBatch = z.infer<typeof IngestBatchSchema>;

export const IngestResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});
export type IngestResult = z.infer<typeof IngestResultSchema>;

/** Kopfzeilen für den Archiv-Upload (Body = gzip der Rohdatei). */
export const ARCHIVE_HEADERS = {
  tool: "x-nyxos-tool",
  sessionId: "x-nyxos-session",
  path: "x-nyxos-path",
  sha256: "x-nyxos-sha256",
  size: "x-nyxos-size",
} as const;

export const ArchiveMetaSchema = z.object({
  tool: ToolSchema,
  sessionId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  /** Pfad relativ zum Werkzeug-Stammordner, z. B. `-Users-alex-projects-demo/<id>.jsonl`. */
  path: z
    .string()
    .min(1)
    .max(500)
    .refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === ""), {
      error: () => t("Pfad muss relativ und ohne '..' sein"),
    }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.coerce.number().int().nonnegative(),
});
export type ArchiveMeta = z.infer<typeof ArchiveMetaSchema>;
