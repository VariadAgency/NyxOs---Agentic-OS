// Nyx' Netz als organischer 3D-Graph (wie das Gehirn in 3D), statt Punkte auf einer Kugelschale.
// Ausgangslage sind die Kugel-Positionen aus `netModel.ts` (deterministisch), dann rechnet d3-force-3d (MIT,
// wie im Gehirn) ein paar hundert Schritte synchron: Kanten ziehen verwandte Dinge zusammen, Knoten stoßen
// sich ab, Werkzeuge bleiben als innerer Ring um den Kern, der Kern bleibt fest in der Mitte. Ergebnis ist in
// Welt-Einheiten normiert (äußerster Knoten ≈ `NET_RADIUS`), damit Kamera und Wellen feste Maße haben.
// Knoten mit eigenem Soll-Abstand (`ring`: Synapsen-Wolke, Dinge im Umlauf) hält eine eigene, straffe
// Radial-Kraft auf ihrer Schale; ihre Kabel zum Kern sind genau so lang.
import { forceLink, forceManyBody, forceRadial, forceSimulation, type Node3 } from "d3-force-3d";
import type { NetModel } from "../netModel";

/** Radius des Netzes in Welt-Einheiten (Kamera steht bei ~3 × davon). */
export const NET_RADIUS = 2.2;
/** Werkzeuge liegen auf diesem Anteil des Radius (innerer Ring). */
export const TOOL_RING = 0.38;
const TICKS = 240;
const SCALE = 150;

interface LNode extends Node3 {
  kind: string;
  /** Soll-Abstand zum Kern (Simulations-Einheiten). */
  goal: number;
  /** Wie straff der Knoten auf seiner Schale gehalten wird. */
  hold: number;
}

function radialFor(kind: string, ring: number | undefined): { goal: number; hold: number } {
  if (ring !== undefined) return { goal: ring * SCALE, hold: kind === "synapse" ? 0.8 : 0.4 };
  if (kind === "core") return { goal: 0, hold: 0 };
  if (kind === "tool") return { goal: TOOL_RING * SCALE, hold: 0.6 };
  return { goal: SCALE, hold: 0.045 };
}

export interface NetLayout {
  /** x,y,z je Knoten (gleiche Reihenfolge wie `model.nodes`). */
  positions: Float32Array;
  /** Abstand je Knoten zum Kern (Welt-Einheiten) — für Wellen, die durchs Netz laufen. */
  radius: Float32Array;
}

export function layoutNet(model: NetModel): NetLayout {
  const nodes: LNode[] = model.nodes.map((n) => ({ kind: n.kind, ...radialFor(n.kind, n.ring), x: n.x * SCALE, y: n.y * SCALE, z: n.z * SCALE }));
  const core = nodes[0];
  if (core) {
    core.fx = 0;
    core.fy = 0;
    core.fz = 0;
  }
  const links = model.edges.map((e) => ({ source: e.a, target: e.b, kind: e.kind, len: e.kind === "spoke" ? (nodes[e.b]?.goal ?? 60) : 0 }));
  const sim = forceSimulation(nodes, 3)
    .force(
      "link",
      forceLink<LNode, (typeof links)[number]>(links)
        .distance((l) => (l.kind === "core" ? 60 : l.kind === "spoke" ? l.len : l.kind === "tool" ? 95 : 34))
        .strength((l) => (l.kind === "core" ? 0.5 : l.kind === "spoke" ? 0.3 : l.kind === "tool" ? 0.08 : 0.35)),
    )
    .force("charge", forceManyBody<LNode>().strength((d) => (d.kind === "core" ? -220 : d.kind === "tool" ? -70 : d.kind === "synapse" ? -10 : -38)).distanceMax(260))
    .force("radial", forceRadial<LNode>((d) => d.goal).strength((d) => d.hold))
    .stop();
  sim.tick(TICKS);

  let max = 1e-6;
  for (const n of nodes) max = Math.max(max, Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0));
  const k = NET_RADIUS / max;
  const positions = new Float32Array(nodes.length * 3);
  const radius = new Float32Array(nodes.length);
  nodes.forEach((n, i) => {
    const x = (n.x ?? 0) * k;
    const y = (n.y ?? 0) * k;
    const z = (n.z ?? 0) * k;
    positions[i * 3] = Number.isFinite(x) ? x : 0;
    positions[i * 3 + 1] = Number.isFinite(y) ? y : 0;
    positions[i * 3 + 2] = Number.isFinite(z) ? z : 0;
    radius[i] = Math.hypot(positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0);
  });
  return { positions, radius };
}

/**
 * Knoten, die erst nach dem Layout dazukommen (Werkzeug, das beim Laden noch nicht bekannt war): auf den
 * Werkzeug-Ring legen, Richtung aus der Kugel-Position des Modells.
 */
export function extendLayout(layout: NetLayout, model: NetModel): NetLayout {
  const have = layout.radius.length;
  if (model.nodes.length <= have) return layout;
  const positions = new Float32Array(model.nodes.length * 3);
  positions.set(layout.positions);
  const radius = new Float32Array(model.nodes.length);
  radius.set(layout.radius);
  for (let i = have; i < model.nodes.length; i++) {
    const n = model.nodes[i];
    if (!n) continue;
    const len = Math.max(1e-6, Math.hypot(n.x, n.y, n.z));
    const r = NET_RADIUS * TOOL_RING;
    positions[i * 3] = (n.x / len) * r;
    positions[i * 3 + 1] = (n.y / len) * r;
    positions[i * 3 + 2] = (n.z / len) * r;
    radius[i] = r;
  }
  return { positions, radius };
}
