// Lese-Seite der Nutzung (Tab "Nutzung"): Verlauf pro Tag, Modelle, teuerste Sessions, Limits.
import { computeContextPct, resolveContextWindow, t } from "@nyxos/shared";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, usageDaily } from "../db/schema.js";
import { addDays, localDay } from "./periods.js";
import { computeCostForModel, loadLatestPrices } from "./pricing.js";
import { visibleSession } from "../db/visible.js";

export type Range = "7" | "30" | "all";

/** Erster Tag (Zeitzone des Nutzers) des Zeitraums: „7 Tage" = heute + 6 Tage davor (wie der Verlauf im Tab).
 * `usage_daily.day` ist der Tag in der Zeitzone des Nutzers (s. `dayOf()` in ingest.ts) — vorher UTC und 8 statt 7 Tage. */
function sinceDay(range: Range, now = new Date()): string | null {
  if (range === "all") return null;
  return addDays(localDay(now), -((range === "7" ? 7 : 30) - 1));
}

export interface DailyUsagePoint {
  day: string;
  tool: string;
  model: string;
  project: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number | null;
}

export async function getDailyUsage(db: Db, range: Range, tool?: "claude" | "codex"): Promise<DailyUsagePoint[]> {
  const since = sinceDay(range);
  const conds = [since ? gte(usageDaily.day, since) : undefined, tool ? eq(usageDaily.tool, tool) : undefined].filter(Boolean);
  const rows = await db
    .select()
    .from(usageDaily)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(usageDaily.day);
  return rows.map((r) => ({
    day: r.day,
    tool: r.tool,
    model: r.model ?? "unbekannt",
    project: r.project,
    totalTokens: r.totalTokens,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreation5mTokens + r.cacheCreation1hTokens,
    cost: r.cost,
  }));
}

export interface ModelUsage {
  model: string;
  tool: string;
  totalTokens: number;
  cost: number | null;
}

export async function getModelUsage(db: Db, range: Range): Promise<ModelUsage[]> {
  const since = sinceDay(range);
  const rows = await db
    .select({
      model: usageDaily.model,
      tool: usageDaily.tool,
      totalTokens: sql<number>`sum(${usageDaily.totalTokens})`,
      cost: sql<number | null>`case when count(*) filter (where ${usageDaily.cost} is null) > 0 then null else sum(${usageDaily.cost}) end`,
    })
    .from(usageDaily)
    .where(since ? gte(usageDaily.day, since) : undefined)
    .groupBy(usageDaily.model, usageDaily.tool)
    .orderBy(desc(sql`sum(${usageDaily.totalTokens})`));
  return rows.map((r) => ({ model: r.model ?? "unbekannt", tool: r.tool, totalTokens: Number(r.totalTokens), cost: r.cost === null ? null : Number(r.cost) }));
}

export interface ExpensiveSession {
  id: string;
  tool: string;
  title: string | null;
  model: string | null;
  totalTokens: number;
  cost: number | null;
}

/** Teuerste Sessions (Nutzung-Tab) — Kosten aus den aktuellen Preisen und dem
 * Session-Gesamtwert `sessions.tokens` (nicht `usage_events`: das deckt nur Sessions ab, die schon
 * durch den Bestand-Scan liefen, `sessions.tokens` ist von Anfang an aus dem normalen Ingest da). */
export async function getExpensiveSessions(db: Db, limit = 10): Promise<ExpensiveSession[]> {
  const prices = await loadLatestPrices(db);
  const rows = await db
    .select({ id: sessions.id, tool: sessions.tool, title: sessions.title, models: sessions.models, tokens: sessions.tokens, tokensTotal: sessions.tokensTotal })
    .from(sessions)
    .where(and(sql`${sessions.tokensTotal} > 0`, visibleSession))
    .orderBy(desc(sessions.tokensTotal))
    .limit(limit * 3); // grob vorfiltern, dann nach echten Kosten sortieren (mehr als `limit`, falls Modelle keinen Preis haben)
  const withCost = rows.map((r) => {
    const model = r.models[0] ?? null;
    const t = r.tokens as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number };
    const cost = model
      ? computeCostForModel(prices, model, { input: t.input ?? 0, output: t.output ?? 0, cacheRead: t.cacheRead ?? 0, cacheCreation5m: t.cacheCreation ?? 0, cacheCreation1h: 0 })
      : null;
    return { id: r.id, tool: r.tool, title: r.title, model, totalTokens: r.tokensTotal, cost };
  });
  withCost.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.totalTokens - a.totalTokens);
  return withCost.slice(0, limit);
}

export interface LimitStatus {
  tool: "claude" | "codex";
  source: string | null;
  data: unknown;
}

/** Limits "ehrlich" (GOAL): nur zeigen, was direkt aus einem Verlauf gemessen ist.
 * Claude: `quotaLimits` steht nur auf der Zeile, die einen 429 "Session-Limit" meldet (kein
 * Dauer-Prozentwert) — Quelle klar benannt, sonst `data: null` ("keine Quelle"). Codex: `token_count
 * .rate_limits` ist ein laufender Gauge (Prozent + Fenster), aus der jüngsten Session. */
export async function getLimits(db: Db): Promise<LimitStatus[]> {
  const [claude] = await db
    .select({ limits: sessions.limits, lastActivityAt: sessions.lastActivityAt })
    .from(sessions)
    .where(and(eq(sessions.tool, "claude"), sql`${sessions.limits} is not null`))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(1);
  const [codex] = await db
    .select({ limits: sessions.limits, lastActivityAt: sessions.lastActivityAt })
    .from(sessions)
    .where(and(eq(sessions.tool, "codex"), sql`${sessions.limits} is not null`))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(1);
  return [
    { tool: "claude", source: claude ? t("Claude-Verlauf: `quotaLimits` bei zuletzt erreichtem Limit (kein Dauer-Messwert)") : null, data: claude?.limits ?? null },
    { tool: "codex", source: codex ? t("Codex-Verlauf: `token_count.rate_limits` (laufender Stand je Session)") : null, data: codex?.limits ?? null },
  ];
}

export interface SessionContext {
  contextPct: number | null;
  contextWindow: number | null;
  contextWindowSource: string | null;
}

/** Kontext-Anteil aus `sessions.lastUsage`/`lastUsageModel`/`modelContextWindow` (von den
 * Parsern gefüllt, s. `packages/shared/src/parse/{claude,codex}.ts`). `null` = Modell/Kontextfenster
 * unbekannt — nie schätzen. */
export function sessionContext(row: { lastUsage: { input: number; output: number; cacheRead: number; cacheCreation: number } | null; lastUsageModel: string | null; modelContextWindow: number | null }): SessionContext {
  const { window, source } = resolveContextWindow(row.lastUsageModel, row.modelContextWindow);
  const contextPct = computeContextPct(row.lastUsage, row.lastUsageModel, row.modelContextWindow);
  return { contextPct, contextWindow: window, contextWindowSource: source };
}
