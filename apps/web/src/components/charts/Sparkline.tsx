// Mini-Sparkline: Verlauf ohne Achsen, Fläche 35 % → 0 %, letzter Punkt als Glühpunkt.
// Misst die eigene Breite, damit der Endpunkt rund bleibt (kein verzerrtes viewBox-Stretching).
import { useId } from "react";
import { useChartWidth } from "./hooks";
import { monotonePath } from "./scale";

export function Sparkline({ values, height = 32, color = "var(--a-acc)", label }: { values: number[]; height?: number; color?: string; label?: string }) {
  const uid = useId().replace(/:/g, "");
  const [ref, width] = useChartWidth<HTMLDivElement>(160);
  if (values.length < 2) return <div ref={ref} style={{ height }} />;
  const max = Math.max(...values);
  const pad = 4;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => (max <= 0 ? height - 2 : pad + (1 - v / max) * (height - pad - 2));
  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const line = monotonePath(pts);
  const last = pts.at(-1) ?? [0, 0];
  return (
    // SVG absolut — sonst bestimmt seine (anfangs geschätzte) Breite die Mindestbreite der Kachel,
    // die Messung liest diese Breite zurück und die Linie lief bei 1280 px über den Kachelrand.
    <div ref={ref} style={{ height }} className="relative w-full min-w-0" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg width={width} height={height} className="absolute inset-y-0 left-0 block overflow-visible">
        <defs>
          <linearGradient id={`${uid}-f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={`${line}L${x(values.length - 1)},${height}L${x(0)},${height}Z`} fill={`url(#${uid}-f)`} />
        <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={last[0]} cy={last[1]} r={6} fill={color} fillOpacity={0.2} />
        <circle cx={last[0]} cy={last[1]} r={3} fill={color} stroke="var(--a-p)" strokeWidth={1.5} />
      </svg>
    </div>
  );
}
