// Zustand eines Haiku-Fadens im Panel: Verlauf laden, Frage senden, NDJSON-Strom einarbeiten.
// Merkt sich den zuletzt benutzten Faden (pro Gerät) und holt ihn beim Öffnen zurück;
// ein neuer Faden kann „temporär“ starten (wird nach X Stunden gelöscht).
import { nyxToolDoing, t, type HaikuContext, type HaikuErrorCode, type HaikuMessage, type HaikuNoteKind, type HaikuSource, type HaikuStreamEvent, type HaikuThread } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchThread, streamHaikuChat } from "./haikuApi";

export type PendingState = { phase: "queued"; position?: number } | { phase: "thinking" } | { phase: "tool"; tool?: string } | { phase: "streaming" };

export interface ChatEntry {
  key: string;
  /** `note` = Karte aus dem Menü „⋯“ (Zusammenfassung, Aufgabe, Obsidian). */
  role: "user" | "assistant" | "note";
  noteKind?: HaikuNoteKind | null;
  text: string;
  sources: HaikuSource[];
  estimate: boolean;
  pending?: PendingState;
  error?: { code: HaikuErrorCode; message: string };
  /** Gedanken (Text vor den Werkzeugen) – eingeklappt zeigen, nie vorlesen. */
  thoughts?: string[];
}

/** Stimme für den Zentrum-Chat – Zwischenmeldung („Ich schau mal.“) und fertige Sprechfassung der Antwort. */
export interface HaikuChatVoice {
  onFiller?: (text: string) => void;
  onAnswer?: (speak: string) => void;
}

/** Zuletzt benutzter Faden: ID, oder "neu" (du hast bewusst „Neuer Faden“ gewählt). */
export const LAST_THREAD_KEY = "nyxos.haiku.faden";

function remember(value: number | "neu"): void {
  try {
    localStorage.setItem(LAST_THREAD_KEY, String(value));
  } catch {
    // privater Modus o. Ä. – dann kommt nach dem Neuladen eben der jüngste Faden
  }
}

function remembered(): number | "neu" | null {
  try {
    const v = localStorage.getItem(LAST_THREAD_KEY);
    if (v === "neu") return "neu";
    const n = Number(v);
    return v && Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Fäden aus Telegram (Handy-Gespräch) öffnen nie von selbst – weder im Zentrum noch im Nyx-Tab. */
const TELEGRAM_TOPIC = "telegram";

/**
 * Welcher Faden beim Öffnen kommt – dieselbe Regel für Zentrum und Nyx-Tab (ohne gemerkten
 * Faden springt das Zentrum nie in einen Telegram-Faden): gemerkter Faden, falls es ihn als eigenen Faden noch gibt;
 * gemerkt, aber weg oder aus Telegram → leer; nichts gemerkt → der jüngste eigene; „neu“ → leer.
 */
export function pickThread(threads: HaikuThread[], stored: number | "neu" | null): number | null {
  if (stored === "neu") return null;
  const own = threads.filter((th) => th.topic !== TELEGRAM_TOPIC);
  if (stored !== null) return own.some((th) => th.id === stored) ? stored : null;
  return own[0]?.id ?? null;
}

function toEntry(m: HaikuMessage): ChatEntry {
  return { key: `m-${m.id}`, role: m.role, text: m.text, sources: m.sources, estimate: m.estimate, ...(m.role === "note" ? { noteKind: m.noteKind ?? null } : {}) };
}

let seq = 0;
const nextKey = (prefix: string) => `${prefix}-${Date.now()}-${seq++}`;

/** Status → kurzer Text am Tipp-Indikator. `null` = nichts anzeigen (Text strömt bereits). */
export function pendingText(p: PendingState): string | null {
  if (p.phase === "queued") return p.position && p.position > 1 ? t("Nyx wartet (Platz {n}) …", { n: p.position }) : t("Nyx wartet kurz …");
  if (p.phase === "thinking") return t("Nyx denkt …");
  // Dieselbe Zuordnung wie Leiste, Nyx-Tab und Telegram (`@nyxos/shared`, nyx-tools.ts).
  if (p.phase === "tool") return `${nyxToolDoing(p.tool)} …`;
  return null;
}

export function useHaikuChat(voice: HaikuChatVoice = {}) {
  const qc = useQueryClient();
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [threadId, setThreadId] = useState<number | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Nur für einen NEUEN Faden: beim ersten Senden als temporär anlegen. */
  const [temporaryNext, setTemporaryNext] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const restored = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setThreadId(null);
    setEntries([]);
    setLoadError(null);
    setTemporaryNext(false);
  }, []);

  /** „Neuer Faden“: leeres Gespräch, und das bleibt so, bis du etwas schickst oder einen Faden wählst. */
  const reset = useCallback(() => {
    restored.current = true;
    clear();
    remember("neu");
  }, [clear]);

  const openThread = useCallback(
    async (id: number) => {
      restored.current = true;
      clear();
      remember(id);
      setThreadId(id);
      setLoadingThread(true);
      try {
        const { messages } = await fetchThread(id);
        setEntries(messages.map(toEntry));
      } catch {
        setLoadError(t("Verlauf konnte nicht geladen werden."));
      } finally {
        setLoadingThread(false);
      }
    },
    [clear],
  );

  /** Einmal beim ersten Öffnen: den zuletzt benutzten Faden zurückholen (sobald die Liste da ist). */
  const restore = useCallback(
    (threads: HaikuThread[]) => {
      if (restored.current) return;
      restored.current = true;
      const id = pickThread(threads, remembered());
      if (id !== null) void openThread(id);
    },
    [openThread],
  );

  const send = useCallback(
    async (message: string, context: HaikuContext) => {
      const text = message.trim();
      if (!text || busy) return;
      const userKey = nextKey("u");
      const botKey = nextKey("a");
      setEntries((prev) => [
        ...prev,
        { key: userKey, role: "user", text, sources: [], estimate: false },
        { key: botKey, role: "assistant", text: "", sources: [], estimate: false, pending: { phase: "queued" } },
      ]);
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (e: ChatEntry) => ChatEntry) => setEntries((prev) => prev.map((e) => (e.key === botKey ? fn(e) : e)));
      let finished = false;
      const onEvent = (ev: HaikuStreamEvent) => {
        if (controller.signal.aborted) return;
        switch (ev.type) {
          case "thread":
            setThreadId(ev.threadId);
            remember(ev.threadId);
            setTemporaryNext(false);
            void qc.invalidateQueries({ queryKey: ["haiku", "threads"] });
            break;
          case "status":
            patch((e) => ({
              ...e,
              pending: ev.status === "queued" ? { phase: "queued", position: ev.position } : ev.status === "tool" ? { phase: "tool", tool: ev.tool } : { phase: "thinking" },
            }));
            break;
          case "thought":
            // Der Entwurf war Denken → in „Gedanken“ verschieben, Antwort-Entwurf leeren.
            patch((e) => ({ ...e, text: "", thoughts: [...(e.thoughts ?? []), ev.text] }));
            break;
          case "filler":
            voiceRef.current.onFiller?.(ev.text);
            break;
          case "delta":
            patch((e) => ({ ...e, text: e.text + ev.text, pending: { phase: "streaming" } }));
            break;
          case "done":
            finished = true;
            patch((e) => ({ ...e, key: e.key, text: ev.text, sources: ev.sources, estimate: ev.estimate, pending: undefined, ...(ev.thoughts?.length ? { thoughts: ev.thoughts } : {}) }));
            voiceRef.current.onAnswer?.(ev.speak?.trim() || ev.text);
            void qc.invalidateQueries({ queryKey: ["haiku", "status"] });
            break;
          case "error":
            finished = true;
            patch((e) => ({ ...e, pending: undefined, error: { code: ev.code, message: ev.message } }));
            // Motor nicht (mehr) bereit → Zustand sofort neu holen, damit Hinweis + Sperre erscheinen.
            if (ev.code === "not_ready" || ev.code === "disabled") void qc.invalidateQueries({ queryKey: ["haiku", "status"] });
            break;
        }
      };

      try {
        await streamHaikuChat({ threadId, message: text, context, ...(threadId === null && temporaryNext ? { temporary: true } : {}) }, onEvent, controller.signal);
        if (!finished && !controller.signal.aborted) {
          patch((e) => ({ ...e, pending: undefined, error: { code: "engine", message: t("Die Antwort brach ab.") } }));
        }
      } catch {
        if (!controller.signal.aborted) patch((e) => ({ ...e, pending: undefined, error: { code: "engine", message: t("Server nicht erreichbar.") } }));
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(false);
        }
      }
    },
    [busy, qc, threadId, temporaryNext],
  );

  /** Neue Karte im gerade offenen Faden sofort zeigen (andere Fäden laden sie beim Öffnen). */
  const appendNote = useCallback(
    (id: number, message: HaikuMessage) => {
      if (id !== threadId) return;
      setEntries((prev) => (prev.some((e) => e.key === `m-${message.id}`) ? prev : [...prev, toEntry(message)]));
    },
    [threadId],
  );

  return { threadId, entries, busy, loadingThread, loadError, send, reset, openThread, restore, temporaryNext, setTemporaryNext, appendNote };
}
