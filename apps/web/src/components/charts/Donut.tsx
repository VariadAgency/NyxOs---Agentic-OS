// Donut/Ring mit Mitte-Zahl (Nebula „Load Distribution",
// Dacati 65 %). dataviz: Teil-vom-Ganzen auf einen Blick, ≤ 6 Segmente, 2 px Lücke zwischen den
// Segmenten statt Umrandung. `total` > Summe → der Rest bleibt als Spur stehen (Füllstand/Meter).
import { t, tc } from "@nyxos/shared";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useReveal } from "./hooks";

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  /** CSS-Farbe aus den Tokens. */
  color: string;
  /** Anzeige des Werts im Tooltip, z. B. „3,5 Mrd. Tokens". */
  display?: string;
}

export interface DonutProps {
  segments: DonutSegment[];
  /** Bezugsgröße; fehlt = Summe der Segmente (voller Ring). */
  total?: number;
  size?: number;
  thickness?: number;
  /** Große Zahl in der Mitte + kleine Beschriftung darunter. */
  center: { value: ReactNode; label?: ReactNode };
  ariaLabel: string;
  onSelect?: (key: string) => void;
  /** Spur-Farbe (unbelegter Teil), Standard eine Stufe über der Kartenfläche. */
  trackColor?: string;
}

const GAP_PX = 2;

export function Donut({ segments, total, size = 148, thickness = 12, center, ariaLabel, onSelect, trackColor = "var(--a-p3)" }: DonutProps) {
  const [active, setActive] = useState<number | null>(null);
  const reveal = useReveal(true, 600);
  const sum = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const whole = Math.max(total ?? sum, sum, 1e-9);
  const r = (size - thickness) / 2 - 3;
  const c = 2 * Math.PI * r;
  const visible = segments.filter((s) => s.value > 0);
  const gap = visible.length > 1 || (total !== undefined && total > sum) ? GAP_PX : 0;

  let offset = 0;
  const arcs = segments.map((s) => {
    const len = (Math.max(0, s.value) / whole) * c * reveal;
    const arc = { ...s, start: offset, len: Math.max(0, len - (len > gap ? gap : 0)) };
    offset += len;
    return arc;
  });

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (segments.length === 0) return;
    const cur = active ?? -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") setActive((cur + 1) % segments.length);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") setActive((cur - 1 + segments.length) % segments.length);
    else if (e.key === "Escape") setActive(null);
    else if ((e.key === "Enter" || e.key === " ") && active !== null && onSelect) onSelect(segments[active]?.key ?? "");
    else return;
    e.preventDefault();
  };

  const a = active !== null ? segments[active] : null;
  const pct = (v: number) => `${Math.round((v / whole) * 100)} %`;

  return (
    <div
      data-chart="donut"
      tabIndex={0}
      role="group"
      aria-roledescription={t("Ringdiagramm")}
      aria-label={ariaLabel}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      className="relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-a-acc/60"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="block -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={thickness} />
        {arcs.map((arc, i) =>
          arc.len > 0 ? (
            <circle
              key={arc.key}
              data-segment={arc.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={arc.color}
              strokeWidth={i === active ? thickness + 4 : thickness}
              strokeDasharray={`${arc.len} ${c}`}
              strokeDashoffset={-arc.start}
              style={{ transition: "stroke-width 150ms cubic-bezier(.2,.8,.2,1)", cursor: onSelect ? "pointer" : "default", filter: i === active ? `drop-shadow(0 0 6px ${arc.color})` : undefined }}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((p) => (p === i ? null : p))}
              onClick={() => onSelect?.(arc.key)}
            />
          ) : null,
        )}
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
        {a ? (
          <div role="status">
            <div className="font-display text-title2 font-semibold leading-none tabular-nums text-a-ink">{pct(a.value)}</div>
            <div className="mx-auto mt-1 max-w-[90px] truncate text-label text-a-mut">{a.label}</div>
            {a.display && <div className="mt-0.5 font-mono text-label text-a-mut">{a.display}</div>}
          </div>
        ) : (
          <div>
            <div className="font-display text-title2 font-semibold leading-none text-a-ink">{center.value}</div>
            {center.label && <div className="mt-1 text-label text-a-mut">{center.label}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Füllstand in Prozent als Ring (Limits, PASS-Quote). Farbe nach Schwelle, wenn nicht gesetzt. */
export function RingMeter({ pct, label, size = 112, thickness = 10, color, ariaLabel, sub }: { pct: number | null; label?: ReactNode; size?: number; thickness?: number; color?: string; ariaLabel: string; sub?: ReactNode }) {
  const v = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const tone = color ?? (v >= 80 ? "var(--a-bad)" : v >= 60 ? "var(--a-wait)" : "var(--a-acc)");
  return (
    <Donut
      size={size}
      thickness={thickness}
      segments={pct === null ? [] : [{ key: "v", label: typeof label === "string" ? label : t("Anteil"), value: v, color: tone }]}
      total={100}
      trackColor={`color-mix(in srgb, ${tone} 16%, var(--a-p3))`}
      center={{ value: pct === null ? "—" : `${Math.round(v)} %`, label: sub }}
      ariaLabel={`${ariaLabel}: ${pct === null ? tc("chart", "keine Angabe") : t("{n} Prozent", { n: Math.round(v) })}`}
    />
  );
}

/** Kleiner Ring ohne Mitte-Text (z. B. PASS-Quote in Listenzeilen), 18–24 px. */
export function MiniRing({ pct, size = 20, color }: { pct: number; size?: number; color?: string }) {
  const v = Math.max(0, Math.min(100, pct));
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tone = color ?? (v >= 80 ? "var(--a-ok)" : v >= 50 ? "var(--a-wait)" : "var(--a-bad)");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90 shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--a-p3)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />
    </svg>
  );
}
