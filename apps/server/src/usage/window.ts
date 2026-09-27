// kleine Lese-Aggregationen für die Diagramme im Tab „Nutzung" und die Überblick-Kachel
// „Max-Fenster". Nur Zahlen aus `usage_events`/`usage_daily`/`sessions.limits`, nie geschätzt:
// - Heatmap Tag × Stunde (Zeitzone des Nutzers, wie `dayOf()` in ingest.ts),
// - Fenster-Stand je Werkzeug: Tokens der letzten 5 Std/7 Tage + eigener Spitzenwert zum Vergleich,
//   plus das, was der Anbieter selbst meldet (Codex: Prozent; Claude: nur „Limit erreicht bis …").
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { addDays, localDay } from "./periods.js";
import { usageReadings, type OfficialUsage, type UsageReadings } from "./official.js";
import { getLimits, type Range } from "./query.js";
import { timeZone } from "@nyxos/shared";

const TOTAL = sql.raw("(input_tokens + output_tokens + cache_read_tokens + cache_creation_5m_tokens + cache_creation_1h_tokens)");
const HOUR_MS = 3_600_000;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function rangeDays(range: Range): number | null {
  return range === "all" ? null : range === "7" ? 7 : 30;
}

export interface HeatCell {
  /** 1 = Montag … 7 = Sonntag (ISO), Zeitzone des Nutzers. */
  dow: number;
  hour: number;
  tokens: number;
}

/** Tokens je Wochentag × Stunde im gewählten Zeitraum (Zeitzone des Nutzers). Nur belegte Zellen. */
export async function getHourlyHeatmap(db: Db, range: Range, tool?: "claude" | "codex", now = new Date()): Promise<HeatCell[]> {
  const days = rangeDays(range);
  const since = days === null ? null : new Date(now.getTime() - days * 24 * HOUR_MS).toISOString();
  const result = await db.execute(sql`
    select extract(isodow from ts at time zone ${timeZone()})::int as dow,
           extract(hour from ts at time zone ${timeZone()})::int as hour,
           sum(${TOTAL})::float8 as tokens
    from usage_events
    where true
      ${since ? sql`and ts >= ${since}::timestamptz` : sql``}
      ${tool ? sql`and tool = ${tool}` : sql``}
    group by 1, 2`);
  return rowsOf<{ dow: number; hour: number; tokens: number }>(result).map((r) => ({ dow: Number(r.dow), hour: Number(r.hour), tokens: Number(r.tokens) }));
}

export interface ToolWindow {
  tool: "claude" | "codex";
  /** Tokens der letzten 5 Stunden (gleitend) bzw. 7 Tage. */
  tokens5h: number;
  tokens7d: number;
  /** Eigener Spitzenwert zum Vergleich: stärkstes 5-Std-Fenster der letzten 7 Tage bzw. stärkste
   * 7-Tage-Summe der letzten 35 Tage (mindestens der aktuelle Wert). */
  peak5h: number;
  peak7d: number;
  /** Tokens je Stunde, die letzten 24 Stunden (älteste zuerst, letzte = laufende Stunde). */
  hourly24: number[];
  /** Was der Anbieter selbst meldet — null, wenn der Verlauf nichts davon enthält. */
  reported: {
    fiveHourPct: number | null;
    weekPct: number | null;
    limitReached: boolean;
    limitType: string | null;
    /** Reset des 5-Std-Fensters (bzw. bei Claude ohne echte Werte: des zuletzt erreichten Limits). */
    resetsAt: string | null;
    /** Reset der Woche, wenn bekannt. */
    weekResetsAt: string | null;
    /** Woher die Prozente kommen: „anthropic“ = OAuth-Nutzung (echt), „codex“ = Codex-Verlauf (echt),
     * „limit_event“ = nur „Limit erreicht bis …“ aus dem Claude-Verlauf, null = nichts gemeldet. */
    source: "anthropic" | "codexbar" | "codex" | "limit_event" | null;
    /** Stand der echten Werte (nur bei „anthropic“/„codexbar“ — CodexBar = dieselben Anthropic-Werte über den Rechner). */
    fetchedAt: string | null;
  };
}

function rollingMax(values: number[], width: number): number {
  let best = 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= width) sum -= values[i - width] ?? 0;
    if (sum > best) best = sum;
  }
  return best;
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** echte Claude-Werte von Anthropic → dieselbe Form wie die übrigen Anbieter-Meldungen. */
function reportedFromOfficial(u: OfficialUsage): ToolWindow["reported"] {
  const five = u.fiveHour;
  const week = u.sevenDay;
  const full = [five, week].find((w) => w && w.pct >= 100) ?? null;
  return {
    fiveHourPct: five?.pct ?? null,
    weekPct: week?.pct ?? null,
    limitReached: full !== null,
    limitType: full === null ? null : full === five ? "five_hour" : "seven_day",
    resetsAt: five?.resetsAt ?? null,
    weekResetsAt: week?.resetsAt ?? null,
    source: u.source === "codexbar" ? "codexbar" : "anthropic",
    fetchedAt: u.fetchedAt,
  };
}

export function reportedFrom(tool: "claude" | "codex", data: unknown, now: Date): ToolWindow["reported"] {
  const empty: ToolWindow["reported"] = { fiveHourPct: null, weekPct: null, limitReached: false, limitType: null, resetsAt: null, weekResetsAt: null, source: null, fetchedAt: null };
  if (!data || typeof data !== "object") return empty;
  if (tool === "claude") {
    const d = data as { status?: string; resetsAt?: number; rateLimitType?: string };
    const resetsAt = typeof d.resetsAt === "number" ? new Date(d.resetsAt * 1000) : null;
    return {
      ...empty,
      limitReached: d.status === "rejected" && resetsAt !== null && resetsAt.getTime() > now.getTime(),
      limitType: d.rateLimitType ?? null,
      resetsAt: resetsAt ? resetsAt.toISOString() : null,
      source: resetsAt ? "limit_event" : null,
    };
  }
  const d = data as { primary?: CodexWindow | null; secondary?: CodexWindow | null };
  const pct = (w: CodexWindow | null | undefined) => (w && typeof w.used_percent === "number" ? w.used_percent : null);
  // Codex meldet zwei Fenster; das kürzere ist das 5-Std-Fenster, das längere die Woche.
  const windows = [d.primary, d.secondary].filter((w): w is CodexWindow => !!w && typeof w.used_percent === "number");
  windows.sort((a, b) => (a.window_minutes ?? 0) - (b.window_minutes ?? 0));
  const short = windows.find((w) => (w.window_minutes ?? 0) <= 6 * 60) ?? null;
  const long = windows.find((w) => (w.window_minutes ?? 0) > 6 * 60) ?? null;
  const resets = short?.resets_at ?? long?.resets_at;
  const iso = (sec: number | undefined) => (typeof sec === "number" ? new Date(sec * 1000).toISOString() : null);
  return {
    fiveHourPct: pct(short),
    weekPct: pct(long),
    limitReached: windows.some((w) => (w.used_percent ?? 0) >= 100),
    limitType: null,
    resetsAt: iso(resets),
    weekResetsAt: iso(long?.resets_at),
    source: windows.length > 0 ? "codex" : null,
    fetchedAt: null,
  };
}

export async function getUsageWindows(db: Db, now = new Date(), readings: UsageReadings = usageReadings): Promise<ToolWindow[]> {
  const nowIso = now.toISOString();
  const hourStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const HOURS = 7 * 24 + 5;
  const firstHour = new Date(hourStart.getTime() - (HOURS - 1) * HOUR_MS);
  const [sumsRes, hourlyRes, dailyRes, limits] = await Promise.all([
    db.execute(sql`
      select tool,
             coalesce(sum(${TOTAL}) filter (where ts >= ${nowIso}::timestamptz - interval '5 hours'), 0)::float8 as t5h,
             coalesce(sum(${TOTAL}), 0)::float8 as t7d
      from usage_events where ts >= ${nowIso}::timestamptz - interval '7 days' group by tool`),
    db.execute(sql`
      select tool, floor(extract(epoch from ts) / 3600)::float8 as h, sum(${TOTAL})::float8 as tokens
      from usage_events where ts >= ${firstHour.toISOString()}::timestamptz group by 1, 2`),
    db.execute(sql`
      select tool, day, sum(total_tokens)::float8 as tokens from usage_daily
      where day >= ${addDays(localDay(now), -34)} group by 1, 2`),
    getLimits(db),
  ]);
  const sums = rowsOf<{ tool: string; t5h: number; t7d: number }>(sumsRes);
  const hourly = rowsOf<{ tool: string; h: number; tokens: number }>(hourlyRes);
  const daily = rowsOf<{ tool: string; day: string; tokens: number }>(dailyRes);
  const firstHourIdx = firstHour.getTime() / HOUR_MS;
  const official = readings.official(now);

  return (["claude", "codex"] as const).map((tool) => {
    const s = sums.find((r) => r.tool === tool);
    const tokens5h = Number(s?.t5h ?? 0);
    const tokens7d = Number(s?.t7d ?? 0);
    const hours = new Array<number>(HOURS).fill(0);
    for (const r of hourly) {
      if (r.tool !== tool) continue;
      const i = Number(r.h) - firstHourIdx;
      if (i >= 0 && i < HOURS) hours[i] = (hours[i] ?? 0) + Number(r.tokens);
    }
    const days: number[] = [];
    // `usage_daily.day` ist der Tag in der Zeitzone des Nutzers — die Tagesliste darum auch (vorher UTC).
    const today = localDay(now);
    for (let i = 34; i >= 0; i--) {
      const day = addDays(today, -i);
      days.push(daily.filter((r) => r.tool === tool && r.day === day).reduce((a, r) => a + Number(r.tokens), 0));
    }
    return {
      tool,
      tokens5h,
      tokens7d,
      peak5h: Math.max(tokens5h, rollingMax(hours, 5)),
      peak7d: Math.max(tokens7d, rollingMax(days, 7)),
      hourly24: hours.slice(-24),
      reported: official && tool === "claude" ? reportedFromOfficial(official) : reportedFrom(tool, limits.find((l) => l.tool === tool)?.data ?? null, now),
    };
  });
}
