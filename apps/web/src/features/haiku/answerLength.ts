// Gemerkte Längen-Wahl für Nyx (Auto · Kurz · Normal · Ausführlich), je Browser.
// EINE Wahl für Nyx-Tab-Chat, Nyx-Feld und die Stimme – `streamHaikuChat` hängt sie an jede Anfrage (Feld `length`).
import { NyxAnswerLengthSchema, type NyxAnswerLength } from "@nyxos/shared";
import { useSyncExternalStore } from "react";

export const ANSWER_LENGTH_KEY = "nyx.answerLength";
export const DEFAULT_ANSWER_LENGTH: NyxAnswerLength = "auto";

/** Nur falls localStorage blockiert ist (privates Fenster): die Wahl gilt bis zum Neuladen. */
let memoryOnly: NyxAnswerLength | null = null;
const listeners = new Set<() => void>();

export function readAnswerLength(): NyxAnswerLength {
  if (memoryOnly) return memoryOnly;
  try {
    const parsed = NyxAnswerLengthSchema.safeParse(localStorage.getItem(ANSWER_LENGTH_KEY));
    return parsed.success ? parsed.data : DEFAULT_ANSWER_LENGTH;
  } catch {
    return DEFAULT_ANSWER_LENGTH;
  }
}

export function saveAnswerLength(value: NyxAnswerLength): void {
  try {
    localStorage.setItem(ANSWER_LENGTH_KEY, value);
    memoryOnly = null;
  } catch {
    memoryOnly = value;
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === ANSWER_LENGTH_KEY) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAnswerLength(): [NyxAnswerLength, (v: NyxAnswerLength) => void] {
  const value = useSyncExternalStore(subscribe, readAnswerLength, () => DEFAULT_ANSWER_LENGTH);
  return [value, saveAnswerLength];
}
