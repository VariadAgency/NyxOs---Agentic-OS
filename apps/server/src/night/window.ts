// Nachtmodus — Fenster-Arithmetik, eigene Datei, weil `push/dispatcher.ts` dieselbe Form
// braucht (Ruhezeiten) — beide importieren aus hier statt sich zu duplizieren.
import { type NightWindow, timeZone } from "@nyxos/shared";

function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Minutes since midnight on the user's wall clock (`timeZone()`: the configured zone, else the machine's), daylight
 * saving included. Windows like "22:00–08:00" are wall-clock times; `now.getHours()` would use the process zone,
 * which is UTC in the server-mode container and would shift quiet hours by one or two hours.
 */
export function wallClockMinutes(now: Date, zone: string = timeZone()): number {
  let fmt = formatters.get(zone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch {
      return now.getHours() * 60 + now.getMinutes(); // unknown zone name → process zone instead of crashing
    }
    formatters.set(zone, fmt);
  }
  const parts = fmt.formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (h % 24) * 60 + m;
}

/** true, wenn `now` innerhalb des Fensters liegt (Wanduhr des Nutzers). Über Mitternacht möglich (Standard 23:00–07:00). */
export function isWithinWindow(window: NightWindow, now: Date): boolean {
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  const cur = wallClockMinutes(now);
  if (start === end) return true; // 24 h freigegeben
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
