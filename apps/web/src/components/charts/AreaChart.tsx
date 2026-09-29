// Flächen-Diagramm mit Leuchten (dataviz):
// 2-px-Linie je Reihe mit weichem Schein, Fläche als Verlauf (Farbe 35 % → 0 %), optional gestapelt
// in fester Reihenfolge (erste Reihe unten, nie nach Rang umsortiert). Fadenkreuz rastet am nächsten
// Datenpunkt ein, EIN Tooltip nennt alle Reihen. Tastatur: Fokus → ←/→/Pos1/Ende, Enter wählt.
// Ungestapelt zeigt jede Linie ihren eigenen Wert, die spätere Reihe liegt OBEN und alle Linien
// über allen Flächen. `onTop` holt eine Reihe ganz nach oben (Nutzung: Claude überdeckt immer Codex),
// ohne Legende/Tooltip umzusortieren. `toggleable`: Legende blendet Reihen aus, die Skala folgt.
// Die X-Achse ist gleichabständig — Lücken füllt der Aufrufer mit 0 (`fillDays`), nie überspringen.
import { t } from "@nyxos/shared";
import { useCallback, useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChartLegend, ChartTooltip, tooltipLeft } from "./ChartTooltip";
import { useChartWidth, useReveal } from "./hooks";
import { monotonePath, niceTicks, tickIndices } from "./scale";

export interface AreaSeries {
  key: string;
  label: string;
  /** CSS-Farbe aus den Tokens, z. B. `var(--a-acc)`. */
  color: string;
}

export interface AreaPoint {
  x: string;
  values: Record<string, number>;
}

export interface AreaChartProps {
  data: AreaPoint[];
  series: AreaSeries[];
  stacked?: boolean;
  /** Gesamthöhe inkl. X-Achse. */
  height?: number;
  ariaLabel: string;
  formatValue: (n: number) => string;
  formatTick: (x: string) => string;
  formatTooltipX: (x: string) => string;
  /** Spitzenwert direkt am Maximum beschriften (sparsame Direkt-Beschriftung). */
  peakLabel?: boolean;
  onSelect?: (x: string) => void;
  /** Für Tests/SSR: Breite ohne Messung. */
  initialWidth?: number;
  /** Legende als Schalter – Reihen aus-/einblenden, die Y-Skala passt sich an. */
  toggleable?: boolean;
  /** Schlüssel der Reihe, die (ungestapelt) über allen anderen gezeichnet wird – Fläche, Linie, Punkt. */
  onTop?: string;
}

const M = { top: 22, right: 16, bottom: 26, left: 48 };

export function AreaChart({ data, series: allSeries, stacked = false, height = 240, ariaLabel, formatValue, formatTick, formatTooltipX, peakLabel = true, onSelect, initialWidth, toggleable = false, onTop }: AreaChartProps) {
  const uid = useId().replace(/:/g, "");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (key: string) =>
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else if (allSeries.some((s) => s.key !== key && !next.has(s.key))) next.add(key);
        return next;
      }),
    [allSeries],
  );
  // Reihen wechseln von außen (Werkzeug-Filter) – wäre danach ALLES ausgeblendet, zeigen wir alle
  // (sonst leeres Diagramm, und bei einer Reihe gibt es keine Legende zum Zurückholen).
  const series = useMemo(() => {
    const shown = allSeries.filter((s) => !hidden.has(s.key));
    return shown.length > 0 ? shown : allSeries;
  }, [allSeries, hidden]);
  const [ref, width] = useChartWidth<HTMLDivElement>(initialWidth ?? 640);
  const [active, setActive] = useState<number | null>(null);
  const reveal = useReveal(data.length > 0);
  const n = data.length;
  const plotW = Math.max(40, width - M.left - M.right);
  const plotH = Math.max(40, height - M.top - M.bottom);

  const geo = useMemo(() => {
    // Gestapelt: obere Kante jeder Reihe = Summe bis einschließlich dieser Reihe.
    const tops = series.map(() => new Array<number>(n).fill(0));
    const bottoms = series.map(() => new Array<number>(n).fill(0));
    let max = 0;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      series.forEach((s, si) => {
        const v = Math.max(0, data[i]?.values[s.key] ?? 0);
        const base = stacked ? acc : 0;
        (bottoms[si] as number[])[i] = base;
        (tops[si] as number[])[i] = base + v;
        acc += v;
        max = Math.max(max, base + v);
      });
    }
    const ticks = niceTicks(max, 4);
    const yMax = ticks.at(-1) ?? 1;
    const x = (i: number) => M.left + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
    const y = (v: number) => M.top + plotH - (v / yMax) * plotH;
    const paths = series.map((s, si) => {
      const topPts = (tops[si] as number[]).map((v, i) => [x(i), y(v)] as [number, number]);
      const botPts = (bottoms[si] as number[]).map((v, i) => [x(i), y(v)] as [number, number]).reverse();
      const line = monotonePath(topPts);
      const lower = stacked && si > 0 ? monotonePath(botPts).replace(/^M/, "L") : `L${x(n - 1)},${y(0)}L${x(0)},${y(0)}`;
      return { key: s.key, color: s.color, line, area: `${line}${lower}Z` };
    });
    // Spitzenwert (Summe über alle Reihen) für die Direkt-Beschriftung.
    let peakIdx = -1;
    let peakVal = 0;
    for (let i = 0; i < n; i++) {
      const total = stacked ? (tops.at(-1)?.[i] ?? 0) : Math.max(...tops.map((t) => t[i] ?? 0));
      if (total > peakVal) {
        peakVal = total;
        peakIdx = i;
      }
    }
    return { tops, ticks, yMax, x, y, paths, peakIdx, peakVal };
  }, [data, series, stacked, n, plotW, plotH]);

  // Zeichenreihenfolge (ungestapelt) – die `onTop`-Reihe zuletzt, also oben. Legende/Tooltip bleiben in `series`-Reihenfolge.
  const drawOrder = useMemo(() => {
    const idx = series.map((_, si) => si);
    if (stacked || onTop === undefined) return idx;
    return [...idx.filter((si) => series[si]?.key !== onTop), ...idx.filter((si) => series[si]?.key === onTop)];
  }, [series, stacked, onTop]);
  const drawnPaths = drawOrder.flatMap((si) => (geo.paths[si] ? [geo.paths[si]] : []));

  const xTicks = useMemo(() => tickIndices(n, Math.max(2, Math.floor(plotW / 72))), [n, plotW]);

  if (n === 0) return null;

  const indexAt = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left - M.left;
    return Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : (px / plotW) * (n - 1))));
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const i = indexAt(e.clientX, svg.getBoundingClientRect());
    setActive((prev) => (prev === i ? prev : i));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? n - 1;
    let next: number | null;
    if (e.key === "ArrowRight") next = Math.min(n - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") next = null;
    else if ((e.key === "Enter" || e.key === " ") && onSelect && active !== null) {
      e.preventDefault();
      onSelect(data[active]?.x ?? "");
      return;
    } else return;
    e.preventDefault();
    setActive(next);
  };

  const a = active !== null ? data[active] : null;
  const ax = active !== null ? geo.x(active) : 0;
  const revealW = M.left + (plotW + M.right) * reveal;
  const total = a ? series.reduce((acc, s) => acc + (a.values[s.key] ?? 0), 0) : 0;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <ChartLegend items={allSeries} hidden={toggleable ? hidden : undefined} onToggle={toggleable ? toggle : undefined} />
      <div
        ref={ref}
        data-chart="area"
        tabIndex={0}
        role="group"
        aria-roledescription={t("Diagramm")}
        aria-label={onSelect ? t("{label}. Pfeiltasten wählen einen Tag, Enter öffnet ihn.", { label: ariaLabel }) : t("{label}. Pfeiltasten wählen einen Tag.", { label: ariaLabel })}
        onKeyDown={onKey}
        onFocus={() => setActive((p) => p ?? n - 1)}
        onBlur={() => setActive(null)}
        className="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-a-acc/60"
        style={{ height }}
      >
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          <defs>
            {geo.paths.map((p) => (
              <linearGradient key={p.key} id={`${uid}-fill-${p.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={p.color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={p.color} stopOpacity={0} />
              </linearGradient>
            ))}
            <filter id={`${uid}-glow`} x="-10%" y="-40%" width="120%" height="180%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
            <clipPath id={`${uid}-reveal`}>
              <rect x={0} y={0} width={revealW} height={height} />
            </clipPath>
          </defs>

          {/* Raster: Haarlinien, eine Stufe über der Fläche (dataviz: durchgezogen, zurückhaltend). */}
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={geo.y(t)} y2={geo.y(t)} stroke="var(--a-line)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={M.left - 8} y={geo.y(t)} dy="0.32em" textAnchor="end" className="fill-a-mut font-mono text-label tabular-nums">
                {formatValue(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text
              key={i}
              x={geo.x(i)}
              y={height - 6}
              textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"}
              className={i === active ? "fill-a-ink font-mono text-label" : "fill-a-mut font-mono text-label"}
            >
              {formatTick(data[i]?.x ?? "")}
            </text>
          ))}

          <g clipPath={`url(#${uid}-reveal)`}>
            {drawnPaths.map((p) => (
              <path key={`a-${p.key}`} data-role="area" data-series={p.key} d={p.area} fill={`url(#${uid}-fill-${p.key})`} />
            ))}
            {/* Gestapelt: Linien in umgekehrter Reihenfolge – wo eine obere Reihe 0 ist, deckt sich ihre Kante
                mit der unteren, dann soll die UNTERE Reihe sichtbar sein. Ungestapelt: in Reihenfolge,
                die spätere Reihe (Codex) liegt oben – sonst verschwand sie unter der meist größeren (Claude). */}
            {(stacked ? [...geo.paths].reverse() : drawnPaths).map((p) => (
              <g key={`l-${p.key}`}>
                <path d={p.line} fill="none" stroke={p.color} strokeWidth={4} strokeOpacity={0.45} filter={`url(#${uid}-glow)`} />
                <path data-role="line" data-series={p.key} d={p.line} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            ))}
          </g>

          {peakLabel && geo.peakIdx >= 0 && active === null && reveal >= 1 && (
            <text
              x={geo.x(geo.peakIdx)}
              y={geo.y(geo.peakVal) - 9}
              textAnchor={geo.peakIdx === 0 ? "start" : geo.peakIdx === n - 1 ? "end" : "middle"}
              className="fill-a-ink font-mono text-label tabular-nums"
            >
              {formatValue(geo.peakVal)}
            </text>
          )}

          {active !== null && (
            <g>
              <line x1={ax} x2={ax} y1={M.top - 6} y2={M.top + plotH} stroke="var(--a-mut)" strokeOpacity={0.55} strokeWidth={1} shapeRendering="crispEdges" />
              {(stacked ? series.map((s, si) => ({ s, si })).reverse() : drawOrder.flatMap((si) => (series[si] ? [{ s: series[si], si }] : []))).map(({ s, si }) => {
                const v = geo.tops[si]?.[active] ?? 0;
                return (
                  <g key={s.key}>
                    <circle cx={ax} cy={geo.y(v)} r={10} fill={s.color} fillOpacity={0.18} />
                    <circle data-role="point" data-series={s.key} cx={ax} cy={geo.y(v)} r={4} fill={s.color} stroke="var(--a-p)" strokeWidth={2} />
                  </g>
                );
              })}
            </g>
          )}

          <rect
            x={M.left - 8}
            y={0}
            width={plotW + 16}
            height={M.top + plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setActive(null)}
            onClick={() => active !== null && onSelect?.(data[active]?.x ?? "")}
            style={{ cursor: onSelect ? "pointer" : "crosshair" }}
          />
        </svg>

        {a && (
          <ChartTooltip
            title={formatTooltipX(a.x)}
            left={tooltipLeft(ax, width)}
            rows={[
              ...series.map((s) => ({ key: s.key, label: s.label, value: formatValue(a.values[s.key] ?? 0), color: s.color })),
              ...(series.length > 1 ? [{ key: "_sum", label: t("Summe"), value: formatValue(total) }] : []),
            ]}
          />
        )}
      </div>
      <div className="sr-only"><table>
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{t("Tag")}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.x}>
              <th scope="row">{formatTooltipX(d.x)}</th>
              {series.map((s) => (
                <td key={s.key}>{formatValue(d.values[s.key] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
