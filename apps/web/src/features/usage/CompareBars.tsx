// Balkenpaare „jetzt gegen vorher“ je Tag des Zeitraums (Woche: Mo–So, Monat: 1.–31.).
// Stil wie BarChart: Vorperiode gedämpft im Akzent-Ton, laufende Periode
// im Akzent. Ein Tag ohne Wert (`null`: Zukunft bzw. im kürzeren Vormonat nicht vorhanden) bekommt
// KEINEN Balken — nie eine 0, die wie „nichts genutzt“ aussieht. Tastatur: ←/→ wie die anderen Diagramme.
import { t } from "@nyxos/shared";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { barPath } from "../../components/charts/BarChart";
import { ChartLegend, ChartTooltip, tooltipLeft } from "../../components/charts/ChartTooltip";
import { useChartWidth, useReveal } from "../../components/charts/hooks";
import { niceTicks } from "../../components/charts/scale";

export interface CompareSlot {
  key: string;
  tick: string;
  current: number | null;
  previous: number | null;
  currentTitle: string | null;
  previousTitle: string | null;
}

const M = { top: 16, right: 8, bottom: 24, left: 48 };
export const CURRENT_COLOR = "var(--a-acc)";
export const PREVIOUS_COLOR = "color-mix(in srgb, var(--a-acc) 45%, var(--a-p3))";

export function CompareBars({ slots, currentLabel, previousLabel, formatValue, ariaLabel, height = 200, initialWidth }: { slots: CompareSlot[]; currentLabel: string; previousLabel: string; formatValue: (n: number) => string; ariaLabel: string; height?: number; initialWidth?: number }) {
  const [ref, width] = useChartWidth<HTMLDivElement>(initialWidth ?? 640);
  const [active, setActive] = useState<number | null>(null);
  const reveal = useReveal(slots.length > 0);
  const n = slots.length;
  const plotW = Math.max(40, width - M.left - M.right);
  const plotH = Math.max(40, height - M.top - M.bottom);

  const geo = useMemo(() => {
    const max = Math.max(0, ...slots.flatMap((s) => [s.current ?? 0, s.previous ?? 0]));
    const ticks = niceTicks(max, 3);
    const yMax = ticks.at(-1) ?? 1;
    const band = plotW / Math.max(1, n);
    const barW = Math.min(14, Math.max(2, band * 0.34));
    const gap = Math.min(3, band * 0.06);
    const y = (v: number) => M.top + plotH - (v / yMax) * plotH;
    return { ticks, yMax, band, barW, gap, y };
  }, [slots, n, plotW, plotH]);

  if (n === 0) return null;
  const tickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 44))));
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - rect.left - M.left) / geo.band)));
    setActive((p) => (p === i ? p : i));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? n - 1;
    const next = e.key === "ArrowRight" ? Math.min(n - 1, cur + 1) : e.key === "ArrowLeft" ? Math.max(0, cur - 1) : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : e.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };
  const a = active !== null ? slots[active] : null;
  const ax = active !== null ? M.left + geo.band * active + geo.band / 2 : 0;
  const h = (v: number | null) => (v === null ? 0 : ((M.top + plotH - geo.y(v)) * reveal));

  return (
    <div className="grid gap-2">
      <ChartLegend items={[{ key: "prev", label: previousLabel, color: PREVIOUS_COLOR }, { key: "cur", label: currentLabel, color: CURRENT_COLOR }]} />
      <div
        ref={ref}
        data-chart="compare"
        tabIndex={0}
        role="group"
        aria-roledescription={t("Diagramm")}
        aria-label={t("{label}. Pfeiltasten wählen einen Tag.", { label: ariaLabel })}
        onKeyDown={onKey}
        onFocus={() => setActive((p) => p ?? n - 1)}
        onBlur={() => setActive(null)}
        className="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-a-acc/60"
        style={{ height }}
      >
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          {geo.ticks.map((tick) => (
            <g key={tick}>
              <line x1={M.left} x2={M.left + plotW} y1={geo.y(tick)} y2={geo.y(tick)} stroke="var(--a-line)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={M.left - 8} y={geo.y(tick)} dy="0.32em" textAnchor="end" className="fill-a-mut font-mono text-label tabular-nums">
                {formatValue(tick)}
              </text>
            </g>
          ))}
          {slots.map((s, i) => {
            const cx = M.left + geo.band * i + geo.band / 2;
            const hp = h(s.previous);
            const hc = h(s.current);
            const dim = active !== null && active !== i;
            return (
              <g key={s.key} opacity={dim ? 0.55 : 1} style={{ transition: "opacity 150ms" }}>
                {active === i && <rect x={M.left + geo.band * i} y={M.top - 4} width={geo.band} height={plotH + 4} rx={4} fill="var(--a-p2)" />}
                {s.previous !== null && <path d={barPath(cx - geo.barW - geo.gap / 2, M.top + plotH - hp, geo.barW, hp)} fill={PREVIOUS_COLOR} />}
                {s.current !== null && <path d={barPath(cx + geo.gap / 2, M.top + plotH - hc, geo.barW, hc)} fill={CURRENT_COLOR} />}
                {i % tickEvery === 0 || i === n - 1 ? (
                  <text x={cx} y={height - 6} textAnchor="middle" className={active === i ? "fill-a-ink font-mono text-label" : "fill-a-mut font-mono text-label"}>
                    {s.tick}
                  </text>
                ) : null}
              </g>
            );
          })}
          <rect x={M.left} y={0} width={plotW} height={M.top + plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setActive(null)} style={{ cursor: "crosshair" }} />
        </svg>
        {a && (
          <ChartTooltip
            title={a.currentTitle ?? a.previousTitle ?? a.tick}
            left={tooltipLeft(ax, width)}
            rows={[
              { key: "cur", label: a.currentTitle ? currentLabel : t("{label} (noch offen)", { label: currentLabel }), value: a.current === null ? "—" : formatValue(a.current), color: CURRENT_COLOR },
              { key: "prev", label: a.previousTitle ?? previousLabel, value: a.previous === null ? "—" : formatValue(a.previous), color: PREVIOUS_COLOR },
            ]}
          />
        )}
      </div>
      <div className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th scope="col">{t("Tag")}</th>
              <th scope="col">{currentLabel}</th>
              <th scope="col">{previousLabel}</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => (
              <tr key={s.key}>
                <th scope="row">{s.tick}</th>
                <td>{s.current === null ? "—" : formatValue(s.current)}</td>
                <td>{s.previous === null ? "—" : formatValue(s.previous)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
