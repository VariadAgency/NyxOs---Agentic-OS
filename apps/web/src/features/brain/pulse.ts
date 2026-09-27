// Klick auf einen Knoten: eine Welle läuft durchs Netz. Stufe 0 ist der Knoten selbst, Stufe 1
// seine Nachbarn usw. Über jede Kante von Stufe k nach k+1 läuft ein Lichtimpuls (wie durch Glasfaser),
// und wenn er ankommt, hellt der Knoten kurz auf.
//
// Früher wirkte es gegen Ende wie ein Feuerwerk: da liefen 3 Stufen mit bis zu 2.400 gleich
// hellen Impulsen — bei einem Knoten mit 70 Verbindungen leuchtete am Ende der halbe Graph. Jetzt:
// direkte Nachbarn voll, die zweite Stufe nur schwach und gedeckelt, keine dritte.
import { FLASH_FADE_S, PULSE_TRAVEL_S } from "./shaders3d";

/** Laufzeit der ersten Kette (s). Ältere Stelle: Abstand zwischen Stufen bei gleichem Tempo. */
export const PULSE_STEP_S = PULSE_TRAVEL_S;
/** Vier Ketten; jede weitere halb so hell und 50 % langsamer, also halbes Tempo = doppelte
 * Laufzeit je Kette (vorher wirkte es, als würde die Welle immer schneller — „Konfetti“). Ganze Welle ≈ 9 s. */
export const PULSE_MAX_HOPS = 4;
/** Der zweite Lichtschlag hat nur noch 20 % des ersten, danach deutlich abgestuft (sonst zu viel
 * Feuerwerk): Stärke je Kette 1 → 0,2 → 0,08 → 0,03. */
export const PULSE_HOP_GAINS = [1, 0.2, 0.08, 0.03] as const;
export const PULSE_HOP_SLOWER = 2;
export const PULSE_MAX_EDGES = 2400;
/** Höchstens so viele Impulse je Kette (Kette 1 = alle direkten Verbindungen). Ohne Deckel erreicht ein
 * Knoten mit vielen Nachbarn in Kette 2–4 schnell Tausende Punkte. */
/** Deutlich weniger gleichzeitige Impulse in den schwachen Ketten (vorher 160/120/90). */
export const PULSE_HOP_EDGE_CAP = [PULSE_MAX_EDGES, 48, 24, 12] as const;
/**
 * Gegen einen weißen Strahlenkranz über den ganzen Bildschirm (Knoten mit Hunderten Verbindungen): je Knoten laufen
 * höchstens so viele Impulse los — die nächsten (bzw. nach `rank` besten) Kanten. Die Impulse selbst bleiben
 * voll hell; weniger Fasern statt aller dunkler (komplett dunkel war falsch).
 */
/** 40 statt 60 — der erste Lichtschlag bleibt voll hell, aber weniger Fasern auf einmal. */
export const PULSE_SOURCE_CAP = 40;

export interface PulseEdge {
  from: number;
  to: number;
  /** Start des Impulses nach dem Klick (s). */
  delay: number;
  /** Laufzeit über diese Kante (s). */
  travel: number;
  /** Stärke 0–1 (Kette 1 voll, dann 0,2 / 0,08 / 0,03). */
  gain: number;
}

export interface PulsePlan {
  /** Stufe je erreichtem Knoten. */
  hop: Map<number, number>;
  edges: PulseEdge[];
  /** Wann die ganze Welle durch ist (s, inkl. Ausblenden). */
  durationS: number;
}

/** Stärke der Kette `hop` (0 = der geklickte Knoten): 1, 0,2, 0,08, 0,03 (tiefer: weiter × 0,4). */
export function hopGain(hop: number): number {
  if (hop <= 1) return 1;
  const last = PULSE_HOP_GAINS.length - 1;
  const tail = PULSE_HOP_GAINS[last] ?? 0;
  return hop - 1 <= last ? (PULSE_HOP_GAINS[hop - 1] ?? 0) : tail * 0.4 ** (hop - 1 - last);
}

/** Laufzeit eines Impulses in Kette `hop` (≥ 1): jede Kette 50 % langsamer als die vorige. */
export function hopTravel(hop: number): number {
  return PULSE_TRAVEL_S * PULSE_HOP_SLOWER ** Math.max(0, hop - 1);
}

/** Wann die Impulse der Kette `hop` ankommen (s nach dem Klick); 0 für den geklickten Knoten. */
export function hopArrival(hop: number): number {
  let t = 0;
  for (let h = 1; h <= hop; h++) t += hopTravel(h);
  return t;
}

export function planPulse(o: {
  adj: number[][];
  linkS: Uint32Array;
  linkT: Uint32Array;
  hidden: Uint8Array;
  start: number;
  maxHops?: number;
  maxEdges?: number;
  /** Rangfolge einer Kante e von a nach b (kleiner = zuerst), z. B. Abstand. Ohne: Reihenfolge der Kanten. */
  rank?: (e: number, a: number, b: number) => number;
}): PulsePlan {
  const maxHops = o.maxHops ?? PULSE_MAX_HOPS;
  const maxEdges = o.maxEdges ?? PULSE_MAX_EDGES;
  const hop = new Map<number, number>([[o.start, 0]]);
  const edges: PulseEdge[] = [];
  let frontier = [o.start];
  for (let k = 0; k < maxHops && frontier.length > 0 && edges.length < maxEdges; k++) {
    const next: number[] = [];
    const cap = Math.min(maxEdges, edges.length + (PULSE_HOP_EDGE_CAP[k] ?? PULSE_HOP_EDGE_CAP[3]));
    const gain = hopGain(k + 1);
    const travel = hopTravel(k + 1);
    const delay = hopArrival(k);
    for (const a of frontier) {
      // Kandidaten dieses Knotens: sichtbar, nicht zurück, nicht quer in dieselbe Stufe.
      const cand: { e: number; b: number }[] = [];
      for (const e of o.adj[a] ?? []) {
        const s = o.linkS[e] ?? 0;
        const t = o.linkT[e] ?? 0;
        const b = s === a ? t : s;
        if (o.hidden[b]) continue;
        const hb = hop.get(b);
        if (hb !== undefined && hb !== k + 1) continue; // Querkanten gleicher Stufe / zurück: kein Impuls
        cand.push({ e, b });
      }
      if (cand.length > PULSE_SOURCE_CAP && o.rank) {
        const rank = o.rank;
        const r = new Map(cand.map((c) => [c.e, rank(c.e, a, c.b)]));
        cand.sort((x, y) => (r.get(x.e) ?? 0) - (r.get(y.e) ?? 0));
      }
      let fromA = 0;
      for (const { b } of cand) {
        if (edges.length >= cap || fromA >= PULSE_SOURCE_CAP) break;
        if (!hop.has(b)) {
          hop.set(b, k + 1);
          next.push(b);
        } else if (hop.get(b) !== k + 1) continue;
        edges.push({ from: a, to: b, delay, travel, gain });
        fromA++;
      }
    }
    frontier = next;
  }
  let deepest = 0;
  for (const h of hop.values()) deepest = Math.max(deepest, h);
  // Letzte Ankunft + Ausblenden des Aufhellens (danach zeichnet nur noch das Schweben).
  return { hop, edges, durationS: hopArrival(deepest) + FLASH_FADE_S };
}
