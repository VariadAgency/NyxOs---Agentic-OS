// Reine Filterlogik: aus Graph + Einstellungen wird, welche Knoten/Kanten sichtbar, ausgegraut oder
// ausgeblendet sind. Filter ändern NUR die Sichtbarkeit (kein Neuaufbau der Simulation → kein
// Flackern, Positionen bleiben).
import type { GraphLink, GraphNode } from "@nyxos/shared";
import { colorKeyOf, familyOf } from "./colors";
import type { BrainSettings, SessionStateKey, Visibility } from "./settings";

export interface GraphView {
  hidden: Set<string>;
  dimmed: Set<string>;
  /** Treffer der Suche (null = keine Suche aktiv). */
  matches: Set<string> | null;
  /** Knoten ohne sichtbare Kante (für den Waisen-Ring). */
  orphans: Set<string>;
  visibleCount: number;
}

const DAY = 24 * 60 * 60 * 1000;

function endpointId(end: string | { id?: string | number }): string {
  return typeof end === "string" ? end : String(end.id);
}

/** Kanten können nach dem Start der Simulation Objekte statt IDs tragen (force-graph ersetzt sie). */
export type LinkLike = Omit<GraphLink, "source" | "target"> & { source: string | { id?: string | number }; target: string | { id?: string | number } };

export function computeView(nodes: GraphNode[], links: LinkLike[], s: BrainSettings, now = Date.now()): GraphView {
  const hidden = new Set<string>();
  const dimmed = new Set<string>();
  const cutoff = s.period === "7d" ? now - 7 * DAY : s.period === "30d" ? now - 30 * DAY : null;

  const noteGroups = s.noteGroups ?? {};
  const subGroups = s.subGroups ?? {};
  // Strengste Stufe gewinnt: Art → Notiz-Familie → Untergruppe (zeigen < ausgrauen < ausblenden).
  const stricter = (a: Visibility, b: Visibility | undefined): Visibility => (b === "hide" || a === "hide" ? "hide" : b === "dim" || a === "dim" ? "dim" : "show");
  for (const n of nodes) {
    let vis: Visibility = s.groups[n.type] ?? "show";
    if (n.type === "note" && vis !== "hide") {
      const key = colorKeyOf(n);
      const fam = familyOf(key);
      vis = stricter(vis, noteGroups[fam.slice(5) as keyof typeof noteGroups]);
      if (fam !== key) vis = stricter(vis, subGroups[key]);
    }
    if (vis === "hide" && n.id !== s.focus?.id) {
      hidden.add(n.id);
      continue;
    }
    if (n.state === "unresolved" && !s.showUnresolved) {
      hidden.add(n.id);
      continue;
    }
    if (cutoff !== null && n.ts && Date.parse(n.ts) < cutoff) {
      hidden.add(n.id);
      continue;
    }
    const isSession = n.type === "session" || n.type === "subagent";
    if (isSession && s.period === "archive" && !n.archived) {
      hidden.add(n.id);
      continue;
    }
    if (n.type === "session" && n.state && n.state in s.states && !s.states[n.state as SessionStateKey]) {
      hidden.add(n.id);
      continue;
    }
    if (vis === "dim") dimmed.add(n.id);
  }

  // Eigenes Gehirn (Pro Baustelle / je Session): nur Knoten bis Tiefe N um den Fokus. Gesucht wird
  // nur über sichtbare Knoten; Art-Knoten (Coding, Audit …) werden gezeigt, aber nicht weiter
  // durchlaufen — sonst hinge über „Coding" jede Session der Welt daran.
  const focusId = s.focus && nodes.some((n) => n.id === s.focus?.id) ? s.focus.id : null;
  if (focusId && s.focus) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const adj = new Map<string, string[]>();
    for (const l of links) {
      const a = endpointId(l.source);
      const b = endpointId(l.target);
      if (hidden.has(a) || hidden.has(b)) continue;
      (adj.get(a) ?? adj.set(a, []).get(a))?.push(b);
      (adj.get(b) ?? adj.set(b, []).get(b))?.push(a);
    }
    const focusIsArt = byId.get(focusId)?.type === "art";
    const reach = new Set<string>([focusId]);
    let frontier = [focusId];
    for (let d = 0; d < s.focus.depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (id !== focusId && !focusIsArt && byId.get(id)?.type === "art") continue;
        for (const o of adj.get(id) ?? []) {
          if (reach.has(o)) continue;
          reach.add(o);
          next.push(o);
        }
      }
      frontier = next;
    }
    for (const n of nodes) if (!reach.has(n.id)) hidden.add(n.id);
    hidden.delete(focusId);
    dimmed.delete(focusId);
  }

  // Waisen = keine Kante zu einem sichtbaren Knoten (wie Obsidian: zählt, was gerade zu sehen ist).
  const linked = new Set<string>();
  for (const l of links) {
    const a = endpointId(l.source);
    const b = endpointId(l.target);
    if (hidden.has(a) || hidden.has(b)) continue;
    linked.add(a);
    linked.add(b);
  }
  const orphans = new Set<string>();
  for (const n of nodes) {
    if (hidden.has(n.id) || linked.has(n.id)) continue;
    orphans.add(n.id);
    if (!s.showOrphans) hidden.add(n.id);
  }

  let matches: Set<string> | null = null;
  const q = s.search.trim().toLowerCase();
  if (q) {
    matches = new Set();
    for (const n of nodes) {
      if (hidden.has(n.id)) continue;
      if (n.label.toLowerCase().includes(q) || n.group.toLowerCase().includes(q)) matches.add(n.id);
      else dimmed.add(n.id);
    }
  }

  return { hidden, dimmed, matches, orphans, visibleCount: nodes.length - hidden.size };
}

export function linkHidden(view: GraphView, l: LinkLike): boolean {
  return view.hidden.has(endpointId(l.source)) || view.hidden.has(endpointId(l.target));
}

export function linkDimmed(view: GraphView, l: LinkLike): boolean {
  return view.dimmed.has(endpointId(l.source)) || view.dimmed.has(endpointId(l.target));
}

/** Kanten fürs Zeichnen aufteilen: normal, ausgegraut (ein Ende ausgegraut); ausgeblendete fallen weg. */
export function splitLinks<L extends LinkLike>(view: GraphView, links: L[]): { base: L[]; dim: L[] } {
  const base: L[] = [];
  const dim: L[] = [];
  for (const l of links) {
    if (linkHidden(view, l)) continue;
    (linkDimmed(view, l) ? dim : base).push(l);
  }
  return { base, dim };
}

export { endpointId };
