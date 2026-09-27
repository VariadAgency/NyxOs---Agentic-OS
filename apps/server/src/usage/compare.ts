// Vergleiche für den Tab „Nutzung“ — Woche/Woche und Monat/Monat (fairer Stand, Zeitzone des Nutzers),
// Claude gegen Codex, Modelle im Wochenverlauf und Tokens je Baustelle. Nur echte Zahlen aus
// `usage_events`/`usage_daily` (+ `sessions` für die Baustelle), nie geschätzt.
import { USAGE_OTHER_PROJECT } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { addDays, localDay, localMidnight, comparisonWindows, dayWindows, deltaPct, weekStartOf, type ComparisonWindows, type PeriodKind, type PeriodWindow } from "./periods.js";
import type { Range } from "./query.js";

const TOTAL = sql.raw("(input_tokens + output_tokens + cache_read_tokens + cache_creation_5m_tokens + cache_creation_1h_tokens)");
const TOOLS = ["claude", "codex"] as const;
type Tool = (typeof TOOLS)[number];

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export interface PeriodTotals {
  fromDay: string;
  toDay: string;
  tokens: number;
  byTool: Record<Tool, number>;
}

export interface ToolSide {
  tool: Tool;
  tokens: number;
  previousTokens: number;
  deltaPct: number | null;
  /** API-Gegenwert in USD; `costComplete = false`, wenn für ein genutztes Modell kein Preis hinterlegt ist. */
  cost: number;
  costComplete: boolean;
  activeDays: number;
  /** Anteil am laufenden Zeitraum (0–100). */
  share: number;
  topModel: string | null;
}

export interface PeriodComparison {
  kind: PeriodKind;
  current: PeriodTotals;
  previous: PeriodTotals;
  previousFull: PeriodTotals;
  deltaPct: number | null;
  /** Tag für Tag: Platz i = i-ter Tag des Zeitraums. `null` = Tag liegt in der Zukunft bzw. gibt es im
   * (kürzeren) Vormonat nicht — nie als 0 zeichnen. */
  series: {
    currentDays: (string | null)[];
    previousDays: (string | null)[];
    current: (number | null)[];
    previous: (number | null)[];
  };
  tools: ToolSide[];
  totalDays: number;
}

export interface UsageComparison {
  now: string;
  /** heute bis jetzt ggü. gestern bis zur gleichen Uhrzeit (Kachel „Heute“ und Überblick „Tokens heute“). */
  day: DayComparison;
  week: PeriodComparison;
  month: PeriodComparison;
}

/** Tagesvergleich zur gleichen Uhrzeit. `comparable = false` vor 06:00 — dann zeigt keine Kachel einen Trend. */
export interface DayComparison {
  today: PeriodTotals;
  previous: PeriodTotals;
  comparable: boolean;
  /** Uhrzeit (Zeitzone des Nutzers), bis zu der verglichen wird, z. B. „14:00“. */
  until: string;
  deltaPct: number | null;
}

interface SumRow {
  tool: string;
  model: string | null;
  [k: string]: unknown;
}

const iso = (d: Date) => d.toISOString();

/** Summen je Werkzeug/Modell für mehrere Fenster in EINER Abfrage (gefilterte Aggregate). */
async function sumWindows(db: Db, windows: Record<string, PeriodWindow>): Promise<SumRow[]> {
  const entries = Object.entries(windows);
  const minStart = Math.min(...entries.map(([, w]) => w.start.getTime()));
  const maxEnd = Math.max(...entries.map(([, w]) => w.end.getTime()));
  const cols = entries.map(
    ([key, w]) => sql`,
      coalesce(sum(${TOTAL}) filter (where ts >= ${iso(w.start)}::timestamptz and ts < ${iso(w.end)}::timestamptz), 0)::float8 as ${sql.raw(`"t_${key}"`)},
      coalesce(sum(cost) filter (where ts >= ${iso(w.start)}::timestamptz and ts < ${iso(w.end)}::timestamptz), 0)::float8 as ${sql.raw(`"c_${key}"`)},
      count(*) filter (where cost is null and ts >= ${iso(w.start)}::timestamptz and ts < ${iso(w.end)}::timestamptz)::int as ${sql.raw(`"m_${key}"`)}`,
  );
  const result = await db.execute(sql`
    select tool, model ${sql.join(cols, sql``)}
    from usage_events
    where ts >= ${new Date(minStart).toISOString()}::timestamptz and ts < ${new Date(maxEnd).toISOString()}::timestamptz
    group by tool, model`);
  return rowsOf<SumRow>(result);
}

function totalsFor(rows: SumRow[], key: string, w: PeriodWindow): PeriodTotals {
  const byTool: Record<Tool, number> = { claude: 0, codex: 0 };
  for (const r of rows) {
    const v = Number(r[`t_${key}`] ?? 0);
    if (r.tool === "claude" || r.tool === "codex") byTool[r.tool] += v;
  }
  return { fromDay: w.fromDay, toDay: w.toDay, tokens: byTool.claude + byTool.codex, byTool };
}

async function dailyByTool(db: Db, fromDay: string, toDay: string): Promise<Map<string, Record<Tool, number>>> {
  const result = await db.execute(sql`
    select day, tool, sum(total_tokens)::float8 as tokens from usage_daily
    where day >= ${fromDay} and day <= ${toDay} group by day, tool`);
  const map = new Map<string, Record<Tool, number>>();
  for (const r of rowsOf<{ day: string; tool: string; tokens: number }>(result)) {
    if (r.tool !== "claude" && r.tool !== "codex") continue;
    const cur = map.get(r.day) ?? { claude: 0, codex: 0 };
    cur[r.tool] += Number(r.tokens);
    map.set(r.day, cur);
  }
  return map;
}

function buildPeriod(w: ComparisonWindows, rows: SumRow[], prefix: string, daily: Map<string, Record<Tool, number>>): PeriodComparison {
  const current = totalsFor(rows, `${prefix}cur`, w.current);
  const previous = totalsFor(rows, `${prefix}prev`, w.previous);
  const previousFull = totalsFor(rows, `${prefix}full`, w.previousFull);
  const slots = Math.max(w.totalDays, w.previousTotalDays);
  const dayTotal = (day: string) => {
    const d = daily.get(day);
    return d ? d.claude + d.codex : 0;
  };
  const currentDays: (string | null)[] = [];
  const previousDays: (string | null)[] = [];
  for (let i = 0; i < slots; i++) {
    const cd = i < w.totalDays ? addDays(w.current.fromDay, i) : null;
    const pd = i < w.previousTotalDays ? addDays(w.previousFull.fromDay, i) : null;
    currentDays.push(cd);
    previousDays.push(pd);
  }
  const tools: ToolSide[] = TOOLS.map((tool) => {
    const mine = rows.filter((r) => r.tool === tool);
    const cost = mine.reduce((a, r) => a + Number(r[`c_${prefix}cur`] ?? 0), 0);
    const missing = mine.reduce((a, r) => a + Number(r[`m_${prefix}cur`] ?? 0), 0);
    const top = mine
      .map((r) => ({ model: r.model, tokens: Number(r[`t_${prefix}cur`] ?? 0) }))
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)[0];
    let activeDays = 0;
    for (const day of currentDays) if (day && day <= w.current.toDay && (daily.get(day)?.[tool] ?? 0) > 0) activeDays++;
    return {
      tool,
      tokens: current.byTool[tool],
      previousTokens: previous.byTool[tool],
      deltaPct: deltaPct(current.byTool[tool], previous.byTool[tool]),
      cost,
      costComplete: missing === 0,
      activeDays,
      share: current.tokens > 0 ? (current.byTool[tool] / current.tokens) * 100 : 0,
      topModel: top?.model ?? null,
    };
  });
  return {
    kind: w.kind,
    current,
    previous,
    previousFull,
    deltaPct: deltaPct(current.tokens, previous.tokens),
    series: {
      currentDays,
      previousDays,
      current: currentDays.map((d) => (d && d <= w.current.toDay ? dayTotal(d) : null)),
      previous: previousDays.map((d) => (d ? dayTotal(d) : null)),
    },
    tools,
    totalDays: w.totalDays,
  };
}

export async function getUsageComparison(db: Db, now = new Date()): Promise<UsageComparison> {
  const week = comparisonWindows("week", now);
  const month = comparisonWindows("month", now);
  const day = dayWindows(now);
  const rows = await sumWindows(db, {
    wcur: week.current,
    wprev: week.previous,
    wfull: week.previousFull,
    mcur: month.current,
    mprev: month.previous,
    mfull: month.previousFull,
    dcur: day.today,
    dprev: day.previous,
  });
  const from = week.previousFull.fromDay < month.previousFull.fromDay ? week.previousFull.fromDay : month.previousFull.fromDay;
  const daily = await dailyByTool(db, from, week.current.toDay);
  return { now: now.toISOString(), day: buildDay(day, rows), week: buildPeriod(week, rows, "w", daily), month: buildPeriod(month, rows, "m", daily) };
}

function buildDay(w: ReturnType<typeof dayWindows>, rows: SumRow[]): DayComparison {
  const today = totalsFor(rows, "dcur", w.today);
  const previous = totalsFor(rows, "dprev", w.previous);
  return { today, previous, comparable: w.comparable, until: w.until, deltaPct: w.comparable ? deltaPct(today.tokens, previous.tokens) : null };
}

/** nur der Tagesvergleich (Überblick „Tokens heute“) — dieselbe Rechnung wie `getUsageComparison().day`. */
export async function getDayComparison(db: Db, now = new Date()): Promise<DayComparison> {
  const day = dayWindows(now);
  return buildDay(day, await sumWindows(db, { dcur: day.today, dprev: day.previous }));
}

export interface ModelTrend {
  /** Montag jeder Woche, älteste zuerst; die letzte ist die laufende Woche. */
  weeks: string[];
  models: { model: string; tool: string; tokens: number[]; total: number }[];
}

/** Tokens je Modell und Kalenderwoche (Montag–Sonntag, Zeitzone des Nutzers), größtes Modell zuerst. */
export async function getModelTrend(db: Db, weeks: number, now = new Date()): Promise<ModelTrend> {
  const last = weekStartOf(localDay(now));
  const weekList = Array.from({ length: weeks }, (_, i) => addDays(last, -7 * (weeks - 1 - i)));
  const first = weekList[0] ?? last;
  const result = await db.execute(sql`
    select day, tool, coalesce(model, 'unbekannt') as model, sum(total_tokens)::float8 as tokens from usage_daily
    where day >= ${first} group by day, tool, model`);
  const index = new Map(weekList.map((w, i) => [w, i]));
  const byModel = new Map<string, { model: string; tool: string; tokens: number[]; total: number }>();
  for (const r of rowsOf<{ day: string; tool: string; model: string; tokens: number }>(result)) {
    const i = index.get(weekStartOf(r.day));
    if (i === undefined) continue;
    const key = `${r.tool}|${r.model}`;
    const cur = byModel.get(key) ?? { model: r.model, tool: r.tool, tokens: new Array<number>(weeks).fill(0), total: 0 };
    cur.tokens[i] = (cur.tokens[i] ?? 0) + Number(r.tokens);
    cur.total += Number(r.tokens);
    byModel.set(key, cur);
  }
  return { weeks: weekList, models: [...byModel.values()].filter((m) => m.total > 0).sort((a, b) => b.total - a.total) };
}

export interface BaustelleUsage {
  slug: string;
  label: string;
  /** Art, unter der die meisten Tokens dieser Baustelle liefen — für den Link `/sessions/<art>/<slug>`. */
  art: string;
  tokens: number;
  claude: number;
  codex: number;
  sessions: number;
}

export interface BaustellenUsage {
  items: BaustelleUsage[];
  /** Sessions erfasster Projekte ohne Baustelle (oder deren Session der NyxOS nicht bekannt ist). */
  ohneBaustelle: number;
  /** Fremde Projekte — nur als Summe, nie mit Namen (Datenschutz, s. `usage_events`). */
  andere: number;
}

export async function getBaustellenUsage(db: Db, range: Range, now = new Date()): Promise<BaustellenUsage> {
  const days = range === "all" ? null : range === "7" ? 7 : 30;
  const since = days === null ? null : localMidnight(addDays(localDay(now), -(days - 1))).toISOString();
  const [grouped, other] = await Promise.all([
    db.execute(sql`
      select s.category_art as art, s.category_baustelle_slug as slug, s.category_baustelle_label as label, e.tool,
             count(distinct s.id)::int as sessions, sum(${sql.raw("(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_5m_tokens + e.cache_creation_1h_tokens)")})::float8 as tokens
      from usage_events e left join sessions s on s.id = e.session_key
      where e.project <> ${USAGE_OTHER_PROJECT} ${since ? sql`and e.ts >= ${since}::timestamptz` : sql``}
      group by 1, 2, 3, 4`),
    db.execute(sql`
      select coalesce(sum(${TOTAL}), 0)::float8 as tokens from usage_events
      where project = ${USAGE_OTHER_PROJECT} ${since ? sql`and ts >= ${since}::timestamptz` : sql``}`),
  ]);
  const bySlug = new Map<string, BaustelleUsage & { artTokens: Map<string, number> }>();
  let ohneBaustelle = 0;
  for (const r of rowsOf<{ art: string | null; slug: string | null; label: string | null; tool: string; sessions: number; tokens: number }>(grouped)) {
    const tokens = Number(r.tokens);
    if (!r.slug) {
      ohneBaustelle += tokens;
      continue;
    }
    const cur = bySlug.get(r.slug) ?? { slug: r.slug, label: r.label ?? r.slug, art: r.art ?? "unsortiert", tokens: 0, claude: 0, codex: 0, sessions: 0, artTokens: new Map<string, number>() };
    cur.tokens += tokens;
    if (r.tool === "claude") cur.claude += tokens;
    else if (r.tool === "codex") cur.codex += tokens;
    cur.sessions += Number(r.sessions);
    const art = r.art ?? "unsortiert";
    cur.artTokens.set(art, (cur.artTokens.get(art) ?? 0) + tokens);
    bySlug.set(r.slug, cur);
  }
  const items = [...bySlug.values()]
    .map(({ artTokens, ...rest }) => ({ ...rest, art: [...artTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? rest.art }))
    .sort((a, b) => b.tokens - a.tokens);
  return { items, ohneBaustelle, andere: Number(rowsOf<{ tokens: number }>(other)[0]?.tokens ?? 0) };
}
