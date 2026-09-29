// EIN Gespräch für den ganzen Nyx-Tab — gesprochene und getippte Fragen landen im selben Faden
// (derselbe Weg wie das Haiku-Panel: `POST /api/haiku/chat`, NDJSON), dazu je Antwort Kosten/Tokens (für den
// Reiter „Kontext“) und das Kennzeichen „unterbrochen“.
// Der Tab setzt den zuletzt benutzten Faden fort – dasselbe Gedächtnis wie das Nyx-Zentrum
// (`LAST_THREAD_KEY`, `pickTabThread`): gemerkter Faden, sonst der jüngste; „neu“ (bewusst „Neues Gespräch“) bleibt leer.
// Vorher merkte sich der Tab einen eigenen Faden und zeigte „Noch kein Gespräch.“, obwohl das Zentrum einen hatte.
import { t, type HaikuChatRequest, type HaikuSource, type HaikuUsage, type NyxFile } from "@nyxos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchThread, fetchThreads, streamHaikuChat } from "../../haiku/haikuApi";
import { LAST_THREAD_KEY, pickThread } from "../../haiku/useHaikuChat";
import { saveInterrupted } from "./nyxTabApi";

export type NyxChannel = "web" | "voice";

export interface ConvMessage {
  key: string;
  id?: number;
  role: "user" | "assistant";
  text: string;
  channel?: NyxChannel;
  streaming?: boolean;
  interrupted?: boolean;
  error?: string;
  usage?: HaikuUsage;
  callId?: number;
  sources: HaikuSource[];
  estimate?: boolean;
  /** Werkzeuge, die Nyx für diese Antwort benutzt hat (Reihenfolge wie gemeldet). */
  tools: string[];
  /** Gedanken (Text vor den Werkzeugen) – eingeklappt zeigen, nie vorlesen. */
  thoughts?: string[];
  /** Sprechfassung der fertigen Antwort (ohne Markdown/Links) – die liest die Stimme bei getippten Fragen. */
  speak?: string;
  attachments?: NyxFile[];
  createdAt: string;
}

export interface AskHandlers {
  onDelta?: (text: string) => void;
  /** Kurze Zwischenmeldung beim ersten Werkzeug („Ich schau mal.“) – darf gesprochen werden. */
  onFiller?: (text: string) => void;
  /** Der bisherige Entwurf war ein Gedanke. `retract`: er war schon gestreamt (Stimme sofort verwerfen). */
  onThought?: (text: string, retract: boolean) => void;
  onTool?: (tool: string | null) => void;
  onDone?: (text: string) => void;
  onError?: (message: string) => void;
}

/** Alter, nur vom Tab benutzter Schlüssel (ältere Version) – wird einmal übernommen und dann gelöscht. */
const LEGACY_THREAD_KEY = "nyx.tab.thread";
let seq = 0;
const key = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Welcher Faden beim Öffnen des Tabs kommt: Telegram-Fäden nie (sonst schriebe der Tab in das
 * Handy-Gespräch). Dieselbe Funktion wie im Zentrum (`pickThread`), damit beide nie auseinanderlaufen.
 */
export const pickTabThread = pickThread;

/** Gemerkter Faden (gemeinsam mit dem Zentrum): ID, „neu“ oder nichts. */
function rememberedThread(): number | "neu" | null {
  try {
    const v = localStorage.getItem(LAST_THREAD_KEY) ?? localStorage.getItem(LEGACY_THREAD_KEY);
    if (v === "neu") return "neu";
    const n = Number(v);
    return v && Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function rememberThread(value: number | "neu"): void {
  try {
    localStorage.setItem(LAST_THREAD_KEY, String(value));
    localStorage.removeItem(LEGACY_THREAD_KEY);
  } catch {
    // privater Modus: dann kommt beim nächsten Öffnen eben der jüngste Faden
  }
}

export interface NyxConversation {
  threadId: number | null;
  /** Titel des laufenden Fadens (wie in der Fadenliste des Zentrums), sonst null. */
  title: string | null;
  messages: ConvMessage[];
  busy: boolean;
  loading: boolean;
  /** Werkzeug, das Nyx für die laufende Antwort gerade benutzt (null = keins). */
  tool: string | null;
  ask(text: string, channel: NyxChannel, handlers?: AskHandlers, attachments?: NyxFile[]): Promise<void>;
  /** Laufende Antwort abbrechen und — falls etwas gehört wurde — als „unterbrochen“ speichern. */
  interrupt(heard: string | null): void;
  newThread(): void;
}

export function useNyxConversation(): NyxConversation {
  const [threadId, setThreadId] = useState<number | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConvMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => rememberedThread() !== "neu");
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const ctrlRef = useRef<AbortController | null>(null);
  const answerKeyRef = useRef<string | null>(null);
  const questionRef = useRef<string | null>(null);
  /** Hast du schon selbst etwas getan (gefragt, „Neues Gespräch“)? Dann überschreibt das Laden nichts mehr. */
  const touchedRef = useRef(false);

  // Beim Öffnen den zuletzt benutzten Faden fortsetzen (wie das Zentrum): gemerkt, sonst der jüngste.
  useEffect(() => {
    const stored = rememberedThread();
    if (stored === "neu") return;
    let cancelled = false;
    (async () => {
      const threads = await fetchThreads();
      const id = pickTabThread(threads, stored);
      if (id === null || cancelled || touchedRef.current) return;
      const r = await fetchThread(id);
      if (cancelled || touchedRef.current) return;
      threadRef.current = id;
      setThreadId(id);
      setTitle(r.thread?.title || threads.find((t) => t.id === id)?.title || null);
      setMessages(
        // Karten aus dem Menü „⋯“ (role = note) sind keine Gesprächsrunden.
        r.messages.flatMap((m) => (m.role === "note" ? [] : [{ key: `db${m.id}`, id: m.id, role: m.role, text: m.text, sources: m.sources, estimate: m.estimate, interrupted: m.interrupted === true, tools: [], createdAt: m.createdAt }])),
      );
    })()
      .catch(() => {
        // Liste/Faden gerade nicht erreichbar → leer anfangen; die erste Frage legt einen neuen Faden an.
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback((k: string, fn: (m: ConvMessage) => ConvMessage) => {
    setMessages((ms) => ms.map((m) => (m.key === k ? fn(m) : m)));
  }, []);

  const ask = useCallback(
    async (text: string, channel: NyxChannel, handlers: AskHandlers = {}, attachments?: NyxFile[]) => {
      touchedRef.current = true;
      setLoading(false);
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const now = new Date().toISOString();
      const userKey = key();
      const answerKey = key();
      answerKeyRef.current = answerKey;
      questionRef.current = text;
      setMessages((ms) => [
        ...ms,
        { key: userKey, role: "user", text, channel, sources: [], tools: [], attachments, createdAt: now },
        { key: answerKey, role: "assistant", text: "", channel, streaming: true, sources: [], tools: [], createdAt: now },
      ]);
      setBusy(true);
      const req = {
        threadId: threadRef.current,
        message: text,
        context: { path: "/nyx", tab: "Nyx", filters: {}, openSessionId: null, openEntryId: null, title: null },
        // Kanal der Frage (Antwort sprechbar halten, wenn „voice“). Ältere Server ignorieren das Feld.
        channel,
      } as HaikuChatRequest & { channel: NyxChannel };
      let acc = "";
      try {
        await streamHaikuChat(
          req,
          (ev) => {
            if (ctrl.signal.aborted) return;
            switch (ev.type) {
              case "thread":
                if (ev.threadId !== threadRef.current) {
                  threadRef.current = ev.threadId;
                  setThreadId(ev.threadId);
                  // Neuer Faden: Titel vergibt der Server; bis dahin die Frage selbst (gekürzt).
                  setTitle(text.length > 60 ? `${text.slice(0, 57)}…` : text);
                }
                rememberThread(ev.threadId);
                break;
              case "status":
                if (ev.status === "tool" && ev.tool) {
                  const tool = ev.tool;
                  patch(answerKey, (m) => ({ ...m, tools: m.tools.at(-1) === tool ? m.tools : [...m.tools, tool] }));
                  setTool(tool);
                  handlers.onTool?.(tool);
                } else {
                  setTool(null);
                  handlers.onTool?.(null);
                }
                break;
              case "thought":
                acc = "";
                patch(answerKey, (m) => ({ ...m, text: "", thoughts: [...(m.thoughts ?? []), ev.text] }));
                handlers.onThought?.(ev.text, ev.retract === true);
                break;
              case "filler":
                handlers.onFiller?.(ev.text);
                break;
              case "delta":
                if (!acc) setTool(null);
                acc += ev.text;
                patch(answerKey, (m) => ({ ...m, text: m.text + ev.text }));
                handlers.onDelta?.(ev.text);
                break;
              case "done":
                patch(answerKey, (m) => ({
                  ...m,
                  id: ev.messageId,
                  text: ev.text || acc,
                  streaming: false,
                  sources: ev.sources,
                  estimate: ev.estimate,
                  usage: ev.usage,
                  callId: ev.callId,
                  ...(ev.speak ? { speak: ev.speak } : {}),
                  ...(ev.thoughts?.length ? { thoughts: ev.thoughts } : {}),
                }));
                handlers.onDone?.(ev.text || acc);
                break;
              case "error":
                patch(answerKey, (m) => ({ ...m, streaming: false, error: ev.message }));
                handlers.onError?.(ev.message);
                break;
            }
          },
          ctrl.signal,
        );
      } catch (e) {
        if (!ctrl.signal.aborted) {
          const message = e instanceof Error && e.message ? t("Nyx ist gerade nicht erreichbar – bitte gleich noch einmal.") : t("Nyx ist gerade nicht erreichbar.");
          patch(answerKey, (m) => ({ ...m, streaming: false, error: message }));
          handlers.onError?.(message);
        }
      } finally {
        if (ctrlRef.current === ctrl) {
          ctrlRef.current = null;
          setBusy(false);
          setTool(null);
          patch(answerKey, (m) => (m.streaming ? { ...m, streaming: false } : m));
        }
      }
    },
    [patch],
  );

  const interrupt = useCallback(
    (heard: string | null) => {
      const ctrl = ctrlRef.current;
      const answerKey = answerKeyRef.current;
      if (ctrl) {
        ctrl.abort();
        ctrlRef.current = null;
        setBusy(false);
        setTool(null);
      }
      if (heard === null || !answerKey) return;
      const text = heard.trim() || t("(unterbrochen, bevor Nyx etwas sagen konnte)");
      patch(answerKey, (m) => ({ ...m, text, streaming: false, interrupted: true }));
      const id = threadRef.current;
      if (id) void saveInterrupted(id, heard, questionRef.current ?? undefined).catch(() => undefined);
    },
    [patch],
  );

  const newThread = useCallback(() => {
    touchedRef.current = true;
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    rememberThread("neu");
    threadRef.current = null;
    setThreadId(null);
    setTitle(null);
    setMessages([]);
    setBusy(false);
    setLoading(false);
  }, []);

  return { threadId, title, messages, busy, loading, tool, ask, interrupt, newThread };
}
