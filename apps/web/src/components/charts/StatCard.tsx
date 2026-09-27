// Kennzahl-Kachel (dataviz „Stat tile"): Mono-Überschrift, große Zahl (Archivo,
// tabular-nums — sonst „tanzen" die Ziffern beim Hochzählen), Trend-Chip ▲▼ gegen einen benannten
// Zeitraum, Mini-Sparkline in fester Höhe, Kontextzeile. Sparkline- und Kontextplatz sind IMMER
// reserviert, damit alle Kacheln einer Reihe gleich hoch sind.
import { t, locale } from "@nyxos/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { metricTone, toneVar, type Tone } from "../../lib/tones";
import { prefersReducedMotion } from "./hooks";
import { Sparkline } from "./Sparkline";
import { easeOut, trendView } from "./scale";

export interface StatTrend {
  current: number;
  previous: number;
  period: string;
  upIsGood: boolean | null;
}

/** Schlüssel, die in dieser Sitzung schon hochgezählt haben — „nur bei Erstanzeige" gilt pro App-Start,
 * nicht pro Tab-Wechsel (sonst zählt alles bei jedem Zurückkommen neu hoch). */
const counted = new Set<string>();

/** Zählt beim ersten Erscheinen eines Schlüssels in ≤ 600 ms hoch; danach springt der Wert direkt. */
export function useCountUpOnce(key: string, value: number | null, durationMs = 600): number | null {
  const firstTime = !counted.has(key);
  const [display, setDisplay] = useState<number | null>(firstTime && value !== null && !prefersReducedMotion() ? 0 : value);
  const raf = useRef(0);
  useEffect(() => {
    if (value === null) return;
    if (counted.has(key) || value === 0 || prefersReducedMotion()) {
      setDisplay(value);
      if (value !== 0) counted.add(key);
      return;
    }
    counted.add(key);
    let done = false;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.max(0, Math.min(1, (now - start) / durationMs));
      setDisplay(value * easeOut(t));
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else done = true;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf.current);
      // Abgebrochen (StrictMode-Doppelaufbau, Wegnavigieren) → beim nächsten Aufbau darf es noch zählen.
      if (!done) counted.delete(key);
      setDisplay(value);
    };
  }, [key, value, durationMs]);
  return display;
}

/** Nur für Tests: Hochzähl-Gedächtnis leeren. */
export function resetCountUpMemory(): void {
  counted.clear();
}

/** Tooltip sagt, WAS verglichen wird, mit denselben Zahlen-Format wie die Kachel. */
/** Neutrale Änderungen (weder gut noch schlecht) tragen die Bedeutungsfarbe der Kachel; gut/schlecht bleiben grün/rot. */
export function TrendChip({ trend, format, tone }: { trend: StatTrend; format?: (n: number) => string; tone?: Tone }) {
  const fmt = format ?? ((n: number) => n.toLocaleString(locale()));
  const view = trendView(trend.current, trend.previous);
  const good = view.direction === "flat" || trend.upIsGood === null ? null : (view.direction === "up") === trend.upIsGood;
  const cls = good === null ? (tone ? "" : "bg-a-p3 text-a-mut") : good ? "bg-a-ok/12 text-a-ok" : "bg-a-bad/12 text-a-bad";
  const style = good === null && tone ? { color: toneVar(tone), backgroundColor: `color-mix(in srgb, ${toneVar(tone)} 14%, transparent)` } : undefined;
  const arrow = view.direction === "up" ? "▲" : view.direction === "down" ? "▼" : "•";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-label font-medium tabular-nums", cls)} style={style} title={t("{period}: vorher {prev}, jetzt {cur}", { period: trend.period, prev: fmt(trend.previous), cur: fmt(trend.current) })}>
      <span aria-hidden className="text-label">{arrow}</span>
      {view.text}
      <span className="sr-only"> {trend.period}</span>
    </span>
  );
}

export interface StatCardProps {
  id: string;
  label: string;
  value: number | null;
  format: (n: number) => string;
  trend?: StatTrend | null;
  sparkline?: number[];
  sparklineLabel?: string | null;
  caption?: ReactNode;
  captionTone?: "wait" | "bad" | null;
  href?: string;
  /** Leer-Anzeige statt Zahl (z. B. „keine Quelle"). */
  emptyText?: string;
  /** Bedeutungsfarbe für Punkt, Sparkline und neutralen Trend-Chip; Standard aus `METRIC_TONE` (lib/tones.ts). */
  tone?: Tone;
  /** „quiet“ = ruhigere Kachel für Kennzahlen ohne Handlungsbedarf (kleinere Zahl, weniger Höhe). */
  variant?: "default" | "quiet";
  /** Rechts unten Platz lassen (dort sitzt ein kleiner „Nyx fragen“-Knopf über der Karte). */
  reserveCorner?: boolean;
}

/** Eine Sparkline mit nur einem Zacken am rechten Rand ist Rauschen — erst ab so vielen Tagen mit Werten. */
export const SPARKLINE_MIN_POINTS = 3;

export function hasSparkline(values: number[]): boolean {
  return values.filter((v) => v > 0).length >= SPARKLINE_MIN_POINTS;
}

export function StatCard({ id, label, value, format, trend, sparkline = [], sparklineLabel, caption, captionTone, href, emptyText = "—", tone, variant = "default", reserveCorner = false }: StatCardProps) {
  const display = useCountUpOnce(id, value);
  const t = tone ?? metricTone(id);
  const quiet = variant === "quiet";
  const showSpark = hasSparkline(sparkline);
  const body = (
    <>
      {/* Trend-Chip neben der Überschrift statt neben der Zahl: bei 1024 px (Kachel ~180 px) würde er
          die große Zahl sonst auf „1,8 …" abschneiden. Bei 390 px schnitt der Chip die Überschrift auf
          „TOKE…“ – jetzt rutscht er in eine zweite Zeile, wenn beides nicht nebeneinander passt. */}
      <div className="flex min-h-[20px] min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-0 max-w-full items-center gap-2">
          <span aria-hidden="true" data-tone={t} className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: toneVar(t) }} />
          <span className="truncate font-mono text-label uppercase tracking-wider text-a-mut">{label}</span>
        </span>
        {trend && value !== null && <TrendChip trend={trend} format={format} tone={t} />}
      </div>
      <span className={cn("whitespace-nowrap font-display font-semibold leading-none tabular-nums text-a-ink", quiet ? "text-title2" : "text-title")}>{display === null ? emptyText : format(display)}</span>
      {/* Platz für die Sparkline bleibt reserviert (gleich hohe Kacheln einer Reihe), auch wenn sie noch zu wenig Daten hat. */}
      <div className={quiet ? "h-6" : "h-8"}>{showSpark && <Sparkline values={sparkline} height={quiet ? 24 : 32} color={toneVar(t)} label={sparklineLabel ?? undefined} />}</div>
      {/* Die Kontextzeile bricht um statt abgeschnitten zu werden (schmale Git-Kachel „635 in Repos · 2.022 in Worktrees“). */}
      <span className={cn("min-h-[16px] text-caption text-pretty [overflow-wrap:anywhere]", reserveCorner && "pr-8", captionTone === "wait" ? "text-a-wait" : captionTone === "bad" ? "text-a-bad" : "text-a-mut")}>
        {caption ?? (showSpark ? sparklineLabel : null) ?? ""}
      </span>
    </>
  );
  const cls = cn(
    "group relative grid min-w-0 content-start rounded-xl border border-a-line bg-a-p transition-[border-color,background-color,transform] duration-200 ease-apple",
    quiet ? "min-h-[112px] gap-1.5 p-3.5" : "min-h-[148px] gap-2 p-4",
  );
  if (!href) return <div data-metric={id} className={cls}>{body}</div>;
  return (
    <Link to={href} data-metric={id} className={cn(cls, "hover:-translate-y-px hover:border-a-line-strong hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc motion-reduce:hover:translate-y-0")}>
      {body}
    </Link>
  );
}
