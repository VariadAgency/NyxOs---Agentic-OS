// PG: Quellen-Adapter-Vertrag und Zusammenführen zu EINEM Graphen (Grad, Duplikate, lose Kanten).
import type { GraphLink, GraphNode, GraphStats } from "@nyxos/shared";

/** Ein Knoten, wie ihn eine Quelle liefert — den Grad rechnet erst `mergeSources` aus. */
export type SourceNode = Omit<GraphNode, "degree">;

export interface SourceResult {
  nodes: SourceNode[];
  links: GraphLink[];
}

/**
 * Eine austauschbare Datenquelle des Graphen (Sessions, Vault, P4-Einträge, P5-Git). Kanten dürfen
 * auf Knoten ANDERER Quellen zeigen (z. B. Notiz → Session); fehlt der Zielknoten am Ende, fällt
 * die Kante still weg (die Quelle kann ja gerade leer sein).
 */
export interface GraphSource {
  name: string;
  load(): Promise<SourceResult>;
}

/** Kanten dieser Art zählen nur beim Ziel (der Datei) zum Grad, nicht bei der Session — Datei-Knoten
 * sind optional, die Größe der Session bleibt beim Umschalten stabil. */
const TARGET_ONLY_DEGREE = new Set<GraphLink["kind"]>(["touched_file"]);

export interface MergedGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: Omit<GraphStats, "builtAt" | "buildMs">;
}

/**
 * Führt Quellen zusammen: erster Knoten je ID gewinnt, Kanten ohne beide Enden oder Schleifen fallen
 * weg, gleiche Kanten (Art + ungeordnetes Paar) werden zu einer mit summiertem Gewicht.
 */
export function mergeSources(results: Array<SourceResult & { name: string }>): MergedGraph {
  const nodes = new Map<string, GraphNode>();
  const sources: string[] = [];
  for (const r of results) {
    if (r.nodes.length > 0 || r.links.length > 0) sources.push(r.name);
    for (const n of r.nodes) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, degree: 0 });
  }

  const links = new Map<string, GraphLink>();
  for (const r of results) {
    for (const l of r.links) {
      if (l.source === l.target || !nodes.has(l.source) || !nodes.has(l.target)) continue;
      const [a, b] = l.source < l.target ? [l.source, l.target] : [l.target, l.source];
      const key = `${l.kind}|${a}|${b}`;
      const existing = links.get(key);
      if (existing) existing.weight += l.weight;
      else links.set(key, { ...l });
    }
  }

  const byType: GraphStats["byType"] = {};
  const byKind: GraphStats["byKind"] = {};
  // Grad = Anzahl verschiedener Nachbarn (wie Obsidian), nicht Anzahl Kanten-Arten.
  const neighbours = new Map<string, Set<string>>();
  const addNeighbour = (a: string, b: string) => {
    const set = neighbours.get(a);
    if (set) set.add(b);
    else neighbours.set(a, new Set([b]));
  };
  for (const l of links.values()) {
    byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
    if (!TARGET_ONLY_DEGREE.has(l.kind)) addNeighbour(l.source, l.target);
    addNeighbour(l.target, l.source);
  }
  for (const [id, set] of neighbours) {
    const n = nodes.get(id);
    if (n) n.degree = set.size;
  }
  let orphans = 0;
  for (const n of nodes.values()) {
    byType[n.type] = (byType[n.type] ?? 0) + 1;
    if (n.degree === 0) orphans += 1;
  }

  return { nodes: [...nodes.values()], links: [...links.values()], stats: { nodes: nodes.size, links: links.size, orphans, byType, byKind, sources } };
}
