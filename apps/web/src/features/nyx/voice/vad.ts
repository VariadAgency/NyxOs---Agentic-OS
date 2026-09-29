// Dauer-Zuhören im Browser – Mikrofon, Pegel, Stille-Erkennung, Aufnahme mit Vorlauf.
//
// Übernommen und angepasst aus adewaskar/jarvis `src/lib/vad.ts` + `src/lib/audio.ts` (MIT, © 2026 Aditya
// Dewaskar, s. NOTICE). Die Entscheidung (Schwelle, Hysterese, Ende) steckt in `vadGate.ts` (testbar),
// hier nur Mikrofon + Rekorder: die Aufnahme startet schon beim ersten Ausschlag („arm“), damit die erste
// Silbe nicht verloren geht; ein Knacks wird verworfen. Echo-Unterdrückung des Browsers ist an.
import { t } from "@nyxos/shared";
import { createVadGate, voiceBandRatio, type VadGateOptions } from "./vadGate";
import { registerAudioContext } from "./unlock";

export interface VadHandlers {
  /** Sprache bestätigt – hier greift das Unterbrechen (Barge-in). */
  onStart?: () => void;
  /** Satz zu Ende: ein vollständiges, abspielbares Audio-Stück. */
  onSegment: (audio: Blob, ms: number) => void;
  /** Mikrofon nicht nutzbar – Text für dich. */
  onError?: (message: string) => void;
}

export interface VadHandle {
  stop(): void;
  setGuard(on: boolean): void;
  /** Geglätteter Pegel 0–1 (für das Netz). */
  level(): number;
  /** Sprichst du gerade (Stille-Erkennung hat Sprache bestätigt, Ende noch nicht erreicht)? */
  speaking(): boolean;
}

function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

/** `pushToTalk`: der Hinweis nennt „Leiste noch einmal gedrückt halten“ statt „Zuhören wieder an“. */
export function micErrorMessage(err: unknown, pushToTalk = false): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return pushToTalk
      ? t("Das Mikrofon ist nicht erlaubt. Erlaube es in der Adressleiste (Schloss-Symbol) und halte die Leiste noch einmal gedrückt.")
      : t("Das Mikrofon ist nicht erlaubt. Erlaube es in der Adressleiste (Schloss-Symbol) und schalte Zuhören wieder an.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("Kein Mikrofon gefunden. Schließ eins an oder schreib Nyx einfach.");
  return t("Das Mikrofon lässt sich gerade nicht öffnen. Schreib Nyx einfach oder versuch es gleich noch einmal.");
}

/** `null` = Mikrofon nicht nutzbar (Grund kam über `onError`). */
export async function startVad(h: VadHandlers, gateOptions: Partial<VadGateOptions> = {}): Promise<VadHandle | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    h.onError?.(t("Dieser Browser kann nicht zuhören. Schreib Nyx einfach."));
    return null;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    h.onError?.(micErrorMessage(e));
    return null;
  }

  const mime = pickMime();
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  registerAudioContext(ctx);
  // Ohne Klick startet ein AudioContext oft „angehalten“ – beim ersten Klick/Tastendruck wecken.
  const wake = () => void ctx.resume().catch(() => {});
  wake();
  window.addEventListener("pointerdown", wake, { passive: true });
  window.addEventListener("keydown", wake);
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.35;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const freq = new Float32Array(analyser.frequencyBinCount);
  const gate = createVadGate(gateOptions);

  let stopped = false;
  let recorder: MediaRecorder | null = null;
  let parts: Blob[] = [];
  let startedAt = 0;

  const startRecorder = () => {
    parts = [];
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = (e) => {
      if (e.data?.size) parts.push(e.data);
    };
    recorder.start();
    startedAt = performance.now();
  };
  const discardRecorder = () => {
    if (!recorder) return;
    try {
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // schon weg
    }
    recorder = null;
    parts = [];
  };
  const endSegment = () => {
    const rec = recorder;
    recorder = null;
    if (!rec) return;
    const ms = performance.now() - startedAt;
    const finalise = () => {
      const blob = new Blob(parts, { type: rec.mimeType || mime || "audio/webm" });
      parts = [];
      if (!stopped && blob.size > 0) h.onSegment(blob, ms);
    };
    rec.onstop = finalise;
    try {
      if (rec.state !== "inactive") rec.stop();
      else finalise();
    } catch {
      finalise();
    }
  };

  // Takt über setInterval statt rAF: läuft auch weiter, wenn der Kreis gerade nicht gezeichnet wird.
  const timer = setInterval(() => {
    if (stopped) return;
    // NyxOS verborgen (anderes Fenster/Tab): nichts aufnehmen, laufende Aufnahme verwerfen. Sonst hörte jedes
    // offene Fenster mit und schickte Gespräche, die gar nicht an Nyx gingen.
    if (document.visibilityState === "hidden") {
      if (recorder) discardRecorder();
      gate.reset();
      return;
    }
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += (buf[i] ?? 0) * (buf[i] ?? 0);
    analyser.getFloatFrequencyData(freq);
    const ev = gate.push(Math.sqrt(sum / buf.length), performance.now(), voiceBandRatio(freq, ctx.sampleRate));
    if (ev === "arm") startRecorder();
    else if (ev === "discard") discardRecorder();
    else if (ev === "start") h.onStart?.();
    else if (ev === "end") endSegment();
  }, 16);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      discardRecorder();
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      for (const t of stream.getTracks()) t.stop();
      try {
        source.disconnect();
        void ctx.close();
      } catch {
        // schon zu
      }
    },
    setGuard: (on) => gate.setGuard(on),
    level: () => gate.level(),
    speaking: () => gate.meter().speaking,
  };
}
