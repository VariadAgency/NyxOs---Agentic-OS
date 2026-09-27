// Gedrückt halten = sprechen. Mikrofon auf, solange die Nyx-Leiste gehalten wird; Loslassen gibt die
// Aufnahme als EIN Stück zurück (danach Server-Transkription, `transcribe`). Pegel 0–1 für die Anzeige in der
// Leiste. Mikrofon wird nach jedem Satz wieder geschlossen (Safari zeigt sonst dauerhaft den roten Punkt).
import { t } from "@nyxos/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportNyxLevel } from "../voice/levelBus";
import { micErrorMessage } from "../voice/vad";

/** Kürzer gehalten = versehentlich (kein Satz), wird verworfen. */
export const MIN_TALK_MS = 350;
/** Liefert der Recorder nach dem Stoppen kein „stop“ (Safari-Macke), wird trotzdem freigegeben. */
export const STOP_TIMEOUT_MS = 1_500;

export interface Recording {
  blob: Blob;
  ms: number;
}

export interface PushToTalk {
  /** Mikrofon offen und nimmt auf. */
  recording: boolean;
  /** Mikrofon nicht nutzbar – Text für dich. */
  error: string | null;
  /** Pegel 0–1 (pro Bild gelesen, ohne React). */
  level: () => number;
  start(): Promise<boolean>;
  /** Aufnahme beenden; `null` = zu kurz oder nichts aufgenommen. */
  stop(): Promise<Recording | null>;
  cancel(): void;
}

function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

interface Live {
  stream: MediaStream;
  recorder: MediaRecorder;
  parts: Blob[];
  startedAt: number;
  ctx: AudioContext | null;
  analyser: AnalyserNode | null;
  buf: Float32Array<ArrayBuffer> | null;
  level: number;
}

export function usePushToTalk(): PushToTalk {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<Live | null>(null);
  /** Loslassen, bevor das Mikrofon offen war (Erlaubnis-Dialog): danach sofort wieder zu. */
  const released = useRef(false);
  /** Zählt jeden Start: nur der jüngste darf sein Mikrofon behalten (schnelles Loslassen + erneut Halten). */
  const gen = useRef(0);

  /** Mikrofon wirklich freigeben: alle Spuren stoppen, Pegel-Kontext schließen. */
  const teardown = useCallback((l: Live | null) => {
    if (live.current === l) live.current = null;
    if (!l) return;
    for (const t of l.stream.getTracks()) t.stop();
    void l.ctx?.close().catch(() => {});
    if (!live.current) setRecording(false);
  }, []);

  const start = useCallback(async () => {
    if (live.current) return true;
    const mine = ++gen.current;
    released.current = false;
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(t("Dieser Browser kann nicht zuhören. Schreib Nyx einfach ins Feld."));
      return false;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      setError(micErrorMessage(e, true));
      return false;
    }
    // Inzwischen losgelassen oder neu gestartet: dieses Mikrofon sofort wieder schließen (kein roter Punkt bleibt).
    if (released.current || mine !== gen.current || live.current) {
      for (const t of stream.getTracks()) t.stop();
      return false;
    }
    const mime = pickMime();
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    const l: Live = { stream, recorder, parts: [], startedAt: performance.now(), ctx: null, analyser: null, buf: null, level: 0 };
    recorder.ondataavailable = (e) => {
      if (e.data?.size) l.parts.push(e.data);
    };
    // Pegel (optional – ohne Web Audio bleibt die Anzeige ruhig, die Aufnahme läuft trotzdem).
    try {
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        void ctx.resume().catch(() => {});
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        ctx.createMediaStreamSource(stream).connect(analyser);
        l.ctx = ctx;
        l.analyser = analyser;
        l.buf = new Float32Array(analyser.fftSize);
      }
    } catch {
      // kein Pegel – egal
    }
    recorder.start();
    live.current = l;
    setRecording(true);
    return true;
  }, []);

  const stop = useCallback(async (): Promise<Recording | null> => {
    released.current = true;
    const l = live.current;
    if (!l) return null;
    // Sofort abmelden: ein neues Halten während des Abschließens bekommt ein eigenes Mikrofon.
    live.current = null;
    const ms = performance.now() - l.startedAt;
    const rec = l.recorder;
    const blob = await new Promise<Blob>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(new Blob(l.parts, { type: rec.mimeType || pickMime() || "audio/webm" }));
      };
      rec.onstop = finish;
      setTimeout(finish, STOP_TIMEOUT_MS);
      try {
        if (rec.state !== "inactive") rec.stop();
        else finish();
      } catch {
        finish();
      }
    });
    teardown(l);
    if (ms < MIN_TALK_MS || blob.size === 0) return null;
    return { blob, ms };
  }, [teardown]);

  const cancel = useCallback(() => {
    released.current = true;
    const l = live.current;
    if (l) {
      l.recorder.ondataavailable = null;
      l.recorder.onstop = null;
      try {
        if (l.recorder.state !== "inactive") l.recorder.stop();
      } catch {
        // schon weg
      }
    }
    teardown(l);
  }, [teardown]);

  const level = useCallback(() => {
    const l = live.current;
    if (!l?.analyser || !l.buf) return 0;
    l.analyser.getFloatTimeDomainData(l.buf);
    let sum = 0;
    for (let i = 0; i < l.buf.length; i++) sum += (l.buf[i] ?? 0) * (l.buf[i] ?? 0);
    // Sprache liegt grob bei RMS 0,02–0,2 → auf 0–1 strecken, geglättet.
    const target = Math.min(1, Math.sqrt(sum / l.buf.length) * 7);
    l.level += (target - l.level) * 0.35;
    return l.level;
  }, []);

  useEffect(() => () => cancel(), [cancel]);
  // Solange das Mikrofon offen ist, bewegt der Pegel auch das Nyx-Logo (gemeinsame Pegel-Quelle).
  useEffect(() => (recording ? reportNyxLevel(level) : undefined), [recording, level]);

  return useMemo(() => ({ recording, error, level, start, stop, cancel }), [recording, error, level, start, stop, cancel]);
}
