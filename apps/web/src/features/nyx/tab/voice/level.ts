// Pegel fürs Netz — ruhig, bildraten-unabhängig und in Frequenzbändern.
// `followEnvelope` aus alexanderqchen/orb-ui `src/adapters/audio-level.ts` (MIT), `normalizeDb` und die
// Band-Aufteilung aus elevenlabs/ui `bar-visualizer.tsx` `useMultibandVolume` (MIT), s. NOTICE.

export const RISE_MS = 100;
export const FALL_MS = 400;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Nähert `current` an `target` an — nach `durationMs` sind 90 % des Weges geschafft. */
export function followEnvelope(current: number, target: number, durationMs: number, elapsedMs: number): number {
  if (durationMs <= 0) return target;
  const rate = 1 - Math.pow(0.1, Math.max(0, elapsedMs) / durationMs);
  return clamp01(current + (target - current) * rate);
}

/** dB (−100 … −10) → 0 … 1, wurzelförmig (leise Töne sichtbar). */
export function normalizeDb(value: number): number {
  if (value === -Infinity) return 0;
  const minDb = -100;
  const maxDb = -10;
  const db = 1 - (Math.max(minDb, Math.min(maxDb, value)) * -1) / 100;
  return Math.sqrt(db);
}

export const BAND_COUNT = 5;
const LO_BIN = 100;
const HI_BIN = 600;

/** Frequenzdaten (dB je Bin, `getFloatFrequencyData`) → 5 Bänder 0 … 1 (Sprachbereich). */
export function bandsFrom(freqDb: Float32Array, bands = BAND_COUNT): number[] {
  const lo = Math.min(LO_BIN, freqDb.length);
  const hi = Math.min(HI_BIN, freqDb.length);
  const size = Math.max(1, Math.floor((hi - lo) / bands));
  const out: number[] = [];
  for (let b = 0; b < bands; b++) {
    let sum = 0;
    let n = 0;
    for (let i = lo + b * size; i < Math.min(hi, lo + (b + 1) * size); i++) {
      sum += normalizeDb(freqDb[i] ?? -Infinity);
      n++;
    }
    out.push(n ? sum / n : 0);
  }
  return out;
}

/** Gemeinsamer, veränderbarer Pegel (kein React-State bei 60 fps — „Drive“-Muster aus adewaskar/jarvis). */
export interface LevelDrive {
  /** Mikro 0 … 1 (geglättet). */
  input: number;
  /** Nyx' Stimme 0 … 1 (geglättet). */
  output: number;
  /** Mikro in 5 Bändern. */
  bands: number[];
}

export function createLevelDrive(): LevelDrive {
  return { input: 0, output: 0, bands: new Array(BAND_COUNT).fill(0) };
}
