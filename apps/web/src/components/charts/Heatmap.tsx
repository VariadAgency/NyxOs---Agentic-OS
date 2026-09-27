// Heatmap Tag × Stunde („Activity by time"): Zeilen = Wochentage, Spalten =
// Stunden. Sequentiell: EIN Farbton (Akzent) in 5 Stufen nach Quartilen, Stufe 0 = Fläche. Legende „weniger → mehr".
// Jede Zelle hat Hover-/Fokus-Tooltip; Tastatur: Fokus aufs Raster, dann Pfeiltasten in 2D.
import { t } from "@nyxos/shared";
import { useMemo, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { ChartTooltip, tooltipLeft } from "./ChartTooltip";
import { useChartWidth } from "./hooks";
import { levelByThresholds, quartileThresholds } from "./scale";

export const HEAT_COLORS = [
  "var(--a-p3)",
  "color-mix(in srgb, var(--a-acc) 28%, var(--a-p3))",
  "color-mix(in srgb, var(--a-acc) 50%, var(--a-p3))",
  "color-mix(in srgb, var(--a-acc) 74%, var(--a-p3))",
  "var(--a-acc)",
] as const;

export interface HeatmapProps {
  rowLabels: string[];
  colCount: number;
  /** Beschriftung einer Spalte, `null` = keine (sparsam, z. B. nur 0/6/12/18). */
  colLabel: (c: number) => string | null;
  /** `values[row][col]`. */
  values: number[][];
  cellTitle: (r: number, c: number) => string;
  formatValue: (n: number) => string;
  ariaLabel: string;
  cellHeight?: number;
}

const ROW_LABEL_W = 28;
const GAP = 3;

export function Heatmap({ rowLabels, colCount, colLabel, values, cellTitle, formatValue, ariaLabel, cellHeight = 20 }: HeatmapProps) {
  const [ref, width] = useChartWidth<HTMLDivElement>(560);
  const [active, setActive] = useState<[number, number] | null>(null);
  const thresholds = useMemo(() => quartileThresholds(values.flat()), [values]);
  const cellW = Math.max(8, (width - ROW_LABEL_W - GAP * colCount) / colCount);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const [r, c] = active ?? [0, 0];
    let next: [number, number] | null;
    if (e.key === "ArrowRight") next = [r, Math.min(colCount - 1, c + 1)];
    else if (e.key === "ArrowLeft") next = [r, Math.max(0, c - 1)];
    else if (e.key === "ArrowDown") next = [Math.min(rowLabels.length - 1, r + 1), c];
    else if (e.key === "ArrowUp") next = [Math.max(0, r - 1), c];
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setActive(next);
  };

  const av = active ? (values[active[0]]?.[active[1]] ?? 0) : 0;
  const ax = active ? ROW_LABEL_W + active[1] * (cellW + GAP) + cellW / 2 : 0;
  const ay = active ? 18 + active[0] * (cellHeight + GAP) + cellHeight + 6 : 0;

  return (
    <div className="grid gap-3">
      <div
        ref={ref}
        data-chart="heatmap"
        tabIndex={0}
        role="group"
        aria-roledescription="Heatmap"
        aria-label={t("{label}. Pfeiltasten wandern durch die Zellen.", { label: ariaLabel })}
        onKeyDown={onKey}
        onFocus={() => setActive((p) => p ?? [0, new Date().getHours()])}
        onBlur={() => setActive(null)}
        className="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-a-acc/60"
      >
        <div className="grid" style={{ gridTemplateColumns: `${ROW_LABEL_W}px repeat(${colCount}, minmax(0, 1fr))`, columnGap: GAP, rowGap: GAP }}>
          <span />
          {Array.from({ length: colCount }, (_, c) => (
            <span key={c} className="h-[15px] font-mono text-label leading-none text-a-mut" aria-hidden>
              {colLabel(c) ?? ""}
            </span>
          ))}
          {rowLabels.map((label, r) => (
            <div key={label} className="contents">
              <span className="self-center font-mono text-label text-a-mut">{label}</span>
              {Array.from({ length: colCount }, (_, c) => {
                const v = values[r]?.[c] ?? 0;
                const isActive = active?.[0] === r && active[1] === c;
                return (
                  <span
                    key={c}
                    data-cell={`${r}-${c}`}
                    onPointerEnter={() => setActive([r, c])}
                    onPointerLeave={() => setActive((p) => (p && p[0] === r && p[1] === c ? null : p))}
                    className={cn("rounded-[4px] transition-[box-shadow,transform] duration-150", isActive && "relative z-10 scale-110 shadow-[0_0_0_1.5px_var(--a-ink)]")}
                    style={{ height: cellHeight, background: HEAT_COLORS[levelByThresholds(v, thresholds)] }}
                  />
                );
              })}
            </div>
          ))}
        </div>
        {active && <ChartTooltip title={cellTitle(active[0], active[1])} left={tooltipLeft(ax, width)} top={ay} rows={[{ key: "v", label: "Tokens", value: formatValue(av), color: "var(--a-acc)" }]} />}
      </div>
      <HeatLegend />
      <div className="sr-only"><table>
        <caption>{ariaLabel}</caption>
        <tbody>
          {rowLabels.map((label, r) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {Array.from({ length: colCount }, (_, c) => (
                <td key={c}>{(values[r]?.[c] ?? 0) > 0 ? `${cellTitle(r, c)}: ${formatValue(values[r]?.[c] ?? 0)}` : ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

export function HeatLegend() {
  return (
    <div className="flex items-center justify-end gap-1.5 text-label text-a-mut" aria-hidden>
      {t("weniger")}
      {HEAT_COLORS.map((c) => (
        <span key={c} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />
      ))}
      {t("mehr")}
    </div>
  );
}
