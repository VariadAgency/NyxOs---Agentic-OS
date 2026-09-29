// Zeiträume der Nutzung in der Zeitzone des Nutzers (`timeZone()`) — Tagesgrenzen, Wochen
// (Montag–Sonntag) und Monate. Reine Funktionen, keine DB. Gleiche Tages-Logik wie `dayOf()` in
// `ingest.ts` (dort wird `usage_daily.day` nach Tag (Zeitzone des Nutzers) gebildet), damit Vergleiche und
// Verdichtung nie verschiedene Tage meinen — auch wenn der Server in UTC läuft.

import { dateTimeFormat, localDayOf } from "@nyxos/shared";

const DAY_MS = 86_400_000;
const wallFormat = () => dateTimeFormat({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }, "en-CA");

/** Kalendertag (Zeitzone des Nutzers) eines Zeitpunkts, `YYYY-MM-DD`. */
export function localDay(d: Date): string {
  return localDayOf(d);
}

/** Tage auf einem `YYYY-MM-DD` addieren (reine Kalender-Arithmetik, zeitzonenfrei). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Wie weit die Wanduhr des Nutzers zum Zeitpunkt `t` vor UTC liegt (ms), z. B. +1 h Winter, +2 h Sommer in Mitteleuropa. */
function zoneOffsetMs(t: number): number {
  const parts = Object.fromEntries(wallFormat().formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(t / 1000) * 1000;
}

/** Zeitpunkt von 00:00 Uhr Zeitzone des Nutzers an diesem Tag. */
export function localMidnight(day: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  // Zweimal: der Versatz am geschätzten Zeitpunkt kann an einem Umstellungstag noch der alte sein.
  const first = guess - zoneOffsetMs(guess);
  return new Date(guess - zoneOffsetMs(first));
}

/** Montag der Woche dieses Tages. */
export function weekStartOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sonntag
  return addDays(day, -((dow + 6) % 7));
}

export function monthStartOf(day: string): string {
  return `${day.slice(0, 8)}01`;
}

export function daysInMonth(day: string): number {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function previousMonthStart(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
}

export type PeriodKind = "week" | "month";

/** Halboffenes Zeitfenster `[start, end)` mit den Kalendertage (Zeitzone des Nutzers)n, die es berührt. */
export interface PeriodWindow {
  start: Date;
  end: Date;
  fromDay: string;
  toDay: string;
}

export interface ComparisonWindows {
  kind: PeriodKind;
  /** Laufender Zeitraum bis jetzt. */
  current: PeriodWindow;
  /** Vorheriger Zeitraum bis zum GLEICHEN Stand (gleicher Tag im Zeitraum, gleiche Uhrzeit) — der
   * faire Vergleich. Ist der Vormonat kürzer (31. März ↔ Februar), zählt der ganze Vormonat. */
  previous: PeriodWindow;
  /** Vorheriger Zeitraum komplett. */
  previousFull: PeriodWindow;
  /** Letzter Tag des laufenden Zeitraums und dessen Ende (für Hochrechnung/Achse). */
  currentLastDay: string;
  currentEnd: Date;
  /** Anzahl Tage des laufenden bzw. vorherigen Zeitraums (Woche 7, Monat 28–31). */
  totalDays: number;
  previousTotalDays: number;
}

export function comparisonWindows(kind: PeriodKind, now: Date): ComparisonWindows {
  const today = localDay(now);
  const curStart = kind === "week" ? weekStartOf(today) : monthStartOf(today);
  const prevStart = kind === "week" ? addDays(curStart, -7) : previousMonthStart(today);
  const totalDays = kind === "week" ? 7 : daysInMonth(today);
  const previousTotalDays = kind === "week" ? 7 : daysInMonth(prevStart);
  const prevLast = addDays(prevStart, previousTotalDays - 1);
  const curLast = addDays(curStart, totalDays - 1);

  const index = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${curStart}T00:00:00Z`)) / DAY_MS);
  let previous: PeriodWindow;
  if (index >= previousTotalDays) {
    previous = { start: localMidnight(prevStart), end: localMidnight(curStart), fromDay: prevStart, toDay: prevLast };
  } else {
    const prevDay = addDays(prevStart, index);
    const elapsedToday = now.getTime() - localMidnight(today).getTime();
    // Am 25-Std-Tag der Zeitumstellung darf der Vergleichstag nie in den nächsten Tag hineinlaufen.
    const endMs = Math.min(localMidnight(prevDay).getTime() + elapsedToday, localMidnight(addDays(prevDay, 1)).getTime());
    previous = { start: localMidnight(prevStart), end: new Date(endMs), fromDay: prevStart, toDay: prevDay };
  }
  return {
    kind,
    current: { start: localMidnight(curStart), end: now, fromDay: curStart, toDay: today },
    previous,
    previousFull: { start: localMidnight(prevStart), end: localMidnight(curStart), fromDay: prevStart, toDay: prevLast },
    currentLastDay: curLast,
    currentEnd: localMidnight(addDays(curLast, 1)),
    totalDays,
    previousTotalDays,
  };
}

/** vor dieser Uhrzeit (Zeitzone des Nutzers) (volle Stunden) gibt es keinen Tagesvergleich — um 00:41 wären es
 * 41 Minuten gegen 41 Minuten, das sagt nichts (vorher stand dort „▼ 99 %“ gegen den ganzen Vortag). */
export const DAY_TREND_MIN_HOURS = 6;

export interface DayWindows {
  /** Heute von 00:00 bis jetzt. */
  today: PeriodWindow;
  /** Gestern von 00:00 bis zur gleichen Uhrzeit (Zeitzone des Nutzers) (nie in den heutigen Tag hinein). */
  previous: PeriodWindow;
  /** Gibt es schon genug vom Tag für einen ehrlichen Vergleich? */
  comparable: boolean;
  /** Uhrzeit (Zeitzone des Nutzers), bis zu der verglichen wird, z. B. „14:00“. */
  until: string;
}


/** Zeitpunkt zu einer Wanduhrzeit des Nutzers (als UTC-ms kodiert) — zweimal, wie `localMidnight`. */
function fromLocalWall(wall: number): number {
  const first = wall - zoneOffsetMs(wall);
  return wall - zoneOffsetMs(first);
}

/** heute bis jetzt gegen gestern bis zur gleichen Uhrzeit (Zeitzone des Nutzers).
 * „gleiche Uhrzeit“ heißt Wanduhr, nicht „gleich viel Zeit seit Mitternacht“ — sonst verglich der
 * Montag nach einer Zeitumstellung (gestern 23 bzw. 25 Std) „bis 14:00“ mit gestern bis 13:00 bzw. 15:00. */
export function dayWindows(now: Date): DayWindows {
  const today = localDay(now);
  const yesterday = addDays(today, -1);
  const todayStart = localMidnight(today);
  const prevStart = localMidnight(yesterday);
  const wallNow = now.getTime() + zoneOffsetMs(now.getTime());
  const sameTimeYesterday = fromLocalWall(wallNow - DAY_MS);
  const prevEnd = new Date(Math.max(prevStart.getTime(), Math.min(sameTimeYesterday, todayStart.getTime())));
  const wallHour = Math.floor((((wallNow % DAY_MS) + DAY_MS) % DAY_MS) / 3_600_000);
  return {
    today: { start: todayStart, end: now, fromDay: today, toDay: today },
    previous: { start: prevStart, end: prevEnd, fromDay: yesterday, toDay: yesterday },
    comparable: wallHour >= DAY_TREND_MIN_HOURS,
    until: dateTimeFormat({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now),
  };
}

/** Veränderung in Prozent; ohne Vorwert `null` (nie ∞ oder eine erfundene 100 %). */
export function deltaPct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}
