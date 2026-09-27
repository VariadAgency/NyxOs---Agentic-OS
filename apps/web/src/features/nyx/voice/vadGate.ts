// Stille-Erkennung (VAD) als reiner Zustandsautomat – ohne Mikrofon testbar.
//
// Übernommen und angepasst aus adewaskar/jarvis `src/lib/vad.ts` (MIT, © 2026 Aditya Dewaskar, s. NOTICE):
// laufender Rauschboden, Schwelle = Boden × 2,6, Hysterese 0,6, Bestätigung nach 110 ms, Segment-Ende
// nach 650 ms Stille, höchstens 20 s. Die Aufnahme startet schon beim ersten Ausschlag („arm“), damit die
// erste Silbe nicht verloren geht; ein Knacks wird verworfen („discard“). Während Nyx spricht, gilt eine
// höhere Schwelle („Guard“), damit seine eigene Stimme ihn nicht unterbricht.
// Geändert: Logik vom Mikrofon getrennt (push(energy, now) → Ereignis), Zahlen als Optionen.

export interface VadGateOptions {
  triggerOverFloor: number;
  guardBoost: number;
  releaseRatio: number;
  startMs: number;
  silenceMs: number;
  maxMs: number;
  floorUp: number;
  floorDown: number;
  minFloor: number;
  initialFloor: number;
  /** Anteil der Energie im Sprachband (250–3500 Hz), ab dem ein Ausschlag als Stimme zählt. */
  minVoiceRatio: number;
}

export const VAD_DEFAULTS: VadGateOptions = {
  triggerOverFloor: 2.6,
  guardBoost: 2.4,
  releaseRatio: 0.6,
  // Sprache erst nach 350 ms bestätigt.
  startMs: 350,
  silenceMs: 650,
  maxMs: 20_000,
  floorUp: 0.0008,
  floorDown: 0.02,
  minFloor: 0.0015,
  initialFloor: 0.01,
  minVoiceRatio: 0.45,
};

/** arm = Vorlauf-Aufnahme starten · discard = war nur ein Knacks · start = Sprache bestätigt · end = Satz fertig. */
export type VadEvent = "arm" | "discard" | "start" | "end";

export interface VadMeter {
  energy: number;
  floor: number;
  threshold: number;
  speaking: boolean;
}

export interface VadGate {
  /** `voiceRatio` = Anteil im Sprachband (s. {@link voiceBandRatio}); ohne Angabe zählt nur der Pegel. */
  push(energy: number, nowMs: number, voiceRatio?: number): VadEvent | null;
  setGuard(on: boolean): void;
  meter(): VadMeter;
  /** Geglätteter Pegel 0–1 für die Anzeige. */
  level(): number;
  /** Laufendes Segment abbrechen (z. B. Stummschalten). */
  reset(): void;
}

export function createVadGate(options: Partial<VadGateOptions> = {}): VadGate {
  const o = { ...VAD_DEFAULTS, ...options };
  let floor = o.initialFloor;
  let smooth = 0;
  let threshold = floor * o.triggerOverFloor;
  let guard = false;
  let armedAt = -1;
  let speaking = false;
  let speechStartedAt = 0;
  let lastLoud = 0;

  return {
    push(energy, now, voiceRatio = 1) {
      smooth += (energy - smooth) * 0.5;
      // Boden nur anpassen, wenn sicher keine Sprache läuft.
      if (!speaking && armedAt < 0) {
        const rate = smooth > floor ? o.floorUp : o.floorDown;
        floor = Math.max(o.minFloor, floor + (smooth - floor) * rate);
      }
      threshold = floor * o.triggerOverFloor * (guard ? o.guardBoost : 1);
      const release = threshold * o.releaseRatio;

      if (!speaking) {
        // Laut UND nach Stimme klingend: Rumpeln (Straße) und Zwitschern (Vogel) liegen außerhalb des Sprachbands.
        if (smooth > threshold && voiceRatio >= o.minVoiceRatio) {
          if (armedAt < 0) {
            armedAt = now;
            return "arm";
          }
          if (now - armedAt >= o.startMs) {
            speaking = true;
            speechStartedAt = armedAt;
            lastLoud = now;
            return "start";
          }
          return null;
        }
        if (armedAt >= 0) {
          armedAt = -1;
          return "discard";
        }
        return null;
      }
      if (smooth > release) lastLoud = now;
      if (now - lastLoud >= o.silenceMs || now - speechStartedAt >= o.maxMs) {
        speaking = false;
        armedAt = -1;
        return "end";
      }
      return null;
    },
    setGuard(on) {
      guard = on;
    },
    meter: () => ({ energy: smooth, floor, threshold, speaking }),
    level: () => Math.min(1, smooth * 12),
    reset() {
      speaking = false;
      armedAt = -1;
    },
  };
}

/**
 * Anteil der Leistung im Sprachband (250–3500 Hz) an 80–8000 Hz, aus `getFloatFrequencyData` (dB).
 * Menschliche Stimme liegt deutlich darüber; Verkehrsrumpeln (tief) und Vogelgezwitscher (hoch) darunter.
 */
export function voiceBandRatio(freqDb: Float32Array, sampleRate: number): number {
  const hzPerBin = sampleRate / (2 * freqDb.length);
  let voice = 0;
  let total = 0;
  for (let i = 0; i < freqDb.length; i++) {
    const hz = i * hzPerBin;
    if (hz < 80 || hz > 8000) continue;
    const db = freqDb[i] ?? -Infinity;
    if (!Number.isFinite(db)) continue;
    const p = 10 ** (db / 10);
    total += p;
    if (hz >= 250 && hz <= 3500) voice += p;
  }
  return total > 0 ? voice / total : 0;
}
