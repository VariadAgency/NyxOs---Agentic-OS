// Die Gesprächs-Schleife von Nyx – EIN Hook für den Begleiter und den Vollbild-Tab.
//
//   Mikrofon → Stille-Erkennung (VAD, mit Vorlauf) → Server-Transkription
//   → Echo-Filter (hört Nyx sich selbst?) → Satz zusammensetzen (wartet, wenn du weiterredest)
//   → optional lokaler Schnell-Befehl („öffne …“) → Nyx über den Haiku-Chat-Weg (`channel`)
//   → Antwort Satz für Satz sprechen, Text parallel → Unterbrechen: sprichst du dazwischen,
//     verstummt Nyx sofort und die laufende Antwort wird abgebrochen.
//
// Regeln (Zahlen) übernommen aus adewaskar/jarvis `src/lib/voice.ts` (MIT, s. NOTICE): Warteschlange statt
// „besetzt“-Flag, SELF_GUARD 350 ms, Echo-Abgleich, Segment ≠ Turn.
import { t, type HaikuContext, type HaikuSource, type HaikuStreamEvent } from "@nyxos/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { streamHaikuChat } from "../haiku/haikuApi";
import type { NyxVisualState } from "./netModel";
import { transcribe } from "./voice/serverVoice";
import { reportNyxLevel } from "./voice/levelBus";
import { createSpeaker, type Speaker } from "./voice/speaker";
import { isEcho, isPhantom, isRealSpeech, makeAssembler } from "./voice/turn";
import { startVad, type VadHandle } from "./voice/vad";

export type NyxChannel = "web" | "voice" | "telegram";

export interface NyxVoiceLoopOptions {
  /** Dauer-Zuhören an (Mikrofon offen, Stille-Erkennung). */
  listening: boolean;
  /** Antworten vorlesen (Standard: an). */
  speak?: boolean;
  /** Kanal für gesprochene Fragen (Standard: "voice"). */
  channel?: NyxChannel;
  /** Kontext der Frage (was du gerade siehst). */
  context: () => HaikuContext;
  /** Vor dem Modell: kann der Text lokal erledigt werden? `true` = erledigt, nicht ans Modell. */
  intercept?: (text: string) => boolean | Promise<boolean>;
  /** Merkschlüssel für den Faden (Fortsetzen über Seitenwechsel). */
  threadKey?: string;
}

export interface NyxVoiceLoop {
  state: NyxVisualState;
  tool: string | null;
  /** Live-Pegel 0–1 (Mikrofon oder Stimme) – als Funktion, für 60 fps ohne React. */
  level: () => number;
  micError: string | null;
  /** Mikrofon ist offen. */
  micOpen: boolean;
  /** Zuletzt Gehörtes (Untertitel). */
  heard: string;
  /** Antwort-Text (wächst beim Strömen). */
  answer: string;
  /** Belege der Antwort (kommen mit „done“; `[n]` im Text verweist auf `answerSources[n-1]`). */
  answerSources: HaikuSource[];
  /** Gedanken der laufenden/letzten Antwort (Text vor den Werkzeugen) – nur anzeigen, nie vorlesen. */
  thoughts: string[];
  /** Fehler der letzten Frage in einfachen Worten. */
  error: string | null;
  busy: boolean;
  /** Frage schicken (getippt: channel "web"). */
  send(text: string, opts?: { channel?: NyxChannel; speak?: boolean }): Promise<void>;
  /**
   * Kurz etwas sagen (lokale Bestätigung), ohne Modell. `filler`: die Zwischenmeldung eines getippten Chats
   * („Ich schau mir das mal an.“) – sie klingt, schaltet aber nicht auf „spricht“ (die Werkzeug-Phase bleibt orange).
   */
  say(text: string, opts?: { filler?: boolean }): void;
  /** Eine fertige Antwort (z. B. aus dem Zentrum-Chat) hinten anreihen und vorlesen – respektiert „Vorlesen aus“. */
  speakAnswer(text: string): void;
  /** Nyx verstummt, laufende Antwort bricht ab. */
  interrupt(): void;
}

/** Barge-in so kurz nach eigenem Satzbeginn ist fast immer das eigene Echo. */
const SELF_GUARD_MS = 350;

function readThread(key: string | undefined): number | null {
  if (!key) return null;
  try {
    const v = Number(sessionStorage.getItem(key));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function writeThread(key: string | undefined, id: number): void {
  if (!key) return;
  try {
    sessionStorage.setItem(key, String(id));
  } catch {
    // privat/blockiert – dann eben ein neuer Faden
  }
}

export function useNyxVoiceLoop(opts: NyxVoiceLoopOptions): NyxVoiceLoop {
  const [phase, setPhase] = useState<"idle" | "hearing" | "transcribing" | "thinking" | "tool" | "speaking">("idle");
  const [tool, setTool] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [micOpen, setMicOpen] = useState(false);
  const [heard, setHeard] = useState("");
  const [answer, setAnswer] = useState("");
  const [answerSources, setAnswerSources] = useState<HaikuSource[]>([]);
  const [thoughts, setThoughts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const vadRef = useRef<VadHandle | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<number | null>(readThread(opts.threadKey));
  const turnRef = useRef(0);
  const hearingRef = useRef(false);
  const queueRef = useRef<{ blob: Blob; ms: number }[]>([]);
  const drainingRef = useRef(false);
  /** Stimme erkannt, während Nyx arbeitete/sprach – Unterbrechen erst nach echten Worten. */
  const bargeRef = useRef(false);
  const busyRef = useRef(false);
  /** Text der laufenden Zwischenmeldung („Ich schau mal.“) – sie klingt, ist aber noch keine Antwort. */
  const fillerRef = useRef("");
  const setBusy = useCallback((b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  }, []);

  const interrupt = useCallback(() => {
    turnRef.current++;
    speakerRef.current?.cancel();
    speakerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    vadRef.current?.setGuard(false);
    setBusy(false);
    setTool(null);
    setPhase(hearingRef.current ? "hearing" : "idle");
  }, []);

  const newSpeaker = useCallback((onSound?: () => void) => {
    speakerRef.current?.cancel();
    const sp = createSpeaker({
      onSpeakingChange: (on) => {
        // Während Nyx spricht: höhere Schwelle, damit seine Stimme ihn nicht selbst unterbricht.
        vadRef.current?.setGuard(on);
        if (!on) return;
        // Die Zwischenmeldung klang ~0,5 s nach dem Werkzeug-Start und schaltete die
        // Phase auf „spricht“ – das Werkzeug (orange, Such-Animation) war weg. Sie gehört zur Werkzeug-Phase.
        const now = sp.speakingText().trim();
        if (!fillerRef.current || !now || !fillerRef.current.includes(now)) setPhase("speaking");
        onSound?.();
      },
    });
    speakerRef.current = sp;
    return sp;
  }, []);

  const say = useCallback(
    (text: string, sayOpts: { filler?: boolean } = {}) => {
      if (optsRef.current.speak === false) return;
      // Zwischenmeldung des getippten Chats (Zentrum/Nyx-Feld) gehört zur Werkzeug-Phase, nicht zur Antwort.
      fillerRef.current = sayOpts.filler ? text.trim() : "";
      const sp = speakerRef.current ?? newSpeaker();
      sp.say(text);
      void sp.end().then(() => {
        if (speakerRef.current === sp) setPhase((p) => (p === "speaking" ? (hearingRef.current ? "hearing" : "idle") : p));
      });
    },
    [newSpeaker],
  );

  const speakAnswer = useCallback(
    (text: string) => {
      if (optsRef.current.speak === false || !text.trim()) return;
      // Jetzt kommt die echte Antwort: ab hier schaltet jeder klingende Satz auf „spricht“.
      fillerRef.current = "";
      const sp = speakerRef.current ?? newSpeaker();
      sp.push(`${text.trim()} `);
      void sp.end().then(() => {
        if (speakerRef.current === sp) setPhase((p) => (p === "speaking" ? (hearingRef.current ? "hearing" : "idle") : p));
      });
    },
    [newSpeaker],
  );

  const send = useCallback(
    async (text: string, sendOpts: { channel?: NyxChannel; speak?: boolean } = {}) => {
      const message = text.trim();
      if (!message) return;
      interrupt();
      const turn = turnRef.current;
      setError(null);
      setAnswer("");
      setAnswerSources([]);
      setThoughts([]);
      setBusy(true);
      setPhase("thinking");
      fillerRef.current = "";
      const wantSpeak = sendOpts.speak ?? optsRef.current.speak ?? true;
      // Hat schon ein Satz der ANTWORT geklungen? Die Zwischenmeldung zählt nicht. Nur wenn nicht,
      // ersetzt die Sprechfassung (`done.speak`, ohne Markdown) den rohen Text – sonst hörtest du Sätze doppelt.
      let filler = "";
      let answerSounded = false;
      const onSound = () => {
        const now = speakerRef.current?.speakingText().trim() ?? "";
        if (!filler || now !== filler) answerSounded = true;
      };
      let sp = wantSpeak ? newSpeaker(onSound) : null;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let full = "";
      const body = {
        threadId: threadRef.current,
        message,
        context: optsRef.current.context(),
        // Vertrag „Nyx fragen“: Kanal, damit der Kern kurz/sprechbar antworten kann.
        channel: sendOpts.channel ?? optsRef.current.channel ?? "voice",
      };
      const onEvent = (ev: HaikuStreamEvent) => {
        if (turn !== turnRef.current) return;
        if (ev.type === "thread") {
          threadRef.current = ev.threadId;
          writeThread(optsRef.current.threadKey, ev.threadId);
        } else if (ev.type === "status") {
          if (ev.status === "tool") {
            setTool(ev.tool ?? null);
            setPhase("tool");
          } else setPhase((p) => (p === "speaking" ? p : "thinking"));
        } else if (ev.type === "thought") {
          // Gedanke, keine Antwort – anzeigen (eingeklappt), nie vorlesen; ein schon gezeigter Entwurf geht weg.
          setThoughts((t) => [...t, ev.text]);
          full = "";
          setAnswer("");
          setPhase((p) => (p === "speaking" ? "thinking" : p));
          // Ein schon (ab 400 Zeichen) gestreamter Entwurf war doch ein Gedanke – was davon noch in der
          // Stimme steckt, sofort verwerfen, sonst läse Nyx sein Denken weiter vor.
          if (ev.retract && sp) {
            answerSounded = false;
            sp = newSpeaker(onSound);
          }
        } else if (ev.type === "filler") {
          // EINE kurze Zwischenmeldung („Ich schau mal.“), solange die Werkzeuge laufen.
          if (sp) {
            filler = ev.text.trim();
            fillerRef.current = filler;
            sp.say(ev.text);
          }
        } else if (ev.type === "delta") {
          full += ev.text;
          setAnswer(full);
          sp?.push(ev.text);
          // Antwort-Text strömt = Nyx antwortet (grün) – die ruhige Abfolge lässt die Such-Runde vorher zu Ende laufen.
          fillerRef.current = "";
          setPhase("speaking");
        } else if (ev.type === "done") {
          if (ev.thoughts?.length) setThoughts(ev.thoughts);
          // Der Nyx-Kern kann eine kurze, sprechbare Fassung mitschicken (`speak`); sonst wurde der Text schon gestreamt.
          const speakText = (ev as { speak?: unknown }).speak;
          full = ev.text || full;
          setAnswer(full);
          setAnswerSources(ev.sources);
          if (sp && typeof speakText === "string" && speakText.trim() && !answerSounded) {
            // Den rohen Text (noch nicht geklungen) verwerfen; eine laufende Zwischenmeldung darf ausklingen.
            sp.dropQueued();
            sp.say(speakText);
            void sp.end();
          }
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      };
      try {
        await streamHaikuChat(body as Parameters<typeof streamHaikuChat>[0], onEvent, ctrl.signal);
      } catch (e) {
        if (turn === turnRef.current && !ctrl.signal.aborted) setError(e instanceof Error && e.message ? e.message : t("Nyx ist gerade nicht erreichbar."));
      }
      if (turn !== turnRef.current) return;
      setBusy(false);
      setTool(null);
      abortRef.current = null;
      if (sp) {
        const cur = speakerRef.current;
        await (cur ?? sp).end();
      }
      if (turn === turnRef.current) setPhase(hearingRef.current ? "hearing" : "idle");
    },
    [interrupt, newSpeaker],
  );

  // Gehörtes → fertiger Gedanke → lokaler Befehl oder Nyx.
  const assembler = useMemo(
    () =>
      makeAssembler({
        partial: (t) => setHeard(t),
        emit: (t) => {
          setHeard(t);
          void (async () => {
            const handled = (await optsRef.current.intercept?.(t)) ?? false;
            if (!handled) await send(t, { channel: optsRef.current.channel ?? "voice" });
          })();
        },
      }),
    [send],
  );

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      for (;;) {
        const seg = queueRef.current.shift();
        if (!seg) break;
        setPhase((p) => (p === "hearing" || p === "idle" ? "transcribing" : p));
        try {
          const r = await transcribe(seg.blob, { audioSeconds: seg.ms / 1000 });
          const spoken = speakerRef.current?.speakingText() ?? "";
          const text = r.text?.trim() ?? "";
          const barge = bargeRef.current;
          bargeRef.current = false;
          // Während Nyx denkt/spricht, unterbrechen NUR echte Worte (≥ 2 Wörter bzw.
          // „Stopp“, kein Phantom-Text, kein Echo). Geräusche → Stimme wieder laut, Nyx macht weiter.
          if (barge || busyRef.current) {
            if (!isRealSpeech(text, spoken)) {
              speakerRef.current?.duck(false);
              continue;
            }
            interrupt();
          } else if (!text || isPhantom(text) || isEcho(text, spoken)) continue;
          // „Sprichst du gerade?“ (Stille-Erkennung) – nicht „Mikro offen“, sonst wartete der
          // Zusammensetzer bei Dauer-Zuhören IMMER die Höchstzeit (6 s), bevor Nyx etwas tat.
          assembler.feed(text, vadRef.current?.speaking() ?? false);
        } catch (e) {
          // Erkennung gescheitert → Ducken aufheben, sonst bliebe Nyx für den Rest der Antwort leise.
          bargeRef.current = false;
          speakerRef.current?.duck(false);
          setError(e instanceof Error ? e.message : t("Die Erkennung hat nicht geklappt."));
        }
        setPhase((p) => (p === "transcribing" ? (hearingRef.current ? "hearing" : "idle") : p));
      }
    } finally {
      drainingRef.current = false;
    }
  }, [assembler]);

  // Dauer-Zuhören an/aus.
  useEffect(() => {
    if (!opts.listening) return;
    let cancelled = false;
    let handle: VadHandle | null = null;
    setMicError(null);
    void startVad({
      onStart: () => {
        const sp = speakerRef.current;
        // Vielleicht redest du dazwischen: erst leiser (nicht in den ersten 350 ms eines eigenen Satzes), ob Nyx
        // wirklich verstummt, entscheidet die Transkription (echte Worte statt Straße/Vogel), s. `drain`.
        if (sp?.isSpeaking() && performance.now() - sp.speakingSince() > SELF_GUARD_MS) {
          sp.duck(true);
          bargeRef.current = true;
        } else if (busyRef.current) bargeRef.current = true;
        setPhase((p) => (p === "idle" ? "hearing" : p));
      },
      onSegment: (blob, ms) => {
        queueRef.current.push({ blob, ms });
        void drain();
      },
      onError: (msg) => {
        if (!cancelled) setMicError(msg);
      },
    }).then((h) => {
      if (cancelled) {
        h?.stop();
        return;
      }
      if (!h) return;
      handle = h;
      vadRef.current = h;
      hearingRef.current = true;
      setMicOpen(true);
      setPhase((p) => (p === "idle" ? "hearing" : p));
    });
    return () => {
      cancelled = true;
      handle?.stop();
      vadRef.current = null;
      hearingRef.current = false;
      assembler.cancel();
      setMicOpen(false);
      setPhase((p) => (p === "hearing" || p === "transcribing" ? "idle" : p));
    };
    // Nur an/aus zählt – die übrigen Werte kommen über Refs.
  }, [opts.listening]);

  useEffect(() => () => interrupt(), [interrupt]);

  const level = useCallback(() => {
    const sp = speakerRef.current;
    if (sp?.isSpeaking()) return sp.level();
    return vadRef.current?.level() ?? 0;
  }, []);

  const state: NyxVisualState = phase === "speaking" ? "speaking" : phase === "tool" ? "tool" : phase === "thinking" || phase === "transcribing" ? "thinking" : phase === "hearing" ? "listening" : "idle";
  // Mikrofon offen oder Nyx spricht → derselbe Pegel bewegt das Nyx-Logo (gemeinsame Pegel-Quelle).
  const soundOn = micOpen || state === "speaking";
  useEffect(() => (soundOn ? reportNyxLevel(level) : undefined), [soundOn, level]);

  return { state, tool, level, micError, micOpen, heard, answer, answerSources, thoughts, error, busy, send, say, speakAnswer, interrupt };
}
