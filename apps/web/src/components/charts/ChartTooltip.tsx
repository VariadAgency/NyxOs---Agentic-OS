// Gemeinsamer Tooltip der Diagramme (dataviz: „Werte vorn, Beschriftung dahinter", Linien-
// Schlüssel statt Kästchen). Kein `pointer-events`, damit er nie den Hover stört. `role="status"`:
// Screenreader lesen die Werte vor, wenn man per Pfeiltaste durchs Diagramm geht.
import { t } from "@nyxos/shared";
import type { ReactNode } from "react";

export interface TooltipRow {
  key: string;
  label: string;
  value: string;
  /** CSS-Farbe (Token-Variable) für den Linien-Schlüssel; fehlt = kein Schlüssel (z. B. Summe). */
  color?: string;
}

const TOOLTIP_W = 176;

/** Linke Kante so, dass der Tooltip neben dem Punkt steht und nie aus dem Diagramm ragt. */
export function tooltipLeft(anchorX: number, containerW: number, width = TOOLTIP_W): number {
  const right = anchorX + 14;
  if (right + width <= containerW) return right;
  return Math.max(0, anchorX - 14 - width);
}

export function ChartTooltip({ title, rows, left, top = 4, footer }: { title: string; rows: TooltipRow[]; left: number; top?: number; footer?: ReactNode }) {
  return (
    <div
      data-chart-tooltip
      role="status"
      className="pointer-events-none absolute z-20 grid gap-1 rounded-lg border border-a-line bg-a-p2/95 px-2.5 py-2 text-caption shadow-[0_8px_24px_rgba(0,0,0,.45)] backdrop-blur-sm"
      style={{ left, top, width: TOOLTIP_W }}
    >
      <div className="font-mono text-label text-a-mut">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2">
          {r.color ? <span aria-hidden className="h-[2px] w-3 rounded-full" style={{ background: r.color }} /> : <span aria-hidden />}
          <span className="truncate text-a-mut">{r.label}</span>
          <span className="font-mono font-medium tabular-nums text-a-ink">{r.value}</span>
        </div>
      ))}
      {footer}
    </div>
  );
}

/** Legende für ≥ 2 Reihen (dataviz: immer da, Farbe nie allein). Fläche/Balken → Rechteck-Schlüssel. */
/** Mit `onToggle` wird jeder Eintrag ein Schalter (Reihe ein-/ausblenden); die letzte sichtbare
 * Reihe lässt sich nicht ausblenden – ein leeres Diagramm hilft niemandem. */
export function ChartLegend({ items, hidden, onToggle }: { items: { key: string; label: string; color: string }[]; hidden?: ReadonlySet<string>; onToggle?: (key: string) => void }) {
  if (items.length < 2) return null;
  const visible = items.filter((it) => !hidden?.has(it.key)).length;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-a-mut" aria-label={t("Legende")}>
      {items.map((it) => {
        const off = hidden?.has(it.key) ?? false;
        const swatch = <span aria-hidden className={`h-2.5 w-2.5 rounded-[3px] transition-opacity duration-150 ${off ? "opacity-30" : ""}`} style={{ background: it.color }} />;
        return (
          <li key={it.key} className="inline-flex items-center gap-1.5">
            {onToggle ? (
              <button
                type="button"
                aria-pressed={!off}
                disabled={!off && visible <= 1}
                title={off ? t("{label} einblenden", { label: it.label }) : visible <= 1 ? t("Mindestens eine Linie bleibt sichtbar") : t("{label} ausblenden – die Skala passt sich an", { label: it.label })}
                onClick={() => onToggle(it.key)}
                className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-150 hover:bg-a-p2 hover:text-a-ink disabled:cursor-default disabled:hover:bg-transparent ${off ? "text-a-mut line-through decoration-a-mut/60" : "text-a-ink"}`}
              >
                {swatch}
                {it.label}
              </button>
            ) : (
              <>
                {swatch}
                {it.label}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
