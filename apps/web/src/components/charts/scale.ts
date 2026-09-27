// Reine Rechen-Helfer der Diagramm-Bausteine. Kein React, alles testbar.
import { formatTokensCompact, t, locale } from "@nyxos/shared";

/** Alle Kalendertage von `from` bis `to` (je einschließlich, YYYY-MM-DD, UTC-Arithmetik). */
export function daySpan(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Füllt fehlende Tage mit 0 — ein Tag ohne Daten bleibt als 0 auf der Achse stehen, statt dass die
 * Zeitachse ihn überspringt und dadurch verzerrt („12., 18., 29., 30. fehlten").
 */
export function fillDays<T extends { day: string }>(rows: T[], from: string, to: string, empty: (day: string) => T): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return daySpan(from, to).map((day) => byDay.get(day) ?? empty(day));
}

/** „Schöne" Achsenwerte 0 … ≥ max (1/2/2.5/5 × 10^n), `count` ≈ Anzahl Abschnitte. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * pow >= rough) ?? 10) * pow;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Welche Indizes eine X-Beschriftung bekommen: höchstens `max`, immer erster und letzter. */
export function tickIndices(n: number, max: number): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  // Der letzte Tag steht immer da; ein zu naher Vorgänger fliegt raus, damit sich nichts überlappt.
  if (out.length > 0 && n - 1 - (out.at(-1) ?? 0) < step / 2) out.pop();
  out.push(n - 1);
  return out;
}

/** Monotone kubische Kurve (Fritsch–Carlson) durch die Punkte — schwingt nie über die Daten hinaus. */
export function monotonePath(points: [number, number][]): string {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M${points[0]?.[0] ?? 0},${points[0]?.[1] ?? 0}`;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push(((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / ((xs[i + 1] ?? 0) - (xs[i] ?? 0) || 1));
  m.push(d[0] ?? 0);
  for (let i = 1; i < n - 1; i++) m.push((d[i - 1] ?? 0) * (d[i] ?? 0) <= 0 ? 0 : ((d[i - 1] ?? 0) + (d[i] ?? 0)) / 2);
  m.push(d[n - 2] ?? 0);
  for (let i = 0; i < n - 1; i++) {
    const di = d[i] ?? 0;
    if (di === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] ?? 0) / di;
    const b = (m[i + 1] ?? 0) / di;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * di;
      m[i + 1] = t * b * di;
    }
  }
  let path = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = xs[i] ?? 0;
    const x1 = xs[i + 1] ?? 0;
    const h = (x1 - x0) / 3;
    path += `C${x0 + h},${(ys[i] ?? 0) + (m[i] ?? 0) * h},${x1 - h},${(ys[i + 1] ?? 0) - (m[i + 1] ?? 0) * h},${x1},${ys[i + 1]}`;
  }
  return path;
}

/** Stufe 0–4 für die Heatmap: 0 = nichts, 1–4 = Viertel des Maximums (ein Farbton, hell → kräftig). */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  const r = value / max;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

/**
 * Stufengrenzen nach Quartilen der belegten Zellen: Nutzung ist stark schief verteilt (wenige
 * Spitzenstunden mit Milliarden Tokens) — linear landeten fast alle Zellen in Stufe 1 und das Muster
 * verschwand. Quartile verteilen die belegten Zellen gleichmäßig auf die 4 Stufen, Reihenfolge bleibt.
 */
export function quartileThresholds(values: number[]): [number, number, number] {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return [0, 0, 0];
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0;
  return [q(0.25), q(0.5), q(0.75)];
}

export function levelByThresholds(value: number, t: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value > t[2]) return 4;
  if (value > t[1]) return 3;
  if (value > t[0]) return 2;
  return 1;
}

export interface TrendView {
  /** Anzeige-Text ohne Pfeil, z. B. „12 %", „+62", „neu". */
  text: string;
  direction: "up" | "down" | "flat";
}

/**
 * Trend ehrlich darstellen: gegen eine Null-Basis gibt es keinen Prozentwert (sonst „▲ 1967 %" —
 * Rauschen), dann die absolute Änderung. Über 500 % ebenfalls absolut.
 */
export function trendView(current: number, previous: number): TrendView {
  const diff = current - previous;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  if (diff === 0) return { text: t("gleich"), direction };
  if (previous <= 0) return { text: `${diff > 0 ? "+" : "−"}${formatCompact(Math.abs(diff))}`, direction };
  const pct = Math.round((Math.abs(diff) / previous) * 100);
  if (pct > 500) return { text: `${diff > 0 ? "+" : "−"}${formatCompact(Math.abs(diff))}`, direction };
  return { text: `${pct} %`, direction };
}

/** „1.284“ / „128.400“ / „4,2 Mio.“ / „3,9 Mrd.“ — dieselbe Schreibweise wie überall (`@nyxos/shared`). */
export function formatCompact(n: number): string {
  return formatTokensCompact(n);
}

const weekdayDayMonth = new Intl.DateTimeFormat(locale(), { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
const dayMonth = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const weekdayShort = new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" });

/** „Sa., 20.09." für Tooltips (statt ISO „2026-09-20"). */
export function formatDayLong(day: string): string {
  return weekdayDayMonth.format(new Date(`${day}T00:00:00Z`));
}

/** „20.09." für Achsen. */
export function formatDayShort(day: string): string {
  return dayMonth.format(new Date(`${day}T00:00:00Z`));
}

/** „Sa." für Achsen mit nur 7 Tagen. */
export function formatWeekday(day: string): string {
  return weekdayShort.format(new Date(`${day}T00:00:00Z`));
}

/** Ease-out für Einzeichnen/Hochzählen: `cubic-bezier(.2,.8,.2,1)` angenähert. */
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}
