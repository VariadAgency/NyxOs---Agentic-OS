// Tab "Nutzung": Zeitraum-/Werkzeug-Filter in EINER Zeile oben, Kennzahlen, leuchtender
// Verlauf pro Tag (Claude/Codex je eigene Linie; lückenlose Tage), Heatmap Tag × Stunde, Modelle als Donut
// + Anteils-Balken, Fenster als Ringe, teuerste Sessions. Alles anklickbar → Großansicht über
// `?day=`/`?model=`. Filterwechsel halten die vorigen Daten sichtbar (kein Flackern).
// Dazu: Ziele + Warnschwellen, Woche/Woche bzw. Monat/Monat, Claude gegen Codex, Modelle im Verlauf,
// Tokens je Baustelle, Blatt „Nutzung einstellen“ (`?einstellen=1`).
import { locale, t, tc, timeZone } from "@nyxos/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { PageShell } from "../../components/PageShell";
import { AreaChart, Donut, Heatmap, RingMeter, StatCard, fillDays, formatDayLong, formatDayShort, type AreaSeries, type DonutSegment } from "../../components/charts";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { fetchBaustellen, fetchComparison, fetchDailyUsage, fetchExpensiveSessions, fetchGoals, fetchHourly, fetchModelTrend, fetchModelUsage, fetchWindows, type ModelUsage, type OfficialStatus, type Range, type ToolFilter, type ToolWindow, type WindowForecast } from "./api";
import { BaustellenPanel, ModelTrendPanel, PeriodComparePanel, ToolsVersusPanel, type CompareKind } from "./ComparePanels";
import { GoalsPanel } from "./GoalsPanel";
import { UsageSettingsSheet, useUsageSettings } from "./UsageSettingsSheet";
import { formatTokensCompact, formatTokensFull, formatUsd } from "./format";
import { EmptyLine, modelColor, Panel, Segmented } from "./parts";
import { sessionLabel } from "../../lib/sessionLabel";

const RANGES: { value: Range; label: string; days: number | null }[] = [
  { value: "7", label: t("7 Tage"), days: 7 },
  { value: "30", label: t("30 Tage"), days: 30 },
  { value: "all", label: tc("period", "Alles"), days: null },
];
const TOOLS: { value: ToolFilter; label: string }[] = [
  { value: "all", label: t("Alle") },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];
// „Claude soll immer Codex überschreiben“: Claude zuerst in Legende/Tooltip, im Diagramm aber
// zuletzt gezeichnet (`onTop`) – die orange Claude-Linie liegt immer über der blauen Codex-Linie.
const SERIES: AreaSeries[] = [
  { key: "claude", label: "Claude", color: "var(--a-claude)" },
  { key: "codex", label: "Codex", color: "var(--a-codex)" },
];
const WEEKDAYS = [t("Mo"), t("Di"), t("Mi"), t("Do"), t("Fr"), t("Sa"), t("So")];
const WEEKDAYS_LONG = [t("Montag"), t("Dienstag"), t("Mittwoch"), t("Donnerstag"), t("Freitag"), t("Samstag"), t("Sonntag")];
const MODEL_SLOTS = 5;

const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone(), year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() });
const dayTimeFmt = new Intl.DateTimeFormat(locale(), { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: timeZone() });
const usdFmt = new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function todayLocal(): string {
  return localDay.format(new Date());
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

export function UsageView() {
  const [params, setParams] = useSearchParams();
  // Ohne `?range=` gilt der gespeicherte Standard-Zeitraum (Einstellungen), sonst 30 Tage.
  const settingsQ = useUsageSettings();
  const rangeParam = params.get("range") as Range | null;
  const range = rangeParam ?? settingsQ.data?.defaultRange ?? "30";
  const rangeReady = rangeParam !== null || !settingsQ.isPending;
  const compareKind: CompareKind = params.get("vgl") === "month" ? "month" : "week";
  const setCompareKind = (k: CompareKind) => setParams((p) => { p.set("vgl", k); return p; }, { replace: true });
  const settingsOpen = params.get("einstellen") === "1";
  const toggleSettings = (open: boolean) => setParams((p) => { if (open) p.set("einstellen", "1"); else p.delete("einstellen"); return p; }, { replace: true });
  const tool = (params.get("tool") as ToolFilter | null) ?? "all";
  const setRange = (r: Range) => setParams((p) => { p.set("range", r); return p; }, { replace: true });
  const setTool = (next: ToolFilter) => setParams((p) => { p.set("tool", next); return p; }, { replace: true });

  const dailyQ = useQuery({ queryKey: ["usage-daily", range, tool], queryFn: () => fetchDailyUsage(range, tool), placeholderData: keepPreviousData, enabled: rangeReady });
  const modelsQ = useQuery({ queryKey: ["usage-models", range], queryFn: () => fetchModelUsage(range), placeholderData: keepPreviousData, enabled: rangeReady });
  const hourlyQ = useQuery({ queryKey: ["usage-hourly", range, tool], queryFn: () => fetchHourly(range, tool), placeholderData: keepPreviousData, enabled: rangeReady });
  const windowsQ = useQuery({ queryKey: ["usage-window"], queryFn: fetchWindows, refetchInterval: 60_000 });
  const expensiveQ = useQuery({ queryKey: ["usage-expensive"], queryFn: () => fetchExpensiveSessions(10) });
  const compareQ = useQuery({ queryKey: ["usage-compare"], queryFn: fetchComparison, refetchInterval: 60_000 });
  const goalsQ = useQuery({ queryKey: ["usage-goals"], queryFn: fetchGoals, refetchInterval: 60_000 });
  const trendQ = useQuery({ queryKey: ["usage-model-trend"], queryFn: () => fetchModelTrend(12) });
  const baustellenQ = useQuery({ queryKey: ["usage-baustellen", range], queryFn: () => fetchBaustellen(range), placeholderData: keepPreviousData, enabled: rangeReady });

  const today = todayLocal();
  const byDay = useMemo(() => {
    const m = new Map<string, { day: string; claude: number; codex: number; cost: number; costMissing: boolean }>();
    for (const p of dailyQ.data ?? []) {
      const cur = m.get(p.day) ?? { day: p.day, claude: 0, codex: 0, cost: 0, costMissing: false };
      if (p.tool === "claude") cur.claude += p.totalTokens;
      else cur.codex += p.totalTokens;
      if (p.cost === null) cur.costMissing = true;
      else cur.cost += p.cost;
      m.set(p.day, cur);
    }
    const rows = [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
    const days = RANGES.find((r) => r.value === range)?.days ?? null;
    const from = days === null ? (rows[0]?.day ?? today) : shiftDay(today, -(days - 1));
    return fillDays(
      rows.filter((r) => r.day >= from),
      from,
      today,
      (day) => ({ day, claude: 0, codex: 0, cost: 0, costMissing: false }),
    );
  }, [dailyQ.data, range, today]);

  const totals = useMemo(() => {
    const perDay = byDay.map((d) => d.claude + d.codex);
    const missing = new Set((dailyQ.data ?? []).filter((p) => p.cost === null).map((p) => p.model));
    return {
      tokens: perDay.reduce((a, b) => a + b, 0),
      today: perDay.at(-1) ?? 0,
      todayRow: byDay.at(-1),
      cost: byDay.reduce((a, d) => a + d.cost, 0),
      missing: [...missing],
      activeDays: perDay.filter((v) => v > 0).length,
      spark: perDay.slice(-14),
    };
  }, [byDay, dailyQ.data]);

  // „Heute“ gegen gestern bis zur gleichen Uhrzeit (Server-Zeitzone); vor 06:00 kein Chip —
  // sonst stand kurz nach Mitternacht „▼ 99 %“ gegen den ganzen Vortag.
  const day = compareQ.data?.day;
  const dayTrend = day?.comparable
    ? { current: totals.today, previous: tool === "all" ? day.previous.tokens : (day.previous.byTool[tool] ?? 0), period: t("ggü. gestern bis {time}", { time: day.until }), upIsGood: null }
    : null;

  const heat = useMemo(() => {
    const grid = WEEKDAYS.map(() => new Array<number>(24).fill(0));
    for (const c of hourlyQ.data ?? []) {
      const row = grid[c.dow - 1];
      if (row && c.hour >= 0 && c.hour < 24) row[c.hour] = (row[c.hour] ?? 0) + c.tokens;
    }
    return grid;
  }, [hourlyQ.data]);

  const openDay = params.get("day");
  const openModel = params.get("model");
  const dayDetail = openDay ? (dailyQ.data ?? []).filter((p) => p.day === openDay) : null;
  const closeDetail = () => setParams((p) => { p.delete("day"); p.delete("model"); return p; }, { replace: true });
  const openDetail = (key: "day" | "model", value: string) => setParams((p) => { p.delete("day"); p.delete("model"); p.set(key, value); return p; });

  if (dailyQ.isPending) {
    return (
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 p-4 md:p-6" aria-busy>
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[148px] rounded-xl" />)}
        </div>
        <Skeleton className="h-[320px] rounded-xl" />
      </div>
    );
  }
  if (dailyQ.isError) {
    return (
      <div className="grid place-items-center p-10 text-center">
        <p className="mb-3 text-callout text-a-mut">{t("Nutzung konnte nicht geladen werden.")}</p>
        <button type="button" onClick={() => void dailyQ.refetch()} className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">{t("Erneut versuchen")}</button>
      </div>
    );
  }

  const series = tool === "all" ? SERIES : SERIES.filter((s) => s.key === tool);
  const refetching = dailyQ.isPlaceholderData || hourlyQ.isPlaceholderData || modelsQ.isPlaceholderData;
  const rangeLabel = RANGES.find((r) => r.value === range)?.label ?? "";

  return (
    <PageShell gap="gap-4">
      <header className="grid gap-3">
        <div className="grid gap-1">
          <h1 className="font-display text-title font-semibold text-a-ink">{t("Nutzung")}</h1>
          <p className="text-callout text-a-mut">{t("Claude und Codex über alle Projekte. Fremde Projekte erscheinen nur als Zahlen, nie mit Namen.")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label={t("Zeitraum")} options={RANGES} value={range} onChange={setRange} />
          <Segmented label={t("Werkzeug")} options={TOOLS} value={tool} onChange={setTool} />
          <button
            type="button"
            aria-expanded={settingsOpen}
            onClick={() => toggleSettings(!settingsOpen)}
            className={cn("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-caption transition-colors duration-150", settingsOpen ? "border-a-acc/60 bg-a-acc/10 text-a-ink" : "border-a-line bg-a-p text-a-mut hover:text-a-ink")}
          >
            <span aria-hidden>⚙</span>
            {t("Nutzung einstellen")}
          </button>
          {refetching && <span className="font-mono text-label text-a-mut" role="status">{t("lädt …")}</span>}
        </div>
      </header>

      {settingsOpen && <UsageSettingsSheet onClose={() => toggleSettings(false)} />}

      {dayDetail && dayDetail.length > 0 && openDay && (
        <DetailShell title={formatDayLong(openDay)} onClose={closeDetail}>
          <div className="grid gap-0.5 text-callout">
            {dayDetail.map((p) => (
              <div key={`${p.tool}-${p.model}-${p.project}`} className="grid grid-cols-[10px_minmax(0,1fr)_auto_88px] items-center gap-3 border-b border-a-line py-1.5 last:border-0">
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: p.tool === "claude" ? "var(--a-claude)" : "var(--a-codex)" }} />
                <span className="truncate text-a-ink">{p.model}</span>
                <span className="font-mono tabular-nums text-a-mut">{formatTokensFull(p.totalTokens)}</span>
                <span className="text-right font-mono tabular-nums text-a-mut">{formatUsd(p.cost)}</span>
              </div>
            ))}
          </div>
        </DetailShell>
      )}
      {openModel && (
        <DetailShell title={t("Modell {model}", { model: openModel })} onClose={closeDetail}>
          <ModelDetailBody model={openModel} range={range} />
        </DetailShell>
      )}

      <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-4 transition-opacity duration-200", refetching && "opacity-60")} aria-busy={refetching}>
        <section aria-label={t("Kennzahlen")} className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
          <StatCard id="usage-tokens" label={`Tokens · ${rangeLabel}`} value={totals.tokens} format={formatTokensCompact} sparkline={totals.spark} sparklineLabel={t("Tokens je Tag · 14 T")} />
          <StatCard
            id="usage-today"
            label={t("Heute")}
            value={totals.today}
            format={formatTokensCompact}
            trend={dayTrend}
            caption={tool === "all" && totals.todayRow ? `Claude ${formatTokensCompact(totals.todayRow.claude)} · Codex ${formatTokensCompact(totals.todayRow.codex)}` : t("bis jetzt")}
          />
          <StatCard
            id="usage-cost"
            label={t("API-Gegenwert")}
            value={totals.cost}
            format={(n) => usdFmt.format(n)}
            caption={totals.missing.length === 0 ? t("zu Listenpreisen, bezahlt ist das Abo") : totals.missing.length === 1 ? t("ohne {model} (kein Preis)", { model: totals.missing[0] }) : t("ohne {n} Modelle (kein Preis)", { n: totals.missing.length })}
            captionTone={totals.missing.length > 0 ? "wait" : null}
          />
          <StatCard id="usage-days" label={t("Aktive Tage")} value={totals.activeDays} format={(n) => String(Math.round(n))} caption={t("von {n} Tagen im Zeitraum", { n: byDay.length })} />
        </section>

        <GoalsPanel data={goalsQ.data} onEdit={() => toggleSettings(true)} />

        <Panel
          title={t("Verlauf pro Tag")}
          sub={tool === "all" ? t("Claude und Codex als je eine eigene Linie · Legende antippen blendet eine aus · Klick auf einen Tag öffnet ihn") : t("nur {tool} · Klick auf einen Tag öffnet ihn", { tool: tool === "claude" ? "Claude" : "Codex" })}
        >
          {byDay.every((d) => d.claude + d.codex === 0) ? (
            <EmptyLine>{t("Noch keine Nutzung in diesem Zeitraum.")}</EmptyLine>
          ) : (
            <AreaChart
              data={byDay.map((d) => ({ x: d.day, values: { claude: d.claude, codex: d.codex } }))}
              series={series}
              onTop="claude"
              toggleable
              height={260}
              ariaLabel={t("Tokens je Tag, {range}", { range: rangeLabel })}
              formatValue={formatTokensCompact}
              formatTick={formatDayShort}
              formatTooltipX={formatDayLong}
              onSelect={(day) => openDetail("day", day)}
            />
          )}
        </Panel>

        <PeriodComparePanel data={compareQ.data} kind={compareKind} onKind={setCompareKind} />
        <ToolsVersusPanel data={compareQ.data} kind={compareKind} />

        <Panel title={t("Aktivität nach Tag und Stunde")} sub={t("Ortszeit · {range}", { range: rangeLabel })}>
          {heat.every((row) => row.every((v) => v === 0)) ? (
            <EmptyLine>{t("Noch keine Nutzung in diesem Zeitraum.")}</EmptyLine>
          ) : (
            <Heatmap
              rowLabels={WEEKDAYS}
              colCount={24}
              colLabel={(c) => (c % 3 === 0 ? String(c).padStart(2, "0") : null)}
              values={heat}
              cellTitle={(r, c) => t("{day}, {from}–{to} Uhr", { day: WEEKDAYS_LONG[r] ?? "", from: String(c).padStart(2, "0"), to: String((c + 1) % 24).padStart(2, "0") })}
              formatValue={formatTokensCompact}
              ariaLabel={t("Tokens nach Wochentag und Stunde")}
            />
          )}
        </Panel>

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
          <ModelsPanel models={modelsQ.data ?? []} rangeLabel={rangeLabel} onOpen={(m) => openDetail("model", m)} />
          <WindowsPanel windows={windowsQ.data ?? null} />
        </div>

        <ModelTrendPanel data={trendQ.data} onOpen={(m) => openDetail("model", m)} />
        <BaustellenPanel data={baustellenQ.data} rangeLabel={rangeLabel} />

        <Panel title={t("Teuerste Sessions")} sub={t("Projekt-Sessions, zu Listenpreisen")}>
          {(expensiveQ.data ?? []).length === 0 ? (
            <EmptyLine>{t("Noch keine Sessions mit Nutzung.")}</EmptyLine>
          ) : (
            <ol className="grid gap-0.5">
              {(expensiveQ.data ?? []).map((s, i) => (
                <li key={s.id}>
                  <Link
                    to={`/sessions/_/_/${s.id.split(":").slice(1).join(":")}`}
                    className="grid grid-cols-[22px_minmax(0,1fr)_96px] items-center gap-3 rounded-lg px-2 py-2 text-callout transition-colors duration-150 hover:bg-a-p2"
                  >
                    <span className="font-mono text-label tabular-nums text-a-mut">{i + 1}</span>
                    <span className="grid min-w-0">
                      <span className="truncate text-a-ink">{sessionLabel(s)}</span>
                      <span className="truncate font-mono text-label text-a-mut">
                        {s.model ?? s.tool} · {t("{n} Tokens", { n: formatTokensCompact(s.totalTokens) })}
                      </span>
                    </span>
                    <span className="text-right font-mono tabular-nums text-a-ink">{s.cost === null ? "—" : formatUsd(s.cost)}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </PageShell>
  );
}

function ModelsPanel({ models, rangeLabel, onOpen }: { models: ModelUsage[]; rangeLabel: string; onOpen: (model: string) => void }) {
  const total = models.reduce((a, m) => a + m.totalTokens, 0);
  const rank = new Map<string, number>();
  const withColor = models.map((m) => {
    const r = rank.get(m.tool) ?? 0;
    rank.set(m.tool, r + 1);
    return { ...m, color: modelColor(m.tool, r) };
  });
  const top = withColor.slice(0, MODEL_SLOTS);
  const rest = withColor.slice(MODEL_SLOTS);
  const restTokens = rest.reduce((a, m) => a + m.totalTokens, 0);
  const segments: DonutSegment[] = [
    ...top.map((m) => ({ key: m.model, label: m.model, value: m.totalTokens, color: m.color, display: t("{n} Tokens", { n: formatTokensCompact(m.totalTokens) }) })),
    ...(restTokens > 0 ? [{ key: "_andere", label: t("{n} weitere", { n: rest.length }), value: restTokens, color: "var(--a-idle)", display: t("{n} Tokens", { n: formatTokensCompact(restTokens) }) }] : []),
  ];
  return (
    <Panel title={t("Modelle")} sub={t("Anteil an allen Tokens · {range}", { range: rangeLabel })}>
      {models.length === 0 ? (
        <EmptyLine>{t("Noch keine Modelle in diesem Zeitraum.")}</EmptyLine>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          <div className="justify-self-center">
            <Donut segments={segments} center={{ value: formatTokensCompact(total), label: "Tokens" }} ariaLabel={t("Anteile der Modelle an den Tokens")} onSelect={(k) => k !== "_andere" && onOpen(k)} />
          </div>
          <ul className="grid min-w-0 gap-0.5">
            {withColor.map((m) => {
              const share = total > 0 ? (m.totalTokens / total) * 100 : 0;
              return (
                <li key={`${m.tool}-${m.model}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(m.model)}
                    data-model={m.model}
                    className="grid w-full grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 rounded-lg px-2 py-1.5 text-left text-callout transition-colors duration-150 hover:bg-a-p2"
                  >
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: m.color }} />
                    <span className="truncate text-a-ink">{m.model}</span>
                    <span className="font-mono text-caption tabular-nums text-a-mut">
                      {share < 1 ? "<1" : Math.round(share)} % · {formatTokensCompact(m.totalTokens)}
                    </span>
                    <span />
                    <span className="col-span-2 h-1 overflow-hidden rounded-full bg-a-p3">
                      <span className="cc-progress-fill block h-full rounded-full" style={{ width: `${Math.max(1, share)}%`, background: m.color }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function windowPct(reported: number | null, current: number, peak: number): { pct: number | null; reported: boolean } {
  if (reported !== null) return { pct: reported, reported: true };
  return { pct: peak > 0 ? (current / peak) * 100 : null, reported: false };
}

function WindowCard({ w }: { w: ToolWindow }) {
  const five = windowPct(w.reported.fiveHourPct, w.tokens5h, w.peak5h);
  const week = windowPct(w.reported.weekPct, w.tokens7d, w.peak7d);
  const name = w.tool === "claude" ? "Claude Max" : "Codex";
  const relColor = w.tool === "claude" ? "var(--a-claude)" : "var(--a-codex)";
  const resets = w.reported.resetsAt ? new Date(w.reported.resetsAt) : null;
  // Echte Werte von Anthropic (OAuth-Nutzung über den Nyx-Motor oder die optionale macOS-App CodexBar) statt Schätzung.
  const fromCodexBar = w.reported.source === "codexbar";
  const fromAnthropic = w.reported.source === "anthropic" || fromCodexBar;
  const sourceName = fromCodexBar ? t("Von CodexBar (optional, macOS; Anthropic-Werte)") : t("Von Anthropic");
  const missingReal = w.tool === "claude" && w.official && !w.official.fresh ? missingRealText(w.official) : null;
  const fetchedAt = w.reported.fetchedAt ? new Date(w.reported.fetchedAt) : null;
  const weekResets = w.reported.weekResetsAt ? new Date(w.reported.weekResetsAt) : null;
  return (
    <div className="grid gap-3 rounded-lg border border-a-line/70 bg-a-bg/30 p-3" data-window={w.tool}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-callout font-medium text-a-ink">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: relColor }} />
          {name}
        </span>
        {w.reported.limitReached && resets ? (
          <span className="rounded-full bg-a-wait/12 px-2 py-0.5 text-caption font-medium text-a-wait">{t("Limit erreicht · frei ab {time}", { time: timeFmt.format(resets) })}</span>
        ) : fromAnthropic ? (
          <span className="rounded-full bg-a-ok/12 px-2 py-0.5 text-caption font-medium text-a-ok" data-source={w.reported.source ?? undefined}>
            {sourceName}
            {fetchedAt ? ` · ${t("Stand {time}", { time: timeFmt.format(fetchedAt) })}` : ""}
          </span>
        ) : resets && w.tool === "claude" ? (
          <span className="text-caption text-a-mut">{t("zuletzt am Limit · frei seit {time}", { time: dayTimeFmt.format(resets) })}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-5">
        <div className="grid justify-items-center gap-1.5">
          <RingMeter pct={five.pct} color={five.reported ? undefined : relColor} sub={t("5 Std")} ariaLabel={t("{name}, 5-Stunden-Fenster", { name })} />
          <span className="font-mono text-label tabular-nums text-a-mut">{t("{n} Tokens", { n: formatTokensCompact(w.tokens5h) })}</span>
        </div>
        <div className="grid justify-items-center gap-1.5">
          <RingMeter pct={week.pct} color={week.reported ? undefined : relColor} sub={t("Woche")} ariaLabel={t("{name}, Woche", { name })} />
          <span className="font-mono text-label tabular-nums text-a-mut">{t("{n} Tokens", { n: formatTokensCompact(w.tokens7d) })}</span>
        </div>
      </div>
      <ForecastLines forecast={w.forecast ?? []} />
      <p className="text-caption leading-snug text-a-mut">
        {fromAnthropic
          ? `${fromCodexBar ? t("Anthropic-Werte über CodexBar (optional, macOS)") : t("Werte direkt von Anthropic")}${resets ? ` · ${t("Sitzung frei ab {time}", { time: timeFmt.format(resets) })}` : ""}${weekResets ? ` · ${t("Woche neu ab {time}", { time: dayTimeFmt.format(weekResets) })}` : ""}.`
          : five.reported || week.reported
          ? t("Prozent vom Anbieter gemeldet.")
          : t("Anteil an deinem stärksten Fenster (5 Std: {five}, Woche: {week}). Das echte Limit nennt {vendor} nicht.", { five: formatTokensCompact(w.peak5h), week: formatTokensCompact(w.peak7d), vendor: w.tool === "claude" ? "Anthropic" : "OpenAI" })}
      </p>
      {missingReal ? (
        <p className="text-caption leading-snug text-a-wait" data-real-limits="missing">
          {missingReal}
        </p>
      ) : null}
    </div>
  );
}

/** Warum gerade keine echten Claude-Limits da sind — Grund des OAuth-Wegs und Stand von CodexBar (optional, macOS). */
function missingRealText(o: OfficialStatus): string {
  const reason = o.errorText ?? t("Keine Quelle meldet gerade Werte.");
  const codexbar = o.codexbarAt
    ? t("CodexBar (optional, macOS) zuletzt {time} (zu alt)", { time: dayTimeFmt.format(new Date(o.codexbarAt)) })
    : t("CodexBar (optional, macOS) meldet nichts – nur nötig, wenn du die App nutzt");
  return t("Echte Limits nicht verfügbar: {reason} {codexbar}.", { reason, codexbar });
}

/** „Limit-Wecker“: je Fenster eine Zeile — gelb, wenn es bei diesem Tempo vor dem Reset voll wird. */
function ForecastLines({ forecast }: { forecast: WindowForecast[] }) {
  const lines = forecast.filter((f) => f.line);
  if (lines.length === 0) return null;
  return (
    <ul className="grid gap-1" aria-label={t("Hochrechnung")}>
      {lines.map((f) => {
        // Nur echte Werte dürfen „voll“ hervorheben; eine Schätzung (Token-Summen) bleibt grau.
        const estimate = f.basis === "last_limit";
        const full = !estimate && f.hitsLimitAt !== null && (f.pct ?? 0) < 100;
        return (
          <li
            key={f.window}
            data-forecast={estimate ? "schaetzung" : full ? "voll" : f.pct === null ? "unbekannt" : "reicht"}
            className={cn("flex items-start gap-2 rounded-md px-2 py-1 text-caption leading-snug", full ? "bg-a-wait/12 font-medium text-a-wait" : "text-a-mut")}
          >
            <span className="w-12 shrink-0 font-mono text-label uppercase tracking-wide">{f.window === "5h" ? t("5 Std") : t("Woche")}</span>
            <span className="min-w-0">{f.line}</span>
          </li>
        );
      })}
    </ul>
  );
}

function WindowsPanel({ windows }: { windows: ToolWindow[] | null }) {
  return (
    <Panel title={t("Fenster und Limits")} sub={t("Letzte 5 Stunden und letzte 7 Tage")}>
      {windows === null ? (
        <Skeleton className="h-[220px] rounded-lg" />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          {windows.map((w) => (
            <WindowCard key={w.tool} w={w} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function DetailShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div data-testid="usage-detail" className="grid min-w-0 gap-2 rounded-xl border border-a-acc/40 bg-a-p2 p-4 shadow-[0_8px_24px_rgba(0,0,0,.35)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="truncate font-display text-headline font-semibold text-a-ink">{title}</h2>
        <button type="button" onClick={onClose} className="shrink-0 rounded-md px-2 py-1 text-caption text-a-mut hover:bg-a-p3 hover:text-a-ink">{t("Schließen ✕")}</button>
      </div>
      {children}
    </div>
  );
}

function ModelDetailBody({ model, range }: { model: string; range: Range }) {
  const q = useQuery({ queryKey: ["usage-daily", range, "all"], queryFn: () => fetchDailyUsage(range, "all") });
  const rows = (q.data ?? []).filter((p) => p.model === model);
  const total = rows.reduce((a, r) => a + r.totalTokens, 0);
  const cost = rows.some((r) => r.cost === null) ? null : rows.reduce((a, r) => a + (r.cost ?? 0), 0);
  const days = new Set(rows.map((r) => r.day));
  const last = rows.at(-1)?.day ?? null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-callout">
      <dt className="text-a-mut">{t("Tage genutzt")}</dt><dd className="font-mono tabular-nums">{days.size}</dd>
      <dt className="text-a-mut">Tokens</dt><dd className="font-mono tabular-nums">{formatTokensFull(total)}</dd>
      <dt className="text-a-mut">{t("API-Gegenwert")}</dt><dd className="font-mono tabular-nums">{cost === null ? t("kein Preis hinterlegt") : formatUsd(cost)}</dd>
      <dt className="text-a-mut">{tc("usage", "Zuletzt")}</dt><dd>{last ? formatDayLong(last) : "—"}</dd>
    </dl>
  );
}
