// Nimmt Nutzungszeilen der Brücke entgegen (`POST /ingest/usage`, s. routes/usage.ts), berechnet
// die Kosten mit den aktuell gültigen Preisen und verdichtet `usage_daily` neu.
import { createHash } from "node:crypto";
import { USAGE_OTHER_PROJECT, type UsageIngestRow, localDayOf, timeZone } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { usageDaily, usageEvents } from "../db/schema.js";
import { computeCostForModel, loadLatestPrices } from "./pricing.js";

/**
 * Deterministisch gebildet — ein erneuter Scan derselben Datei erzeugt dieselbe ID,
 * `onConflictDoNothing` verhindert Doppelzählung.
 *
 * **Bevorzugt `sourceId`** (Claude: `message.id`, global eindeutig), wenn vorhanden — Fund
 * NUTZUNG-BEFUND.md "Sub-Agent-Duplikate": ein Claude-Code-Subagent (Task-Tool) wiederholt die
 * geerbte Eltern-Antwort samt `usage` in seinem EIGENEN Verlauf, aber mit der Aufruf-Zeit des
 * Subagenten statt der ursprünglichen Antwort-Zeit — ein Schlüssel aus `(ts, Zahlen)` dedupliziert
 * das NICHT (verschiedene `ts` bei identischem Inhalt), zählte dieselbe Antwort also einmal je
 * Subagent zusätzlich. `message.id` ist dagegen für die ganze Session stabil, unabhängig davon,
 * in welcher Datei/mit welcher Zeit sie auftaucht. Ohne `sourceId` (Codex, OTel) bleibt der alte
 * Schlüssel aus Inhalt+Zeit (Codex hat kein vergleichbares Feld je Ereignis).
 */
export function usageEventId(row: UsageIngestRow): string {
  const h = createHash("sha256");
  if (row.sourceId) {
    h.update([row.tool, "src", row.sourceId].join("|"));
  } else {
    h.update([row.tool, row.sessionKey ?? "-", row.ts, row.model ?? "-", row.input, row.output, row.cacheRead, row.cacheCreation5m, row.cacheCreation1h].join("|"));
  }
  return `ue:${h.digest("hex").slice(0, 32)}`;
}

// Kalendertag in der Zeitzone des Nutzers (`timeZone()`), NICHT UTC: ccusage (die Vorlage für den
// Abgleich, s. NOTICE) bucketet sichtbar nach Ortszeit — Tage direkt nach Mitternacht Ortszeit (aber
// noch VOR Mitternacht UTC) würden sonst dem FALSCHEN Tag zugeschlagen. Die Zone kommt aus den
// Einstellungen statt aus dem Prozess: ein Server läuft oft in UTC, das Ergebnis muss trotzdem gleich
// sein wie lokal auf dem Rechner.
function dayOf(ts: string): string {
  return localDayOf(new Date(ts));
}

/** Wie `search.ts` `rowsOf`: postgres-js liefert die Zeilen direkt, PGlite (Tests) in `{ rows }`. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

export interface IngestUsageResult {
  accepted: number;
  duplicates: number;
}

export async function ingestUsage(db: Db, items: UsageIngestRow[]): Promise<IngestUsageResult> {
  if (items.length === 0) return { accepted: 0, duplicates: 0 };
  const prices = await loadLatestPrices(db);
  // Nie `model: null` speichern: Postgres behandelt NULL in einem UNIQUE-Index als paarweise
  // verschieden, `usage_daily` könnte sonst mehrere Zeilen für "Modell unbekannt" am selben Tag
  // anlegen statt sie zusammenzuführen (`onConflictDoUpdate` unten geht von genau einer Zeile aus).
  const rows = items.map((row) => ({
    id: usageEventId(row),
    ts: row.ts,
    tool: row.tool,
    model: row.model ?? "unbekannt",
    project: row.project,
    // Verteidigung in der Tiefe: selbst bei einem falschen/böswilligen Absender darf
    // nie ein `sessionKey` zu einem fremden Projekt gespeichert werden — nur erfasste Projekte
    // (nicht `USAGE_OTHER_PROJECT`) dürfen einen `sessionKey` tragen (s. Schema-Kommentar).
    sessionKey: row.project !== USAGE_OTHER_PROJECT ? row.sessionKey : null,
    inputTokens: row.input,
    outputTokens: row.output,
    cacheReadTokens: row.cacheRead,
    cacheCreation5mTokens: row.cacheCreation5m,
    cacheCreation1hTokens: row.cacheCreation1h,
    reasoningTokens: row.reasoning,
    cost: computeCostForModel(prices, row.model, {
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheCreation5m: row.cacheCreation5m,
      cacheCreation1h: row.cacheCreation1h,
    }),
  }));

  const buckets = new Set<string>();
  for (const r of rows) buckets.add(`${dayOf(r.ts)}|${r.tool}|${r.model}|${r.project}`);

  return db.transaction(async (tx) => {
    let accepted = 0;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const inserted = await tx.insert(usageEvents).values(rows.slice(i, i + CHUNK)).onConflictDoNothing().returning({ id: usageEvents.id });
      accepted += inserted.length;
    }
    for (const bucket of buckets) {
      const [day, tool, model, project] = bucket.split("|") as [string, string, string, string];
      await rollupBucket(tx, day, tool, model, project);
    }
    return { accepted, duplicates: rows.length - accepted };
  });
}

/** Nach einer Preis-Änderung (`PATCH /api/usage/prices/:id`): rechnet Kosten für ALLE
 * `usage_events` dieses Modells mit dem neuen Preis neu und verdichtet `usage_daily` danach neu —
 * sonst zeigt die Nutzung nach einer Preis-Korrektur weiter die alten Kosten. */
export async function recomputeModelCost(db: Db, model: string): Promise<number> {
  const prices = await loadLatestPrices(db);
  const priceRow = prices.get(model);
  // `::double precision`: ohne den Cast leitet Postgres den Parametertyp aus der (bigint-)Spalte ab
  // und verlangt dann fälschlich einen bigint-Parameter für den (Fließkomma-)Preis.
  const costExpr = priceRow
    ? sql`input_tokens::double precision * ${priceRow.inputPerToken} + output_tokens::double precision * ${priceRow.outputPerToken} + cache_read_tokens::double precision * ${priceRow.cacheReadPerToken} + cache_creation_5m_tokens::double precision * ${priceRow.cacheCreation5mPerToken} + cache_creation_1h_tokens::double precision * ${priceRow.cacheCreation1hPerToken ?? priceRow.cacheCreation5mPerToken}`
    : sql`null`;
  await db.execute(sql`update usage_events set cost = ${costExpr} where model = ${model}`);
  const buckets = rowsOf<{ day: string; tool: string; project: string }>(
    await db.execute(sql`select distinct to_char(ts at time zone ${timeZone()}, 'YYYY-MM-DD') as day, tool, project from usage_events where model = ${model}`),
  );
  for (const b of buckets) await rollupBucket(db, b.day, b.tool, model, b.project);
  return buckets.length;
}

/** Rechnet EINE (Tag, Werkzeug, Modell, Projekt)-Gruppe komplett aus `usage_events` neu — robust
 * gegen Wiederholungen/Nachimporte (nie ein additives "+=", das bei erneutem Scan doppelt zählen würde). */
async function rollupBucket(tx: Db, day: string, tool: string, model: string, project: string): Promise<void> {
  interface AggRow {
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    cache_creation_5m_tokens: string;
    cache_creation_1h_tokens: string;
    reasoning_tokens: string;
    cost: string | null;
    n: string;
  }
  const result = await tx.execute(sql`
    select
      coalesce(sum(input_tokens), 0) as input_tokens,
      coalesce(sum(output_tokens), 0) as output_tokens,
      coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
      coalesce(sum(cache_creation_5m_tokens), 0) as cache_creation_5m_tokens,
      coalesce(sum(cache_creation_1h_tokens), 0) as cache_creation_1h_tokens,
      coalesce(sum(reasoning_tokens), 0) as reasoning_tokens,
      case when count(*) filter (where cost is null) > 0 then null else sum(cost) end as cost,
      count(*) as n
    from usage_events
    where to_char(ts at time zone ${timeZone()}, 'YYYY-MM-DD') = ${day} and tool = ${tool} and project = ${project} and model = ${model}
  `);
  const [agg] = rowsOf<AggRow>(result);
  if (!agg || Number(agg.n) === 0) return;
  const inputTokens = Number(agg.input_tokens);
  const outputTokens = Number(agg.output_tokens);
  const cacheReadTokens = Number(agg.cache_read_tokens);
  const cacheCreation5mTokens = Number(agg.cache_creation_5m_tokens);
  const cacheCreation1hTokens = Number(agg.cache_creation_1h_tokens);
  const reasoningTokens = Number(agg.reasoning_tokens);
  const cost = agg.cost === null ? null : Number(agg.cost);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreation5mTokens + cacheCreation1hTokens;
  await tx
    .insert(usageDaily)
    .values({ day, tool, model, project, inputTokens, outputTokens, cacheReadTokens, cacheCreation5mTokens, cacheCreation1hTokens, reasoningTokens, totalTokens, cost, updatedAt: sql`now()` as unknown as string })
    .onConflictDoUpdate({
      target: [usageDaily.day, usageDaily.tool, usageDaily.model, usageDaily.project],
      set: { inputTokens, outputTokens, cacheReadTokens, cacheCreation5mTokens, cacheCreation1hTokens, reasoningTokens, totalTokens, cost, updatedAt: sql`now()` },
    });
}
