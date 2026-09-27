// Vergleiche im Tab „Nutzung“ — Woche/Woche bzw. Monat/Monat (fairer Stand), Claude gegen
// Codex, Modelle im Wochenverlauf und Tokens je Baustelle. Nur Daten vom Server (usage/compare.ts).
import { locale, t } from "@nyxos/shared";
import { useState } from "react";
import { Link } from "react-router";
import { AreaChart, TrendChip, formatDayLong, formatDayShort, type AreaSeries } from "../../components/charts";
import { Skeleton } from "../../components/ui/skeleton";
import type { BaustellenUsage, ModelTrend, PeriodComparison, UsageComparison } from "./api";
import { CompareBars, type CompareSlot } from "./CompareBars";
import { formatTokensCompact, formatUsd } from "./format";
import { EmptyLine, modelColor, Panel, Segmented, TOOL_NAME, toolColor } from "./parts";

export type CompareKind = "week" | "month";
const KINDS: { value: CompareKind; label: string }[] = [
  { value: "week", label: t("Woche") },
  { value: "month", label: t("Monat") },
];
const LABELS: Record<CompareKind, { current: string; previous: string; previousFull: string }> = {
  week: { current: t("diese Woche"), previous: t("Vorwoche"), previousFull: t("ganze Vorwoche") },
  month: { current: t("dieser Monat"), previous: t("Vormonat"), previousFull: t("ganzer Vormonat") },
};
const weekdayFmt = new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" });

function trendOf(p: { current: number; previous: number }, period: string) {
  return { current: p.current, previous: p.previous, period, upIsGood: null };
}

export function PeriodComparePanel({ data, kind, onKind }: { data: UsageComparison | undefined; kind: CompareKind; onKind: (k: CompareKind) => void }) {
  const p = data?.[kind];
  const l = LABELS[kind];
  return (
    <Panel
      title={t("Zeitraum im Vergleich")}
      sub={t("{period} · verglichen wird immer bis zum gleichen Stand (Tag und Uhrzeit)", { period: kind === "week" ? t("Woche für Woche") : t("Monat für Monat") })}
      action={<Segmented label={t("Vergleich")} options={KINDS} value={kind} onChange={onKind} />}
    >
      {!p ? (
        <Skeleton className="h-[260px] rounded-lg" />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div className="grid gap-1">
              <span className="font-mono text-label uppercase tracking-wider text-a-mut">{l.current}</span>
              <div className="flex items-center gap-2">
                <span className="font-display text-[32px] font-semibold leading-none tabular-nums text-a-ink">{formatTokensCompact(p.current.tokens)}</span>
                <TrendChip trend={trendOf({ current: p.current.tokens, previous: p.previous.tokens }, t("ggü. {prev}", { prev: l.previous }))} />
              </div>
            </div>
            <div className="grid gap-0.5 pb-0.5 text-caption text-a-mut">
              <span>
                {t("{prev} bis zum gleichen Stand: {n}", { prev: l.previous, n: formatTokensCompact(p.previous.tokens) })}
              </span>
              <span>
                {l.previousFull}: {formatTokensCompact(p.previousFull.tokens)}
              </span>
            </div>
          </div>
          <CompareBars slots={slotsOf(p)} currentLabel={l.current} previousLabel={l.previous} formatValue={formatTokensCompact} ariaLabel={t("Tokens je Tag, {cur} gegen {prev}", { cur: l.current, prev: l.previous })} />
        </>
      )}
    </Panel>
  );
}

function slotsOf(p: PeriodComparison): CompareSlot[] {
  const { currentDays, previousDays, current, previous } = p.series;
  return currentDays.map((cd, i) => {
    const pd = previousDays[i] ?? null;
    const anyDay = cd ?? pd ?? "";
    return {
      key: String(i),
      tick: p.kind === "week" ? weekdayFmt.format(new Date(`${anyDay}T00:00:00Z`)) : String(i + 1),
      current: current[i] ?? null,
      previous: previous[i] ?? null,
      currentTitle: cd ? formatDayLong(cd) : null,
      previousTitle: pd ? formatDayLong(pd) : null,
    };
  });
}

export function ToolsVersusPanel({ data, kind }: { data: UsageComparison | undefined; kind: CompareKind }) {
  const p = data?.[kind];
  const l = LABELS[kind];
  return (
    <Panel title={t("Claude und Codex")} sub={t("{cur} gegenübergestellt · Veränderung ggü. {prev} (gleicher Stand)", { cur: l.current, prev: l.previous })}>
      {!p ? (
        <Skeleton className="h-[200px] rounded-lg" />
      ) : p.current.tokens === 0 && p.previous.tokens === 0 ? (
        <EmptyLine>{t("In diesem Zeitraum noch keine Nutzung.")}</EmptyLine>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <div className="flex h-3 overflow-hidden rounded-full bg-a-p3" aria-hidden>
              {p.tools.map((side) => (
                <span key={side.tool} className="cc-progress-fill block h-full" style={{ width: `${side.share}%`, background: toolColor(side.tool) }} />
              ))}
            </div>
            <p className="font-mono text-caption tabular-nums text-a-mut">{p.tools.map((side) => `${TOOL_NAME[side.tool]} ${shareText(side.share)} %`).join(" · ")}</p>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[repeat(2,minmax(0,1fr))]">
            {p.tools.map((side) => (
              <div key={side.tool} data-tool-side={side.tool} className="grid content-start gap-2 rounded-lg border border-a-line/70 bg-a-bg/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-callout font-medium text-a-ink">
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: toolColor(side.tool) }} />
                    {TOOL_NAME[side.tool]}
                  </span>
                  <TrendChip trend={trendOf({ current: side.tokens, previous: side.previousTokens }, t("ggü. {prev}", { prev: l.previous }))} />
                </div>
                <span className="font-display text-[26px] font-semibold leading-none tabular-nums text-a-ink">{formatTokensCompact(side.tokens)}</span>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
                  <dt className="text-a-mut">{l.previous}</dt>
                  <dd className="text-right font-mono tabular-nums text-a-ink">{formatTokensCompact(side.previousTokens)}</dd>
                  <dt className="text-a-mut">{t("Aktive Tage")}</dt>
                  <dd className="text-right font-mono tabular-nums text-a-ink">{side.activeDays}</dd>
                  <dt className="text-a-mut">{t("Ø je aktivem Tag")}</dt>
                  <dd className="text-right font-mono tabular-nums text-a-ink">{side.activeDays > 0 ? formatTokensCompact(side.tokens / side.activeDays) : "—"}</dd>
                  <dt className="text-a-mut">{t("API-Gegenwert")}</dt>
                  <dd className="text-right font-mono tabular-nums text-a-ink">
                    {formatUsd(side.cost)}
                    {!side.costComplete && <span className="text-a-wait"> *</span>}
                  </dd>
                  <dt className="text-a-mut">{t("Meistes Modell")}</dt>
                  <dd className="truncate text-right text-a-ink">{side.topModel ?? "—"}</dd>
                </dl>
              </div>
            ))}
          </div>
          {p.tools.some((side) => !side.costComplete) && <p className="text-caption text-a-wait">{t("* ohne Modelle, für die kein Preis hinterlegt ist")}</p>}
        </div>
      )}
    </Panel>
  );
}

function shareText(share: number): string {
  return share > 0 && share < 1 ? "<1" : String(Math.round(share));
}

const TREND_TOP = 5;
type TrendMode = "share" | "tokens";

export function ModelTrendPanel({ data, onOpen }: { data: ModelTrend | undefined; onOpen: (model: string) => void }) {
  const [mode, setMode] = useState<TrendMode>("share");
  if (!data) {
    return (
      <Panel title={t("Modelle im Verlauf")} sub={t("je Woche")}>
        <Skeleton className="h-[260px] rounded-lg" />
      </Panel>
    );
  }
  const rank = new Map<string, number>();
  const top = data.models.slice(0, TREND_TOP).map((m) => {
    const r = rank.get(m.tool) ?? 0;
    rank.set(m.tool, r + 1);
    return { ...m, key: `${m.tool}|${m.model}`, color: modelColor(m.tool, r) };
  });
  const rest = data.models.slice(TREND_TOP);
  const series: AreaSeries[] = [...top.map((m) => ({ key: m.key, label: m.model, color: m.color })), ...(rest.length > 0 ? [{ key: "_rest", label: t("{n} weitere", { n: rest.length }), color: "var(--a-idle)" }] : [])];
  // Wochen vor der ersten Nutzung weglassen — sonst läge eine lange „0 %“-Linie vor dem Beginn der Aufzeichnung.
  const firstUsed = data.weeks.findIndex((_, i) => data.models.some((m) => (m.tokens[i] ?? 0) > 0));
  const points = data.weeks.map((week, i) => {
    const raw: Record<string, number> = {};
    for (const m of top) raw[m.key] = m.tokens[i] ?? 0;
    if (rest.length > 0) raw._rest = rest.reduce((a, m) => a + (m.tokens[i] ?? 0), 0);
    const sum = Object.values(raw).reduce((a, b) => a + b, 0);
    const values = mode === "tokens" ? raw : Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, sum > 0 ? (v / sum) * 100 : 0]));
    return { x: week, values };
  }).slice(Math.max(0, firstUsed));
  return (
    <Panel
      title={t("Modelle im Verlauf")}
      sub={t("je Kalenderwoche · {mode} · Klick auf ein Modell öffnet es", { mode: mode === "share" ? t("Anteil an allen Tokens der Woche") : "Tokens" })}
      action={
        <Segmented
          label={t("Darstellung")}
          options={[
            { value: "share", label: t("Anteil") },
            { value: "tokens", label: "Tokens" },
          ]}
          value={mode}
          onChange={setMode}
        />
      }
    >
      {data.models.length === 0 ? (
        <EmptyLine>{t("Noch keine Modelle in den letzten Wochen.")}</EmptyLine>
      ) : (
        <>
          <AreaChart
            data={points}
            series={series}
            stacked
            height={240}
            peakLabel={mode === "tokens"}
            ariaLabel={mode === "share" ? t("Anteil der Modelle je Woche") : t("Tokens der Modelle je Woche")}
            formatValue={mode === "share" ? (n) => `${Math.round(n)} %` : formatTokensCompact}
            formatTick={formatDayShort}
            formatTooltipX={(w) => t("Woche ab {day}", { day: formatDayLong(w) })}
          />
          <ul className="flex flex-wrap gap-1.5">
            {top.map((m) => (
              <li key={m.key}>
                <button type="button" onClick={() => onOpen(m.model)} className="inline-flex items-center gap-1.5 rounded-full border border-a-line px-2.5 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-p2">
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: m.color }} />
                  {m.model}
                  <span className="font-mono text-label text-a-mut">{formatTokensCompact(m.total)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

const BAUSTELLEN_TOP = 8;

export function BaustellenPanel({ data, rangeLabel }: { data: BaustellenUsage | undefined; rangeLabel: string }) {
  const [all, setAll] = useState(false);
  if (!data) {
    return (
      <Panel title={t("Nach Baustelle")} sub={rangeLabel}>
        <Skeleton className="h-[220px] rounded-lg" />
      </Panel>
    );
  }
  const max = data.items[0]?.tokens ?? 0;
  const shown = all ? data.items : data.items.slice(0, BAUSTELLEN_TOP);
  const hidden = data.items.length - shown.length;
  return (
    <Panel title={t("Nach Baustelle")} sub={t("Projekt-Sessions · {range} · Klick öffnet die Baustelle", { range: rangeLabel })}>
      {data.items.length === 0 ? (
        <EmptyLine>{t("Noch keine Nutzung einer Baustelle zugeordnet.")}</EmptyLine>
      ) : (
        <ol className="grid gap-0.5">
          {shown.map((b, i) => (
            <li key={b.slug}>
              <Link
                to={`/sessions/${encodeURIComponent(b.art)}/${encodeURIComponent(b.slug)}`}
                className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-callout transition-colors duration-150 hover:bg-a-p2"
              >
                <span className="font-mono text-label tabular-nums text-a-mut">{i + 1}</span>
                <span className="truncate text-a-ink">{b.label}</span>
                <span className="font-mono text-caption tabular-nums text-a-mut">
                  {formatTokensCompact(b.tokens)} · {b.sessions === 1 ? t("1 Session") : t("{n} Sessions", { n: b.sessions })}
                </span>
                <span />
                <span className="col-span-2 flex h-1.5 overflow-hidden rounded-full bg-a-p3" aria-hidden>
                  <span className="cc-progress-fill block h-full" style={{ width: `${max > 0 ? (b.claude / max) * 100 : 0}%`, background: toolColor("claude") }} />
                  <span className="cc-progress-fill block h-full" style={{ width: `${max > 0 ? (b.codex / max) * 100 : 0}%`, background: toolColor("codex") }} />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-a-mut">
          {t("ohne Baustelle {a} · andere Projekte {b} (nur als Summe)", { a: formatTokensCompact(data.ohneBaustelle), b: formatTokensCompact(data.andere) })}
        </p>
        {hidden > 0 && (
          <button type="button" onClick={() => setAll(true)} className="rounded-md border border-a-line px-2.5 py-1 text-caption text-a-ink hover:bg-a-p2">
            {t("{n} weitere zeigen", { n: hidden })}
          </button>
        )}
      </div>
    </Panel>
  );
}
