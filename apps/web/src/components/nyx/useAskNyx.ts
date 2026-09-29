// „Nyx fragen“: EIN Weg für alle Knöpfe (Briefing-Kacheln, Konflikte, Audits, Entscheidungen).
// Fragt Nyx über den normalen Chat-Weg (`POST /api/haiku/chat`, Wegwerf-Faden, Kanal „voice“ = kurze, sprechbare
// Antwort), zeigt die Antwort und liest sie mit Nyx' Stimme vor. Das Nyx-Logo bewegt sich dabei mit (Pegel).
// Antworten werden 10 Minuten gemerkt (gleiche Frage + gleiche Daten = sofort da, kein neuer Lauf).
import { t } from "@nyxos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "../../lib/friendlyError";
import { streamHaikuChat } from "../../features/haiku/haikuApi";
import { useHaikuContext } from "../../features/haiku/useHaikuContext";
import { reportNyxLevel } from "../../features/nyx/voice/levelBus";
import { createSpeaker, type Speaker } from "../../features/nyx/voice/speaker";

export type AskNyxState = "idle" | "asking" | "answered" | "error";

export interface AskNyxAnswer {
  text: string;
  /** Kurze, sprechbare Fassung (ohne Markdown). */
  speak: string;
}

const CACHE_MS = 10 * 60_000;
/** eine fertige Antwort-Karte schließt sich nach einer Minute von selbst. */
export const ASK_NYX_AUTO_CLOSE_MS = 60_000;

/** Es steht immer nur EINE Antwort-Karte da – eine neue Frage schließt die vorige (egal welcher Knopf). */
let activeCard: { id: symbol; close: () => void } | null = null;
const MAX_FACTS = 3000;
const cache = new Map<string, { answer: AskNyxAnswer; at: number }>();

/** Nachricht an Nyx: Frage + die Daten, die auf der Seite stehen (damit er nichts erfinden muss). */
export function buildAskMessage(question: string, facts?: string | null): string {
  const f = (facts ?? "").trim().slice(0, MAX_FACTS);
  return [question.trim(), f ? t("Das steht gerade auf der Seite:\n{facts}", { facts: f }) : "", t("Fasse es kurz in zwei bis drei einfachen Sätzen zusammen – was ist los und was sollte ich tun?")].filter(Boolean).join("\n\n");
}

/** Nur für Tests. */
export function clearAskNyxCache(): void {
  cache.clear();
}

export function cachedAnswer(message: string, now = Date.now()): AskNyxAnswer | null {
  const hit = cache.get(message);
  if (!hit || now - hit.at > CACHE_MS) return null;
  return hit.answer;
}

export interface AskNyx {
  state: AskNyxState;
  answer: AskNyxAnswer | null;
  /** Antwort-Text, solange er noch hereinkommt. */
  partial: string;
  error: string | null;
  speaking: boolean;
  ask(): void;
  /** Antwort noch einmal vorlesen. */
  replay(): void;
  stopSpeaking(): void;
  reset(): void;
  /** Zeiger/Fokus auf der Karte: das automatische Schließen wartet. */
  hold(on: boolean): void;
}

export function useAskNyx(question: string, facts?: string | null): AskNyx {
  const { context } = useHaikuContext();
  const contextRef = useRef(context);
  contextRef.current = context;
  const message = buildAskMessage(question, facts);
  const [state, setState] = useState<AskNyxState>("idle");
  const [answer, setAnswer] = useState<AskNyxAnswer | null>(null);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const idRef = useRef(Symbol("ask-nyx"));
  const resetRef = useRef<() => void>(() => {});
  const [held, setHeld] = useState(false);

  const stopSpeaking = useCallback(() => {
    speakerRef.current?.cancel();
    speakerRef.current = null;
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (a: AskNyxAnswer) => {
      stopSpeaking();
      const text = a.speak.trim();
      if (!text) return;
      const sp = createSpeaker();
      speakerRef.current = sp;
      setSpeaking(true);
      // Das Nyx-Logo bewegt sich mit, solange er spricht.
      const unreport = reportNyxLevel(() => sp.level());
      sp.say(text);
      void sp.end().finally(() => {
        unreport();
        if (speakerRef.current === sp) {
          speakerRef.current = null;
          setSpeaking(false);
        }
      });
    },
    [stopSpeaking],
  );

  const ask = useCallback(() => {
    // Neue Frage: eine andere offene Karte schließt sich, diese wird die aktive.
    if (activeCard && activeCard.id !== idRef.current) activeCard.close();
    activeCard = { id: idRef.current, close: () => resetRef.current() };
    abortRef.current?.abort();
    setError(null);
    const hit = cachedAnswer(message);
    if (hit) {
      setAnswer(hit);
      setState("answered");
      speak(hit);
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setState("asking");
    setAnswer(null);
    setPartial("");
    let text = "";
    let finished = false;
    streamHaikuChat(
      { message, context: contextRef.current, temporary: true, channel: "voice" },
      (ev) => {
        if (abort.signal.aborted) return;
        if (ev.type === "delta") {
          text += ev.text;
          setPartial(text);
        } else if (ev.type === "done") {
          finished = true;
          const a: AskNyxAnswer = { text: ev.text || text, speak: ev.speak ?? (ev.text || text) };
          cache.set(message, { answer: a, at: Date.now() });
          setAnswer(a);
          setState("answered");
          speak(a);
        } else if (ev.type === "error") {
          finished = true;
          setError(ev.message || t("Nyx antwortet gerade nicht – bitte gleich noch einmal."));
          setState("error");
        }
      },
      abort.signal,
    )
      .then(() => {
        if (!finished && !abort.signal.aborted) {
          setError(t("Nyx hat nicht zu Ende geantwortet – bitte noch einmal."));
          setState("error");
        }
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setError(friendlyError(e, t("Nyx antwortet gerade nicht – bitte gleich noch einmal.")));
        setState("error");
      });
  }, [message, speak]);

  const reset = useCallback(() => {
    if (activeCard?.id === idRef.current) activeCard = null;
    abortRef.current?.abort();
    stopSpeaking();
    setState("idle");
    setAnswer(null);
    setPartial("");
    setError(null);
    setHeld(false);
  }, [stopSpeaking]);
  resetRef.current = reset;

  // Fertig (Antwort oder Fehler), Nyx spricht nicht mehr, niemand hält die Karte: nach einer Minute schließen.
  const done = state === "answered" || state === "error";
  useEffect(() => {
    if (!done || speaking || held) return;
    const timer = setTimeout(() => resetRef.current(), ASK_NYX_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [done, speaking, held]);

  // Seite verlassen: Frage abbrechen, Stimme aus.
  useEffect(
    () => () => {
      if (activeCard?.id === idRef.current) activeCard = null;
      abortRef.current?.abort();
      speakerRef.current?.cancel();
    },
    [],
  );

  return { state, answer, partial, error, speaking, ask, replay: () => answer && speak(answer), stopSpeaking, reset, hold: setHeld };
}
