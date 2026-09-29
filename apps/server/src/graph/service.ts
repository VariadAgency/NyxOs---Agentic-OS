// PG: vorberechneter, gecachter Graph + Filter + lokaler Graph + Live-Deltas.
//
// Ablauf: Jede Änderung (Ingest, Einsortierung, Vault) ruft `markDirty()`. Sind Browser über `/live`
// verbunden, baut der Dienst nach einer kurzen Bündelung (Standard 400 ms) neu, vergleicht mit dem
// vorigen Stand und schickt NUR die Unterschiede als `{ type: "graph", … }`. Ohne Zuhörer wird erst
// bei der nächsten Anfrage neu gebaut. Antworten werden je Abfrage als fertiger JSON-Text
// zwischengespeichert, bis sich die Version ändert (Ziel < 300 ms für den Gesamtgraphen).
import { linkKey, type GraphDeltaMessage, type GraphLink, type GraphLocalResponse, type GraphNode, type GraphNodeType, type GraphResponse, type GraphStats } from "@nyxos/shared";
import { mergeSources, type GraphSource, type SourceResult } from "./build.js";

export interface BuiltGraph {
  version: number;
  nodes: GraphNode[];
  links: GraphLink[];
  stats: GraphStats;
  byId: Map<string, GraphNode>;
  /** Nachbarn je Knoten (Index in `links`). */
  adjacency: Map<string, number[]>;
  responses: Map<string, string>;
}

export interface GraphQuery {
  types: Set<GraphNodeType> | null;
  since: string | null;
  includeFiles: boolean;
}

export interface GraphServiceOptions {
  debounceMs?: number;
  onDelta?: (delta: GraphDeltaMessage) => void;
  /** Nur neu bauen und Deltas schicken, wenn jemand zuhört. */
  hasListeners?: () => boolean;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Größte Anzahl Knoten eines lokalen Graphen (Tiefe 3 um einen Knotenpunkt kann sonst alles sein). */
export const LOCAL_MAX_NODES = 1500;

export class GraphService {
  private current: BuiltGraph | null = null;
  private dirty = true;
  private building: Promise<BuiltGraph> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private version = 0;
  private readonly lastResults = new Map<string, SourceResult>();
  /** Quellen, die beim nächsten Bau neu gelesen werden (die übrigen kommen aus dem Zwischenspeicher). */
  private readonly staleSources = new Set<string>();

  constructor(
    private readonly sources: GraphSource[],
    private readonly opts: GraphServiceOptions = {},
  ) {}

  /** Aktueller Graph (baut bei Bedarf neu). */
  async get(): Promise<BuiltGraph> {
    if (this.current && !this.dirty) return this.current;
    return this.rebuild();
  }

  /**
   * Etwas hat sich geändert. `sources` = nur diese Quellen neu lesen (z. B. nach einem Session-Ingest
   * nicht die 5.000 Vault-Notizen); ohne Angabe alle.
   */
  markDirty(sources?: string[]): void {
    for (const name of sources ?? this.sources.map((s) => s.name)) this.staleSources.add(name);
    this.dirty = true;
    if (!this.opts.hasListeners?.() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.rebuild().catch((e: unknown) => this.opts.log?.("graph-fehler", { error: String(e) }));
    }, this.opts.debounceMs ?? 600);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async rebuild(): Promise<BuiltGraph> {
    while (this.building) await this.building.catch(() => undefined);
    if (this.current && !this.dirty) return this.current;
    this.building = this.buildOnce();
    try {
      return await this.building;
    } finally {
      this.building = null;
    }
  }

  private async buildOnce(): Promise<BuiltGraph> {
    this.dirty = false;
    const started = performance.now();
    const stale = new Set(this.staleSources);
    this.staleSources.clear();
    const results = await Promise.all(
      this.sources.map(async (s) => {
        const cached = this.lastResults.get(s.name);
        if (cached && !stale.has(s.name)) return { name: s.name, ...cached };
        try {
          const r = await s.load();
          this.lastResults.set(s.name, r);
          return { name: s.name, ...r };
        } catch (e) {
          // Eine kaputte Quelle darf den Graphen nicht leeren: letzten guten Stand weiterverwenden.
          this.opts.log?.("graph-quelle-fehler", { source: s.name, error: String(e) });
          this.staleSources.add(s.name); // beim nächsten Bau erneut versuchen
          const last = this.lastResults.get(s.name) ?? { nodes: [], links: [] };
          return { name: s.name, ...last };
        }
      }),
    );
    const merged = mergeSources(results);
    const buildMs = Math.round(performance.now() - started);
    const prev = this.current;
    const built: BuiltGraph = {
      version: ++this.version,
      nodes: merged.nodes,
      links: merged.links,
      stats: { ...merged.stats, builtAt: new Date().toISOString(), buildMs },
      byId: new Map(merged.nodes.map((n) => [n.id, n])),
      adjacency: buildAdjacency(merged.links),
      responses: new Map(),
    };
    this.current = built;
    if (prev && this.opts.onDelta) {
      const delta = diffGraphs(prev, built);
      if (delta) this.opts.onDelta(delta);
    }
    return built;
  }

  /** Gesamtgraph als fertiger JSON-Text (gecacht je Abfrage und Version). */
  async queryJson(q: GraphQuery): Promise<string> {
    const g = await this.get();
    const key = `${q.types ? [...q.types].sort().join(",") : "*"}|${q.since ?? ""}|${q.includeFiles ? 1 : 0}`;
    const cached = g.responses.get(key);
    if (cached) return cached;
    const body = JSON.stringify(filterGraph(g, q));
    if (g.responses.size > 32) g.responses.clear();
    g.responses.set(key, body);
    return body;
  }

  async local(nodeId: string, depth: number, includeFiles: boolean): Promise<GraphLocalResponse | null> {
    const g = await this.get();
    const center = resolveCenter(g, nodeId);
    if (!center) return null;
    return localGraph(g, center, depth, includeFiles);
  }
}

export function buildAdjacency(links: GraphLink[]): Map<string, number[]> {
  const adj = new Map<string, number[]>();
  links.forEach((l, i) => {
    for (const id of [l.source, l.target]) {
      const list = adj.get(id);
      if (list) list.push(i);
      else adj.set(id, [i]);
    }
  });
  return adj;
}

export function filterGraph(g: BuiltGraph, q: GraphQuery): GraphResponse {
  const includeFiles = q.includeFiles || (q.types?.has("file") ?? false);
  const typeOk = (n: GraphNode) => (n.type === "file" ? includeFiles && (!q.types || q.types.has("file")) : !q.types || q.types.has(n.type));
  const linkOk = (l: GraphLink) => includeFiles || l.kind !== "touched_file";
  let keep = new Set<string>();
  for (const n of g.nodes) if (typeOk(n) && (!q.since || !n.ts || n.ts >= q.since)) keep.add(n.id);
  if (q.since) {
    // Zeitraum: Knoten ohne Zeit (Arten, Baustellen, nicht erstellte Notizen) nur, wenn sie an
    // einem Knoten mit Zeit im Zeitraum hängen — sonst bliebe ein Kranz leerer Knotenpunkte.
    const timed = new Set([...keep].filter((id) => g.byId.get(id)?.ts));
    const next = new Set(timed);
    for (const id of keep) {
      if (timed.has(id)) continue;
      const touches = (g.adjacency.get(id) ?? []).some((i) => {
        const l = g.links[i];
        return l !== undefined && linkOk(l) && timed.has(l.source === id ? l.target : l.source);
      });
      if (touches) next.add(id);
    }
    keep = next;
  }
  const nodes = g.nodes.filter((n) => keep.has(n.id));
  const links = g.links.filter((l) => linkOk(l) && keep.has(l.source) && keep.has(l.target));
  return { version: g.version, nodes, links, stats: { ...g.stats, nodes: nodes.length, links: links.length, orphans: nodes.filter((n) => n.degree === 0).length } };
}

const BARE_ID = /^[0-9a-zA-Z][0-9a-zA-Z._-]*$/;

export function resolveCenter(g: BuiltGraph, nodeId: string): string | null {
  if (g.byId.has(nodeId)) return nodeId;
  if (g.byId.has(`session:${nodeId}`)) return `session:${nodeId}`;
  if (BARE_ID.test(nodeId)) {
    for (const tool of ["claude", "codex"]) if (g.byId.has(`session:${tool}:${nodeId}`)) return `session:${tool}:${nodeId}`;
  }
  return null;
}

export function localGraph(g: BuiltGraph, center: string, depth: number, includeFiles: boolean): GraphLocalResponse {
  const seen = new Set<string>([center]);
  let frontier = [center];
  for (let d = 0; d < depth && frontier.length > 0 && seen.size < LOCAL_MAX_NODES; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const i of g.adjacency.get(id) ?? []) {
        const l = g.links[i];
        if (!l || (!includeFiles && l.kind === "touched_file")) continue;
        const other = l.source === id ? l.target : l.source;
        if (seen.has(other)) continue;
        if (seen.size >= LOCAL_MAX_NODES) break;
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  const nodes = [...seen].map((id) => g.byId.get(id)).filter((n): n is GraphNode => n !== undefined);
  const links = g.links.filter((l) => seen.has(l.source) && seen.has(l.target) && (includeFiles || l.kind !== "touched_file"));
  return {
    version: g.version,
    center,
    depth,
    nodes,
    links,
    stats: { ...g.stats, nodes: nodes.length, links: links.length, orphans: 0 },
  };
}

/** Unterschiede zwischen zwei Ständen (null = nichts geändert). */
export function diffGraphs(prev: BuiltGraph, next: BuiltGraph): GraphDeltaMessage | null {
  const addNodes: GraphNode[] = [];
  const updateNodes: GraphNode[] = [];
  const removeNodes: string[] = [];
  for (const n of next.nodes) {
    const old = prev.byId.get(n.id);
    if (!old) addNodes.push(n);
    else if (nodeChanged(old, n)) updateNodes.push(n);
  }
  for (const n of prev.nodes) if (!next.byId.has(n.id)) removeNodes.push(n.id);

  const prevLinks = new Map(prev.links.map((l) => [linkKey(l), l]));
  const nextLinks = new Map(next.links.map((l) => [linkKey(l), l]));
  const addLinks: GraphLink[] = [];
  const removeLinks: GraphDeltaMessage["removeLinks"] = [];
  for (const [key, l] of nextLinks) {
    const old = prevLinks.get(key);
    if (!old) addLinks.push(l);
    else if (old.weight !== l.weight) {
      removeLinks.push({ source: old.source, target: old.target, kind: old.kind });
      addLinks.push(l);
    }
  }
  for (const [key, l] of prevLinks) if (!nextLinks.has(key)) removeLinks.push({ source: l.source, target: l.target, kind: l.kind });

  if (addNodes.length + updateNodes.length + removeNodes.length + addLinks.length + removeLinks.length === 0) return null;
  return { type: "graph", fromVersion: prev.version, version: next.version, addNodes, updateNodes, removeNodes, addLinks, removeLinks };
}

/** Feldvergleich statt JSON.stringify je Knoten. `ref` ändert sich nur mit Art/Baustelle/Zustand. */
function nodeChanged(a: GraphNode, b: GraphNode): boolean {
  if (a.label !== b.label || a.group !== b.group || a.degree !== b.degree || a.state !== b.state || a.ts !== b.ts || a.archived !== b.archived || a.type !== b.type || (a.lib ?? null) !== (b.lib ?? null)) return true;
  const ra = a.ref as Record<string, unknown>;
  const rb = b.ref as Record<string, unknown>;
  for (const k of Object.keys(rb)) if (ra[k] !== rb[k]) return true;
  return false;
}
