import type { TokenTotals } from "../events.js";

export type Json = Record<string, unknown>;

/** Maximale Titellänge in der Liste. */
export const TITLE_MAX = 80;
/** Maximale Textlänge, die ein Event im Klartext mitträgt (Brücke → DB, nur für Index/Vorschau).
 * Der volle Text liegt im Archiv; der Chat liest ihn dort ungekürzt (`textMax: null`). */
export const EVENT_TEXT_MAX = 2000;

/** Parser-Optionen. `textMax: null` = nie kürzen (Chat-Verlauf aus dem Archiv). */
export interface ParserOptions {
  textMax?: number | null;
}

/**
 * Text für ein Event, nie stillschweigend gekürzt. Wird gekürzt, trägt das Event die
 * Marke `textTruncated: true` und die echte Länge `textLength` — so sieht jede Vorschau, dass es
 * mehr gibt, und der Chat weiß, dass er den vollen Text aus dem Archiv holen muss.
 */
export function clipText(text: string, max: number | null): { text: string; textTruncated?: true; textLength?: number } {
  if (max === null || text.length <= max) return { text };
  return { text: truncate(text, max), textTruncated: true, textLength: text.length };
}

export function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Nicht-negative Ganzzahl oder 0 — kaputte Token-Werte dürfen Summen nie verfälschen. */
export function count(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Eine Zeile als Titel: Leerraum zusammenfassen, kürzen. */
export function toTitle(s: string): string | null {
  const t = s.replace(/\s+/g, " ").trim();
  return t ? truncate(t, TITLE_MAX) : null;
}

/** Normiert einen Zeitstempel auf ISO-8601 (UTC) oder liefert null. */
export function isoTs(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parst eine JSONL-Zeile. `undefined` = Leerzeile (kein Fehler),
 * `null` = kaputt (zählt als Fehler), sonst das Objekt.
 */
export function parseJsonLine(line: string): Json | null | undefined {
  if (line.trim() === "") return undefined;
  try {
    const v: unknown = JSON.parse(line);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 };
}

/** Menge, die die Reihenfolge des ersten Auftretens behält. */
export class OrderedSet {
  private readonly items = new Set<string>();
  add(v: string | null | undefined): void {
    if (v) this.items.add(v);
  }
  toArray(): string[] {
    return [...this.items];
  }
}

export class Counter {
  private readonly counts: Record<string, number> = {};
  inc(key: string): void {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }
  toObject(): Record<string, number> {
    return { ...this.counts };
  }
}

/** Frühester und spätester gültiger Zeitpunkt. */
export class TimeRange {
  first: string | null = null;
  last: string | null = null;
  see(ts: string): void {
    if (this.first === null || ts < this.first) this.first = ts;
    if (this.last === null || ts > this.last) this.last = ts;
  }
}
