// Schemas für `GET /api/search` (fester API-Vertrag). Das eigentliche Suchen
// (Postgres-Volltext, Ranking, Snippet) steht serverseitig in apps/server/src/search.ts.
import { z } from "zod";
import { ToolSchema } from "./events.js";
import { lazyRecord } from "./lazy-text.js";

/** In welchem Feld der Treffer sitzt — bestimmt zugleich die Rang-Reihenfolge (Titel > Prompt > Datei > Chat). */
export const SearchFieldSchema = z.enum(["title", "prompt", "file", "chat"]);
export type SearchField = z.infer<typeof SearchFieldSchema>;

export const SearchBaustelleSchema = z.object({ slug: z.string(), label: z.string() });

export const SearchHitSchema = z.object({
  sessionKey: z.string(),
  sessionId: z.string(),
  tool: ToolSchema,
  title: z.string().nullable(),
  art: z.string(),
  baustelle: SearchBaustelleSchema.nullable(),
  state: z.string().nullable(),
  closed: z.boolean(),
  field: SearchFieldSchema,
  /** HTML-Snippet mit `<mark>…</mark>` um den Treffer; der restliche Text ist escaped. */
  snippet: z.string(),
  /** Index des Eintrags im Chat-Verlauf (wie `transcript.ts` zählt) — nur bei `field = "chat"`. */
  position: z.number().int().nonnegative().nullable(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = z.object({
  hits: z.array(SearchHitSchema),
  tookMs: z.number().nonnegative(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

// ---------------------------------------------------------------------------------------------
// `GET /api/search/all?q=` — ⌘K sucht alles (Sessions, Ideen, Aufträge, Audits, Skills,
// Nyx-Gedächtnis, Agenten). Tabs/Einstellungen sucht die Palette selbst (die Liste lebt im Web).
// ---------------------------------------------------------------------------------------------

/** Reihenfolge = Reihenfolge der Gruppen in der Antwort und in ⌘K. */
export const SEARCH_ALL_KINDS = ["session", "idee", "auftrag", "audit", "skill", "gedaechtnis", "agent"] as const;
export const SearchAllKindSchema = z.enum(SEARCH_ALL_KINDS);
export type SearchAllKind = z.infer<typeof SearchAllKindSchema>;

/** Überschrift je Gruppe (deutsch, für ⌘K). */
export const SEARCH_ALL_LABEL: Record<SearchAllKind, string> = lazyRecord({
  session: "Sessions",
  idee: "Ideen",
  auftrag: "Aufträge & Aufgaben",
  audit: "Audits",
  skill: "Skills",
  gedaechtnis: "Nyx-Gedächtnis",
  agent: "Agenten",
});

export const SearchAllHitSchema = z.object({
  kind: SearchAllKindSchema,
  title: z.string(),
  /** Reiner Text (kein HTML) — die Oberfläche hebt den Suchbegriff selbst hervor. */
  snippet: z.string(),
  /** Ziel in der App (Detailseite bzw. Großansicht). */
  path: z.string(),
});
export type SearchAllHit = z.infer<typeof SearchAllHitSchema>;

export const SearchAllGroupSchema = z.object({ kind: SearchAllKindSchema, label: z.string(), hits: z.array(SearchAllHitSchema) });
export type SearchAllGroup = z.infer<typeof SearchAllGroupSchema>;

export const SearchAllResponseSchema = z.object({
  q: z.string(),
  /** Nur Gruppen mit Treffern, in der Reihenfolge von {@link SEARCH_ALL_KINDS}. */
  groups: z.array(SearchAllGroupSchema),
  tookMs: z.number().nonnegative(),
});
export type SearchAllResponse = z.infer<typeof SearchAllResponseSchema>;

/** Höchstens so viele Treffer je Gruppe. */
export const SEARCH_ALL_PER_KIND = 5;
/** Längere Eingaben lehnt der Server mit 400 ab. */
export const SEARCH_ALL_MAX_QUERY_LENGTH = 200;
