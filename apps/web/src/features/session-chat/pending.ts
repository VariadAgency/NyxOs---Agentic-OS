// Gesendete Nachrichten, die noch nicht im Verlauf stehen (Claude schreibt sie erst ins
// Transkript, wenn er sie übernimmt). Der Chat zeigt sie so lange als eigene Blase mit Zustand an:
// „wird übergeben“ → „angekommen“ bzw. „in der Warteschlange“ — und entfernt sie, sobald die echte
// Nachricht im Verlauf auftaucht. Pro Browser-Tab im Speicher, bewusst nicht dauerhaft.
import { useSyncExternalStore } from "react";
import type { TranscriptItem } from "../../lib/api";

export type PendingState = "sending" | "delivered" | "queued" | "uncertain";

export interface PendingMessage {
  key: string;
  text: string;
  files: string[];
  sentAt: number;
  state: PendingState;
  error?: string;
}

/** Nach dieser Zeit ohne Treffer im Verlauf wird ehrlich „nicht im Verlauf angekommen“ gezeigt. */
export const PENDING_STALE_MS = 3 * 60_000;

const store = new Map<string, PendingMessage[]>();
const listeners = new Set<() => void>();
const EMPTY: PendingMessage[] = [];

function emit(): void {
  for (const l of listeners) l();
}

export function addPending(sessionId: string, m: PendingMessage): void {
  store.set(sessionId, [...(store.get(sessionId) ?? []), m]);
  emit();
}

export function updatePending(sessionId: string, key: string, patch: Partial<PendingMessage>): void {
  const list = store.get(sessionId);
  if (!list) return;
  store.set(
    sessionId,
    list.map((m) => (m.key === key ? { ...m, ...patch } : m)),
  );
  emit();
}

export function removePending(sessionId: string, key: string): void {
  const list = store.get(sessionId);
  if (!list) return;
  store.set(
    sessionId,
    list.filter((m) => m.key !== key),
  );
  emit();
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Steht diese gesendete Nachricht schon im Verlauf? (Text-Anfang oder — nur Anhänge — eine neue Nachricht von dir.) */
export function matchesTranscript(m: PendingMessage, items: TranscriptItem[]): boolean {
  const head = norm(m.text).slice(0, 40);
  return items.some((i) => {
    if (i.role !== "user") return false;
    const ts = Date.parse(i.ts);
    // Nur, was NACH dem Senden in den Verlauf kam (5 s Spielraum für Uhren-Versatz).
    if (Number.isFinite(ts) && ts < m.sentAt - 5_000) return false;
    if (!head) return true;
    return norm(i.text ?? "").includes(head);
  });
}

export function usePendingMessages(sessionId: string): PendingMessage[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => store.get(sessionId) ?? EMPTY,
  );
}

/** Nur für Tests: alle wartenden Nachrichten vergessen. */
export function __resetPendingForTests(): void {
  store.clear();
  emit();
}
