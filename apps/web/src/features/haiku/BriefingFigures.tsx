// Kennzahl-Kacheln und Graphen des Briefings. Einzige Zahlenquelle ist `report.figures` (vom Server
// aus dem Schnappschuss berechnet) — Nyx bestimmt nur, welche Kacheln hervorgehoben und welche Graphen zuerst
// stehen. Einzige Ausnahme: die Server-Kachel zeigt den Live-Zustand aus `/health` (keine Zahl, ein Zustand).
import { BRIEF_TILE_KEYS, formatTokensCompact, locale, orderCharts, t, type BriefChartKey, type BriefTaskStage, type BriefTileKey, type BriefingFigures, type ToolSplit } from "@nyxos/shared";
import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { AreaChart, BarChart, Donut, formatDayLong, formatDayShort, formatWeekday, TrendChip, type AreaSeries } from "../../components/charts";
import { useCountUpOnce } from "../../components/charts/StatCard";
import { AskNyxButton } from "../../components/nyx/AskNyxButton";
import { useServerStatus } from "../../hooks/useHealth";
import { cn } from "../../lib/cn";
import { riseStyle } from "./ui";

const nf = new Intl.NumberFormat(locale());
const fmtCount = (n: number) => nf.format(Math.round(n));
const sumSplit = (s: ToolSplit) => s.claude + s.codex;
/** Zählwort: `one`/`many` sind Übersetzungs-Schlüssel mit `{n}`. */
const plural = (n: number, one: string, many: string) => t(n === 1 ? one : many, { n: fmtCount(n) });

// ───────────────────────────── Kacheln ─────────────────────────────

interface TileSpec {
  key: BriefTileKey;
  label: string;
  /** Zahl zum Hochzählen (null = Zustand statt Zahl, z. B. Server). */
  value: number | null;
  format: (n: number) => string;
  /** Anzeige, wenn es keine Zahl gibt. */
  text?: string;
  caption: ReactNode;
  tone?: "wait" | "bad" | "ok" | null;
  color: string;
  href: string;
  split?: ToolSplit;
  trend?: { current: number; previous: number; period: string; upIsGood: boolean | null } | null;
}

function tileSpecs(f: BriefingFigures, server: ReturnType<typeof useServerStatus>): Record<BriefTileKey, TileSpec> {
  const stage = (s: BriefTaskStage) => f.tasks.byStage.find((x) => x.stage === s)?.count ?? 0;
  const active = f.sessions.running + f.sessions.waiting;
  const usageToday = sumSplit(f.usage.today);
  const usageWeek = sumSplit(f.usage.week);
  const serverText = server.tone === "ok" ? t("Läuft") : server.tone === "bad" ? t("Störung") : server.tone === "wait" ? t("Hakt kurz") : t("Prüfe …");
  return {
    needs_you: {
      key: "needs_you",
      label: t("Braucht dich"),
      value: f.needsYou,
      format: fmtCount,
      caption: f.needsYou === 0 ? t("Nichts wartet auf dich") : f.openQuestions.total > 0 ? plural(f.openQuestions.total, "{n} Frage offen", "{n} Fragen offen") : t("Sessions und Fehler"),
      tone: f.needsYou > 0 ? "wait" : null,
      color: "var(--a-wait)",
      href: "/inbox",
    },
    sessions_active: {
      key: "sessions_active",
      label: t("Sessions aktiv"),
      value: active,
      format: fmtCount,
      caption: t("{running} arbeiten · {waiting} warten · {idle} ruhen", { running: fmtCount(f.sessions.running), waiting: fmtCount(f.sessions.waiting), idle: fmtCount(f.sessions.idle) }),
      color: "var(--a-ok)",
      href: "/sessions",
    },
    sessions_done: {
      key: "sessions_done",
      label: t("Sessions fertig"),
      value: f.sessions.closedInPeriod,
      format: fmtCount,
      caption: t("{n} aktiv {period}", { n: fmtCount(f.sessions.activeInPeriod), period: f.periodLabel }),
      color: "var(--a-done)",
      href: "/sessions",
    },
    commits: {
      key: "commits",
      label: t("Commits · 7 Tage"),
      value: f.commits.week,
      format: fmtCount,
      caption: t("{n} heute", { n: fmtCount(f.commits.today) }),
      color: "var(--a-violet)",
      href: "/git",
      trend: { current: f.commits.week, previous: f.commits.prevWeek, period: t("Commits 7 Tage ggü. den 7 Tagen davor"), upIsGood: true },
    },
    tasks_open: {
      key: "tasks_open",
      label: t("Offene Aufträge"),
      value: f.tasks.open,
      format: fmtCount,
      caption: t("{ready} startklar · {running} laufen", { ready: fmtCount(stage("startklar")), running: fmtCount(stage("laeuft")) }),
      color: "var(--a-indigo)",
      href: "/tasks",
    },
    usage_today: {
      key: "usage_today",
      label: t("Nutzung heute"),
      value: usageToday,
      format: formatTokensCompact,
      caption: "Tokens",
      color: "var(--a-claude)",
      href: "/usage",
      split: f.usage.today,
    },
    usage_week: {
      key: "usage_week",
      label: t("Nutzung · 7 Tage"),
      value: usageWeek,
      format: formatTokensCompact,
      caption: "Tokens",
      color: "var(--a-codex)",
      href: "/usage",
      split: f.usage.week,
      trend: { current: usageWeek, previous: sumSplit(f.usage.prevWeek), period: t("Tokens 7 Tage ggü. den 7 Tagen davor"), upIsGood: null },
    },
    server: {
      key: "server",
      label: "Server",
      value: null,
      format: fmtCount,
      text: serverText,
      caption: f.buildsRed > 0 ? t("{n} Build-Fehler offen", { n: fmtCount(f.buildsRed) }) : t("Keine Build-Fehler"),
      tone: server.tone === "bad" || f.buildsRed > 0 ? "bad" : server.tone === "ok" ? "ok" : "wait",
      color: "var(--a-acc)",
      href: "/server",
    },
    conflicts: {
      key: "conflicts",
      label: t("Konflikte"),
      value: f.conflicts,
      format: fmtCount,
      caption: f.conflicts === 0 ? t("Keine Überschneidungen") : t("Dateien, die mehrere Sessions ändern"),
      tone: f.conflicts > 0 ? "bad" : null,
      color: "var(--a-conf)",
      href: "/conflicts",
    },
  };
}

const TONE_TEXT = { wait: "text-a-wait", bad: "text-a-bad", ok: "text-a-ok" } as const;

function SplitBar({ split }: { split: ToolSplit }) {
  const total = sumSplit(split);
  const claudePct = total > 0 ? (split.claude / total) * 100 : 50;
  return (
    <div className="grid gap-1">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-a-p3" aria-hidden="true">
        {total > 0 && (
          <>
            <span className="h-full bg-[var(--a-claude)] transition-[width] duration-500" style={{ width: `${claudePct}%` }} />
            <span className="h-full bg-[var(--a-codex)] transition-[width] duration-500" style={{ width: `${100 - claudePct}%` }} />
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-2.5 pr-8 font-mono text-label tabular-nums">
        <span className="text-[var(--a-claude)]">Claude {formatTokensCompact(split.claude)}</span>
        <span className="text-[var(--a-codex)]">Codex {formatTokensCompact(split.codex)}</span>
      </div>
    </div>
  );
}

/** Nyx darf hervorheben, aber „wichtig“ steht nur, wo es etwas gibt: Zahl > 0, beim Server ein Problem.
 * Vorher trug auch „Sessions fertig 0“ das Etikett. */
export function isImportant(spec: Pick<TileSpec, "value" | "tone">, highlight: boolean): boolean {
  if (!highlight) return false;
  return spec.value === null ? spec.tone === "bad" || spec.tone === "wait" : spec.value > 0;
}

function BriefTile({ spec, highlight, index }: { spec: TileSpec; highlight: boolean; index: number }) {
  const important = isImportant(spec, highlight);
  const shown = useCountUpOnce(`brief:${spec.key}`, spec.value);
  const finalText = spec.value === null ? (spec.text ?? "—") : spec.format(spec.value);
  const shownText = spec.value === null ? finalText : spec.format(shown ?? spec.value);
  return (
    // Jede Kachel führt per Klick zum passenden Tab (mehr Infos) und hat unten rechts einen kleinen
    // „Nyx fragen“-Knopf (neben dem Link, nicht darin – ein Knopf in einem Link wäre ungültig).
    <div className="relative grid min-w-0">
      <Link
        to={spec.href}
        data-brief-tile={spec.key}
        data-speech-target={`tile:${spec.key}`}
        data-value={finalText}
        data-highlight={important ? "true" : undefined}
        aria-label={t("{label}: {value} – mehr dazu", { label: spec.label, value: finalText })}
        className="cc-rise group relative grid min-h-[132px] min-w-0 content-start gap-1.5 overflow-hidden rounded-xl border border-a-line bg-a-p p-3.5 pt-4 transition-[border-color,background-color,transform] duration-150 ease-apple hover:-translate-y-px hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc motion-reduce:hover:translate-y-0 sm:p-4 sm:pt-[18px]"
        style={{ ...riseStyle(index), "--speech-accent": spec.color } as CSSProperties}
      >
        {/* Statt bunter Voll-Rahmen höchstens ein 3-px-Streifen links in der Kachelfarbe. */}
        {important && <span aria-hidden="true" data-brief-stripe className="absolute inset-y-0 left-0 w-[3px]" style={{ background: spec.color }} />}
        <div className="flex min-h-[20px] min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-label uppercase tracking-[.06em] text-a-mut">
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: spec.color }} />
            {spec.label}
            {important && (
              <span title={t("Nyx: heute wichtig")} className="shrink-0 rounded-full px-1.5 py-px text-label normal-case tracking-normal" style={{ color: spec.color, background: `color-mix(in srgb, ${spec.color} 16%, transparent)` }}>
                {t("wichtig")}
              </span>
            )}
          </span>
          {spec.trend && <TrendChip trend={spec.trend} format={spec.format} />}
        </div>
        <span className={cn("whitespace-nowrap font-display text-title font-semibold leading-none tabular-nums", spec.value === null && spec.tone ? TONE_TEXT[spec.tone] : "text-a-ink")}>{shownText}</span>
        {spec.split ? <SplitBar split={spec.split} /> : <span className={cn("min-w-0 truncate pr-8 text-caption leading-4", spec.tone && spec.value !== null ? TONE_TEXT[spec.tone] : "text-a-mut")}>{spec.caption}</span>}
        {spec.split && <span className="pr-8 text-caption text-a-mut">{spec.caption}</span>}
        {spec.value === null && spec.tone && <span className="sr-only">{spec.caption}</span>}
      </Link>
      <div className="absolute bottom-2.5 right-2.5 z-[2]">
        <AskNyxButton compact inline={false} label={t("Nyx zu „{label}“ fragen", { label: spec.label })} question={t("Erklär mir kurz die Kennzahl „{label}“ aus meinem Briefing.", { label: spec.label })} facts={`${spec.label}: ${finalText}. ${captionText(spec.caption)}`} />
      </div>
    </div>
  );
}

/** Beschriftung als reiner Text (für die Frage an Nyx). */
function captionText(caption: ReactNode): string {
  return typeof caption === "string" || typeof caption === "number" ? String(caption) : "";
}

export function KpiGrid({ figures, highlights }: { figures: BriefingFigures; highlights: readonly BriefTileKey[] }) {
  const server = useServerStatus();
  const specs = tileSpecs(figures, server);
  return (
    <section aria-label={t("Kennzahlen")} data-testid="briefing-kpis" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 @sm:grid-cols-2 @3xl:grid-cols-3 @[1500px]:grid-cols-9">
      {BRIEF_TILE_KEYS.map((k, i) => (
        <BriefTile key={k} spec={specs[k]} highlight={highlights.includes(k)} index={i} />
      ))}
    </section>
  );
}

// ───────────────────────────── Graphen ─────────────────────────────

/** Kategorien für Ordner im Commit-Diagramm: bunt, nie grau, keine Zustandsfarbe außer als letzte Wahl. */
const REPO_COLORS = ["var(--a-teal)", "var(--a-violet)", "var(--a-lime)", "var(--a-done)"];
const OTHER_COLOR = "var(--a-indigo)";

const STAGE_META: Record<BriefTaskStage, { label: string; color: string }> = {
  geplant: { label: t("Geplant"), color: "var(--a-indigo)" },
  startklar: { label: t("Startklar"), color: "var(--a-teal)" },
  laeuft: { label: t("Läuft"), color: "var(--a-ok)" },
  pruefen: { label: t("Prüfen"), color: "var(--a-wait)" },
  erledigt: { label: t("Erledigt"), color: "var(--a-done)" },
};

const USAGE_SERIES: AreaSeries[] = [
  { key: "claude", label: "Claude", color: "var(--a-claude)" },
  { key: "codex", label: "Codex", color: "var(--a-codex)" },
];

function ChartCard({ chartKey, title, sub, color, index, total, children }: { chartKey: BriefChartKey; title: string; sub: string; color: string; index: number; total?: ReactNode; children: ReactNode }) {
  const id = `brief-chart-${chartKey}`;
  return (
    // Auch die Graphen werden vorgelesen – beim Vorlesen bekommt der aktive Graph den Rahmen in seiner Farbe.
    <figure data-brief-chart={chartKey} data-speech-target={`chart:${chartKey}`} aria-labelledby={id} className="cc-card cc-rise m-0 grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-4 sm:p-5" style={{ ...riseStyle(index + 3), "--speech-accent": color } as CSSProperties}>
      <figcaption className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-[3px]" style={{ background: color }} />
        <span id={id} className="font-display text-headline font-semibold text-a-ink">
          {title}
        </span>
        <span className="text-caption text-a-mut">{sub}</span>
        {total !== undefined && <span className="ml-auto font-mono text-caption tabular-nums text-a-ink">{total}</span>}
      </figcaption>
      {children}
    </figure>
  );
}

const hourLabel = (x: string) => t("{hour} Uhr", { hour: x.padStart(2, "0") });

export function ChartGrid({ figures, order }: { figures: BriefingFigures; order: readonly BriefChartKey[] | undefined }) {
  const navigate = useNavigate();
  const c = figures.charts;
  const usageData = useMemo(() => c.usage7d.map((d) => ({ x: d.day, values: { claude: d.claude, codex: d.codex } })), [c.usage7d]);
  // Stunden als eindeutiger Schlüssel „Index:Stunde“, angezeigt wird nur die Stunde.
  const hourData = useMemo(() => c.sessionsHourly.map((h, i) => ({ x: `${i}:${h.hour}`, value: h.claude + h.codex })), [c.sessionsHourly]);
  const repoSeries = useMemo<AreaSeries[]>(() => c.commitRepos.map((r, i) => ({ key: r.key, label: r.label, color: r.key === "andere" ? OTHER_COLOR : (REPO_COLORS[i] ?? OTHER_COLOR) })), [c.commitRepos]);
  const commitData = useMemo(() => c.commitsDaily.map((d) => ({ x: d.day, values: d.repos })), [c.commitsDaily]);
  const stages = figures.tasks.byStage;
  const hourOf = (x: string) => x.split(":")[1] ?? x;
  const peakHour = c.sessionsHourly.reduce((m, h) => Math.max(m, h.claude + h.codex), 0);

  const charts: Record<BriefChartKey, (i: number) => ReactNode> = {
    usage_7d: (i) => (
      <ChartCard key="usage_7d" chartKey="usage_7d" index={i} title={t("Nutzung · 7 Tage")} sub={t("Tokens je Tag")} color="var(--a-claude)" total={formatTokensCompact(sumSplit(figures.usage.week))}>
        {/* Wie der Nutzung-Tab je eine eigene Linie, nicht gestapelt — sonst klebt die
            kleine Codex-Linie an der Claude-Kante und ist kaum zu sehen. */}
        <AreaChart data={usageData} series={USAGE_SERIES} height={220} ariaLabel={t("Nutzung der letzten 7 Tage, Claude und Codex")} formatValue={formatTokensCompact} formatTick={formatWeekday} formatTooltipX={formatDayLong} onSelect={() => navigate("/usage")} />
      </ChartCard>
    ),
    sessions_hourly: (i) => (
      <ChartCard key="sessions_hourly" chartKey="sessions_hourly" index={i} title={t("Sessions je Stunde")} sub={t("letzte 24 Stunden, Claude + Codex")} color="var(--a-ok)" total={t("Spitze {n}", { n: fmtCount(peakHour) })}>
        <BarChart data={hourData} height={220} color="var(--a-ok)" ariaLabel={t("Aktive Sessions je Stunde, letzte 24 Stunden")} unit="Sessions" formatValue={fmtCount} formatTick={(x) => hourOf(x).padStart(2, "0")} formatTooltipX={(x) => hourLabel(hourOf(x))} onSelect={() => navigate("/sessions")} />
      </ChartCard>
    ),
    commits_daily: (i) => (
      <ChartCard key="commits_daily" chartKey="commits_daily" index={i} title={t("Commits je Tag")} sub={t("14 Tage, nach Ordner")} color="var(--a-violet)" total={plural(figures.commits.week, "{n} Commit · 7 T", "{n} Commits · 7 T")}>
        {repoSeries.length > 0 ? (
          <AreaChart data={commitData} series={repoSeries} stacked height={220} ariaLabel={t("Commits je Tag der letzten 14 Tage nach Ordner")} formatValue={fmtCount} formatTick={formatDayShort} formatTooltipX={formatDayLong} onSelect={() => navigate("/git")} />
        ) : (
          <p className="py-8 text-center text-caption text-a-mut">{t("In den letzten 14 Tagen gab es keine Commits.")}</p>
        )}
      </ChartCard>
    ),
    tasks_progress: (i) => (
      <ChartCard key="tasks_progress" chartKey="tasks_progress" index={i} title={t("Aufgaben-Fortschritt")} sub={t("Aufträge je Stufe")} color="var(--a-indigo)" total={t("{n} erledigt", { n: fmtCount(stages.find((s) => s.stage === "erledigt")?.count ?? 0) })}>
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-5 @xl:justify-start">
          <Donut
            segments={stages.map((s) => ({ key: s.stage, label: STAGE_META[s.stage].label, value: s.count, color: STAGE_META[s.stage].color, display: fmtCount(s.count) }))}
            size={148}
            thickness={14}
            center={{ value: fmtCount(figures.tasks.open), label: t("offen") }}
            ariaLabel={t("Aufträge je Stufe")}
            onSelect={() => navigate("/tasks")}
          />
          <ul className="grid min-w-[min(100%,180px)] flex-1 gap-1.5">
            {stages.map((s) => (
              <li key={s.stage}>
                <Link to="/tasks" className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-callout transition-colors duration-150 hover:bg-a-p2">
                  <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STAGE_META[s.stage].color }} />
                  <span className="min-w-0 flex-1 truncate text-a-ink">{STAGE_META[s.stage].label}</span>
                  <span className="font-mono tabular-nums text-a-ink">{fmtCount(s.count)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </ChartCard>
    ),
  };

  return (
    <section aria-label={t("Graphen")} data-testid="briefing-charts" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 @5xl:grid-cols-2">
      {orderCharts(order).map((k, i) => charts[k](i))}
    </section>
  );
}
