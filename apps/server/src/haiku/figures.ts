// Kennzahlen und Diagramm-Reihen für das Briefing — die EINZIGE Zahlenquelle der Briefing-Seite.
// „Jetzt“-Werte (Sessions, offene Fragen, Konflikte, Build-Fehler, „Braucht dich“) kommen aus demselben
// Schnappschuss wie die Sätze (`overview/snapshot.ts`), Verläufe aus vorhandenen Tabellen (usage_daily,
// usage_events, git_commits, entries). Das Modell sieht diese Zahlen nie als Eingabe für Kacheln — es darf
// nur sagen, welche Kacheln/Diagramme wichtig sind.
import { BRIEF_TASK_STAGES, type BriefTaskStage, type BriefingFigures, type ToolSplit, dateTimeFormat, t, timeZone } from "@nyxos/shared";
import { and, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { entries, usageDaily } from "../db/schema.js";
import { getCommitsPerDay } from "../git/store.js";
import type { LiveSnapshot } from "../overview/snapshot.js";
import { addDays, localDay } from "../usage/periods.js";

/** Nicht mitgezählt in „Aufträge offen“. dieselbe Zählung wie der Kopf des Aufgaben-Tabs
 * (Standard „Aufträge + Bugs“, `features/tasks/{model,TasksView}.ts(x)`): ohne Ideen, ohne Audit-Befunde
 * (eigener Tab, vorher „423 offen“ statt 41) und ohne Einträge, deren Quelle entfernt wurde. */
const NOT_TASK_KINDS = ["idee", "audit"] as const;
/** So viele Ordner bekommen eine eigene Farbe im Commit-Diagramm, der Rest heißt „andere“. */
const TOP_REPOS = 4;
const HOUR_MS = 3600_000;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Die letzten `n` Tage (Zeitzone des Nutzers) bis einschließlich heute, älteste zuerst. */
function lastDays(n: number, now: Date): string[] {
  const today = localDay(now);
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}

const split = (): ToolSplit => ({ claude: 0, codex: 0 });
const addTo = (split: ToolSplit, tool: string, n: number) => {
  if (tool === "claude" || tool === "codex") split[tool] += n;
};
const sumSplit = (rows: ToolSplit[]): ToolSplit => rows.reduce((a, r) => ({ claude: a.claude + r.claude, codex: a.codex + r.codex }), split());

const localHourOf = (t: number) => Number(dateTimeFormat({ hour: "numeric", hourCycle: "h23" }, "en-GB").formatToParts(new Date(t)).find((p) => p.type === "hour")?.value ?? 0);

export interface PeriodCounts {
  periodLabel: string;
  activeInPeriod: number;
  closedInPeriod: number;
}

export async function collectFigures(db: Db, snap: LiveSnapshot, period: PeriodCounts, now: Date): Promise<BriefingFigures> {
  const days14 = lastDays(14, now);
  const days7 = days14.slice(-7);
  // Stunden-Raster: die letzten 24 vollen Stunden bis zur laufenden (UTC-Stunden = Stunde (Zeitzone des Nutzers)n, Versatz ist ganzzahlig).
  const hourNow = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const hourStart = hourNow - 23 * HOUR_MS;

  const [usageRows, hourRows, commitTotals, repoRows, stageRows] = await Promise.all([
    db
      .select({ day: usageDaily.day, tool: usageDaily.tool, n: sql<number>`coalesce(sum(${usageDaily.totalTokens}), 0)::float8` })
      .from(usageDaily)
      .where(and(gte(usageDaily.day, days14[0] ?? ""), inArray(usageDaily.tool, ["claude", "codex"])))
      .groupBy(usageDaily.day, usageDaily.tool),
    // Haupt-Sessions mit Aktivität je Stunde: ein Nutzungs-Ereignis eines Sub-Agenten zählt für seine Haupt-Session.
    db.execute(sql`
      select extract(epoch from date_trunc('hour', e.ts))::float8 * 1000 as bucket, e.tool as tool,
             count(distinct coalesce(s.parent_id, s.id))::int as n
      from usage_events e join sessions s on s.id = e.session_key
      where e.ts >= ${new Date(hourStart).toISOString()}::timestamptz and s.archived_at is null
        and e.tool in ('claude', 'codex')
      group by 1, 2`),
    // Gleiche Zählung wie die Überblick-Kachel „Commits · 7 Tage“ (verschiedene SHAs je Tag (Zeitzone des Nutzers)).
    getCommitsPerDay(db, 14, { timeZone: timeZone(), now }),
    // Je Ordner: Worktrees zählen zu ihrem Repo (derselbe Commit steht sonst doppelt da).
    db.execute(sql`
      select to_char(c.author_date at time zone ${timeZone()}, 'YYYY-MM-DD') as day, coalesce(r.parent_id, r.id) as repo,
             coalesce(p.label, r.label) as label, count(distinct c.sha)::int as n
      from git_commits c join git_repos r on r.id = c.repo_id left join git_repos p on p.id = r.parent_id
      where c.author_date >= ${new Date(now.getTime() - 15 * 24 * HOUR_MS).toISOString()}::timestamptz
      group by 1, 2, 3`),
    db
      .select({ stage: entries.stage, n: sql<number>`count(*)::int` })
      .from(entries)
      .where(and(notInArray(entries.kind, [...NOT_TASK_KINDS]), isNull(entries.sourceRemovedAt)))
      .groupBy(entries.stage),
  ]);

  // Nutzung je Tag und Anbieter.
  const usageByDay = new Map(days14.map((d) => [d, split()]));
  for (const r of usageRows) {
    const day = usageByDay.get(r.day);
    if (day) addTo(day, r.tool, Number(r.n));
  }
  const usage14 = days14.map((d) => usageByDay.get(d) ?? split());
  const usage7d = days7.map((day) => ({ day, ...(usageByDay.get(day) ?? split()) }));

  // Sessions je Stunde.
  const hours = new Map<number, ToolSplit>();
  for (let t = hourStart; t <= hourNow; t += HOUR_MS) hours.set(t, split());
  for (const r of rowsOf<{ bucket: number; tool: string; n: number }>(hourRows)) {
    const h = hours.get(Number(r.bucket));
    if (h) addTo(h, r.tool, Number(r.n));
  }
  const sessionsHourly = [...hours.entries()].map(([t, v]) => ({ at: new Date(t).toISOString(), hour: localHourOf(t), ...v }));

  // Commits: Summen wie im Überblick, Diagramm je Ordner (die aktivsten 4 + „andere“).
  const totals = new Map(commitTotals.map((r) => [r.date, Number(r.count)]));
  const commits14 = days14.map((d) => totals.get(d) ?? 0);
  const repoData = rowsOf<{ day: string; repo: string; label: string; n: number }>(repoRows).filter((r) => days14.includes(r.day));
  const repoSum = new Map<string, { label: string; n: number }>();
  for (const r of repoData) {
    const cur = repoSum.get(r.repo) ?? { label: r.label, n: 0 };
    cur.n += Number(r.n);
    repoSum.set(r.repo, cur);
  }
  const ranked = [...repoSum.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, TOP_REPOS).map(([key, v]) => ({ key, label: v.label }));
  const hasOther = ranked.length > TOP_REPOS;
  const commitRepos = hasOther ? [...top, { key: "andere", label: t("Andere") }] : top;
  const topKeys = new Set(top.map((r) => r.key));
  const commitsDaily = days14.map((day) => {
    const repos: Record<string, number> = Object.fromEntries(commitRepos.map((r) => [r.key, 0]));
    for (const r of repoData) if (r.day === day) repos[topKeys.has(r.repo) ? r.repo : "andere"] = (repos[topKeys.has(r.repo) ? r.repo : "andere"] ?? 0) + Number(r.n);
    return { day, repos };
  });

  // Aufträge je Stufe.
  const stageCount = new Map(stageRows.map((r) => [r.stage, Number(r.n)]));
  const byStage = BRIEF_TASK_STAGES.map((stage: BriefTaskStage) => ({ stage, count: stageCount.get(stage) ?? 0 }));
  const open = byStage.filter((s) => s.stage !== "erledigt").reduce((a, s) => a + s.count, 0);

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    at: snap.at,
    periodLabel: period.periodLabel,
    sessions: { ...pickCounts(snap), activeInPeriod: period.activeInPeriod, closedInPeriod: period.closedInPeriod },
    commits: { today: commits14.at(-1) ?? 0, week: sum(commits14.slice(-7)), prevWeek: sum(commits14.slice(0, 7)) },
    tasks: { open, byStage },
    usage: { today: usage14.at(-1) ?? split(), week: sumSplit(usage14.slice(-7)), prevWeek: sumSplit(usage14.slice(0, 7)) },
    openQuestions: snap.openQuestions,
    conflicts: snap.activeConflicts,
    buildsRed: snap.redBuilds.length,
    needsYou: snap.needsYou.length,
    charts: { usage7d, sessionsHourly, commitsDaily, commitRepos },
  };
}

function pickCounts(snap: LiveSnapshot) {
  const { running, waiting, idle, crashed } = snap.counts;
  return { running, waiting, idle, crashed };
}
