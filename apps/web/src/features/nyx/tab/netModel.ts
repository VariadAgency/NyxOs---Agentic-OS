// Aus welchen Knoten Nyx' Netz besteht. Keine Deko-Zufallsgrafik, sondern echte Dinge: in der Mitte
// Nyx (Kern), innen seine echten Werkzeuge (`GET /api/haiku/tools`), außen eine Auswahl aus dem Gehirn-Graph
// (Baustellen, jüngste Sessions, Aufträge/Bugs/Ideen, Commits, Notizen). Ruft Nyx ein Werkzeug, leuchten dessen
// Knoten und die Dinge, die es liest (z. B. `git_lage` → Commits). Positionen liegen auf zwei Kugeln
// (Fibonacci-Verteilung), nach Art sortiert, damit Arten als Bänder zusammenstehen.
// Mehr Datenpunkte und sichtbare Kabel um das Leuchten: eine Synapsen-Wolke aus drei dünnen Schalen dicht um den Kern, jede Synapse per Kabel am Kern; dazu
// kreisen die jüngsten Sessions und die wichtigsten Aufträge/Notizen näher am Kern, ebenfalls per Kabel verbunden.
// Die Knotenzahl ist gedeckelt (`MAX_NET_NODES`), damit das Netz in WebKit flüssig bleibt.
import { nyxToolName, type GraphNode, type GraphNodeType, type GraphResponse } from "@nyxos/shared";
import { openTarget } from "../../brain/links";

export type NetNodeKind = "core" | "tool" | "entity" | "neuron" | "synapse";

/** Sichtbarer Name eines Knotens. Werkzeuge heißen intern wie ihre ID („git_lage“) – angezeigt wird „Git“. */
export function nodeText(n: { kind: NetNodeKind; label: string } | undefined): string {
  if (!n?.label) return "";
  return n.kind === "tool" ? nyxToolName(n.label) : n.label;
}

export interface NetNode {
  id: string;
  label: string;
  kind: NetNodeKind;
  type?: GraphNodeType;
  color: string;
  x: number;
  y: number;
  z: number;
  size: number;
  /** Route in NyxOS (Klick öffnet). */
  href?: string;
  /** Echtes Ding, das nah am Kern kreist (jüngste Sessions, wichtigste Aufträge/Notizen). */
  orbit?: boolean;
  /** Soll-Abstand zum Kern als Anteil der Außenhülle (Synapsen, Umlauf); sonst gilt der Standard je Art. */
  ring?: number;
}

export interface NetEdge {
  a: number;
  b: number;
  /** Zufallsphase 0 … 1 für laufende Signale. */
  phase: number;
  /** core = Kern → Werkzeug, spoke = Kern → Synapse/Umlauf-Ding, tool = Werkzeug → Ding, link = quer. */
  kind: "core" | "spoke" | "tool" | "link";
}

export interface NetModel {
  nodes: NetNode[];
  edges: NetEdge[];
  /** Werkzeug-Knoten-Index → Knoten, die dieses Werkzeug liest. */
  toolTargets: Map<number, number[]>;
}

/**
 * Farben je Art — bunt und knallig wie die Tokens des POS-Designsystems (app.css), nie grau/weiß/
 * schwarz als Kategorie. Werkzeug = Amber wie der Zustand „arbeitet“, Kern = Türkis wie „spricht“.
 */
export const NET_COLORS = {
  core: "#3cc6c0",
  tool: "#ffb020",
  neuron: "#a77bff",
  session: "#3cc6c0",
  subagent: "#7b8cff",
  baustelle: "#c77dff",
  art: "#c8e64a",
  task: "#4da3ff",
  bug: "#ff5a4e",
  idea: "#e3b341",
  finding: "#ff6b8a",
  decision: "#ff8f57",
  question: "#8fd0ff",
  problem: "#ff5a4e",
  commit: "#2fd27a",
  branch: "#c8e64a",
  note: "#c9a8ff",
  file: "#8fd0ff",
} as const satisfies Record<string, string>;

/** Wie viele Knoten je Art höchstens ins Netz kommen (sonst wird es Brei). */
const QUOTA: Partial<Record<GraphNodeType, { max: number; by: "recent" | "degree" }>> = {
  baustelle: { max: 10, by: "degree" },
  art: { max: 6, by: "degree" },
  session: { max: 36, by: "recent" },
  task: { max: 14, by: "degree" },
  bug: { max: 8, by: "degree" },
  idea: { max: 8, by: "degree" },
  finding: { max: 6, by: "degree" },
  question: { max: 4, by: "degree" },
  decision: { max: 4, by: "degree" },
  commit: { max: 10, by: "recent" },
  branch: { max: 4, by: "degree" },
  note: { max: 10, by: "degree" },
};
const TYPE_ORDER: GraphNodeType[] = ["baustelle", "art", "session", "subagent", "task", "bug", "problem", "idea", "finding", "question", "decision", "commit", "branch", "note", "file"];

/** Welche Arten ein Werkzeug liest (Name des Werkzeugs → Arten). Reihenfolge = Vorrang. */
const TOOL_TARGETS: [RegExp, GraphNodeType[]][] = [
  [/git|commit|branch|worktree|zweig/i, ["commit", "branch"]],
  [/idee/i, ["idea"]],
  [/eintrag|auftrag|aufgabe|task|todo|plan|bug|audit|befund/i, ["task", "bug", "finding", "problem"]],
  [/frage|freigabe|inbox|entscheid/i, ["question", "decision"]],
  [/konflikt/i, ["baustelle"]],
  [/session|nacht/i, ["session", "subagent"]],
  [/gedaechtnis|gedächtnis|memory|obsidian|notiz|vault/i, ["note"]],
  [/lage|briefing|recap|ueberblick|überblick/i, ["baustelle", "art"]],
];

const NEURON_MIN = 40;

/** Höchstzahl Knoten im Netz (Kern + Werkzeuge + Dinge + Neuronen + Synapsen) — hält WebKit bei ≥ 55 fps. */
export const MAX_NET_NODES = 240;
/** Synapsen in der Wolke um den Kern. */
export const SYNAPSES = 42;
/** Schalen der Synapsen-Wolke (Anteil der Außenhülle): zwei dicht am Leuchten, eine knapp außerhalb der Werkzeuge. */
export const SYNAPSE_SHELLS = [0.2, 0.28, 0.5] as const;
/** Umlaufbahn der echten Dinge nah am Kern (Anteil der Außenhülle). */
export const ORBIT_RING = 0.64;
/** Werkzeuge beim Laden höchstens (weitere kommen dazu, sobald Nyx sie benutzt). */
const MAX_TOOLS = 40;
/** Welche echten Dinge nah am Kern kreisen: jüngste Sessions zuerst, dann die meistverknüpften Aufträge usw. */
const ORBIT_PLAN: [GraphNodeType, number][] = [
  ["session", 5],
  ["task", 3],
  ["note", 2],
  ["idea", 1],
  ["bug", 1],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Punkt i von n auf der Einheitskugel (gleichmäßig, Fibonacci). */
function fib(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (i + 0.5)) / Math.max(1, n);
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const t = golden * i;
  return [Math.cos(t) * r, y, Math.sin(t) * r];
}

function pick(nodes: GraphNode[]): GraphNode[] {
  const out: GraphNode[] = [];
  const byType = new Map<GraphNodeType, GraphNode[]>();
  for (const n of nodes) {
    if (!QUOTA[n.type]) continue;
    const list = byType.get(n.type) ?? [];
    list.push(n);
    byType.set(n.type, list);
  }
  for (const type of TYPE_ORDER) {
    const q = QUOTA[type];
    const list = byType.get(type);
    if (!q || !list) continue;
    const sorted = [...list].sort((a, b) => (q.by === "recent" ? (b.ts ?? "").localeCompare(a.ts ?? "") : b.degree - a.degree) || a.id.localeCompare(b.id));
    out.push(...sorted.slice(0, q.max));
  }
  return out;
}

function targetsFor(toolName: string): GraphNodeType[] {
  for (const [re, types] of TOOL_TARGETS) if (re.test(toolName)) return types;
  return [];
}

/** Werkzeugname ohne MCP-Vorsatz (`mcp__nyxos__git_lage` → `git_lage`). */
export function baseToolName(tool: string): string {
  const parts = tool.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : tool;
}

export function buildNetModel(graph: GraphResponse | null, tools: readonly string[]): NetModel {
  const nodes: NetNode[] = [{ id: "nyx:core", label: "Nyx", kind: "core", color: NET_COLORS.core, x: 0, y: 0, z: 0, size: 9 }];
  const edges: NetEdge[] = [];
  const toolTargets = new Map<number, number[]>();

  const toolNames = [...new Set(tools.map(baseToolName))].slice(0, MAX_TOOLS);
  toolNames.forEach((name, i) => {
    const [x, y, z] = fib(i, Math.max(toolNames.length, 8));
    nodes.push({ id: `nyx:tool:${name}`, label: name, kind: "tool", color: NET_COLORS.tool, x: x * 0.45, y: y * 0.45, z: z * 0.45, size: 3.4 });
    edges.push({ a: 0, b: nodes.length - 1, phase: hash(name), kind: "core" });
  });

  // Platz für Dinge: was nach Kern, Werkzeugen und Synapsen unter dem Deckel übrig bleibt.
  const budget = Math.max(0, MAX_NET_NODES - nodes.length - SYNAPSES);
  const chosen = (graph ? pick(graph.nodes) : []).slice(0, budget);
  const orbitIds = new Set<string>();
  for (const [type, max] of ORBIT_PLAN) {
    // `pick` sortiert Sessions schon nach Zeit (jüngste zuerst), den Rest nach Verknüpfungen.
    for (const n of chosen.filter((c) => c.type === type).slice(0, max)) orbitIds.add(n.id);
  }
  const entityStart = nodes.length;
  const total = Math.max(chosen.length, NEURON_MIN);
  chosen.forEach((n, i) => {
    const [x, y, z] = fib(i, total);
    const orbit = orbitIds.has(n.id);
    const jitter = orbit ? ORBIT_RING : 0.9 + hash(n.id) * 0.2;
    const target = openTarget(n);
    nodes.push({
      id: n.id,
      label: n.label,
      kind: "entity",
      type: n.type,
      color: (NET_COLORS as Record<string, string>)[n.type] ?? NET_COLORS.neuron,
      x: x * jitter,
      y: y * jitter,
      z: z * jitter,
      size: 1.6 + Math.min(2.2, Math.log2(1 + n.degree) * 0.45) + (orbit ? 0.4 : 0),
      href: target?.kind === "route" ? target.to : undefined,
      ...(orbit ? { orbit: true, ring: ORBIT_RING } : {}),
    });
    // Kabel vom Kern zum Ding im Umlauf; niedrige Phase = läuft schon im Ruhezustand öfter ein Signal.
    if (orbit) edges.push({ a: 0, b: nodes.length - 1, phase: hash(`o${n.id}`) * 0.5, kind: "spoke" });
  });
  // Wenig echte Daten (frische Installation, Gehirn lädt nicht): unbeschriftete Neuronen, damit das Netz lebt.
  const neuronEnd = Math.min(NEURON_MIN, chosen.length + Math.max(0, MAX_NET_NODES - nodes.length - SYNAPSES));
  for (let i = chosen.length; i < neuronEnd; i++) {
    const [x, y, z] = fib(i, total);
    nodes.push({ id: `nyx:neuron:${i}`, label: "", kind: "neuron", color: NET_COLORS.neuron, x, y, z, size: 1.3 });
  }
  const outerEnd = nodes.length;

  // Synapsen-Wolke um den Kern: drei dünne Schalen, jede Synapse per Kabel am Kern.
  const synStart = nodes.length;
  for (let i = 0; i < SYNAPSES; i++) {
    const [x, y, z] = fib(i, SYNAPSES);
    const ring = SYNAPSE_SHELLS[i % SYNAPSE_SHELLS.length] ?? SYNAPSE_SHELLS[0];
    const r = ring * (0.92 + hash(`syn${i}`) * 0.16);
    nodes.push({ id: `nyx:synapse:${i}`, label: "", kind: "synapse", color: NET_COLORS.neuron, x: x * r, y: y * r, z: z * r, size: 1 + hash(`sz${i}`) * 0.5, ring });
    edges.push({ a: 0, b: nodes.length - 1, phase: hash(`sp${i}`) * 0.35, kind: "spoke" });
  }

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  // Kanten aus dem Gehirn (nur zwischen gewählten Knoten).
  if (graph) {
    for (const l of graph.links) {
      const a = index.get(l.source);
      const b = index.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      edges.push({ a, b, phase: hash(`${l.source}|${l.target}`), kind: "link" });
    }
  }
  // Werkzeug → Dinge, die es liest (für die Anzeige höchstens 5 Kanten je Werkzeug, leuchten tun alle).
  for (let t = 1; t < entityStart; t++) {
    const types = targetsFor(nodes[t]?.label ?? "");
    const targets: number[] = [];
    for (let e = entityStart; e < outerEnd; e++) {
      const n = nodes[e];
      if (n?.type && types.includes(n.type)) targets.push(e);
    }
    toolTargets.set(t, targets);
    for (const e of targets.slice(0, 5)) edges.push({ a: t, b: e, phase: hash(`${t}>${e}`), kind: "tool" });
  }
  // Nachbarn verbinden (Netz-Optik), deterministisch: je Knoten die zwei nächsten.
  const outer: number[] = [];
  for (let i = entityStart; i < outerEnd; i++) outer.push(i);
  linkNearest(nodes, outer, 2, edges, "~");
  // Synapsen untereinander (je eine Nachbarin) und die äußere Schale an das nächste Werkzeug: ein feines Geflecht.
  const syn: number[] = [];
  for (let i = synStart; i < nodes.length; i++) syn.push(i);
  linkNearest(nodes, syn, 1, edges, "s");
  const toolIdx: number[] = [];
  for (let t = 1; t < entityStart; t++) toolIdx.push(t);
  if (toolIdx.length > 0) {
    for (const s of syn) {
      if ((nodes[s]?.ring ?? 0) < SYNAPSE_SHELLS[2]) continue;
      const near = nearest(nodes, s, toolIdx, 1)[0];
      if (near !== undefined) edges.push({ a: near, b: s, phase: hash(`st${s}`), kind: "link" });
    }
  }
  // Jedes Werkzeug ohne passende Dinge hängt wenigstens an zwei Außenknoten (sonst schwebt es lose).
  for (let t = 1; t < entityStart; t++) {
    if ((toolTargets.get(t) ?? []).length > 0 || outer.length === 0) continue;
    const pickA = outer[Math.floor(hash(`a${t}`) * outer.length)] as number;
    const pickB = outer[Math.floor(hash(`b${t}`) * outer.length)] as number;
    edges.push({ a: t, b: pickA, phase: hash(`ta${t}`), kind: "tool" }, { a: t, b: pickB, phase: hash(`tb${t}`), kind: "tool" });
  }
  return { nodes, edges, toolTargets };
}

/** Die `k` nächsten Knoten aus `pool` zu Knoten `i` (nach Modell-Position). */
function nearest(nodes: NetNode[], i: number, pool: readonly number[], k: number): number[] {
  const a = nodes[i] as NetNode;
  return pool
    .filter((j) => j !== i)
    .map((j) => {
      const b = nodes[j] as NetNode;
      return { j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 };
    })
    .sort((p, q) => p.d - q.d)
    .slice(0, k)
    .map((p) => p.j);
}

/** Verbindet jeden Knoten der Gruppe mit seinen `k` nächsten (jede Kante nur einmal). */
function linkNearest(nodes: NetNode[], group: readonly number[], k: number, edges: NetEdge[], tag: string): void {
  const seen = new Set<string>();
  for (const i of group) {
    for (const j of nearest(nodes, i, group, k)) {
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      const key = `${a}-${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b, phase: hash(`${a}${tag}${b}`), kind: "link" });
    }
  }
}

/**
 * Index des Werkzeug-Knotens (−1 = unbekannt). `add: true` legt einen neuen Knoten an, wenn Nyx ein Werkzeug
 * nutzt, das beim Laden noch nicht in der Liste stand (z. B. neu aus dem Kern oder ein MCP-Konnektor).
 */
export function findToolIndex(model: NetModel, tool: string, opts: { add?: boolean } = {}): number {
  const name = baseToolName(tool);
  const i = model.nodes.findIndex((n) => n.kind === "tool" && n.label === name);
  if (i >= 0 || !opts.add) return i;
  const count = model.nodes.filter((n) => n.kind === "tool").length;
  const [x, y, z] = fib(count, count + 1);
  model.nodes.push({ id: `nyx:tool:${name}`, label: name, kind: "tool", color: NET_COLORS.tool, x: x * 0.45, y: y * 0.45, z: z * 0.45, size: 3.4 });
  const idx = model.nodes.length - 1;
  model.edges.push({ a: 0, b: idx, phase: hash(name), kind: "core" });
  const types = targetsFor(name);
  const targets = model.nodes.map((n, j) => (n.type && types.includes(n.type) ? j : -1)).filter((j) => j >= 0);
  model.toolTargets.set(idx, targets);
  for (const e of targets.slice(0, 5)) model.edges.push({ a: idx, b: e, phase: hash(`${idx}>${e}`), kind: "tool" });
  return idx;
}

export function targetsOfTool(model: NetModel, toolIndex: number): number[] {
  return model.toolTargets.get(toolIndex) ?? [];
}
