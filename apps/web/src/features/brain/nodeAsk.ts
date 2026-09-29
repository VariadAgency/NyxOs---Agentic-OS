// Daten für den Nyx-Knopf in der Gehirn-Detailkarte. Nyx bekommt, was auf der Karte steht (Art, Titel, Pfad,
// Auszug, Verbindungen, Zeitpunkt) – gekürzt, damit die Frage klein bleibt und Nyx nichts erfinden muss.
import { markdownToText, t, type GraphNode, type GraphNodeDetail, type GraphNodeType } from "@nyxos/shared";
import { endpointId } from "./filter";
import type { LiveGraph } from "./graphData";

export interface Neighbour {
  node: GraphNode;
  kind: string;
}

/** Höchstens so viele Verbindungen gehen an Nyx (die mit den meisten eigenen Verbindungen zuerst). */
export const ASK_NEIGHBOURS_MAX = 12;
const EXCERPT_MAX = 500;

/** Einzahl für Nyx („Heatmap (Notiz)“ statt „(Obsidian-Notizen)“); übersetzt beim Aufruf über `t()`. */
const TYPE_ONE: Record<GraphNodeType, string> = {
  session: "Session",
  subagent: "Sub-Agent",
  baustelle: "Baustelle",
  art: "Art",
  file: "Datei",
  note: "Notiz",
  bug: "Bug",
  task: "Aufgabe",
  idea: "Idee",
  finding: "Audit-Befund",
  decision: "Entscheidung",
  question: "Frage",
  problem: "Problem",
  commit: "Commit",
  branch: "Zweig",
};
const PATH_MAX = 200;

/** Nachbarn eines Knotens, die wichtigsten (meiste Verbindungen) zuerst. */
export function neighboursOf(node: GraphNode, graph: Pick<LiveGraph, "nodes" | "links">): Neighbour[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Neighbour[] = [];
  for (const l of graph.links) {
    const a = endpointId(l.source);
    const b = endpointId(l.target);
    const other = a === node.id ? b : b === node.id ? a : null;
    const n = other ? byId.get(other) : undefined;
    if (n) out.push({ node: n, kind: l.kind });
  }
  return out.sort((x, y) => y.node.degree - x.node.degree);
}

export function nodePath(node: GraphNode): string | null {
  if (node.ref.kind === "note" || node.ref.kind === "file") return node.ref.path ?? null;
  return null;
}

/** Fakten vom Server können schon übersetzt sein. */
const isFact = (k: string, de: string) => k === de || k === t(de);

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function nodeAskQuestion(node: GraphNode, detail?: GraphNodeDetail | null): string {
  const name = detail?.title ?? node.label;
  return t("Was ist „{name}“ und wie hängt es zusammen? Sag kurz, was es ist, wofür es steht und was die wichtigsten Verbindungen sind.", { name });
}

/** Die Daten zur Frage – eine Zeile pro Angabe, Verbindungen als „Name (Art)“. */
export function nodeAskFacts(node: GraphNode, detail: GraphNodeDetail | null | undefined, neighbours: Neighbour[] | null, when?: string | null): string {
  const lines: string[] = [];
  lines.push(`${t("Art")}: ${t(TYPE_ONE[node.type])}`);
  lines.push(`${t("Titel")}: ${detail?.title ?? node.label}`);
  const path = nodePath(node);
  if (path) lines.push(`${t("Pfad")}: ${cut(path, PATH_MAX)}`);
  for (const [k, v] of detail?.facts ?? []) {
    if (isFact(k, "Pfad") && path) continue;
    lines.push(`${k}: ${cut(v, PATH_MAX)}`);
  }
  if (when && !detail?.facts.some(([k]) => isFact(k, "Zuletzt"))) lines.push(`${t("Zuletzt")}: ${when}`);
  if (detail?.tags.length) lines.push(`${t("Schlagworte")}: ${detail.tags.slice(0, 10).join(", ")}`);
  for (const x of [detail?.excerpt, detail?.extra]) {
    if (x) lines.push(`${x.label}: ${cut(markdownToText(x.text).replace(/\s+/g, " ").trim(), EXCERPT_MAX)}`);
  }
  if (neighbours) {
    const shown = neighbours.slice(0, ASK_NEIGHBOURS_MAX).map(({ node: n }) => `${cut(n.label, 80)} (${t(TYPE_ONE[n.type])})`);
    const more = neighbours.length - shown.length;
    lines.push(neighbours.length === 0 ? t("Verbindungen: keine") : `${t("Verbindungen ({n})", { n: neighbours.length })}: ${shown.join("; ")}${more > 0 ? ` ${t("… und {n} weitere", { n: more })}` : ""}`);
  } else {
    lines.push(`${t("Verbindungen")}: ${node.degree}`);
  }
  return lines.join("\n");
}
