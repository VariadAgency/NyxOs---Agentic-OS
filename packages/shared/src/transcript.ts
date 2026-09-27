// Schemas für den Chat-Verlauf einer Session (`GET /api/sessions/:id/transcript`).
// Die Web-App importiert nur diese Typen; das eigentliche Lesen des Archivs (streamend,
// mit Cursor-Seiten) steht serverseitig in apps/server/src/transcript.ts.
import { z } from "zod";

/** Rolle eines Verlaufs-Eintrags. Denken (`kind: "thinking"`) wird nie ausgeliefert. */
export const TranscriptRoleSchema = z.enum(["user", "assistant", "tool", "subagent", "system"]);
export type TranscriptRole = z.infer<typeof TranscriptRoleSchema>;

export const TranscriptToolStatusSchema = z.enum(["ok", "error"]);
export type TranscriptToolStatus = z.infer<typeof TranscriptToolStatusSchema>;

/** Werkzeug-Aufruf: Ergebnis (falls zuordenbar) steht als Status am Aufruf, nie als eigener Eintrag. */
export const TranscriptToolSchema = z.object({
  name: z.string(),
  target: z.string().nullable().optional(),
  status: TranscriptToolStatusSchema.optional(),
});
export type TranscriptTool = z.infer<typeof TranscriptToolSchema>;

/** Ein eingeklappter Sub-Agent-Block; sein eigener Verlauf kommt über `?subagent=<id>`. */
export const TranscriptSubagentSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  count: z.number().int().nonnegative(),
});
export type TranscriptSubagent = z.infer<typeof TranscriptSubagentSchema>;

export const TranscriptItemSchema = z.object({
  id: z.string(),
  ts: z.string(),
  role: TranscriptRoleSchema,
  text: z.string().optional(),
  tool: TranscriptToolSchema.optional(),
  subagent: TranscriptSubagentSchema.optional(),
  /**
   * Nur bei `role: "system"` gesetzt: `true` bei reiner Plumbing-Meta
   * (Anhänge wie `total_tokens_reminder`, generische `subtype`/`itemType`/`recordType`-Zeilen wie
   * „stop_hook_summary"/„turn_duration") — die Web-App blendet diese standardmäßig ein-/ausklappbar
   * aus, statt sie zwischen echte Nachrichten zu mischen. `false`/fehlend bei inhaltlichen
   * System-Hinweisen (z. B. „Kontext komprimiert"), die immer sichtbar bleiben.
   */
  internal: z.boolean().optional(),
  /**
   * Bilder, die der Nutzer mit dieser Eingabe geschickt hat (Claude Code: „[Image #n]“). Nur die
   * Kennzahlen — das Bild selbst kommt angemeldet über `/api/sessions/:id/attachments/:itemId/:n`.
   */
  images: z.array(z.object({ n: z.number().int().positive(), mediaType: z.string(), bytes: z.number().int().nonnegative() })).optional(),
  /** Immer `false` — Denken wird herausgefiltert, nie ausgeliefert. */
  thinking: z.literal(false),
});
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

export const TranscriptDirectionSchema = z.enum(["forward", "backward"]);
export type TranscriptDirection = z.infer<typeof TranscriptDirectionSchema>;

export const TRANSCRIPT_DEFAULT_LIMIT = 200;
export const TRANSCRIPT_MAX_LIMIT = 500;

export const TranscriptResponseSchema = z.object({
  items: z.array(TranscriptItemSchema),
  nextCursor: z.string().nullable(),
  prevCursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
  archivedAt: z.string().nullable(),
  sha256: z.string().nullable(),
  /** Nur bei `?around=<position>` (Such-Sprung): Index des gesuchten Eintrags innerhalb von `items`. */
  anchorIndex: z.number().int().nonnegative().optional(),
});
export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;

/** Liste der Sub-Agenten-Dateien einer Session (nur Claude; Codex-Sub-Threads sind eigene Sessions). */
export const TranscriptSubagentRefSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
});
export type TranscriptSubagentRef = z.infer<typeof TranscriptSubagentRefSchema>;
