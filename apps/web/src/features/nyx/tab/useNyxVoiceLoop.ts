// Gesprächsschleife des Nyx-Tabs (Halten zum Sprechen, Dauer-Zuhören, Zeitmessung, gehörter Teil beim
// Unterbrechen). Erkennung, Stimme, Satz-Zerlegung und Turn-Regeln kommen aus den gemeinsamen Bausteinen
// `features/nyx/voice/*` (dieselben wie beim Begleiter). Hält sich an die Jarvis-Sprach-Pipeline (Übernahmen aus
// adewaskar/jarvis, MIT, s. NOTICE):
//   Mikro → (Halten zum Sprechen | Dauer-Zuhören/VAD) → Warteschlange → POST /api/nyx/voice/transcribe
//   → Echo-Filter → Turn-Ende (holdFor) → POST /api/haiku/chat {channel:"voice"} → Satz-für-Satz
//   POST /api/nyx/voice/speak?stream=1
//   → Wiedergabe. Reinsprechen unterbricht sofort; der gehörte Teil wird gespeichert.
import { t, type NyxState } from "@nyxos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { synthesize, transcribe } from "../voice/serverVoice";
import { streamSentence } from "../voice/streamedSpeech";
import type { NyxTabSettings } from "./settings";
import type { NyxConversation } from "./useNyxConversation";
import type { LevelDrive } from "./voice/level";
import { openMicCapture, type MicCapture } from "./voice/mic";
import { createSpeaker, type Speaker } from "./voice/speaker";
import { holdFor, isEcho, isPhantom, isRealSpeech, MAX_HOLD_MS, SELF_GUARD_MS } from "../voice/turn";

/** Gemessene Zeiten einer Runde (ms), ab dem letzten gesprochenen Wort. */
export interface VoiceTiming {
  at: string;
  /** Aufnahme-Ende → Text da. */
  sttMs: number | null;
  /** Frage abgeschickt → erstes Textstück von Nyx. */
  llmFirstMs: number | null;
  /** Erstes Textstück → erster Ton. */
  ttsFirstMs: number | null;
  /** Letztes Wort → erster Ton (das, was sich wie Warten anfühlt). */
  totalMs: number | null;
}

export interface NyxVoiceLoop {
  awake: boolean;
  waking: boolean;
  state: NyxState;
  tool: string | null;
  holding: boolean;
  userCaption: string;
  nyxCaption: string;
  interrupted: boolean;
  error: string | null;
  timings: VoiceTiming[];
  wake(): Promise<void>;
  sleep(): void;
  pttDown(): void;
  pttUp(): void;
  interrupt(): void;
  /** Getippte Antwort zusätzlich vorlesen (Einstellung „auch getippte Antworten vorlesen“). */
  speak(text: string): void;
}

interface TurnMarks {
  speechEnd: number;
  sttDone: number | null;
  asked: number | null;
  firstDelta: number | null;
  firstAudio: number | null;
}

declare global {
  interface Window {
    /** Messwerte der letzten Runden (Playwright/Diagnose). */
    __nyxTimings?: VoiceTiming[];
  }
}

export function useNyxVoiceLoop(conversation: NyxConversation, settings: NyxTabSettings, drive: LevelDrive): NyxVoiceLoop {
  const [awake, setAwake] = useState(false);
  const [waking, setWaking] = useState(false);
  const [state, setState] = useState<NyxState>("idle");
  const [tool, setTool] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [userCaption, setUserCaption] = useState("");
  const [nyxCaption, setNyxCaption] = useState("");
  const [interrupted, setInterrupted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timings, setTimings] = useState<VoiceTiming[]>([]);

  const micRef = useRef<MicCapture | null>(null);
  /** Dauer-Zuhören: Stimme erkannt, während Nyx antwortet – Unterbrechen erst nach echten Worten. */
  const bargeRef = useRef(false);
  const speakerRef = useRef<Speaker | null>(null);
  const convRef = useRef(conversation);
  convRef.current = conversation;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const stateRef = useRef<NyxState>("idle");
  const answeringRef = useRef(false);
  const speakingStartedRef = useRef(false);
  /** Text der Zwischenmeldung („Ich schau mal.“) – sie klingt während des Werkzeugs, ist aber keine Antwort. */
  const fillerRef = useRef("");
  const turnRef = useRef(0);
  const marksRef = useRef<TurnMarks | null>(null);
  const heldRef = useRef<{ text: string; since: number; speechEnd: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sttChainRef = useRef<Promise<void>>(Promise.resolve());
  const ttsErrorShownRef = useRef(false);

  const go = useCallback((s: NyxState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const restState = useCallback((): NyxState => (settingsRef.current.continuous && micRef.current ? "listening" : "idle"), []);

  const recordTiming = useCallback(() => {
    const m = marksRef.current;
    if (!m || m.firstAudio === null) return;
    const t: VoiceTiming = {
      at: new Date().toISOString(),
      sttMs: m.sttDone !== null ? Math.round(m.sttDone - m.speechEnd) : null,
      llmFirstMs: m.firstDelta !== null && m.asked !== null ? Math.round(m.firstDelta - m.asked) : null,
      ttsFirstMs: m.firstDelta !== null ? Math.round(m.firstAudio - m.firstDelta) : null,
      totalMs: Math.round(m.firstAudio - m.speechEnd),
    };
    marksRef.current = null;
    setTimings((ts) => {
      const next = [t, ...ts].slice(0, 20);
      window.__nyxTimings = next;
      return next;
    });
  }, []);

  const ensureSpeaker = useCallback((): Speaker => {
    if (speakerRef.current) return speakerRef.current;
    const sp = createSpeaker(
      async (text, signal) => {
        const audio = await synthesize(text, { voice: settingsRef.current.voice, voiceEn: settingsRef.current.voiceEn, speed: settingsRef.current.rate, signal });
        if (!audio) throw new Error(t("Nyx kann gerade nicht sprechen – die Antwort steht rechts im Chat."));
        return audio;
      },
      drive,
      {
        onSentenceStart: (text, index) => {
          if (index === 0) {
            if (marksRef.current) marksRef.current.firstAudio = performance.now();
            recordTiming();
          }
          micRef.current?.setGuard(true);
          setNyxCaption(text);
          // Die Zwischenmeldung schaltete auf „spricht“, löschte das Werkzeug und
          // sperrte weitere Werkzeug-Meldungen (`speakingStartedRef`). Sie gehört zur Werkzeug-Phase.
          const t = text.trim();
          if (fillerRef.current && t && fillerRef.current.includes(t)) return;
          speakingStartedRef.current = true;
          setTool(null);
          go("speaking");
        },
        onDrained: () => {
          micRef.current?.setGuard(false);
          answeringRef.current = false;
          if (stateRef.current === "speaking" || stateRef.current === "thinking" || stateRef.current === "tool") go(restState());
        },
        onError: (message) => {
          if (ttsErrorShownRef.current) return;
          ttsErrorShownRef.current = true;
          setError(message);
        },
      },
      {
        // Tempo nur über `speed` an den Server (playbackRate bleibt 1).
        stream: (text, context, signal, ducked) =>
          streamSentence(text, { context, signal, ducked, voice: settingsRef.current.voice, voiceEn: settingsRef.current.voiceEn, speed: settingsRef.current.rate }),
      },
    );
    sp.setRate(settingsRef.current.rate);
    speakerRef.current = sp;
    return sp;
  }, [drive, go, recordTiming, restState]);

  useEffect(() => {
    speakerRef.current?.setRate(settings.rate);
  }, [settings.rate]);

  /** Laufende Antwort stoppen (Stimme aus, Strom ab), gehörten Teil speichern. */
  const interrupt = useCallback(() => {
    if (!answeringRef.current) return;
    const sp = speakerRef.current;
    const heard = sp ? sp.cancel() : "";
    answeringRef.current = false;
    convRef.current.interrupt(heard);
    micRef.current?.setGuard(false);
    setInterrupted(true);
    setNyxCaption(heard);
    setTool(null);
    marksRef.current = null;
    go(micRef.current ? "listening" : "idle");
  }, [go]);

  const commit = useCallback(
    (text: string, speechEnd: number, sttDone: number | null) => {
      const turn = ++turnRef.current;
      heldRef.current = null;
      setUserCaption(text);
      setNyxCaption("");
      setInterrupted(false);
      setError(null);
      ttsErrorShownRef.current = false;
      const sp = ensureSpeaker();
      sp.reset();
      answeringRef.current = true;
      speakingStartedRef.current = false;
      fillerRef.current = "";
      marksRef.current = { speechEnd, sttDone, asked: performance.now(), firstDelta: null, firstAudio: null };
      go("thinking");
      void convRef.current.ask(text, "voice", {
        onDelta: (d) => {
          if (turn !== turnRef.current) return;
          if (marksRef.current && marksRef.current.firstDelta === null) marksRef.current.firstDelta = performance.now();
          sp.push(d);
          // Antwort-Text strömt = Nyx antwortet (grün); die Such-Runde läuft in der Anzeige trotzdem zu Ende.
          fillerRef.current = "";
          if (stateRef.current !== "speaking") go("speaking");
        },
        // EINE Zwischenmeldung, solange die Werkzeuge laufen; Gedanken werden nie gesprochen.
        onFiller: (f) => {
          if (turn !== turnRef.current) return;
          fillerRef.current = f.trim();
          sp.push(`${f} `);
        },
        // Ein schon gestreamter Entwurf (ab 400 Zeichen) war doch ein Gedanke – was davon noch in der
        // Stimme steckt, sofort verwerfen, sonst läse Nyx sein Denken weiter vor.
        onThought: (_t, retract) => {
          if (turn !== turnRef.current || !retract) return;
          sp.cancel();
          sp.reset();
          // Es war doch keine Antwort – die folgenden Werkzeuge wieder zeigen (orange statt grün).
          speakingStartedRef.current = false;
          go("thinking");
        },
        onTool: (t) => {
          if (turn !== turnRef.current || speakingStartedRef.current) return;
          setTool(t);
          go(t ? "tool" : "thinking");
        },
        onDone: () => {
          if (turn !== turnRef.current) return;
          sp.end();
        },
        onError: (message) => {
          if (turn !== turnRef.current) return;
          answeringRef.current = false;
          setError(message);
          sp.cancel();
          go(restState());
        },
      });
    },
    [ensureSpeaker, go, restState],
  );

  const flushHeld = useCallback(() => {
    holdTimerRef.current = null;
    const held = heldRef.current;
    if (!held) return;
    commit(held.text, held.speechEnd, performance.now());
  }, [commit]);

  const onTranscript = useCallback(
    (text: string, speechEnd: number, mode: "ptt" | "continuous") => {
      const raw = text.trim();
      const sp = speakerRef.current;
      const barge = bargeRef.current;
      bargeRef.current = false;
      // Beim Dauer-Zuhören unterbrechen NUR echte Worte (≥ 2 Wörter bzw. „Stopp“),
      // nie Geräusche/Phantom-Texte der Erkennung oder das eigene Echo – dann Stimme wieder laut, weiter wie bisher.
      if (mode === "continuous" && (barge || answeringRef.current)) {
        if (!isRealSpeech(raw, sp?.spokenText() ?? "")) {
          sp?.duck(false);
          return;
        }
        interrupt();
      }
      const clean = mode === "continuous" && isPhantom(raw) ? "" : raw;
      if (!clean) {
        if (!heldRef.current && !answeringRef.current) {
          setUserCaption("");
          go(restState());
        }
        return;
      }
      // Hört Nyx sich selbst (Lautsprecher)? Dann verwerfen — „Stopp“ kommt immer durch (isEcho).
      if (sp && answeringRef.current && isEcho(clean, sp.spokenText())) return;
      if (mode === "ptt") {
        commit(clean, speechEnd, performance.now());
        return;
      }
      const held = heldRef.current;
      const joined = held ? `${held.text} ${clean}` : clean;
      heldRef.current = { text: joined, since: held?.since ?? performance.now(), speechEnd };
      setUserCaption(joined);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      const waited = performance.now() - (heldRef.current.since ?? 0);
      const wait = Math.max(0, Math.min(holdFor(joined), MAX_HOLD_MS - waited));
      if (wait === 0) flushHeld();
      else holdTimerRef.current = setTimeout(flushHeld, wait);
    },
    [commit, flushHeld, go, restState],
  );

  const onSegment = useCallback(
    (audio: Blob, speechMs: number, endedAt: number) => {
      const mode = settingsRef.current.continuous ? "continuous" : "ptt";
      if (!answeringRef.current) go("thinking");
      sttChainRef.current = sttChainRef.current.then(async () => {
        try {
          const r = await transcribe(audio, { audioSeconds: speechMs / 1000 });
          onTranscript(r.text ?? "", endedAt, mode);
        } catch (e) {
          // Erkennung gescheitert → nicht leise bleiben (Ducken aufheben), Nyx spricht normal weiter.
          bargeRef.current = false;
          speakerRef.current?.duck(false);
          setError(e instanceof Error ? e.message : t("Nyx hat dich gerade nicht verstanden – sag es bitte noch einmal."));
          if (!answeringRef.current && !heldRef.current) go(restState());
        }
      });
    },
    [go, onTranscript, restState],
  );

  const onSpeechStart = useCallback(() => {
    // Denkpause vorbei — du redest weiter: nicht mitten im Gedanken abschicken.
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    const sp = speakerRef.current;
    if (answeringRef.current) {
      const selfEcho = sp && speakingStartedRef.current && performance.now() - sp.sentenceStartedAt() < SELF_GUARD_MS;
      // Halten zum Sprechen = eindeutig du → sofort still. Dauer-Zuhören: erst leiser, die Transkription
      // entscheidet (echte Worte?), s. `onTranscript` – Straße, Vogel, Klappern brechen Nyx nicht mehr ab.
      if (settingsRef.current.continuous) {
        if (!selfEcho) {
          sp?.duck(true);
          bargeRef.current = true;
        }
        return;
      }
      if (!selfEcho) interrupt();
    }
    setUserCaption("");
    go("listening");
  }, [go, interrupt]);

  const wake = useCallback(async () => {
    if (micRef.current || waking) return;
    setWaking(true);
    setError(null);
    ensureSpeaker();
    const mic = await openMicCapture(drive, { onSpeechStart, onSegment, onError: (m) => setError(m) }, settingsRef.current.continuous ? "continuous" : "ptt");
    setWaking(false);
    if (!mic) return;
    micRef.current = mic;
    setAwake(true);
    go(settingsRef.current.continuous ? "listening" : "idle");
  }, [drive, ensureSpeaker, go, onSegment, onSpeechStart, waking]);

  const sleep = useCallback(() => {
    interrupt();
    micRef.current?.close();
    micRef.current = null;
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    heldRef.current = null;
    setAwake(false);
    setHolding(false);
    go("idle");
  }, [go, interrupt]);

  useEffect(() => {
    micRef.current?.setMode(settings.continuous ? "continuous" : "ptt");
    if (micRef.current && !answeringRef.current) go(settings.continuous ? "listening" : "idle");
  }, [settings.continuous, go]);

  const pttDown = useCallback(() => {
    if (!micRef.current || holding) return;
    setHolding(true);
    micRef.current.pttStart();
  }, [holding]);

  const pttUp = useCallback(() => {
    if (!micRef.current || !holding) return;
    setHolding(false);
    micRef.current.pttStop();
    if (stateRef.current === "listening" && !settingsRef.current.continuous) go("thinking");
  }, [go, holding]);

  const speak = useCallback(
    (text: string) => {
      const sp = ensureSpeaker();
      sp.reset();
      answeringRef.current = true;
      speakingStartedRef.current = false;
      fillerRef.current = "";
      sp.push(text);
      sp.end();
    },
    [ensureSpeaker],
  );

  // Aufräumen beim Verlassen des Tabs: Mikro zu, Stimme aus.
  useEffect(
    () => () => {
      micRef.current?.close();
      micRef.current = null;
      speakerRef.current?.dispose();
      speakerRef.current = null;
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    },
    [],
  );

  return { awake, waking, state, tool, holding, userCaption, nyxCaption, interrupted, error, timings, wake, sleep, pttDown, pttUp, interrupt, speak };
}
