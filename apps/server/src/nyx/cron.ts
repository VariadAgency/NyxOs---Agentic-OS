// Kleiner Cron-Rechner für geplante Aufgaben: 5 Felder (Minute Stunde Tag Monat Wochentag),
// immer als Wandzeit in der Zeitzone des Nutzers (OpenClaw-Regel: „expr is wall time in tz; never pre-convert to UTC“).
// Eigene Umsetzung statt einer weiteren Abhängigkeit; unterstützt `*`, Listen `1,2`, Bereiche `1-5`, Schritte `*/15`.

import { t, dateTimeFormat } from "@nyxos/shared";

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(field: string, [min, max]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) => parseField(f, RANGES[i] as [number, number]));
  if (sets.some((s) => s === null)) return null;
  const [minute, hour, dom, month, dow] = sets as Set<number>[];
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0); // 7 = Sonntag wie 0
  return { minute, hour, dom, month, dow, domAny: fields[2] === "*", dowAny: fields[4] === "*" };
}

const partsFmt = () => dateTimeFormat({ year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" }, "en-US");
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wandzeit in der Zeitzone des Nutzers für einen Zeitpunkt. */
export function localParts(d: Date): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  const p: Record<string, string> = {};
  for (const x of partsFmt().formatToParts(d)) p[x.type] = x.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), dow: WEEKDAY[p.weekday ?? "Sun"] ?? 0 };
}

function dayMatches(spec: CronSpec, p: { day: number; dow: number }): boolean {
  // Klassische Cron-Regel: sind Tag UND Wochentag eingeschränkt, reicht eines von beiden.
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return spec.dow.has(p.dow);
  if (spec.dowAny) return spec.dom.has(p.day);
  return spec.dom.has(p.day) || spec.dow.has(p.dow);
}

/** Nächster Lauf STRENG nach `after` (auf die Minute genau), höchstens gut ein Jahr voraus; sonst null. */
export function nextCronRun(expr: string, after: Date): Date | null {
  const spec = parseCron(expr);
  if (!spec) return null;
  let ts = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = after.getTime() + 370 * 86_400_000;
  while (ts <= limit) {
    const p = localParts(new Date(ts));
    if (!spec.month.has(p.month) || !dayMatches(spec, p)) {
      // Bis zum nächsten Tage (Zeitzone des Nutzers)sbeginn springen (Minuten bis Mitternacht).
      ts += ((23 - p.hour) * 60 + (60 - p.minute)) * 60_000;
      continue;
    }
    if (!spec.hour.has(p.hour)) {
      ts += (60 - p.minute) * 60_000;
      continue;
    }
    if (!spec.minute.has(p.minute)) {
      ts += 60_000;
      continue;
    }
    return new Date(ts);
  }
  return null;
}

const DOW_DE = ["sonntags", "montags", "dienstags", "mittwochs", "donnerstags", "freitags", "samstags"];
const pad = (n: number) => String(n).padStart(2, "0");

/** „täglich 07:00“, „montags bis freitags 09:30“, „alle 15 Minuten“ – sonst der Ausdruck selbst. */
export function cronDescribe(expr: string): string {
  const spec = parseCron(expr);
  if (!spec) return expr;
  const f = expr.trim().split(/\s+/);
  const everyMin = /^\*\/(\d+)$/.exec(f[0] ?? "");
  if (everyMin && f.slice(1).every((x) => x === "*")) return t("alle {n} Minuten", { n: everyMin[1] });
  if (spec.minute.size !== 1 || spec.hour.size !== 1 || !spec.domAny || f[3] !== "*") return t("nach Plan „{expr}“", { expr });
  const time = `${pad([...spec.hour][0] ?? 0)}:${pad([...spec.minute][0] ?? 0)}`;
  if (spec.dowAny) return t("täglich {time}", { time });
  const days = [...new Set([...spec.dow].map((d) => d % 7))].sort((a, b) => a - b);
  const isRange = days.length > 2 && days.every((d, i) => i === 0 || d === (days[i - 1] ?? 0) + 1);
  const day = (d: number) => t(DOW_DE[d] ?? "");
  if (isRange) return t("{from} bis {to} {time}", { from: day(days[0] ?? 0), to: day(days[days.length - 1] ?? 0), time });
  return `${days.map(day).join(", ")} ${time}`;
}

/** Liegt `now` im Fenster „aktive Stunden“ (Zeitzone des Nutzers)? Fenster über Mitternacht erlaubt; start = end → nie. */
export function withinActiveHours(win: { start: string; end: string } | null, now: Date): boolean {
  if (!win) return true;
  const p = localParts(now);
  const cur = p.hour * 60 + p.minute;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const a = toMin(win.start);
  const b = toMin(win.end);
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}
