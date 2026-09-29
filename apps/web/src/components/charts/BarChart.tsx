// Balken mit hervorgehobenem Wert: alle Balken
// gedämpft, der heutige/gewählte in Akzent mit Wert-Etikett. dataviz: ≤ 24 px dick, 4 px runde
// Oberkante, eckig an der Grundlinie, Balken selbst ist das Ziel für Hover/Fokus (kein Fadenkreuz).
import { t } from "@nyxos/shared";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { ChartTooltip, tooltipLeft } from "./ChartTooltip";
import { useChartWidth, useReveal } from "./hooks";
import { niceTicks, tickIndices } from "./scale";

export interface BarDatum {
  x: string;
  value: number;
}

export interface BarChartProps {
  data: BarDatum[];
  /** Index des hervorgehobenen Balkens (Standard: der letzte = heute). */
  highlightIndex?: number;
  height?: number;
  ariaLabel: string;
  /** Einheit im Tooltip, z. B. „Commits". */
  unit: string;
  formatValue?: (n: number) => string;
  formatTick: (x: string) => string;
  formatTooltipX: (x: string) => string;
  onSelect?: (x: string) => void;
  initialWidth?: number;
  /** Kategorie-Farbe (Token). Gesetzt → alle Balken in dieser Farbe (gedämpft), der hervorgehobene voll;
   * ohne → wie bisher gedämpft neutral mit Akzent-Balken. */
  color?: string;
}

const M = { top: 22, right: 8, bottom: 24, left: 8 };
const MAX_BAR = 24;
const RADIUS = 4;

/** Balken mit runder Oberkante und eckiger Unterkante (Pfad, weil `rx` alle vier Ecken rundet). */
export function barPath(x: number, y: number, w: number, h: number, r = RADIUS): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function BarChart({ data, highlightIndex, height = 180, ariaLabel, unit, formatValue = String, formatTick, formatTooltipX, onSelect, initialWidth, color }: BarChartProps) {
  const hiColor = color ?? "var(--a-acc)";
  const restColor = color ? `color-mix(in srgb, ${color} 42%, var(--a-p))` : "color-mix(in srgb, var(--a-idle) 42%, var(--a-p))";
  const uid = useId().replace(/:/g, "");
  const [ref, width] = useChartWidth<HTMLDivElement>(initialWidth ?? 640);
  const [active, setActive] = useState<number | null>(null);
  const reveal = useReveal(data.length > 0);
  const n = data.length;
  const hi = highlightIndex ?? n - 1;
  const plotW = Math.max(40, width - M.left - M.right);
  const plotH = Math.max(30, height - M.top - M.bottom);

  const geo = useMemo(() => {
    const max = Math.max(0, ...data.map((d) => d.value));
    const yMax = niceTicks(max, 3).at(-1) ?? 1;
    const band = plotW / Math.max(1, n);
    const barW = Math.min(MAX_BAR, Math.max(4, band * 0.62));
    const bars = data.map((d, i) => {
      const cx = M.left + band * i + band / 2;
      const h = (d.value / yMax) * plotH;
      return { cx, x: cx - barW / 2, h, band };
    });
    return { bars, barW, band };
  }, [data, n, plotW, plotH]);

  const xTicks = useMemo(() => tickIndices(n, Math.max(2, Math.floor(plotW / 56))), [n, plotW]);
  if (n === 0) return null;

  const baseY = M.top + plotH;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? hi;
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
  const hb = geo.bars[hi];
  const hd = data[hi];

  return (
    <div
      ref={ref}
      data-chart="bar"
      tabIndex={0}
      role="group"
      aria-roledescription={t("Diagramm")}
      aria-label={t("{label}. Pfeiltasten wählen einen Balken.", { label: ariaLabel })}
      onKeyDown={onKey}
      onFocus={() => setActive((p) => p ?? hi)}
      onBlur={() => setActive(null)}
      className="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-a-acc/60"
      style={{ height }}
    >
      <svg width={width} height={height} className="block overflow-visible" aria-hidden>
        <defs>
          <filter id={`${uid}-glow`} x="-60%" y="-30%" width="220%" height="160%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>
        <line x1={M.left} x2={M.left + plotW} y1={baseY + 0.5} y2={baseY + 0.5} stroke="var(--a-line)" strokeWidth={1} />
        {geo.bars.map((b, i) => {
          const h = b.h * reveal;
          const isHi = i === hi;
          const isActive = i === active;
          const fill = isHi ? hiColor : isActive ? `color-mix(in srgb, ${hiColor} ${color ? 70 : 45}%, var(--a-p3))` : restColor;
          return (
            <g key={data[i]?.x ?? i}>
              {isHi && h > 0 && <path d={barPath(b.x, baseY - h, geo.barW, h)} fill={hiColor} opacity={0.45} filter={`url(#${uid}-glow)`} />}
              <path d={barPath(b.x, baseY - h, geo.barW, h)} fill={fill} style={{ transition: "fill 150ms cubic-bezier(.2,.8,.2,1)" }} />
              <rect
                data-bar={data[i]?.x}
                x={b.cx - b.band / 2}
                y={M.top - 16}
                width={b.band}
                height={plotH + 16}
                fill="transparent"
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive((p) => (p === i ? null : p))}
                onClick={() => onSelect?.(data[i]?.x ?? "")}
                style={{ cursor: onSelect ? "pointer" : "default" }}
              />
            </g>
          );
        })}
        {hb && hd && reveal >= 1 && (
          <text x={hb.cx} y={baseY - hb.h - 8} textAnchor="middle" className="fill-a-ink font-mono text-label font-semibold tabular-nums">
            {formatValue(hd.value)}
          </text>
        )}
        {xTicks.map((i) => {
          const b = geo.bars[i];
          if (!b) return null;
          return (
            <text key={i} x={b.cx} y={height - 6} textAnchor="middle" className={i === hi || i === active ? "fill-a-ink font-mono text-label" : "fill-a-mut font-mono text-label"}>
              {formatTick(data[i]?.x ?? "")}
            </text>
          );
        })}
      </svg>
      {a && active !== null && (
        <ChartTooltip title={formatTooltipX(a.x)} left={tooltipLeft(geo.bars[active]?.cx ?? 0, width)} rows={[{ key: "v", label: unit, value: formatValue(a.value), color: hiColor }]} />
      )}
      <div className="sr-only"><table>
        <caption>{ariaLabel}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.x}>
              <th scope="row">{formatTooltipX(d.x)}</th>
              <td>
                {formatValue(d.value)} {unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
