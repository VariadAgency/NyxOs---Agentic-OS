// „Seit du weg warst“: der letzte Besuch steht im Browser (localStorage, jeder Zugriff mit try/catch).
// Zwei Werte, geteilt von allen NyxOS-Tabs:
// - LAST_SEEN_KEY: wann NyxOS zuletzt sichtbar war (beim Verlassen des Tabs, beim Schließen und jede Minute,
//   solange ein Tab offen ist),
// - LAST_VISIT_KEY: der Bezugspunkt der Karte = Ende des vorigen Besuchs.
// Ein neuer Besuch beginnt erst, wenn NyxOS länger als AWAY_MS nirgends offen war. Seitenwechsel in NyxOS,
// Neuladen (F5) und der Wechsel zwischen zwei NyxOS-Tabs verschieben den Bezugspunkt deshalb nicht.
import { useSyncExternalStore } from "react";

export const LAST_VISIT_KEY = "nyxos.lastVisit";
export const LAST_SEEN_KEY = "nyxos.lastSeen";
/** Kürzere Abwesenheiten (kurz ein anderes Fenster, Neuladen) verschieben den Bezugspunkt nicht. */
const AWAY_MS = 5 * 60_000;
/** So oft merkt sich ein sichtbarer Tab „ich bin noch da“ (deutlich kürzer als AWAY_MS). */
const HEARTBEAT_MS = 60_000;

function read(key: string): number | null {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function write(key: string, t: number): void {
  try {
    localStorage.setItem(key, String(t));
  } catch {
    // ohne Speicher (privates Fenster): dann gelten beim nächsten Mal 24 Std
  }
}

let loaded = false;
let baseline: number | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Bist du gerade (wieder) da? War NyxOS länger als AWAY_MS nirgends offen, beginnt ein neuer Besuch. */
function arrive(): boolean {
  const now = Date.now();
  const seen = read(LAST_SEEN_KEY);
  let changed = false;
  if (seen !== null && now - seen >= AWAY_MS) {
    baseline = seen;
    write(LAST_VISIT_KEY, seen);
    changed = true;
  }
  write(LAST_SEEN_KEY, now);
  return changed;
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  baseline = read(LAST_VISIT_KEY);
  if (typeof document === "undefined" || document.visibilityState !== "hidden") arrive();
}

function markSeen() {
  write(LAST_SEEN_KEY, Date.now());
}

function onVisibility() {
  if (document.visibilityState === "hidden") {
    markSeen();
    return;
  }
  if (arrive()) notify();
}

function onStorage(e: StorageEvent) {
  // Ein anderer Tab hat einen neuen Besuch begonnen → dieselbe Karte hier.
  if (e.key !== LAST_VISIT_KEY) return;
  const next = read(LAST_VISIT_KEY);
  if (next !== baseline) {
    baseline = next;
    notify();
  }
}

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", markSeen);
  window.addEventListener("storage", onStorage);
  window.setInterval(() => {
    if (document.visibilityState === "visible") markSeen();
  }, HEARTBEAT_MS);
}

function subscribe(cb: () => void) {
  ensureLoaded();
  install();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): number | null {
  ensureLoaded();
  return baseline;
}

/** Zeitpunkt (ms), an dem der vorige Besuch endete, oder `null`, wenn keiner gemerkt ist. */
export function useLastVisit(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** Nur für Tests: Speicher neu einlesen (wie ein frisch geladener Tab), Zustand zurücksetzen. */
export function __resetLastVisitForTests(): void {
  loaded = false;
  baseline = null;
  listeners.clear();
}

/** Nur für Tests: aktueller Bezugspunkt (lädt wie ein frischer Tab, falls nötig). */
export function readLastVisitForTests(): number | null {
  return getSnapshot();
}
