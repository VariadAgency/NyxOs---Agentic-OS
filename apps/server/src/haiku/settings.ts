// Haiku-Einstellungen (eine Zeile, `id = 1`), Tag in Zeitzone des Nutzers, Tagesverbrauch.
import type { HaikuSettings, HaikuSettingsPatch } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { haikuCalls, haikuSettings } from "../db/schema.js";
import { dateTimeFormat, localDayOf, timeZone } from "@nyxos/shared";

/** Tages-Budget (API-Gegenwert, Max-Plan zahlt nicht je Aufruf). Gemessen: ein normaler Tag ≈ 0,3–0,6 USD
 * (Briefing ≈ 0,02, Recap ≈ 0,06, Chat-Frage ≈ 0,01–0,02, Begleitung je Auftrags-Runde ≈ 0,01–0,02). */
export const DEFAULT_DAILY_BUDGET_USD = 1;

/** "YYYY-MM-DD" in Zeitzone des Nutzers. */
export function localDay(d: Date): string {
  return localDayOf(d);
}

/** "HH:MM" in Zeitzone des Nutzers. */
export function localTime(d: Date): string {
  // feste Schreibweise „HH:MM“ (unabhängig von der Sprache), `localHour` liest daraus die Stunde
  return dateTimeFormat({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, "en-GB").format(d);
}

export function localHour(d: Date): number {
  return Number(localTime(d).slice(0, 2));
}

function toSettings(r: typeof haikuSettings.$inferSelect): HaikuSettings {
  return {
    engine: r.engine as HaikuSettings["engine"],
    dailyBudgetUsd: r.dailyBudgetUsd,
    briefingTime: r.briefingTime,
    recapTime: r.recapTime,
    rundgangMinutes: r.rundgangMinutes,
    timeoutSeconds: r.timeoutSeconds,
    ideaLinkBudgetPercent: r.ideaLinkBudgetPercent,
    ideaLinkIdeasPerLinkDay: r.ideaLinkIdeasPerLinkDay,
    ideaLinkIdeasPerDay: r.ideaLinkIdeasPerDay,
  };
}

export async function loadHaikuSettings(db: Db): Promise<HaikuSettings> {
  const [row] = await db.select().from(haikuSettings).where(eq(haikuSettings.id, 1)).limit(1);
  if (row) return toSettings(row);
  await db.insert(haikuSettings).values({ id: 1, dailyBudgetUsd: DEFAULT_DAILY_BUDGET_USD }).onConflictDoNothing();
  const [created] = await db.select().from(haikuSettings).where(eq(haikuSettings.id, 1)).limit(1);
  return toSettings(created as typeof haikuSettings.$inferSelect);
}

export async function patchHaikuSettings(db: Db, patch: HaikuSettingsPatch): Promise<HaikuSettings> {
  await loadHaikuSettings(db);
  await db
    .update(haikuSettings)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(haikuSettings.id, 1));
  return loadHaikuSettings(db);
}

export interface DayUsage {
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Verbrauch je Tag (Zeitzone des Nutzers) (nur echte Läufe, keine Budget-Absagen). */
export async function usageByDay(db: Db, days: number, now = new Date()): Promise<DayUsage[]> {
  const since = new Date(now.getTime() - days * 86400_000).toISOString();
  const res = await db.execute(sql`
    select to_char(${haikuCalls.createdAt} at time zone ${timeZone()}, 'YYYY-MM-DD') as day,
           count(*)::int as calls,
           coalesce(sum(${haikuCalls.inputTokens}), 0)::int as input,
           coalesce(sum(${haikuCalls.outputTokens}), 0)::int as output,
           coalesce(sum(${haikuCalls.costUsd}), 0)::float8 as cost
    from ${haikuCalls}
    where ${haikuCalls.createdAt} >= ${since} and ${haikuCalls.status} not in ('budget', 'queued')
    group by 1 order by 1`);
  return rowsOf(res).map((r) => ({ day: String(r.day), calls: Number(r.calls), inputTokens: Number(r.input), outputTokens: Number(r.output), costUsd: Number(r.cost) }));
}

/** Verbrauch einer Aufruf-Art (z. B. "idealink") am Tag (Zeitzone des Nutzers) `day` – für Teilbudgets. */
export async function usageForKind(db: Db, kind: string, day: string): Promise<number> {
  const res = await db.execute(sql`
    select coalesce(sum(${haikuCalls.costUsd}), 0)::float8 as cost
    from ${haikuCalls}
    where ${haikuCalls.kind} = ${kind}
      and to_char(${haikuCalls.createdAt} at time zone ${timeZone()}, 'YYYY-MM-DD') = ${day}
      and ${haikuCalls.status} not in ('budget', 'queued')`);
  return Number(rowsOf(res)[0]?.cost ?? 0);
}

export async function usageForDay(db: Db, day: string, now = new Date()): Promise<DayUsage> {
  const all = await usageByDay(db, 2, now);
  return all.find((u) => u.day === day) ?? { day, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}
