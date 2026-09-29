// Nachtmodus — Fenster-Arithmetik, eigene Datei, weil `push/dispatcher.ts` dieselbe Form
// braucht (Ruhezeiten) — beide importieren aus hier statt sich zu duplizieren.
import type { NightWindow } from "@nyxos/shared";

function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** true, wenn `now` innerhalb des Fensters liegt. Über Mitternacht möglich (Standard 23:00–07:00). */
export function isWithinWindow(window: NightWindow, now: Date): boolean {
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true; // 24 h freigegeben
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
