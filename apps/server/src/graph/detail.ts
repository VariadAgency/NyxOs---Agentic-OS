// Info-Karte zu einem Knoten (`GET /api/graph/node/:id`). Klein und begrenzt: Fakten +
// höchstens zwei Textauszüge (je ≤ GRAPH_EXCERPT_MAX Zeichen). Notiz-Text kommt nur als Anfang
// (`vault_notes.excerpt`, von der Brücke gekürzt) — der Volltext verlässt den Rechner weiterhin nicht.
import { artLabel, GRAPH_EXCERPT_MAX, markdownToText, pick, sessionLabel, t, type GraphNode, type GraphNodeDetail, dateTimeFormat, numberFormat } from "@nyxos/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { entries, gitCommits, searchDocs, sessionEvents, sessions, vaultNotes } from "../db/schema.js";
import type { BuiltGraph } from "./service.js";

const STATE_LABELS: Record<string, string> = {
  running: "läuft",
  waiting: "wartet",
  idle: "ruht",
  crashed: "abgestürzt",
  closed: "geschlossen",
  ended: "beendet",
  unresolved: "noch nicht erstellt",
};

const TOOL_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex" };

const dateFmt = () => dateTimeFormat({ dateStyle: "medium", timeStyle: "short" });
function when(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : dateFmt().format(d);
}

/** Nur so viel Text wird umgewandelt, wie der Auszug höchstens braucht (Markdown-Zeichen fallen weg,
 * darum mit Reserve). Chat-Nachrichten können Megabytes groß sein — ganz umgewandelt blockierte das
 * den Server sekundenlang. */
const CLIP_SOURCE_MAX = GRAPH_EXCERPT_MAX * 8;

/** Markdown aus Chat/Beschreibung als einfacher Text (keine Backticks, Sternchen, Striche), gekürzt. */
export const clipText = (text: string | null | undefined): string | null => clip(text ? markdownToText(text.slice(0, CLIP_SOURCE_MAX)) : null);

/** Kürzt an einer Wortgrenze auf höchstens `max` Zeichen (inklusive „…"). Zeilenumbrüche bleiben
 * (Aufzählungen in der Info-Karte), Leerzeichen/Tabs und Leerzeilen-Folgen werden zusammengezogen. */
export function clip(text: string | null | undefined, max = GRAPH_EXCERPT_MAX): string | null {
  const out = (text ?? "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!out) return null;
  if (out.length <= max) return out;
  const cut = out.slice(0, max - 1);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function promptText(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.text === "string" && d.text.trim()) return d.text;
  if (typeof d.command === "string" && d.command.trim()) return `${d.command} ${typeof d.args === "string" ? d.args : ""}`.trim();
  return null;
}

const push = (facts: Array<[string, string]>, label: string, value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === "") return;
  // Beschriftung ist der deutsche Text; übersetzt wird beim Bauen der Karte.
  facts.push([t(label), String(value)]);
};

async function sessionDetail(db: Db, node: GraphNode, key: string): Promise<GraphNodeDetail> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, key)).limit(1);
  const facts: Array<[string, string]> = [];
  if (!row) return { id: node.id, type: node.type, title: node.label, facts, excerpt: null, extra: null, tags: [] };
  // Sub-Agent aus der Liste einer Session (eigener Knoten ohne eigene Verlaufsdatei)
  if (node.id.startsWith("subagent:")) {
    push(facts, "Gehört zu", sessionLabel({ ...row, baustelleLabel: row.categoryBaustelleLabel }));
    push(facts, "Werkzeug", TOOL_LABELS[row.tool] ?? row.tool);
    push(facts, "Zuletzt", when(row.lastActivityAt));
    return { id: node.id, type: node.type, title: node.label, facts, excerpt: null, extra: null, tags: [] };
  }
  push(facts, "Werkzeug", TOOL_LABELS[row.tool] ?? row.tool);
  push(facts, "Zustand", row.closedAt ? t("geschlossen") : row.state ? (STATE_LABELS[row.state] ? t(STATE_LABELS[row.state] as string) : row.state) : null);
  push(facts, "Art", row.categoryArt ? t(artLabel(row.categoryArt)) : null);
  push(facts, "Baustelle", row.categoryBaustelleLabel);
  push(facts, "Zweig", row.gitBranch);
  push(facts, pick({ de: "Ordner", en: "Folder" }), row.cwd);
  push(facts, "Modell", row.models.join(", ") || null);
  push(facts, "Tokens", row.tokensTotal > 0 ? numberFormat().format(row.tokensTotal) : null);
  push(facts, "Gestartet", when(row.startedAt));
  push(facts, "Zuletzt", when(row.lastActivityAt));

  const [first] = await db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionKey, key), eq(sessionEvents.kind, "prompt")))
    .orderBy(asc(sessionEvents.ts))
    .limit(1);
  // Letzte Nachricht: letzter Eintrag im Volltext-Index (Chat), sonst die letzte Eingabe.
  const [lastChat] = await db
    .select({ text: searchDocs.text })
    .from(searchDocs)
    .where(and(eq(searchDocs.sessionKey, key), eq(searchDocs.field, "chat")))
    .orderBy(desc(searchDocs.position), asc(searchDocs.id))
    .limit(1);
  let last = clipText(lastChat?.text);
  if (!last) {
    const [lastPrompt] = await db
      .select({ data: sessionEvents.data })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionKey, key), eq(sessionEvents.kind, "prompt")))
      .orderBy(desc(sessionEvents.ts))
      .limit(1);
    last = clipText(promptText(lastPrompt?.data));
  }
  const auftrag = clipText(promptText(first?.data));
  return {
    id: node.id,
    type: node.type,
    title: row.title?.trim() || node.label,
    facts,
    excerpt: last ? { label: t("Letzte Nachricht"), text: last } : null,
    extra: auftrag && auftrag !== last ? { label: t("Auftrag"), text: auftrag } : null,
    tags: [],
  };
}

async function noteDetail(db: Db, node: GraphNode, path: string): Promise<GraphNodeDetail> {
  const [row] = await db.select().from(vaultNotes).where(eq(vaultNotes.path, path)).orderBy(desc(vaultNotes.updatedAt)).limit(1);
  const facts: Array<[string, string]> = [];
  if (!row) return { id: node.id, type: node.type, title: node.label, facts, excerpt: null, extra: null, tags: [] };
  push(facts, pick({ de: "Ordner", en: "Folder" }), row.folder || t("(Wurzel)"));
  push(facts, "Bibliothek", node.lib ?? null);
  push(facts, "Quelldatei", row.sourcePath);
  push(facts, "Geändert", when(row.mtime));
  push(facts, "Verbindungen", node.degree);
  const text = clip(row.excerpt);
  return { id: node.id, type: node.type, title: row.heading?.trim() || row.title, facts, excerpt: text ? { label: t("Notiz-Anfang"), text } : null, extra: null, tags: row.tags.slice(0, 12) };
}

async function entryDetail(db: Db, node: GraphNode, id: number): Promise<GraphNodeDetail | null> {
  const [row] = await db.select().from(entries).where(eq(entries.id, id)).limit(1);
  if (!row) return null;
  const facts: Array<[string, string]> = [];
  push(facts, "Stand", row.stage);
  push(facts, "Priorität", row.priority);
  push(facts, "Baustelle", row.baustelleLabel);
  push(facts, "Fortschritt", row.progressTotalWeight > 0 ? `${row.progressPercent} %` : null);
  push(facts, "Angelegt", when(row.createdAt));
  const text = clipText(row.description);
  return { id: node.id, type: node.type, title: row.title, facts, excerpt: text ? { label: t("Beschreibung"), text } : null, extra: null, tags: [] };
}

async function commitDetail(db: Db, node: GraphNode, repo: string, sha: string): Promise<GraphNodeDetail> {
  const [row] = await db
    .select()
    .from(gitCommits)
    .where(and(eq(gitCommits.repoId, repo), eq(gitCommits.sha, sha)))
    .limit(1);
  const facts: Array<[string, string]> = [];
  push(facts, "Commit", sha.slice(0, 10));
  push(facts, "Ablage", repo);
  push(facts, "Zweig", row?.branch);
  push(facts, "Zeit", when(row?.authorDate));
  const subject = clipText(row?.subject);
  return { id: node.id, type: node.type, title: node.label, facts, excerpt: subject ? { label: t("Nachricht"), text: subject } : null, extra: null, tags: [] };
}

function plainDetail(node: GraphNode): GraphNodeDetail {
  const facts: Array<[string, string]> = [];
  if (node.ref.kind === "file") push(facts, "Pfad", node.ref.path);
  else if (node.ref.kind === "branch") push(facts, "Ablage", node.ref.repo);
  push(facts, "Zustand", node.state ? (STATE_LABELS[node.state] ? t(STATE_LABELS[node.state] as string) : node.state) : null);
  push(facts, "Zuletzt", when(node.ts));
  push(facts, "Verbindungen", node.degree);
  return { id: node.id, type: node.type, title: node.label, facts, excerpt: null, extra: null, tags: [] };
}

/** Info-Karte für einen Knoten des Graphen (null = unbekannt). */
export async function nodeDetail(db: Db, g: BuiltGraph, id: string): Promise<GraphNodeDetail | null> {
  const node = g.byId.get(id);
  if (!node) return null;
  const r = node.ref;
  switch (r.kind) {
    case "session":
      return sessionDetail(db, node, r.sessionKey);
    case "note":
      if (!r.path) return { ...plainDetail(node), facts: [[t("Zustand"), t("noch nicht erstellt — nur verlinkt")]] };
      return noteDetail(db, node, r.path);
    case "entry": {
      const n = Number(r.id);
      return Number.isInteger(n) ? ((await entryDetail(db, node, n)) ?? plainDetail(node)) : plainDetail(node);
    }
    case "commit":
      return commitDetail(db, node, r.repo, r.sha);
    default:
      return plainDetail(node);
  }
}
