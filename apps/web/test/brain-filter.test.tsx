import type { GraphDeltaMessage, GraphLink, GraphNode } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { applyDelta, type LiveGraph } from "../src/features/brain/graphData";
import { computeView } from "../src/features/brain/filter";
import { defaultSettings, loadSettings, saveSettings, type BrainSettings } from "../src/features/brain/settings";

const NOW = Date.parse("2026-09-25T03:00:00.000Z");
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type: "note",
  label: id,
  group: "g",
  degree: 1,
  ref: { kind: "note", path: id },
  ...over,
});
const link = (source: string, target: string, kind: GraphLink["kind"] = "wikilink"): GraphLink => ({ source, target, kind, weight: 1 });

const nodes: GraphNode[] = [
  node("n1", { label: "Gehirn Plan", ts: "2026-09-24T10:00:00.000Z" }),
  node("n2", { label: "Alt", ts: "2026-06-01T10:00:00.000Z" }),
  node("n3", { label: "Waise", degree: 0 }),
  node("ghost", { label: "Fehlt", state: "unresolved", ref: { kind: "note", path: null } }),
  node("s1", { type: "session", label: "Session läuft", state: "running", ts: "2026-09-25T02:00:00.000Z", archived: false }),
  node("s2", { type: "session", label: "Session zu", state: "closed", ts: "2026-09-20T02:00:00.000Z", archived: true }),
  node("f1", { type: "file", label: "a.ts" }),
];
const links: GraphLink[] = [link("n1", "n2"), link("n1", "ghost"), link("s1", "n1", "note_session"), link("s2", "n2", "note_session"), link("s1", "f1", "touched_file")];

const settings = (over: Partial<BrainSettings> = {}): BrainSettings => ({ ...defaultSettings(), ...over });

describe("Gehirn: Filterlogik", () => {
  it("Vorgabe: alles sichtbar außer Dateien", () => {
    const v = computeView(nodes, links, settings(), NOW);
    expect([...v.hidden]).toEqual(["f1"]);
    expect(v.dimmed.size).toBe(0);
    expect(v.visibleCount).toBe(6);
    expect(v.orphans).toEqual(new Set(["n3"]));
  });

  it("je Knotenart zeigen · ausgrauen · ausblenden", () => {
    const base = settings();
    const dim = computeView(nodes, links, { ...base, groups: { ...base.groups, session: "dim" } }, NOW);
    expect(dim.dimmed).toEqual(new Set(["s1", "s2"]));
    expect(dim.hidden.has("s1")).toBe(false);
    const hide = computeView(nodes, links, { ...base, groups: { ...base.groups, session: "hide" } }, NOW);
    expect(hide.hidden.has("s1") && hide.hidden.has("s2")).toBe(true);
    const files = computeView(nodes, links, { ...base, groups: { ...base.groups, file: "show" } }, NOW);
    expect(files.hidden.has("f1")).toBe(false);
  });

  it("Waisen aus blendet Knoten ohne sichtbare Kante aus — auch solche, die erst durch Filter verwaisen", () => {
    const base = settings({ showOrphans: false });
    const v = computeView(nodes, links, base, NOW);
    expect(v.hidden.has("n3")).toBe(true);
    const noNotes = computeView(nodes, links, { ...base, groups: { ...base.groups, note: "hide" } }, NOW);
    expect(noNotes.hidden.has("s2")).toBe(true); // hing nur an einer Notiz
  });

  it("Suche graut Nicht-Treffer aus, Treffer bleiben hell", () => {
    const v = computeView(nodes, links, settings({ search: "gehirn" }), NOW);
    expect(v.matches).toEqual(new Set(["n1"]));
    expect(v.dimmed.has("n2")).toBe(true);
    expect(v.dimmed.has("n1")).toBe(false);
  });

  it("Zeitraum und „nur Archiv“", () => {
    const week = computeView(nodes, links, settings({ period: "7d" }), NOW);
    expect(week.hidden.has("n2")).toBe(true);
    expect(week.hidden.has("n1")).toBe(false);
    expect(week.hidden.has("n3")).toBe(false); // ohne Zeit bleibt
    const archive = computeView(nodes, links, settings({ period: "archive" }), NOW);
    expect(archive.hidden.has("s1")).toBe(true);
    expect(archive.hidden.has("s2")).toBe(false);
  });

  it("Zustand und nicht erstellte Notizen", () => {
    const base = settings();
    const v = computeView(nodes, links, { ...base, states: { ...base.states, running: false }, showUnresolved: false }, NOW);
    expect(v.hidden.has("s1")).toBe(true);
    expect(v.hidden.has("ghost")).toBe(true);
  });

  it("Einstellungen werden gemerkt, Suche nicht", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveSettings(settings({ search: "x", arrows: true, forces: { center: 0.2, repel: 5, link: 0.5, distance: 100, drift: 0.5 } }), storage);
    const back = loadSettings(storage);
    expect(back.arrows).toBe(true);
    expect(back.forces.repel).toBe(5);
    expect(back.search).toBe("");
    expect(loadSettings({ getItem: () => "{kaputt" })).toEqual(defaultSettings());
  });
});

describe("Gehirn: Live-Delta anwenden", () => {
  const start = (): LiveGraph => ({ version: 3, nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) });
  const delta = (over: Partial<GraphDeltaMessage>): GraphDeltaMessage => ({ type: "graph", fromVersion: 3, version: 4, addNodes: [], updateNodes: [], removeNodes: [], addLinks: [], removeLinks: [], ...over });

  it("fügt hinzu, aktualisiert (Positionen bleiben), entfernt samt Kanten", () => {
    const g = start();
    const n1 = g.nodes.find((n) => n.id === "n1") as GraphNode & { x?: number; y?: number };
    n1.x = 10;
    n1.y = 20;
    const res = applyDelta(g, delta({ addNodes: [node("n9", { label: "Neu" })], addLinks: [link("n9", "n1")], updateNodes: [{ ...nodes[0], label: "Umbenannt", degree: 3 } as GraphNode], removeNodes: ["n2"] }));
    expect(res.status).toBe("applied");
    expect(g.version).toBe(4);
    const upd = g.nodes.find((n) => n.id === "n1") as GraphNode & { x?: number };
    expect(upd.label).toBe("Umbenannt");
    expect(upd.x).toBe(10);
    expect(upd).toBe(n1); // dasselbe Objekt (force-graph hält Referenzen)
    expect(g.nodes.some((n) => n.id === "n2")).toBe(false);
    expect(g.links.some((l) => l.source === "n2" || l.target === "n2")).toBe(false);
    const added = g.nodes.find((n) => n.id === "n9") as GraphNode & { x?: number; y?: number };
    expect(added.x).toBeCloseTo(10, -1); // startet neben seinem Nachbarn statt in der Mitte
  });

  it("Versionslücke → Neu laden statt falsch anwenden", () => {
    const g = start();
    expect(applyDelta(g, delta({ fromVersion: 7, version: 8 })).status).toBe("reload");
    expect(applyDelta(g, delta({ fromVersion: 1, version: 2 })).status).toBe("stale");
  });
});
