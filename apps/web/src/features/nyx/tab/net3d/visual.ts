// Wie das 3D-Netz in jedem Zustand aussieht — als reine Rechenregeln (testbar ohne WebGL).
//   idle      ruhig glimmend, langsame Drehung, Atmen, ganz vereinzelte Signale (Nyx-Violett)
//   listening Wellen gehen aus dem Kern im Takt des Mikro-Pegels (Blau)
//   thinking  Signale laufen durch das ganze Netz (Rot)
//   tool      der Werkzeug-Knoten leuchtet mit Namen, Signale Kern → Werkzeug → gelesene Dinge (Orange)
//   speaking  der Kern pulsiert mit der Stimme bzw. dem strömenden Text (Grün)
// Sanft: Impulse gehen zum Punkt und heben ihn nur leicht an — kein Aufblitzen.
import { t, type NyxState } from "@nyxos/shared";

export interface NetVisual {
  /** Drehung um die Hochachse (rad/s). */
  spin: number;
  /** Tempo der Signale entlang der Kanten (Kantenlängen je Sekunde). */
  signalSpeed: number;
  /** Anteil der Kanten, auf denen gerade ein Signal läuft (0 … 1). */
  signalShare: number;
  /** Farbe des Kerns und der Wellen. */
  color: string;
  /** Grundhelligkeit des ganzen Netzes (0 … 1). */
  energy: number;
  /** Klartext für Bildschirmleser und Statuszeile. */
  label: string;
}

/**
 * Zustandsfarben — knallig wie das POS-Designsystem (schwarz, ohne Blaustich, kräftige Farben).
 * Quelle sind die Tokens aus app.css (`STATE_TOKEN`); die Werte hier sind nur der Rückfall, falls ein Token fehlt
 * (Test-Umgebung, alter Stand). Jeder Zustand hat einen eigenen Farbton, damit er auf einen Blick klar ist.
 */
// Eigene Nyx-Tokens (blau → rot → orange → grün → lila), gleich wie Aura (nyxAura.css) und Tab (nyxTab.css).
export const STATE_TOKEN: Record<NyxState, string> = {
  idle: "--a-nyx",
  listening: "--a-nyx-listen",
  thinking: "--a-nyx-think",
  tool: "--a-nyx-tool",
  speaking: "--a-nyx-speak",
};

export const STATE_COLOR: Record<NyxState, string> = {
  idle: "#c77dff",
  listening: "#4da3ff",
  thinking: "#ff4d5e",
  tool: "#ff8a1f",
  speaking: "#2fd27a",
};

/** Zustandsfarben aus den CSS-Tokens lesen (einmal beim Aufbau, nicht je Bild). */
export function resolveStateColors(read: (token: string) => string): Record<NyxState, string> {
  const out = { ...STATE_COLOR };
  for (const s of Object.keys(STATE_TOKEN) as NyxState[]) {
    const v = read(STATE_TOKEN[s]).trim();
    // three.js versteht sicher nur #rgb / #rrggbb — alles andere bleibt beim Rückfall.
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) out[s] = v;
  }
  return out;
}

// Eigenrotation bewusst ruhig (~30 % langsamer als die erste Fassung).
const VISUAL: Record<NyxState, Omit<NetVisual, "color">> = {
  idle: { spin: 0.032, signalSpeed: 0.18, signalShare: 0.05, energy: 0.55, label: t("Nyx ruht") },
  listening: { spin: 0.043, signalSpeed: 0.3, signalShare: 0.08, energy: 0.72, label: t("Nyx hört zu") },
  thinking: { spin: 0.08, signalSpeed: 0.75, signalShare: 0.42, energy: 0.85, label: t("Nyx denkt") },
  tool: { spin: 0.058, signalSpeed: 0.65, signalShare: 0.18, energy: 0.8, label: t("Nyx benutzt ein Werkzeug") },
  speaking: { spin: 0.05, signalSpeed: 0.35, signalShare: 0.12, energy: 0.8, label: t("Nyx spricht") },
};

export function visualFor(state: NyxState, reducedMotion = false): NetVisual {
  const v = VISUAL[state];
  if (!reducedMotion) return { ...v, color: STATE_COLOR[state] };
  // Weniger Bewegung: kaum Drehung, langsame, wenige Signale — Zustand bleibt über Farbe und Helligkeit klar.
  return { ...v, spin: v.spin * 0.15, signalSpeed: v.signalSpeed * 0.3, signalShare: Math.min(v.signalShare, 0.08), color: STATE_COLOR[state] };
}

/** Eine Welle, die vom Kern aus durch das Netz läuft. */
export interface Wave {
  born: number;
  strength: number;
}

export const WAVE_LIFE_S = 2.4;
/** Mindestabstand zwischen zwei Wellen (s) — bei lauter Stimme dichter. */
const WAVE_GAP_S = 0.34;
/** Pegel, ab dem eine Welle entsteht. */
const WAVE_MIN_LEVEL = 0.12;

/**
 * Soll jetzt eine neue Welle starten? Nur beim Zuhören und nur, wenn der Pegel gerade ansteigt (Silbe/Wort) —
 * so kommen die Wellen im Takt der Stimme, nicht als Dauerrauschen.
 */
export function shouldSpawnWave(state: NyxState, level: number, prevLevel: number, sinceLastS: number, reducedMotion = false): boolean {
  if (reducedMotion || state !== "listening") return false;
  if (level < WAVE_MIN_LEVEL) return false;
  const gap = WAVE_GAP_S * (1.2 - Math.min(1, level) * 0.5);
  return sinceLastS >= gap && level >= prevLevel - 0.01;
}

/** Radius (Welt-Einheiten) einer Welle im Alter `ageS`, wenn das Netz `netRadius` groß ist. */
export function waveRadius(ageS: number, netRadius: number): number {
  const p = Math.max(0, ageS) / WAVE_LIFE_S;
  return netRadius * 1.25 * (1 - Math.pow(1 - Math.min(1, p), 2.2));
}

/** Wie stark eine Welle einen Knoten im Abstand `r` gerade anhebt (0 … 1, sanft). */
export function waveLift(wave: Wave, nowS: number, r: number, netRadius: number): number {
  const age = nowS - wave.born;
  if (age < 0 || age > WAVE_LIFE_S) return 0;
  const front = waveRadius(age, netRadius);
  const width = netRadius * 0.12;
  const d = (r - front) / width;
  return Math.exp(-d * d) * wave.strength * (1 - age / WAVE_LIFE_S) * 0.6;
}

/** Kern-Größe (Faktor) je Zustand: beim Sprechen pulsiert er mit dem Ausgangspegel, sonst atmet er. */
export function corePulse(state: NyxState, t: number, input: number, output: number, reducedMotion = false): number {
  const breath = reducedMotion ? 0 : 0.04 * Math.sin(t * 1.15);
  if (state === "speaking") return 1 + breath + Math.min(1, output) * 0.55;
  if (state === "listening") return 1.05 + breath + Math.min(1, input) * 0.2;
  if (state === "thinking") return 1.08 + (reducedMotion ? 0 : 0.06 * Math.sin(t * 3.4));
  if (state === "tool") return 1.06 + breath;
  return 1 + breath;
}

/**
 * Wie hell ein Kabel im Grund leuchtet (Faktor auf die Grund-Deckkraft). Kabel vom Kern (zu Werkzeugen, Synapsen, Dingen im Umlauf) deutlich heller als
 * Querverbindungen; am Kern-Ende noch heller (`EDGE_CORE_END`), so glimmen sie aus dem lila Kern heraus.
 */
export const EDGE_WEIGHT = { core: 2.8, spoke: 2.4, tool: 1.35, link: 1 } as const;
/** Zusatz-Faktor am Kern-Ende eines Kern-Kabels (läuft zum anderen Ende auf 1 aus). */
export const EDGE_CORE_END = 1.5;
