// Pegel eines `<audio>`-Elements (Briefing-Vorlesen, „Nyx fragen“) für das Nyx-Logo. Vorher spielte das
// Vorlesen über einen eigenen Weg ohne Pegel – die Aura blieb still, während Nyx vorlas.
//
// Ein AnalyserNode hängt am Element (`createMediaElementSource` geht nur EINMAL je Element, deshalb gemerkt).
// Achtung Safari: ein an einen Kontext gehängtes Element klingt nur, solange der Kontext läuft. Deshalb wird nur
// angehängt, wenn der Kontext schon läuft; sonst liefert der Leser einen ruhigen Ersatz-Pegel (Logo pulsiert trotzdem).
import { registerAudioContext } from "./unlock";

/** Ersatz-Pegel, wenn kein Analyser möglich ist (Logo „spricht“ ruhig weiter). */
export const FALLBACK_LEVEL = 0.35;
/** Verstärkung: Sprache füllt das Spektrum nur zu einem kleinen Teil. */
const GAIN = 3.5;

let ctx: AudioContext | null = null;
const readers = new WeakMap<HTMLAudioElement, () => number>();

function context(): AudioContext | null {
  try {
    if (typeof window === "undefined") return null;
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!ctx) {
      ctx = new AudioCtx();
      registerAudioContext(ctx);
    }
    return ctx;
  } catch {
    return null;
  }
}

/** Im Klick aufrufen: weckt den Kontext, damit der Pegel ab dem ersten Satz mitläuft. */
export function wakePlaybackLevel(): void {
  const c = context();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

/**
 * Lese-Funktion (0–1) für den Pegel dieses Elements. Wird pro Bild gerufen (siehe `reportNyxLevel`).
 * Ohne Web-Audio oder mit schlafendem Kontext: fester Ersatz-Pegel, solange das Element spielt.
 */
export function playbackLevelReader(audio: HTMLAudioElement): () => number {
  const known = readers.get(audio);
  if (known) return known;
  const c = context();
  const fallback = () => (audio.paused ? 0 : FALLBACK_LEVEL);
  if (!c || c.state !== "running") return fallback;
  try {
    const analyser = c.createAnalyser();
    analyser.fftSize = 256;
    c.createMediaElementSource(audio).connect(analyser);
    analyser.connect(c.destination);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const read = () => {
      if (audio.paused) return 0;
      analyser.getByteFrequencyData(bins);
      let sum = 0;
      for (let i = 2; i < bins.length; i++) sum += bins[i] ?? 0;
      return Math.min(1, (sum / Math.max(1, bins.length - 2) / 255) * GAIN);
    };
    readers.set(audio, read);
    return read;
  } catch {
    return fallback;
  }
}
