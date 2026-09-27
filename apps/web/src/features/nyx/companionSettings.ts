// Einstellungen von Nyx in der Leiste (Dauer-Zuhören, Vorlesen) – im Browser gemerkt.
// Der schwebende Kreis ist weg – „anzeigen“ und der Platz (Seite/Höhe) entfallen, Nyx ist immer in der Leiste.
// Bewusst lokal (localStorage): es ist eine Vorliebe je Gerät (am Tablet vielleicht aus, am Rechner an).
import { useSyncExternalStore } from "react";

export interface CompanionSettings {
  /** Dauer-Zuhören (Mikrofon offen). Aus = nur gedrückt halten zum Sprechen, Schreiben geht immer. */
  listening: boolean;
  /** Antworten vorlesen. */
  speak: boolean;
}

export const COMPANION_KEY = "nyxos:companion";
/**
 * Stand der gespeicherten Vorlieben. Früher ließ sich Dauer-Zuhören über eine Kachel im Zentrum nebenbei
 * einschalten; gewollt ist aber, dass Nyx nur zuhört, solange die Leiste gedrückt gehalten wird. Ein alter Wert „an“
 * (ohne diesen Stand) gilt deshalb einmalig als „aus“ – wer es danach in den Einstellungen bewusst einschaltet, behält es.
 */
export const COMPANION_SCHEMA = 2;
// Zuhören ist aus: Nyx hört nur, solange die Leiste gedrückt gehalten wird. Dauer-Zuhören ist ein bewusster
// Schalter in den Einstellungen (danach gemerkt).
export const COMPANION_DEFAULTS: CompanionSettings = { listening: false, speak: true };

function rawValue(): string | null {
  try {
    return window.localStorage.getItem(COMPANION_KEY);
  } catch {
    return null;
  }
}

function parse(raw: string | null): CompanionSettings {
  try {
    if (!raw) return COMPANION_DEFAULTS;
    const v = JSON.parse(raw) as Partial<CompanionSettings> & { schema?: unknown };
    const current = v.schema === COMPANION_SCHEMA;
    return {
      listening: current && typeof v.listening === "boolean" ? v.listening : COMPANION_DEFAULTS.listening,
      speak: typeof v.speak === "boolean" ? v.speak : COMPANION_DEFAULTS.speak,
    };
  } catch {
    return COMPANION_DEFAULTS;
  }
}

// Gemerkt je Rohwert: gleiche Speicher-Zeichenkette = dasselbe Objekt (stabil für useSyncExternalStore),
// ein anderer Tab oder ein Test, der localStorage ändert, wird trotzdem sofort gesehen.
let cache: { raw: string | null; value: CompanionSettings } | null = null;
/** Nur falls localStorage blockiert ist: Wert im Speicher. */
let memoryOnly: CompanionSettings | null = null;
const listeners = new Set<() => void>();

export function getCompanionSettings(): CompanionSettings {
  if (memoryOnly) return memoryOnly;
  const raw = rawValue();
  if (!cache || cache.raw !== raw) cache = { raw, value: parse(raw) };
  return cache.value;
}

export function setCompanionSettings(patch: Partial<CompanionSettings>): void {
  const next = { ...getCompanionSettings(), ...patch };
  try {
    window.localStorage.setItem(COMPANION_KEY, JSON.stringify({ ...next, schema: COMPANION_SCHEMA }));
    memoryOnly = null;
  } catch {
    // privat/blockiert – gilt dann nur bis zum Neuladen
    memoryOnly = next;
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === COMPANION_KEY) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useCompanionSettings(): CompanionSettings {
  return useSyncExternalStore(subscribe, getCompanionSettings, () => COMPANION_DEFAULTS);
}
