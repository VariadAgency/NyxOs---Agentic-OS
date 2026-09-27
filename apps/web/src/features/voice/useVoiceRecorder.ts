// Sprechen statt tippen — Aufnahme im Browser (MediaRecorder), Pegel über die Web Audio
// API (AnalyserNode, damit der Ring in `MicButton.tsx` animiert reagiert), Upload an
// `POST /api/voice/transcribe`. Reiner Hook, keine Darstellung — testbar ohne DOM-Rendering.
import { friendlyError, micErrorText } from "../../lib/friendlyError";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, type VoiceTarget } from "@nyxos/shared";
import { authFetch } from "../terminal/authClient";
import { reportNyxLevel } from "../nyx/voice/levelBus";

export type RecorderStatus = "idle" | "recording" | "transcribing" | "error";

export interface VoiceResult {
  text: string;
  tookMs: number;
  engine: "mac" | "server";
}

export interface UseVoiceRecorderOptions {
  target?: VoiceTarget;
  onResult?: (result: VoiceResult) => void;
}

/** Diktat-Pegel (RMS/64) ist bei Sprache eher klein – fürs Nyx-Logo auf ~0–1 strecken. */
const DICTATION_GAIN = 2.5;

/** 0–1, aus dem Zeitbereich-Signal (RMS) — reicht für einen ruhigen Pegelring, keine FFT nötig. */
function rmsLevel(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] ?? 128) - 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / data.length) / 64);
}

export function useVoiceRecorder(opts: UseVoiceRecorderOptions = {}) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  /** Derselbe Pegel für das Nyx-Logo (pro Bild gelesen, ohne React). */
  const levelRef = useRef(0);

  const stopLevelLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    levelRef.current = 0;
    setLevel(0);
  }, []);
  // Beim Diktieren (z. B. in der ⌘K-Suche) hört auch das Nyx-Logo mit.
  useEffect(() => (status === "recording" ? reportNyxLevel(() => Math.min(1, levelRef.current * DICTATION_GAIN)) : undefined), [status]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        levelRef.current = rmsLevel(data);
        setLevel(levelRef.current);
        rafRef.current = requestAnimationFrame(loop);
      };
      loop();

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start();
      setStatus("recording");
    } catch (e) {
      setError(micErrorText(e));
      setStatus("error");
    }
  }, []);

  const stop = useCallback(async () => {
    const recorder = mediaRef.current;
    if (!recorder || status !== "recording") return;
    const audioSeconds = (Date.now() - startedAtRef.current) / 1000;
    setStatus("transcribing");
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      recorder.stop();
    });
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    stopLevelLoop();
    try {
      const res = await authFetch(`/api/voice/transcribe?target=${opts.target ?? "search"}&audioSeconds=${audioSeconds.toFixed(1)}`, {
        method: "POST",
        headers: { "content-type": blob.type || "audio/webm" },
        body: blob,
      });
      if (!res.ok) {
        // Der Server sagt in einem Satz, was los ist (z. B. „Brücke nicht verbunden“) — nie eine Rohmeldung.
        const detail = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        throw new Error(detail ?? t("Die Erkennung hat nicht geklappt – bitte noch einmal versuchen."));
      }
      const body = (await res.json()) as VoiceResult;
      opts.onResult?.(body);
      setStatus("idle");
    } catch (e) {
      setError(friendlyError(e, t("Die Spracherkennung hat nicht geklappt – bitte noch einmal sprechen.")));
      setStatus("error");
    }
  }, [status, opts, stopLevelLoop]);

  const cancel = useCallback(() => {
    mediaRef.current?.stop();
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    stopLevelLoop();
    setStatus("idle");
  }, [stopLevelLoop]);

  return { status, level, error, start, stop, cancel };
}
