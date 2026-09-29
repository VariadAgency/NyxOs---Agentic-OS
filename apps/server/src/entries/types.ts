import type { entries } from "../db/schema.js";

/** Roh-Zeile aus `entries` (Drizzle-Select-Typ) — intern zwischen `store.ts`/`maturity.ts`/`import.ts`
 * geteilt, damit sie nicht bei jedem Aufruf neu inline getippt werden muss. */
export type EntryRow = typeof entries.$inferSelect;
