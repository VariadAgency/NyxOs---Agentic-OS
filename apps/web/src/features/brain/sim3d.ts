// 3D-Kräfte-Simulation (d3-force-3d, MIT) für die 3D-Ansicht — läuft im Web-Worker
// (`sim3d.worker.ts`), der Hauptthread zeichnet nur. Positionen gehen als EIN
// Float32Array [x0,y0,z0, x1,…] hin und her (übertragbar, ohne Kopie) und landen direkt im
// Positions-Puffer von three.js.
//
// Kräfte wie in 2D: Abstoßung, Verbindung, Zug zur Mitte; Waisen auf einer Kugelschale außen
// (wie Obsidians Waisen-Ring, nur in 3D).
//
// Vorher rechnete 3D mit festen Werten (CHARGE/LINK_DISTANCE/CENTER) — die Regler unter
// „Kräfte“ kamen nie im Worker an. Jetzt gehen sie beim Start mit und bei jeder Änderung als
// Nachricht `forces` (die Simulation wacht dann auf und bewegt sich sichtbar).
import { forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY, forceZ, type LinkForce, type ManyBody, type Node3, type PositionForce, type Simulation } from "d3-force-3d";
import { DEFAULT_FORCES, type Forces } from "./forces";

export interface N3 extends Node3 {
  orphan: boolean;
}
interface L3 {
  source: N3;
  target: N3;
  weight: number;
}

export type ToSim3d =
  | {
      type: "init";
      gen: number;
      /** Je Knoten x,y,z (NaN = unbekannt). */
      pos: Float32Array;
      degree: Uint32Array;
      src: Uint32Array;
      dst: Uint32Array;
      weight: Float32Array;
      alpha: number;
      /** Vor dem ersten Bild so lange vorrechnen (ms). */
      warmupMs: number;
      /** Regler „Kräfte“. */
      forces: Forces;
    }
  | { type: "forces"; forces: Forces }
  /** Knoten wird gezogen — an dieser Stelle festhalten, Physik wach halten (Nachbarn folgen). */
  | { type: "pin"; index: number; x: number; y: number; z: number }
  /** Losgelassen: freigeben, die Physik kühlt ab und der Knoten federt in die Wolke zurück. */
  | { type: "unpin"; index: number }
  | { type: "stop" };

export type FromSim3d = { type: "positions"; gen: number; pos: Float32Array; alpha: number; tickMs: number } | { type: "settled"; gen: number };

const FRAME_MS = 16;
export const SIM3D_ALPHA_MIN = 0.004;
/** Nach einer Regler-Änderung so kräftig aufwecken, dass man die Bewegung sieht. */
export const FORCES_REHEAT = 0.6;
/** Während des Ziehens bleibt die Physik so warm (Nachbarn folgen sichtbar, aber ruhig). */
export const DRAG_ALPHA_TARGET = 0.22;
// Bisherige feste 3D-Werte = Vorgabe der Regler (das Aussehen bleibt, bis jemand die Regler verschiebt).
const CHARGE_PER_REPEL = -55 / DEFAULT_FORCES.repel;
const DISTANCE_PER_UNIT = 26 / DEFAULT_FORCES.distance;
const CENTER_PER_UNIT = 0.035 / DEFAULT_FORCES.center;

/** Regler (wie Obsidian) → d3-force-3d-Werte. */
export function forceParams3d(f: Forces) {
  return {
    charge: Math.max(0, f.repel) * CHARGE_PER_REPEL,
    linkDistance: Math.max(4, f.distance * DISTANCE_PER_UNIT),
    center: Math.max(0, f.center) * CENTER_PER_UNIT,
    linkScale: Math.max(0, f.link),
  };
}

export function buildSim3d(nodes: N3[], links: L3[], forces: Forces = DEFAULT_FORCES): Simulation<N3> {
  // Schale für Waisen knapp außerhalb der Wolke (Wurzel der Knotenzahl ~ Radius einer Kugel).
  const connected = nodes.length - nodes.filter((n) => n.orphan).length;
  const shell = 60 + Math.cbrt(Math.max(1, connected)) * 34;
  const sim = forceSimulation<N3>(nodes, 3)
    .alphaDecay(0.028)
    // Etwas weniger Reibung als früher (0,4): die Wolke gleitet sichtbarer, statt sofort zu stehen.
    .velocityDecay(0.32)
    .alphaMin(SIM3D_ALPHA_MIN)
    .force("charge", forceManyBody<N3>().theta(0.95).distanceMax(900))
    .force("link", forceLink<N3, L3>(links))
    .force("x", forceX<N3>(0))
    .force("y", forceY<N3>(0))
    .force("z", forceZ<N3>(0))
    .force("orphans", forceRadial<N3>(shell).strength((n) => (n.orphan ? 0.08 : 0)))
    .stop();
  applyForces3d(sim, forces);
  return sim;
}

/** Regler-Werte in eine laufende Simulation übernehmen (ohne Neuaufbau). */
export function applyForces3d(sim: Simulation<N3>, f: Forces): void {
  const p = forceParams3d(f);
  (sim.force("charge") as ManyBody<N3> | undefined)?.strength((n) => (n.orphan ? p.charge * 0.3 : p.charge));
  const link = sim.force("link") as LinkForce<N3, L3> | undefined;
  if (link) {
    const count = new Map<N3, number>();
    for (const l of link.links()) {
      count.set(l.source, (count.get(l.source) ?? 0) + 1);
      count.set(l.target, (count.get(l.target) ?? 0) + 1);
    }
    link.distance(p.linkDistance).strength((l) => (p.linkScale / Math.min(count.get(l.source) ?? 1, count.get(l.target) ?? 1)) * Math.min(2, 1 + Math.log2(Math.max(1, l.weight)) * 0.25));
  }
  for (const axis of ["x", "y", "z"]) (sim.force(axis) as PositionForce<N3> | undefined)?.strength((n) => (n.orphan ? 0 : p.center));
}

/** Nimmt `ToSim3d` an, schickt `FromSim3d` zurück — im Worker oder als Rückfall im Hauptthread. */
export function createSim3dHost(post: (msg: FromSim3d, transfer: Transferable[]) => void): (m: ToSim3d) => void {
  let sim: Simulation<N3> | null = null;
  let nodes: N3[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let gen = 0;

  const send = (tickMs: number) => {
    const pos = new Float32Array(nodes.length * 3);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      pos[i * 3] = n?.x ?? 0;
      pos[i * 3 + 1] = n?.y ?? 0;
      pos[i * 3 + 2] = n?.z ?? 0;
    }
    post({ type: "positions", gen, pos, alpha: sim?.alpha() ?? 0, tickMs }, [pos.buffer]);
  };
  const loop = () => {
    timer = null;
    if (!sim) return;
    const t0 = performance.now();
    sim.tick();
    const tickMs = performance.now() - t0;
    send(tickMs);
    if (sim.alpha() < sim.alphaMin()) {
      post({ type: "settled", gen }, []);
      return;
    }
    timer = setTimeout(loop, Math.max(0, FRAME_MS - tickMs));
  };

  return (m) => {
    if (m.type === "stop") {
      sim?.stop();
      sim = null;
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (m.type === "pin" || m.type === "unpin") {
      const n = nodes[m.index];
      if (!sim || !n) return;
      if (m.type === "pin") {
        n.fx = m.x;
        n.fy = m.y;
        n.fz = m.z;
        sim.alphaTarget(DRAG_ALPHA_TARGET);
        sim.alpha(Math.max(sim.alpha(), DRAG_ALPHA_TARGET));
      } else {
        n.fx = null;
        n.fy = null;
        n.fz = null;
        sim.alphaTarget(0);
      }
      if (!timer) timer = setTimeout(loop, 0);
      return;
    }
    if (m.type === "forces") {
      if (!sim) return;
      applyForces3d(sim, m.forces);
      sim.alpha(Math.max(sim.alpha(), FORCES_REHEAT));
      if (!timer) timer = setTimeout(loop, 0);
      return;
    }
    sim?.stop();
    if (timer) clearTimeout(timer);
    timer = null;
    gen = m.gen;
    nodes = Array.from(m.degree, (degree, i) => {
      const n: N3 = { index: i, orphan: degree === 0 };
      const x = m.pos[i * 3] ?? Number.NaN;
      const y = m.pos[i * 3 + 1] ?? Number.NaN;
      const z = m.pos[i * 3 + 2] ?? Number.NaN;
      if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) Object.assign(n, { x, y, z });
      return n;
    });
    const links: L3[] = [];
    for (let i = 0; i < m.src.length; i++) {
      const s = nodes[m.src[i] ?? -1];
      const t = nodes[m.dst[i] ?? -1];
      if (s && t && s !== t) links.push({ source: s, target: t, weight: m.weight[i] ?? 1 });
    }
    sim = buildSim3d(nodes, links, m.forces);
    sim.alpha(m.alpha);
    const until = performance.now() + m.warmupMs;
    while (m.warmupMs > 0 && performance.now() < until && sim.alpha() > 0.1) sim.tick();
    send(0);
    timer = setTimeout(loop, 0);
  };
}
