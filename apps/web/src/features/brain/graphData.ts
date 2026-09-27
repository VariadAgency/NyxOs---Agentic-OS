// Live-Graph im Browser: Daten aus `/api/graph`, danach nur noch kleine Deltas über `/live`.
// Knoten-Objekte bleiben dieselben (force-graph hält Referenzen und Positionen daran).
import type { GraphDeltaMessage, GraphLink, GraphNode } from "@nyxos/shared";
import { endpointId } from "./filter";

/** Knoten mit Simulations-Feldern (force-graph/d3 schreiben x/y/vx/vy direkt hinein). */
export type SimNode = GraphNode & { x?: number; y?: number; z?: number; vx?: number; vy?: number; fx?: number; fy?: number };
export type SimLink = Omit<GraphLink, "source" | "target"> & { source: string | SimNode; target: string | SimNode };

export interface LiveGraph {
  version: number;
  nodes: SimNode[];
  links: SimLink[];
}

export type DeltaStatus = "applied" | "stale" | "reload";

const key = (kind: string, a: string, b: string) => `${kind}|${a}|${b}`;

/**
 * Wendet ein Delta an. `stale` = älteres Delta (schon enthalten) → ignorieren; `reload` = Lücke
 * (ein Delta verpasst, z. B. nach Verbindungsabbruch) → ganzen Graphen neu laden.
 */
export function applyDelta(g: LiveGraph, d: GraphDeltaMessage, opts: { includeFiles?: boolean } = {}): { status: DeltaStatus } {
  if (d.version <= g.version) return { status: "stale" };
  if (d.fromVersion !== g.version) return { status: "reload" };

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const removed = new Set(d.removeNodes);
  if (removed.size > 0) g.nodes = g.nodes.filter((n) => !removed.has(n.id));

  for (const u of d.updateNodes) {
    const n = byId.get(u.id);
    if (n) Object.assign(n, u);
  }

  const dropLinks = new Set(d.removeLinks.map((l) => key(l.kind, l.source, l.target)));
  g.links = g.links.filter((l) => {
    const a = endpointId(l.source);
    const b = endpointId(l.target);
    return !removed.has(a) && !removed.has(b) && !dropLinks.has(key(l.kind, a, b));
  });

  // Dateien nur, wenn sie geladen wurden (`include=files`) — sonst passt das Delta nicht zur Ansicht.
  const fileOk = (type: string) => opts.includeFiles === true || type !== "file";
  const added: SimNode[] = d.addNodes.filter((n) => !byId.has(n.id) && fileOk(n.type)).map((n) => ({ ...n }));
  for (const n of added) byId.set(n.id, n);
  g.nodes.push(...added);
  g.links.push(...d.addLinks.filter((l) => byId.has(l.source) && byId.has(l.target) && !removed.has(l.source) && !removed.has(l.target)).map((l) => ({ ...l })));

  // Neue Knoten starten neben einem schon platzierten Nachbarn statt in der Mitte (kein Sprung).
  for (const n of added) {
    const neighbour = d.addLinks
      .map((l) => (l.source === n.id ? l.target : l.target === n.id ? l.source : null))
      .map((id) => (id ? byId.get(id) : undefined))
      .find((m) => m && m.x !== undefined && m.y !== undefined);
    if (neighbour?.x !== undefined && neighbour.y !== undefined) {
      n.x = neighbour.x + (Math.random() - 0.5) * 8;
      n.y = neighbour.y + (Math.random() - 0.5) * 8;
    }
  }

  g.version = d.version;
  return { status: "applied" };
}
