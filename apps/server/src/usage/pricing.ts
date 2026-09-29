// Preistabelle: Ausgangswerte aus `packages/shared/src/usage.ts` `BUILTIN_MODEL_PRICES`,
// danach editierbar über `prices` (Feld `validFrom`+`source`), s. `routes/usage.ts` PATCH.
import { BUILTIN_MODEL_PRICES, computeCost as computeCostShared, type UsageTokens } from "@nyxos/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { prices } from "../db/schema.js";

export type PriceRow = typeof prices.$inferSelect;

/** Legt die eingebauten Preise an, wenn `prices` noch leer ist (erster Start nach der Migration).
 * `onConflictDoNothing` auf `(model, valid_from)`: mehrere gleichzeitige Aufrufer (der Start in
 * `app.ts` UND ein früher Lese-Zugriff, s. `loadLatestPrices`/`GET /api/usage/prices`) dürfen sich
 * nie gegenseitig mit einem doppelten-Schlüssel-Fehler zu Fall bringen — der Leer-Check bleibt nur
 * als schneller Ausstieg im Normalfall. */
export async function seedPrices(db: Db): Promise<void> {
  const existing = await db.select({ id: prices.id }).from(prices).limit(1);
  if (existing.length > 0) return;
  await db
    .insert(prices)
    .values(
      BUILTIN_MODEL_PRICES.map((p) => ({
        model: p.model,
        inputPerToken: p.inputPerToken,
        outputPerToken: p.outputPerToken,
        cacheReadPerToken: p.cacheReadPerToken,
        cacheCreation5mPerToken: p.cacheCreation5mPerToken,
        cacheCreation1hPerToken: p.cacheCreation1hPerToken,
        contextWindow: p.contextWindow,
        validFrom: p.validFrom,
        source: p.source,
      })),
    )
    .onConflictDoNothing();
}

/** Je Modell die zuletzt gültige Preiszeile (`validFrom` absteigend, erste Zeile). Lädt einmal alle
 * Preise (kleine Tabelle) und cacht In-Memory-nichts — `store`/Rollup ruft das je Ingest-Batch auf,
 * das ist für die erwartete Datenmenge (wenige Modelle) unkritisch. Sät die eingebauten Preise
 * selbst nach, falls die Tabelle noch leer ist — `seedPrices` in `app.ts` läuft absichtlich
 * unabhängig vom ersten Ingest (kein Bootstrap-Wettlauf: sonst könnte die allererste Nutzungszeile
 * nach einem Neustart ohne Preis ankommen). */
export async function loadLatestPrices(db: Db): Promise<Map<string, PriceRow>> {
  let rows = await db.select().from(prices).orderBy(asc(prices.validFrom));
  if (rows.length === 0) {
    await seedPrices(db);
    rows = await db.select().from(prices).orderBy(asc(prices.validFrom));
  }
  const byModel = new Map<string, PriceRow>();
  for (const r of rows) byModel.set(r.model, r); // spätere (größere validFrom) überschreiben frühere
  return byModel;
}

export function priceRowToTokenPrice(row: PriceRow | undefined) {
  if (!row) return undefined;
  return {
    inputPerToken: row.inputPerToken,
    outputPerToken: row.outputPerToken,
    cacheReadPerToken: row.cacheReadPerToken,
    cacheCreation5mPerToken: row.cacheCreation5mPerToken,
    cacheCreation1hPerToken: row.cacheCreation1hPerToken,
  };
}

export function computeCostForModel(byModel: Map<string, PriceRow>, model: string | null, tokens: UsageTokens): number | null {
  if (!model) return null;
  return computeCostShared(priceRowToTokenPrice(byModel.get(model)), tokens);
}

export async function updatePrice(db: Db, id: number, patch: Partial<Pick<PriceRow, "inputPerToken" | "outputPerToken" | "cacheReadPerToken" | "cacheCreation5mPerToken" | "cacheCreation1hPerToken" | "contextWindow">>): Promise<PriceRow | null> {
  const [row] = await db.update(prices).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(prices.id, id)).returning();
  return row ?? null;
}
