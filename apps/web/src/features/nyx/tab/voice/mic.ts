// Mikrofon für den Nyx-Tab — ein Stream, Echo-Unterdrückung an, Pegel in Bändern fürs Netz und
// zwei Arten aufzunehmen: „Halten zum Sprechen“ (Knopf/Leertaste) und „Dauer-Zuhören“ (Energie-VAD).
// Die VAD ist übernommen aus adewaskar/jarvis `src/lib/vad.ts` (`startVad`: adaptiver Rauschboden, Vorlauf-
// Aufnahme ab dem ersten Ausschlag, Hysterese, Guard während Nyx spricht; MIT, s. NOTICE) — hier mit
// deutschen Meldungen, Band-Pegel und Pause, solange der Tab nicht sichtbar ist.
import { t } from "@nyxos/shared";
import { registerAudioContext } from "../../voice/unlock";
import { VAD_DEFAULTS, voiceBandRatio } from "../../voice/vadGate";
import { bandsFrom, FALL_MS, followEnvelope, RISE_MS, type LevelDrive } from "./level";

export type CaptureMode = "ptt" | "continuous";

export interface CaptureHandlers {
  /** Sprache erkannt (Dauer-Zuhören) bzw. Taste gedrückt — hier greift das Unterbrechen. */
  onSpeechStart: () => void;
  /** Ein fertiges Stück Aufnahme (eine eigenständige Audiodatei). `endedAt` = letztes Wort (performance.now). */
  onSegment: (audio: Blob, speechMs: number, endedAt: number) => void;
  onError: (message: string) => void;
}

export interface MicCapture {
  setMode(mode: CaptureMode): void;
  /** Schwelle anheben, solange Nyx spricht (sein Ton, der an der Echo-Unterdrückung vorbeikommt, zählt nicht). */
  setGuard(on: boolean): void;
  pttStart(): void;
  pttStop(): void;
  close(): void;
}

// Einstellwerte aus adewaskar/jarvis (dort begründet): Schwelle über Rauschboden, Guard, Hysterese, Zeiten.
const TRIGGER_OVER_FLOOR = 2.6;
const GUARD_BOOST = 2.4;
const RELEASE_RATIO = 0.6;
// Sprache erst nach 350 ms bestätigt, nur im Sprachband.
const START_MS = VAD_DEFAULTS.startMs;
const MIN_VOICE_RATIO = VAD_DEFAULTS.minVoiceRatio;
const SILENCE_MS = 650;
const MAX_MS = 20_000;
const FLOOR_UP = 0.0008;
const FLOOR_DOWN = 0.02;
/** Kürzer als das ist ein Knacken, keine Sprache — beim Halten zum Sprechen nicht senden. */
const MIN_PTT_MS = 250;

/** Aufnahme-Formate in der Reihenfolge, die die Server-Erkennung am liebsten nimmt. */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function micError(err: unknown): string {
  if (err instanceof DOMException && err.name === "NotAllowedError") return t("Das Mikrofon ist gesperrt. Erlaube es oben in der Adressleiste und tippe dann noch einmal auf „Nyx wecken“.");
  if (err instanceof DOMException && err.name === "NotFoundError") return t("Kein Mikrofon gefunden. Schließ eins an oder schreib Nyx rechts im Chat.");
  return t("Das Mikrofon lässt sich gerade nicht öffnen. Schreib Nyx rechts im Chat oder versuch es gleich noch einmal.");
}

export async function openMicCapture(drive: LevelDrive, handlers: CaptureHandlers, initialMode: CaptureMode): Promise<MicCapture | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    handlers.onError(t("Dieser Browser kann nicht aufnehmen. Schreib Nyx rechts im Chat."));
    return null;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    handlers.onError(micError(e));
    return null;
  }
  const mime = pickRecorderMime();
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  registerAudioContext(ctx);
  // Safari: nach `await getUserMedia` ist die Klick-Erlaubnis weg, der Kontext bleibt „angehalten“ (keine Pegel,
  // kein Zuhören) – beim nächsten Klick/Tastendruck wecken.
  const wakeCtx = () => void ctx.resume().catch(() => {});
  wakeCtx();
  window.addEventListener("pointerdown", wakeCtx, { passive: true });
  window.addEventListener("keydown", wakeCtx);
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.35;
  source.connect(analyser);
  const time = new Float32Array(analyser.fftSize);
  const freq = new Float32Array(analyser.frequencyBinCount);

  let mode: CaptureMode = initialMode;
  let closed = false;
  let guard = false;
  let floor = 0.01;
  let smooth = 0;
  let recorder: MediaRecorder | null = null;
  let parts: Blob[] = [];
  let armedAt = 0;
  let speaking = false;
  let speechStartedAt = 0;
  let lastLoud = 0;
  let pttActive = false;
  let raf = 0;
  let lastFrame = performance.now();

  const startRecorder = () => {
    parts = [];
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) parts.push(e.data);
    };
    recorder.start();
  };

  const discardRecorder = () => {
    if (!recorder) return;
    try {
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // schon beendet
    }
    recorder = null;
    parts = [];
  };

  const endSegment = (send: boolean) => {
    const rec = recorder;
    const startedAt = speechStartedAt;
    const endedAt = performance.now();
    speaking = false;
    speechStartedAt = 0;
    armedAt = 0;
    if (!rec) return;
    recorder = null;
    const finalise = () => {
      const blob = new Blob(parts, { type: rec.mimeType || mime || "audio/webm" });
      parts = [];
      const ms = startedAt ? endedAt - startedAt : 0;
      if (send && blob.size > 0) handlers.onSegment(blob, ms, endedAt);
    };
    rec.onstop = finalise;
    try {
      if (rec.state !== "inactive") rec.stop();
      else finalise();
    } catch {
      finalise();
    }
  };

  const tick = () => {
    if (closed) return;
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = now - lastFrame;
    lastFrame = now;

    analyser.getFloatTimeDomainData(time);
    let sum = 0;
    for (let i = 0; i < time.length; i++) sum += (time[i] ?? 0) * (time[i] ?? 0);
    const energy = Math.sqrt(sum / time.length);
    smooth += (energy - smooth) * 0.5;
    const target = Math.min(1, smooth * 12);
    drive.input = followEnvelope(drive.input, target, target > drive.input ? RISE_MS : FALL_MS, dt);
    analyser.getFloatFrequencyData(freq);
    const bands = bandsFrom(freq);
    const voiceRatio = voiceBandRatio(freq, ctx.sampleRate);
    for (let b = 0; b < bands.length; b++) drive.bands[b] = followEnvelope(drive.bands[b] ?? 0, bands[b] ?? 0, (bands[b] ?? 0) > (drive.bands[b] ?? 0) ? RISE_MS : FALL_MS, dt);

    // Halten zum Sprechen: nie endlos (Loslassen kann verloren gehen, z. B. Cmd+Tab bei gedrückter Leertaste).
    if (pttActive) {
      if (now - speechStartedAt >= MAX_MS) {
        pttActive = false;
        endSegment(true);
      }
      return;
    }
    if (mode !== "continuous") return;
    // Nur zuhören, solange der Tab sichtbar ist (wie in der Jarvis-Pipeline).
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      if (armedAt || speaking) endSegment(false);
      return;
    }
    if (!speaking && armedAt === 0) {
      const rate = smooth > floor ? FLOOR_UP : FLOOR_DOWN;
      floor += (smooth - floor) * rate;
      floor = Math.max(floor, 0.0015);
    }
    const threshold = floor * TRIGGER_OVER_FLOOR * (guard ? GUARD_BOOST : 1);
    const release = threshold * RELEASE_RATIO;
    if (!speaking) {
      if (smooth > threshold && voiceRatio >= MIN_VOICE_RATIO) {
        if (armedAt === 0) {
          // Sofort aufnehmen, damit die erste Silbe nicht verloren geht; war es nur ein Knacken, wird verworfen.
          armedAt = now;
          startRecorder();
        } else if (now - armedAt >= START_MS) {
          speaking = true;
          speechStartedAt = armedAt;
          lastLoud = now;
          handlers.onSpeechStart();
        }
      } else if (armedAt !== 0) {
        armedAt = 0;
        discardRecorder();
      }
    } else {
      if (smooth > release) lastLoud = now;
      if (now - lastLoud >= SILENCE_MS || now - speechStartedAt >= MAX_MS) endSegment(true);
    }
  };
  tick();

  return {
    setMode(m) {
      if (m === mode) return;
      if (speaking || armedAt) endSegment(false);
      mode = m;
    },
    setGuard(on) {
      guard = on;
    },
    pttStart() {
      if (pttActive) return;
      if (speaking || armedAt) endSegment(false);
      pttActive = true;
      speechStartedAt = performance.now();
      startRecorder();
      handlers.onSpeechStart();
    },
    pttStop() {
      if (!pttActive) return;
      pttActive = false;
      const long = performance.now() - speechStartedAt >= MIN_PTT_MS;
      endSegment(long);
    },
    close() {
      closed = true;
      cancelAnimationFrame(raf);
      discardRecorder();
      window.removeEventListener("pointerdown", wakeCtx);
      window.removeEventListener("keydown", wakeCtx);
      for (const t of stream.getTracks()) t.stop();
      try {
        source.disconnect();
        void ctx.close();
      } catch {
        // schon zu
      }
      drive.input = 0;
      drive.bands.fill(0);
    },
  };
}
