// Kräfte-Simulation (d3-force) — läuft im Web-Worker (`sim.worker.ts`), damit das Zeichnen auch bei
// ~6.000 Knoten flüssig bleibt. Kräfte wie Obsidians Regler: Zentrum, Abstoßung, Verbindung, Abstand.
// Waisen (Grad 0) werden sanft auf einen Ring außerhalb der Wolke gezogen (wie in Obsidian).
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Force, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { nodeWorldRadius } from "./lod";
import type { Forces } from "./settings";

export interface WNode extends SimulationNodeDatum {
  orphan: boolean;
  degree: number;
}
export interface WLink extends SimulationLinkDatum<WNode> {
  weight: number;
}

export const ALPHA_DECAY = 0.0228; // d3-Vorgabe: ~300 Schritte bis zur Ruhe — „sanft abklingend"
export const VELOCITY_DECAY = 0.38;
export const ALPHA_MIN = 0.002;
/**
 * Kollision (vorher überlappten sich Knoten stark) — jeder Knoten hält seinen gezeichneten Radius
 * (bei Knotengröße 1) plus diesen Rand zu jedem Nachbarn frei. Vorher gab es gar keine Kollision.
 */
export const COLLIDE_PAD = 1.6;
export const COLLIDE_STRENGTH = 0.85;
export function collideRadius(degree: number): number {
  return nodeWorldRadius(degree, 1) + COLLIDE_PAD;
}

/** Obsidian-Reglerwerte → d3-Parameter. */
export function forceParams(f: Forces) {
  return {
    charge: -Math.max(0, f.repel) * 5,
    centerStrength: Math.max(0, f.center) * 0.12,
    linkDistance: Math.max(8, f.distance / 8),
    linkScale: Math.max(0, f.link),
  };
}

/** Ring für Waisen: Radius ~ 1,25 × 92. Perzentil der Abstände verbundener Knoten vom Mittelpunkt. */
export function orphanRing(): Force<WNode, WLink> & { radius: () => number } {
  let nodes: WNode[] = [];
  let radius = 200;
  let step = 0;
  const recompute = () => {
    const d: number[] = [];
    for (const n of nodes) if (!n.orphan && n.x !== undefined && n.y !== undefined) d.push(Math.hypot(n.x, n.y));
    if (d.length === 0) {
      radius = 80 + Math.sqrt(nodes.length) * 12;
      return;
    }
    d.sort((a, b) => a - b);
    const p = d[Math.min(d.length - 1, Math.floor(d.length * 0.92))] ?? 0;
    radius = Math.max(120, p * 1.1 + 20);
  };
  const force = ((alpha: number) => {
    if (step++ % 15 === 0) recompute();
    for (const n of nodes) {
      if (!n.orphan || n.x === undefined || n.y === undefined) continue;
      const dist = Math.hypot(n.x, n.y) || 1;
      const k = ((radius - dist) / dist) * 0.12 * alpha;
      n.vx = (n.vx ?? 0) + n.x * k;
      n.vy = (n.vy ?? 0) + n.y * k;
    }
  }) as Force<WNode, WLink> & { radius: () => number };
  force.initialize = (ns: WNode[]) => {
    nodes = ns;
    step = 0;
  };
  force.radius = () => radius;
  return force;
}

export function buildSimulation(nodes: WNode[], links: WLink[], f: Forces): Simulation<WNode, WLink> {
  const p = forceParams(f);
  const count = new Map<WNode, number>();
  for (const l of links) {
    const s = l.source as WNode;
    const t = l.target as WNode;
    count.set(s, (count.get(s) ?? 0) + 1);
    count.set(t, (count.get(t) ?? 0) + 1);
  }
  const sim = forceSimulation<WNode, WLink>(nodes)
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(VELOCITY_DECAY)
    .alphaMin(ALPHA_MIN)
    .force("charge", forceManyBody<WNode>().strength((n) => (n.orphan ? p.charge * 0.35 : p.charge)).theta(0.9))
    .force(
      "link",
      forceLink<WNode, WLink>(links)
        .distance(p.linkDistance)
        .strength((l) => {
          const a = count.get(l.source as WNode) ?? 1;
          const b = count.get(l.target as WNode) ?? 1;
          return (p.linkScale / Math.min(a, b)) * Math.min(2, 1 + Math.log2(Math.max(1, l.weight)) * 0.25);
        }),
    )
    .force("x", forceX<WNode>(0).strength((n) => (n.orphan ? 0 : p.centerStrength)))
    .force("y", forceY<WNode>(0).strength((n) => (n.orphan ? 0 : p.centerStrength)))
    .force("orphans", orphanRing())
    .force("collide", forceCollide<WNode>((n) => collideRadius(n.degree)).strength(COLLIDE_STRENGTH).iterations(1))
    .stop();
  return sim;
}

export function applyForces(sim: Simulation<WNode, WLink>, f: Forces): void {
  const p = forceParams(f);
  const charge = sim.force("charge") as ReturnType<typeof forceManyBody<WNode>> | undefined;
  charge?.strength((n) => (n.orphan ? p.charge * 0.35 : p.charge));
  const link = sim.force("link") as ReturnType<typeof forceLink<WNode, WLink>> | undefined;
  if (link) {
    const counts = new Map<WNode, number>();
    for (const l of link.links()) {
      counts.set(l.source as WNode, (counts.get(l.source as WNode) ?? 0) + 1);
      counts.set(l.target as WNode, (counts.get(l.target as WNode) ?? 0) + 1);
    }
    link.distance(p.linkDistance).strength((l) => {
      const a = counts.get(l.source as WNode) ?? 1;
      const b = counts.get(l.target as WNode) ?? 1;
      return (p.linkScale / Math.min(a, b)) * Math.min(2, 1 + Math.log2(Math.max(1, l.weight)) * 0.25);
    });
  }
  (sim.force("x") as ReturnType<typeof forceX<WNode>> | undefined)?.strength((n) => (n.orphan ? 0 : p.centerStrength));
  (sim.force("y") as ReturnType<typeof forceY<WNode>> | undefined)?.strength((n) => (n.orphan ? 0 : p.centerStrength));
}

// --------------------------------------------------------------------------------------------
// Nachrichten zwischen Hauptthread und Worker
// --------------------------------------------------------------------------------------------

export type ToWorker =
  | {
      type: "init";
      /** Laufnummer des Datenstands — alte Positionen nach einem Neuaufbau werden verworfen. */
      gen: number;
      /** Je Knoten: x, y (NaN = unbekannt), Grad. */
      xs: Float32Array;
      ys: Float32Array;
      degree: Uint32Array;
      /** Kanten als Paare von Knoten-Indizes + Gewicht. */
      src: Uint32Array;
      dst: Uint32Array;
      weight: Float32Array;
      forces: Forces;
      alpha: number;
      /** Vor dem ersten Bild so lange vorrechnen (ms) — „erste stabile Form" ohne Wackelstart. */
      warmupMs: number;
    }
  | { type: "forces"; forces: Forces }
  | { type: "reheat"; alpha: number }
  | { type: "drag"; index: number; x: number; y: number }
  | { type: "dragEnd"; index: number }
  | { type: "stop" };

export type FromWorker =
  | { type: "positions"; gen: number; xs: Float32Array; ys: Float32Array; alpha: number; tickMs: number; ringRadius: number }
  | { type: "settled"; gen: number };
