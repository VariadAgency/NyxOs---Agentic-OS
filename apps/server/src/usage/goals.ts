// Ziele („10 Mrd. Tokens im Monat“) mit Fortschritt und Hochrechnung, dazu der Stand der
// Warnschwellen (Tagesverbrauch, 5-Std-Fenster) für die Anzeige und den Warn-Push (`warnings.ts`).
import type { UsageGoalScope, UsageSettings } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { localDay, localMidnight, comparisonWindows, type PeriodKind } from "./periods.js";
import { getUsageWindows } from "./window.js";
import { timeZone } from "@nyxos/shared";

const DAY_MS = 86_400_000;
const PACE_DAYS = 7;
const TOTAL = sql.raw("(input_tokens + output_tokens + cache_read_tokens + cache_creation_5m_tokens + cache_creation_1h_tokens)");

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export interface GoalProjection {
  target: number;
  soFar: number;
  /** Fortschritt in Prozent (kann über 100 liegen). */
  pct: number;
  /** Tempo: Tokens je Tag im Schnitt der letzten 7 Tage (gleitend, 7 × 24 Std). */
  pacePerDay: number;
  remainingDays: number;
  /** Stand am Ende des Zeitraums, wenn das Tempo so bleibt. */
  projected: number;
  onTrack: boolean;
  /** Tokens je Tag, die ab jetzt nötig wären (0 = schon erreicht, `null` = Zeitraum vorbei). */
  neededPerDay: number | null;
  /** Tag in der Zeitzone des Nutzers, an dem das Ziel beim aktuellen Tempo erreicht ist (`null` = nicht in diesem Zeitraum). */
  reachDay: string | null;
}

/** Reine Hochrechnung: bisher + Tempo × verbleibende Tage. Das Tempo kommt aus den letzten 7 Tagen
 * statt aus dem Monatsschnitt — am Monatsanfang wäre der Monatsschnitt aus 1–2 Tagen sehr zufällig. */
export function projectGoal(input: { target: number; soFar: number; pacePerDay: number; now: Date; periodEnd: Date }): GoalProjection {
  const { target, soFar, pacePerDay, now, periodEnd } = input;
  const remainingDays = Math.max(0, (periodEnd.getTime() - now.getTime()) / DAY_MS);
  const projected = soFar + pacePerDay * remainingDays;
  const reached = soFar >= target;
  let reachDay: string | null = null;
  if (reached) reachDay = localDay(now);
  else if (pacePerDay > 0) {
    const at = now.getTime() + ((target - soFar) / pacePerDay) * DAY_MS;
    if (at < periodEnd.getTime()) reachDay = localDay(new Date(at));
  }
  return {
    target,
    soFar,
    pct: target > 0 ? (soFar / target) * 100 : 0,
    pacePerDay,
    remainingDays,
    projected,
    onTrack: projected >= target,
    neededPerDay: reached ? 0 : remainingDays > 0 ? (target - soFar) / remainingDays : null,
    reachDay,
  };
}

export interface GoalStatus extends GoalProjection {
  kind: PeriodKind;
  fromDay: string;
  lastDay: string;
}

export interface WarningStatus {
  daily: { threshold: number; today: number; over: boolean } | null;
  window: { threshold: number; tools: { tool: "claude" | "codex"; pct: number | null; reported: boolean; over: boolean }[] } | null;
}

export interface GoalsResponse {
  scope: UsageGoalScope;
  week: GoalStatus | null;
  month: GoalStatus | null;
  warnings: WarningStatus;
}

async function sumSince(db: Db, fromIso: string, toIso: string, scope: UsageGoalScope): Promise<number> {
  const result = await db.execute(sql`
    select coalesce(sum(${TOTAL}), 0)::float8 as tokens from usage_events
    where ts >= ${fromIso}::timestamptz and ts < ${toIso}::timestamptz ${scope === "all" ? sql`` : sql`and tool = ${scope}`}`);
  return Number(rowsOf<{ tokens: number }>(result)[0]?.tokens ?? 0);
}

/** Tag in der Zeitzone des Nutzers, an dem die laufende Summe das Ziel erreichte (`projectGoal` kennt nur
 * „jetzt“ und nannte darum immer heute, auch wenn das Ziel vor Tagen fiel). */
async function reachedOn(db: Db, fromIso: string, toIso: string, scope: UsageGoalScope, target: number): Promise<string | null> {
  const result = await db.execute(sql`
    select to_char(ts at time zone ${timeZone()}, 'YYYY-MM-DD') as day, sum(${TOTAL})::float8 as tokens from usage_events
    where ts >= ${fromIso}::timestamptz and ts < ${toIso}::timestamptz ${scope === "all" ? sql`` : sql`and tool = ${scope}`}
    group by 1 order by 1`);
  let sum = 0;
  for (const r of rowsOf<{ day: string; tokens: number }>(result)) {
    sum += Number(r.tokens);
    if (sum >= target) return r.day;
  }
  return null;
}

async function goalFor(db: Db, kind: PeriodKind, target: number | null, scope: UsageGoalScope, now: Date, pacePerDay: number): Promise<GoalStatus | null> {
  if (target === null) return null;
  const w = comparisonWindows(kind, now);
  // Bis „jetzt + 1 ms": ein Ereignis mit genau dem Zeitstempel von jetzt zählt schon mit.
  const fromIso = w.current.start.toISOString();
  const toIso = new Date(now.getTime() + 1).toISOString();
  const soFar = await sumSince(db, fromIso, toIso, scope);
  const projection = projectGoal({ target, soFar, pacePerDay, now, periodEnd: w.currentEnd });
  if (soFar >= target) projection.reachDay = (await reachedOn(db, fromIso, toIso, scope, target)) ?? projection.reachDay;
  return { kind, fromDay: w.current.fromDay, lastDay: w.currentLastDay, ...projection };
}

/** Warnschwellen-Stand: derselbe Fenster-Prozentwert wie der Ring im Tab (Anbieter-Meldung, sonst
 * Anteil am eigenen stärksten 5-Std-Fenster der letzten 7 Tage). */
export async function getWarningStatus(db: Db, settings: UsageSettings, now = new Date()): Promise<WarningStatus> {
  let daily: WarningStatus["daily"] = null;
  if (settings.warnDailyTokens !== null) {
    const today = await sumSince(db, localMidnight(localDay(now)).toISOString(), new Date(now.getTime() + 1).toISOString(), "all");
    daily = { threshold: settings.warnDailyTokens, today, over: today > settings.warnDailyTokens };
  }
  let window: WarningStatus["window"] = null;
  if (settings.warnWindowPct !== null) {
    const threshold = settings.warnWindowPct;
    const windows = await getUsageWindows(db, now);
    window = {
      threshold,
      tools: windows.map((w) => {
        const reportedPct = w.reported.fiveHourPct ?? (w.reported.limitReached ? 100 : null);
        const pct = reportedPct ?? (w.peak5h > 0 ? (w.tokens5h / w.peak5h) * 100 : null);
        return { tool: w.tool, pct, reported: reportedPct !== null, over: pct !== null && pct >= threshold };
      }),
    };
  }
  return { daily, window };
}

export async function getGoalStatus(db: Db, settings: UsageSettings, now = new Date()): Promise<GoalsResponse> {
  const scope = settings.goalScope;
  const needsPace = settings.goalMonthTokens !== null || settings.goalWeekTokens !== null;
  const pacePerDay = needsPace ? (await sumSince(db, new Date(now.getTime() - PACE_DAYS * DAY_MS).toISOString(), new Date(now.getTime() + 1).toISOString(), scope)) / PACE_DAYS : 0;
  const [week, month, warnings] = await Promise.all([
    goalFor(db, "week", settings.goalWeekTokens, scope, now, pacePerDay),
    goalFor(db, "month", settings.goalMonthTokens, scope, now, pacePerDay),
    getWarningStatus(db, settings, now),
  ]);
  return { scope, week, month, warnings };
}
