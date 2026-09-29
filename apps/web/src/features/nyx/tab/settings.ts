// Einstellungen des Nyx-Tabs (je Browser, localStorage). Der Schalter „Begleiter“ ist derselbe
// Schlüssel, den der schwebende Kreis liest — Änderungen gehen zusätzlich als Fenster-Ereignis raus,
// damit der Kreis sofort reagiert, ohne neu zu laden.
import { useCallback, useSyncExternalStore } from "react";

export interface NyxTabSettings {
  /** Stimme (Name aus `GET /api/nyx/voice/status`, null = Standard des Servers). */
  voice: string | null;
  /** Englische Stimme für englische Sätze (null = Standard des Servers, `NYX_TTS_DEFAULT_EN`). */
  voiceEn: string | null;
  /** Sprechtempo 0,8 … 1,4. */
  rate: number;
  /** Dauer-Zuhören (Stille-Erkennung) statt „Halten zum Sprechen“. Nicht mehr im Tab einstellbar, immer aus. */
  continuous: boolean;
  /** Antworten auf getippte Fragen auch vorlesen (Standard an – Nyx liest immer vor). */
  speakTyped: boolean;
  /** Schwebender Nyx-Begleiter auf allen Seiten. */
  companion: boolean;
}

export const NYX_SETTINGS_KEY = "nyx.tab.settings";
/** Geteilt mit dem Begleiter. */
export const NYX_COMPANION_KEY = "nyx.companion.enabled";
export const NYX_SETTINGS_EVENT = "nyx:settings";

export const DEFAULT_SETTINGS: NyxTabSettings = { voice: null, voiceEn: null, rate: 1, continuous: false, speakTyped: true, companion: true };
/**
 * Früher war „Getippte Antworten vorlesen“ standardmäßig aus und wurde mit jedem Speichern als `false` abgelegt.
 * Darum zählt ein gespeichertes `false` nur, wenn du den Schalter selbst gestellt hat (Merker `speakTypedChosen`).
 */
const SPEAK_TYPED_CHOSEN = "speakTypedChosen";

function speakTypedChosen(): boolean {
  try {
    const raw = localStorage.getItem(NYX_SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>)[SPEAK_TYPED_CHOSEN] === true : false;
  } catch {
    return false;
  }
}
export const RATE_MIN = 0.8;
export const RATE_MAX = 1.4;

function read(): NyxTabSettings {
  try {
    const raw = localStorage.getItem(NYX_SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<NyxTabSettings>) : {};
    const companionRaw = localStorage.getItem(NYX_COMPANION_KEY);
    const rate = typeof parsed.rate === "number" ? Math.min(RATE_MAX, Math.max(RATE_MIN, parsed.rate)) : DEFAULT_SETTINGS.rate;
    return {
      voice: typeof parsed.voice === "string" ? parsed.voice : null,
      voiceEn: typeof parsed.voiceEn === "string" ? parsed.voiceEn : null,
      rate,
      // Dauer-Zuhören hat keinen Schalter mehr im Tab – ein alter „an“-Zustand zählt
      // als aus, sonst hörte Nyx unsichtbar dauerhaft mit (wie beim Begleiter).
      continuous: false,
      speakTyped: (parsed as Record<string, unknown>)[SPEAK_TYPED_CHOSEN] === true ? parsed.speakTyped === true : DEFAULT_SETTINGS.speakTyped,
      companion: companionRaw === null ? DEFAULT_SETTINGS.companion : companionRaw !== "0",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let cache: NyxTabSettings | null = null;
const listeners = new Set<() => void>();

function snapshot(): NyxTabSettings {
  if (!cache) cache = read();
  return cache;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === NYX_SETTINGS_KEY || e.key === NYX_COMPANION_KEY) {
      cache = null;
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

/** Aktueller Stand außerhalb von React (Leiste, „Nyx fragen“ lesen Stimme + Tempo beim Sprechen). */
export function readNyxSettings(): NyxTabSettings {
  return snapshot();
}

export function saveNyxSettings(patch: Partial<NyxTabSettings>): void {
  const next = { ...snapshot(), ...patch };
  cache = next;
  try {
    const { companion, ...rest } = next;
    const chosen = "speakTyped" in patch || speakTypedChosen();
    localStorage.setItem(NYX_SETTINGS_KEY, JSON.stringify(chosen ? { ...rest, [SPEAK_TYPED_CHOSEN]: true } : rest));
    localStorage.setItem(NYX_COMPANION_KEY, companion ? "1" : "0");
  } catch {
    // privates Fenster o. Ä. — gilt dann nur bis zum Neuladen
  }
  for (const l of listeners) l();
  window.dispatchEvent(new CustomEvent(NYX_SETTINGS_EVENT, { detail: next }));
}

export function useNyxSettings(): [NyxTabSettings, (patch: Partial<NyxTabSettings>) => void] {
  const s = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_SETTINGS);
  const set = useCallback((patch: Partial<NyxTabSettings>) => saveNyxSettings(patch), []);
  return [s, set];
}

/** Nur für Tests: Zwischenspeicher leeren. */
export function __resetNyxSettingsCache(): void {
  cache = null;
}
