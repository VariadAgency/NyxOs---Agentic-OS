// Überblick-Dashboard. Baut die `OverviewSnapshot`-DTO aus echten Daten (Sessions, Git,
// Konflikte, Einträge, dazu Nutzung für „Max-Fenster“ und Nyx-Aufrufe).
//
// jede Kachel bekommt, wo es Verlaufsdaten gibt, eine 14-Tage-Reihe (Sparkline) und einen
// Trend als Rohwerte (aktuell/vorher/Zeitraum). Wo es keine Historie gibt (z. B. „wartet"), trägt
// die Kachel stattdessen eine Zeile Kontext aus echten Daten (`caption`).
//
// Zähler, „Wartet auf dich“, „Kritische Sessions“ und Lage-Satz kommen aus dem gemeinsamen
// Schnappschuss (`snapshot.ts`) — derselbe, aus dem Briefing/Recap schreiben.
// dazu Tokens heute/7 Tage (mit Trend), offene Build-Fehler (gebündelt), Konflikt-Trend und
// „Zuletzt fertig“ (Sessions + erledigte Aufträge) — alles aus vorhandenen Tabellen, keine Platzhalter.
import { BUILD_KIND_LABEL, DEFAULT_GREETING_NAME, formatTokensCompact, openQuestionsCaption, uncommittedCaption, type BaustelleProgress, type CriticalSession, type MetricTile, type MetricTrend, type OverviewSnapshot, type RecentDoneItem, dateTimeFormat, t, timeZone } from "@nyxos/shared";
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { entries, sessions, usageDaily } from "../db/schema.js";
import { sessionTitle, takeSnapshot, type SnapSession } from "./snapshot.js";
import { getCommitsPerDay } from "../git/store.js";
import { getUncommittedTotals } from "../git/dashboard.js";
import { getDayComparison } from "../usage/compare.js";
import { usageByDay as haikuUsageByDay } from "../haiku/settings.js";
import { addDays, localDay, localMidnight, dayWindows } from "../usage/periods.js";
import { getUsageWindows } from "../usage/window.js";
import { getForecasts } from "../usage/forecast.js";
import { getLimits } from "../usage/query.js";
import { countedHistorySession, visibleSession } from "../db/visible.js";

/** P4-Baustellen-Arten, die für den Fortschrittsbalken zählen — Ideen/Entscheidungen/Fragen sind
 * kein "Arbeitsfortschritt" einer Baustelle (s. Baustelle-Definition in `entries/store.ts`). */
const PROGRESS_KINDS = ["bug", "aufgabe", "audit", "problem"] as const;

const SPARK_DAYS = 14;
/** so viele „zuletzt fertig“-Einträge. */
const RECENT_DONE_LIMIT = 8;
/** Kritische Sessions: alle Abgestürzten + Wartenden des Stands (Obergrenze nur gegen Ausreißer). */
const CRITICAL_LIMIT = 30;
/** verwaiste Sessions – die Liste ist begrenzt (Geister können sich sammeln), die Zahl nicht. */
export const ORPHANED_LIMIT = 20;
/** „<Art> erledigt“ je Eintragsart (ganze Sätze als Übersetzungsschlüssel, übersetzt beim Bauen). */
const ENTRY_DONE_LABEL: Record<string, string> = { bug: "Bug erledigt", aufgabe: "Aufgabe erledigt", audit: "Audit-Fund erledigt", problem: "Problem erledigt", idee: "Idee erledigt", frage: "Frage erledigt" };

/** Postgres- oder ISO-Zeit → ISO (für Sortierung und Anzeige). */
function toIso(v: string | Date | null): string {
  if (v instanceof Date) return v.toISOString();
  if (!v) return new Date(0).toISOString();
  const ms = Date.parse(v);
  const t2 = Number.isNaN(ms) ? Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")) : ms;
  return new Date(Number.isNaN(t2) ? 0 : t2).toISOString();
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Die letzten `days` Kalendertage (Zeitzone des Nutzers) lückenlos, älteste zuerst. Vorher UTC —
 * `usage_daily.day` und `haiku.day` sind aber Tage (Zeitzone des Nutzers), zwischen 0 und 2 Uhr stand „heute“ auf dem Vortag. */
function lastDays(days: number, now: Date): string[] {
  const today = localDay(now);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

function fill(days: string[], rows: { date: string; count: number }[]): number[] {
  const m = new Map(rows.map((r) => [r.date, Number(r.count)]));
  return days.map((d) => m.get(d) ?? 0);
}

/** Zählung je Kalendertag (Zeitzone des Nutzers) einer Zeitstempel-Spalte (für Sparklines). `where` ist fester SQL-Text. */
async function perDay(db: Db, table: string, column: string, where: string, since: string): Promise<{ date: string; count: number }[]> {
  const result = await db.execute(
    sql`select to_char(${sql.raw(column)} at time zone ${timeZone()}, 'YYYY-MM-DD') as date, count(*)::int as count
        from ${sql.raw(table)} where ${sql.raw(column)} >= ${since}::timestamptz and ${sql.raw(where)} group by 1`,
  );
  return rowsOf<{ date: string; count: number }>(result);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function minutesAgo(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
}

function waitLabel(min: number): string {
  if (min < 1) return t("unter 1 min");
  if (min < 60) return t("{n} min", { n: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t("{n} Std", { n: h }) : t("{n} T", { n: Math.floor(h / 24) });
}

const timeFmt = () => dateTimeFormat({ hour: "2-digit", minute: "2-digit" });

function tile(partial: Partial<MetricTile> & Pick<MetricTile, "key" | "label" | "value" | "href">): MetricTile {
  return {
    format: "count",
    trend: null,
    sparkline: [],
    sparklineLabel: null,
    caption: null,
    captionTone: null,
    placeholder: false,
    placeholderReason: null,
    ...partial,
  };
}

export async function getOverviewSnapshot(db: Db, greetingName = DEFAULT_GREETING_NAME, now = new Date()): Promise<OverviewSnapshot> {
  const days14 = lastDays(SPARK_DAYS, now);
  const since14 = localMidnight(days14[0] ?? localDay(now)).toISOString();
  const days28 = lastDays(SPARK_DAYS * 2, now);
  const dayW = dayWindows(now);
  const [
    snap,
    uncommitted,
    dayCompare,
    commitRows,
    baustellenRows,
    criticalAuditRows,
    entryProgressRows,
    sessionStarts,
    conflictDays,
    windows,
    haikuCosts7d,
    tokenRows,
    doneSessionRows,
    doneEntryRows,
    forecasts,
    haikuPrevRows,
  ] = await Promise.all([
    takeSnapshot(db, now),
    // dieselbe Zählung wie die Git-Seite (nur Repos/Worktrees, die der letzte Scan gesehen hat).
    getUncommittedTotals(db),
    // Tages-Trend gegen gestern bis zur gleichen Uhrzeit (dieselbe Rechnung wie Nutzung → „Heute“).
    getDayComparison(db, now),
    getCommitsPerDay(db, SPARK_DAYS * 2, { timeZone: timeZone(), now }),
    db
      .select({
        slug: sessions.categoryBaustelleSlug,
        label: sessions.categoryBaustelleLabel,
        open: sql<number>`count(*) filter (where ${sessions.closedAt} is null and ${sessions.parentId} is null and ${sessions.state} in ('running','waiting','idle'))::int`,
      })
      .from(sessions)
      .where(and(isNotNull(sessions.categoryBaustelleSlug), visibleSession))
      .groupBy(sessions.categoryBaustelleSlug, sessions.categoryBaustelleLabel),
    // kritische Audit-Befunde (priority='p0', s. entries/import.ts "0=kritisch"), noch nicht erledigt.
    db.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.kind, "audit"), eq(entries.priority, "p0"), ne(entries.stage, "erledigt"))),
    // Fortschritt je Baustelle aus den gewichteten Teilaufgaben-Summen (nur Arbeits-Arten, s. PROGRESS_KINDS).
    db
      .select({
        slug: entries.baustelleSlug,
        doneWeight: sql<number>`coalesce(sum(${entries.progressDoneWeight}), 0)::int`,
        totalWeight: sql<number>`coalesce(sum(${entries.progressTotalWeight}), 0)::int`,
      })
      .from(entries)
      .where(and(isNotNull(entries.baustelleSlug), inArray(entries.kind, PROGRESS_KINDS)))
      .groupBy(entries.baustelleSlug),
    // Sparklines (14 Tage): Haupt-Sessions gestartet je Tag, Kollisionen je Tag, neue Fragen je Tag.
    perDay(db, "sessions", "started_at", "parent_id is null and archived_at is null", since14),
    perDay(db, "conflict_events", "detected_at", "kind = 'kollision'", since14),
    getUsageWindows(db, now),
    // Haiku-Aufrufe der letzten 7 Tage (Zeitzone des Nutzers) (Briefing/Recap/Chat/Begleitung).
    haikuUsageByDay(db, 7, now),
    // Tokens je Tag (alle Werkzeuge/Modelle/Projekte, Tag in der Zeitzone des Nutzers wie `usage_daily`), 28 Tage für Woche/Vorwoche.
    db
      .select({ date: usageDaily.day, count: sql<number>`coalesce(sum(${usageDaily.totalTokens}), 0)::float8` })
      .from(usageDaily)
      .where(gte(usageDaily.day, days28[0] ?? ""))
      .groupBy(usageDaily.day),
    // zuletzt sauber fertig gewordene Haupt-Sessions (SessionEnd/Runde zu, oder vom Nutzer geschlossen).
    // beendete temporäre Sessions (jeder Grund) nie (`countedHistorySession`).
    db
      .select({
        id: sessions.id,
        sessionId: sessions.sessionId,
        title: sessions.title,
        // alles, was `sessionLabel` für einen Namen ohne Titel braucht (Ordner/Baustelle + Startzeit).
        titleSource: sessions.titleSource,
        tool: sessions.tool,
        cwd: sessions.cwd,
        categoryBaustelleLabel: sessions.categoryBaustelleLabel,
        startedAt: sessions.startedAt,
        art: sessions.categoryArt,
        baustelleSlug: sessions.categoryBaustelleSlug,
        closedAt: sessions.closedAt,
        at: sql<string>`coalesce(${sessions.closedAt}, ${sessions.endedAt}, ${sessions.lastActivityAt})`,
      })
      .from(sessions)
      .where(and(isNull(sessions.parentId), countedHistorySession, or(isNotNull(sessions.closedAt), and(eq(sessions.status, "ended"), or(isNotNull(sessions.sessionEndReceivedAt), eq(sessions.turnOpen, false))))))
      .orderBy(sql`coalesce(${sessions.closedAt}, ${sessions.endedAt}, ${sessions.lastActivityAt}) desc nulls last`)
      .limit(RECENT_DONE_LIMIT),
    // zuletzt erledigte Aufträge (Stufe „erledigt“, Zeit = letzte Änderung).
    db.select({ id: entries.id, kind: entries.kind, title: entries.title, at: entries.updatedAt }).from(entries).where(eq(entries.stage, "erledigt")).orderBy(desc(entries.updatedAt)).limit(RECENT_DONE_LIMIT),
    // Limit-Wecker — Hochrechnung des Claude-Fensters für die Kachel „Max-Fenster“.
    getLimits(db).then((l) => getForecasts(db, l, now)),
    // Nyx-Aufrufe gestern bis zur gleichen Uhrzeit (Trend „Nyx heute“, gleiche Regel wie „Tokens heute“).
    db.execute(
      sql`select count(*)::int as n from haiku_calls where created_at >= ${dayW.previous.start.toISOString()}::timestamptz and created_at < ${dayW.previous.end.toISOString()}::timestamptz and status not in ('budget', 'queued')`,
    ).then((r) => rowsOf<{ n: number }>(r)[0]?.n ?? 0),
  ]);

  const counts = snap.counts;
  const openCount = counts.running + counts.waiting + counts.idle;
  // „am längsten wartet“ = älteste Aktivität zuerst.
  const waitingRows = [...snap.waiting].reverse();

  // Commits: 28 Tage holen → diese Woche vs. Vorwoche als Trend, 14 Tage als Diagramm.
  const commits28 = fill(days28, commitRows);
  const commitsThisWeek = sum(commits28.slice(-7));
  const commitsPrevWeek = sum(commits28.slice(-14, -7));
  const commits14 = commits28.slice(-SPARK_DAYS);

  const starts = fill(days14, sessionStarts);
  const oldestWait = minutesAgo(waitingRows[0]?.lastActivityAt ?? null, now);

  const claude = windows.find((w) => w.tool === "claude");
  const claude5h = forecasts.find((f) => f.tool === "claude" && f.window === "5h");
  // ein Abzeichen vergleicht immer DIESELBE Größe wie die große Zahl mit dem Zeitraum davor;
  // `period` nennt die Größe (Tooltip „Tokens heute ggü. gestern: vorher …, jetzt …“). Gibt es keinen
  // Vorwert derselben Größe (offene Sessions, aktive Konflikte), gibt es kein Abzeichen.
  const trend = (current: number, previous: number, period: string, upIsGood: boolean | null): MetricTrend => ({ current, previous, period, upIsGood });

  let maxCaption: string | null = null;
  let maxTone: MetricTile["captionTone"] = null;
  if (claude?.reported.limitReached && claude.reported.resetsAt) {
    maxCaption = t("Limit erreicht · frei ab {time}", { time: timeFmt().format(new Date(claude.reported.resetsAt)) });
    maxTone = "wait";
  } else if (claude5h?.hitsLimitAt && claude5h.resetsAt) {
    // bei diesem Tempo voll, bevor das Fenster zurückgesetzt wird.
    maxCaption = t("Voll um {time} · Reset {reset}", { time: timeFmt().format(new Date(claude5h.hitsLimitAt)), reset: timeFmt().format(new Date(claude5h.resetsAt)) });
    maxTone = "wait";
  } else if (claude5h?.pct !== null && claude5h?.pct !== undefined && claude5h.resetsAt) {
    maxCaption = t("Reicht bis Reset {time}", { time: timeFmt().format(new Date(claude5h.resetsAt)) });
  } else if (claude && claude.peak5h > 0) {
    maxCaption = t("Spitze 7 T: {tokens} in 5 Std", { tokens: formatTokensCompact(claude.peak5h) });
  }

  // dieselben 7 Tage (Zeitzone des Nutzers), aber Haiku-Aufrufe statt Commits (`usageByDay`
  // liefert den Tag schon in Zeitzone des Nutzers, s. haiku/settings.ts).
  const haikuFilled = lastDays(7, now).map((d) => ({ date: d, count: haikuCosts7d.find((h) => h.day === d)?.calls ?? 0 }));

  // Tokens je Tag (28 T) → heute ggü. gestern, 7 Tage ggü. Vorwoche; Sparkline 14 T.
  const tokens28 = fill(days28, tokenRows.map((r) => ({ date: r.date, count: Number(r.count) })));
  const tokensToday = tokens28.at(-1) ?? 0;
  const tokensWeek = sum(tokens28.slice(-7));
  const tokensPrevWeek = sum(tokens28.slice(-14, -7));
  const conflicts14 = fill(days14, conflictDays);
  const red = snap.redBuilds;
  const firstRed = red[0];

  const sessionTile = tile({
    key: "sessions_open",
      label: t("Sessions offen"),
      value: openCount,
      // „offen“ heißt Prozess lebt (nicht „aktiv“) — aufgeschlüsselt, damit die Zahl ehrlich ist.
      caption: t("{running} arbeiten · {waiting} warten · {idle} ruhen", { running: counts.running, waiting: counts.waiting, idle: counts.idle }),
      sparkline: starts,
      sparklineLabel: t("Starts je Tag · 14 T"),
      href: "/sessions",
  });
  const metrics: MetricTile[] = [
    sessionTile,
    tile({
      key: "sessions_waiting",
      label: t("Wartet auf dich"),
      value: counts.waiting,
      caption: oldestWait === null ? t("Nichts wartet") : t("am längsten seit {time}", { time: waitLabel(oldestWait) }),
      captionTone: oldestWait !== null && oldestWait >= 30 ? "wait" : null,
      href: "/sessions?state=waiting",
    }),
    tile({
      key: "tokens_today",
      label: t("Tokens heute"),
      value: tokensToday,
      format: "tokens",
      sparkline: tokens28.slice(-SPARK_DAYS),
      sparklineLabel: t("Tokens je Tag · 14 T"),
      // gegen gestern bis zur gleichen Uhrzeit; vor 06:00 kein Vergleich (sonst „▼ 99 %“ nach Mitternacht).
      trend: dayCompare.comparable ? trend(tokensToday, dayCompare.previous.tokens, t("Tokens heute ggü. gestern bis {time}", { time: dayCompare.until }), null) : null,
      href: "/usage",
    }),
    tile({
      key: "tokens_7d",
      label: t("Tokens · 7 Tage"),
      value: tokensWeek,
      format: "tokens",
      sparkline: tokens28.slice(-SPARK_DAYS),
      sparklineLabel: t("Tokens je Tag · 14 T"),
      trend: trend(tokensWeek, tokensPrevWeek, t("Tokens 7 Tage ggü. den 7 Tagen davor"), null),
      href: "/usage",
    }),
    tile({
      key: "commits_7d",
      label: t("Commits · 7 Tage"),
      value: commitsThisWeek,
      sparkline: commits14,
      sparklineLabel: t("Commits je Tag · 14 T"),
      trend: trend(commitsThisWeek, commitsPrevWeek, t("Commits 7 Tage ggü. den 7 Tagen davor"), true),
      href: "/git",
    }),
    tile({
      key: "uncommitted",
      label: t("Ungesichert"),
      value: uncommitted.files,
      caption: uncommittedCaption(uncommitted),
      captionTone: uncommitted.files > 200 ? "wait" : null,
      href: "/git",
    }),
    tile({
      key: "conflicts",
      label: t("Konflikte"),
      // nur Konflikte zwischen Sessions, die gerade leben (Quelle: Schnappschuss).
      value: snap.activeConflicts,
      caption: snap.activeConflicts === 0 ? t("Keine zwei laufenden Sessions an denselben Dateien") : t("Dateien, die gerade mehrere Sessions ändern"),
      sparkline: conflicts14,
      sparklineLabel: t("neue Kollisionen je Tag · 14 T"),
      href: "/conflicts",
    }),
    // Build-Zustand gebündelt (gleiche Fehler = ein Eintrag; im selben Ordner wieder grün = behoben).
    tile({
      key: "builds_red",
      label: t("Builds rot"),
      value: red.length,
      caption: firstRed ? `${t(BUILD_KIND_LABEL[firstRed.kind])}: ${firstRed.sentence}${red.length > 1 ? ` (+${red.length - 1})` : ""}` : t("Kein offener Build-Fehler"),
      captionTone: red.length > 0 ? "bad" : null,
      href: "/server",
    }),
    tile({
      key: "open_questions",
      label: t("Offene Fragen"),
      // dieselbe Zahl wie Entscheidungen-Tab (Kopf + Leiste) — Freigaben, Karten, Konflikt-Fragen.
      value: snap.openQuestions.total,
      caption: openQuestionsCaption(snap.openQuestions),
      captionTone: snap.openQuestions.total > 0 ? "wait" : null,
      href: "/inbox",
    }),
    tile({
      key: "audits_critical",
      label: t("Audit kritisch"),
      value: criticalAuditRows[0]?.n ?? 0,
      caption: (criticalAuditRows[0]?.n ?? 0) === 0 ? t("Kein kritischer Fund offen") : t("Priorität 0, noch offen"),
      captionTone: (criticalAuditRows[0]?.n ?? 0) > 0 ? "bad" : null,
      href: "/audits",
    }),
    tile({
      key: "max_window",
      label: t("Max-Fenster · 5 Std"),
      value: claude?.tokens5h ?? 0,
      format: "tokens",
      sparkline: claude?.hourly24 ?? [],
      sparklineLabel: t("Claude-Tokens je Stunde · 24 Std"),
      caption: maxCaption,
      captionTone: maxTone,
      href: "/usage",
    }),
    // war bis dahin `placeholder:true` ("kommt in P7") — jetzt
    // echte Aufrufe/Tag aus `haiku_calls` (Briefing zählt mit, s. haiku/report.ts).
    tile({
      key: "haiku_briefing",
      label: t("Nyx heute"),
      value: haikuFilled.at(-1)?.count ?? 0,
      sparkline: haikuFilled.map((d) => d.count),
      sparklineLabel: t("Nyx-Aufrufe je Tag · 7 T"),
      trend: dayW.comparable ? trend(haikuFilled.at(-1)?.count ?? 0, haikuPrevRows, t("Nyx-Aufrufe heute ggü. gestern bis {time}", { time: dayW.until }), null) : null,
      href: "/briefing",
    }),
  ];

  const sessionHref = (r: { art: string | null; baustelleSlug: string | null; sessionId: string }) => `/sessions/${r.art ?? "unsortiert"}/${r.baustelleSlug ?? "_"}/${r.sessionId}`;
  const hrefOf = (r: { categoryArt: string | null; categoryBaustelleSlug: string | null; sessionId: string }) => sessionHref({ art: r.categoryArt, baustelleSlug: r.categoryBaustelleSlug, sessionId: r.sessionId });
  const critical = (r: SnapSession, reason: string): CriticalSession => ({ sessionKey: r.id, sessionId: r.sessionId, title: r.title, label: sessionTitle(r), tool: r.tool, state: r.state, reason, href: hrefOf(r) });
  // genau die Abgestürzten und Wartenden des Schnappschusses (Zahl = Kopfzeile).
  const criticalSessions: CriticalSession[] = [
    ...snap.crashed.map((r) => critical(r, t("abgestürzt"))),
    ...waitingRows.map((r) => {
      const min = minutesAgo(r.lastActivityAt, now);
      return critical(r, min === null ? t("wartet") : t("wartet seit {time}", { time: waitLabel(min) }));
    }),
  ].slice(0, CRITICAL_LIMIT);
  // verwaiste Geister-Sessions (Aufräum-Zeile im Überblick) – nur anzeigen, Schließen nur per Rückfrage.
  const orphanedSessions: CriticalSession[] = snap.orphaned.slice(0, ORPHANED_LIMIT).map((r) => {
    const min = minutesAgo(r.lastActivityAt ?? r.startedAt ?? null, now);
    return critical(r, min === null ? t("verwaist") : t("verwaist seit {time}", { time: waitLabel(min) }));
  });

  const recentDone: RecentDoneItem[] = [
    ...doneSessionRows.map((r) => ({
      kind: "session" as const,
      id: r.id,
      title: sessionTitle({ ...r, lastActivityAt: toIso(r.at) }),
      label: r.closedAt ? t("Session geschlossen") : t("Session beendet"),
      at: toIso(r.at),
      href: sessionHref(r),
    })),
    ...doneEntryRows.map((r) => ({ kind: "entry" as const, id: `entry:${r.id}`, title: r.title, label: t(ENTRY_DONE_LABEL[r.kind] ?? "Eintrag erledigt"), at: toIso(r.at), href: `/tasks?e=${r.id}` })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, RECENT_DONE_LIMIT);

  const progressBySlug = new Map(entryProgressRows.filter((r) => r.slug).map((r) => [r.slug as string, r]));
  const baustellen: BaustelleProgress[] = baustellenRows
    .filter((b) => b.slug)
    .map((b) => {
      const progress = progressBySlug.get(b.slug as string);
      const progressPct = progress && progress.totalWeight > 0 ? Math.round((progress.doneWeight / progress.totalWeight) * 100) : null;
      return { slug: b.slug as string, label: b.label ?? (b.slug as string), progressPct, openSessions: b.open };
    })
    .sort((a, b) => b.openSessions - a.openSessions || (b.progressPct ?? -1) - (a.progressPct ?? -1));

  return {
    greetingName,
    generatedAt: now.toISOString(),
    counts,
    lage: snap.lage,
    openQuestions: snap.openQuestions,
    needsYouCount: snap.needsYou.length,
    fingerprint: snap.fingerprint,
    metrics,
    commits: days14.map((date, i) => ({ date, claude: 0, codex: 0, human: commits14[i] ?? 0 })),
    criticalSessions,
    orphanedSessions,
    orphanedTotal: snap.orphaned.length,
    baustellen,
    recentDone,
    pendingDeliveries: snap.pendingDeliveries,
    serverOk: null,
  };
}
