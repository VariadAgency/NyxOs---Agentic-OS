import type { GraphDeltaMessage, GraphLocalResponse, GraphResponse, IngestItem, SessionSummary, VaultIngest, VaultNote } from "@nyxos/shared";
import { emptyTokens } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { createResolver } from "../src/graph/wikilinks.js";
import { setup } from "./helpers.js";

/**
 * PG „Gehirn": Graph-API (`/api/graph`, `/api/graph/local/:id`), Vault-Einlesen (`/ingest/vault`)
 * und Live-Deltas. Alles mit synthetischen Daten (kein echter Vault im Repo).
 */

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: null,
  title: null,
  titleSource: null,
  startedAt: "2026-09-24T10:00:00.000Z",
  lastActivityAt: "2026-09-24T10:00:00.000Z",
  models: [],
  tokens: emptyTokens(),
  toolCalls: {},
  filesWritten: [],
  filesRead: [],
  subagents: [],
  gitBranch: null,
  cliVersion: null,
  eventCount: 0,
  parseErrors: 0,
  limits: null,
  lastUsage: null,
  lastUsageModel: null,
  modelContextWindow: null,
  ...over,
});
const summaryItem = (s: SessionSummary): IngestItem => ({ type: "summary", summary: s });

const ROOT = "/Users/test/Vault";
const note = (path: string, over: Partial<VaultNote> = {}): VaultNote => {
  const parts = path.split("/");
  const file = parts.pop() ?? path;
  return {
    path,
    title: file.replace(/\.md$/, ""),
    heading: null,
    folder: parts.join("/"),
    tags: [],
    links: [],
    mentions: [],
    mtime: "2026-09-20T10:00:00.000Z",
    size: 100,
    ...over,
  };
};
const vault = (notes: VaultNote[], over: Partial<VaultIngest> = {}): VaultIngest => ({ root: ROOT, syncId: "s1", mode: "full", notes, deleted: [], done: true, ...over });

const UUID_A = "11111111-2222-4333-8444-555555555555";

async function seeded() {
  const t = await setup();
  await t.post("/ingest/events", {
    items: [
      summaryItem(summary({ sessionId: UUID_A, title: "Gehirn bauen", filesWritten: ["/repo/a.ts", "/repo/b.ts", `${ROOT}/01 Sessions/Log.md`] })),
      summaryItem(summary({ sessionId: "zwei", title: "Zweite", filesWritten: ["/repo/a.ts", "/repo/b.ts"] })),
      summaryItem(summary({ sessionId: "drei", title: "Dritte", filesWritten: ["/repo/b.ts"] })),
      summaryItem(summary({ sessionId: "kind", title: "Kind", parentSessionId: UUID_A })),
      summaryItem(summary({ sessionId: "sub-owner", title: "Mit Sub-Agent", subagents: [{ id: "agent-1", name: "Reviewer", type: "general-purpose" }] })),
    ],
  });
  const res = await t.post(
    "/ingest/vault",
    vault([
      note("Index.md", { links: ["Features/Graph", "Log", "Fehlt"] }),
      note("Features/Graph.md", { links: ["Index"] }),
      note("01 Sessions/Log.md", { mentions: ["22222222-3333-4444-8555-666666666666"] }),
      note("Notizen/Nennt.md", { mentions: [UUID_A] }),
      note("Allein.md"),
    ]),
  );
  expect(res.status).toBe(200);
  return t;
}

async function getGraph(t: Awaited<ReturnType<typeof setup>>, query = ""): Promise<GraphResponse> {
  const res = await t.app.request(`/api/graph${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as GraphResponse;
}

const hasLink = (g: GraphResponse, a: string, b: string, kind: string) =>
  g.links.some((l) => l.kind === kind && ((l.source === a && l.target === b) || (l.source === b && l.target === a)));

describe("Wiki-Link-Auflösung wie Obsidian", () => {
  const r = createResolver(["Index.md", "Features/Graph.md", "Archiv/Graph.md", "a/b/Tief.md", "Groß.md"]);
  it("löst Dateinamen, Pfade, Groß-/Kleinschreibung und .md-Endung auf", () => {
    expect(r("Index", "x.md")).toBe("Index.md");
    expect(r("index.md", "x.md")).toBe("Index.md");
    expect(r("Features/Graph", "x.md")).toBe("Features/Graph.md");
    expect(r("b/Tief", "x.md")).toBe("a/b/Tief.md");
    expect(r("groß", "x.md")).toBe("Groß.md");
  });
  it("bevorzugt bei gleichem Namen den Ordner der verlinkenden Notiz, sonst den kürzesten Pfad", () => {
    expect(r("Graph", "Archiv/Start.md")).toBe("Archiv/Graph.md");
    expect(r("Graph", "Features/Start.md")).toBe("Features/Graph.md");
    expect(r("Graph", "Anders/Start.md")).toBe("Archiv/Graph.md");
  });
  it("liefert null für unbekannte Ziele", () => {
    expect(r("Gibt es nicht", "x.md")).toBeNull();
  });
});

describe("POST /ingest/vault", () => {
  it("verlangt das Brücken-Token und ein gültiges Paket", async () => {
    const t = await setup();
    expect((await t.post("/ingest/vault", vault([]), {})).status).toBe(401);
    expect((await t.post("/ingest/vault", { root: ROOT })).status).toBe(400);
  });

  it("Vollabgleich in Teilen löscht erst nach dem letzten Teil verschwundene Notizen; Delta ändert und löscht", async () => {
    const t = await setup();
    await t.post("/ingest/vault", vault([note("A.md"), note("B.md"), note("C.md")], { syncId: "s1" }));
    let g = await getGraph(t, "?types=note");
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["note:A.md", "note:B.md", "note:C.md"]);

    // Zweiter Vollabgleich in zwei Teilen: C.md ist weg.
    await t.post("/ingest/vault", vault([note("A.md")], { syncId: "s2", done: false }));
    g = await getGraph(t, "?types=note");
    expect(g.nodes).toHaveLength(3); // noch nicht gelöscht
    await t.post("/ingest/vault", vault([note("B.md", { links: ["A"] })], { syncId: "s2", done: true }));
    g = await getGraph(t, "?types=note");
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["note:A.md", "note:B.md"]);
    expect(hasLink(g, "note:A.md", "note:B.md", "wikilink")).toBe(true);

    // Delta: neue Notiz D verlinkt A, B wird gelöscht.
    await t.post("/ingest/vault", vault([note("D.md", { links: ["A"] })], { syncId: "s2", mode: "delta", deleted: ["B.md"] }));
    g = await getGraph(t, "?types=note");
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["note:A.md", "note:D.md"]);
    expect(hasLink(g, "note:A.md", "note:D.md", "wikilink")).toBe(true);
    expect(hasLink(g, "note:A.md", "note:B.md", "wikilink")).toBe(false);
  });
});

describe("GET /api/graph", () => {
  it("baut Knoten und Kanten aus Sessions und Vault mit echten Verknüpfungen", async () => {
    const t = await seeded();
    const g = await getGraph(t);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const a = `session:claude:${UUID_A}`;

    // Sessions, Sub-Agenten (Codex-artige Kind-Session + Claude-Sub-Agent aus `subagents`), Art
    expect(byId.get(a)?.type).toBe("session");
    expect(byId.get(a)?.label).toBe("Gehirn bauen");
    expect(byId.get("session:claude:kind")?.type).toBe("subagent");
    expect(hasLink(g, a, "session:claude:kind", "parent")).toBe(true);
    const sub = g.nodes.find((n) => n.type === "subagent" && n.label === "Reviewer");
    expect(sub).toBeDefined();
    expect(hasLink(g, "session:claude:sub-owner", sub?.id ?? "", "parent")).toBe(true);
    expect(g.nodes.some((n) => n.type === "art")).toBe(true);
    expect(hasLink(g, a, `art:${byId.get(a)?.group}`, "art")).toBe(true);

    // Gemeinsame Dateien: A+zwei teilen 2 Dateien, A+drei 1, zwei+drei 1
    const shared = g.links.find((l) => l.kind === "shared_files" && [l.source, l.target].sort().join() === [a, "session:claude:zwei"].sort().join());
    expect(shared?.weight).toBe(2);
    expect(hasLink(g, a, "session:claude:drei", "shared_files")).toBe(true);

    // Vault: Wiki-Links, unaufgelöstes Ziel, Session-Bezug per Nennung und per geschriebener Datei
    expect(hasLink(g, "note:Index.md", "note:Features/Graph.md", "wikilink")).toBe(true);
    expect(hasLink(g, "note:Index.md", "note:01 Sessions/Log.md", "wikilink")).toBe(true);
    const ghost = g.nodes.find((n) => n.label === "Fehlt");
    expect(ghost?.state).toBe("unresolved");
    expect(hasLink(g, "note:Index.md", ghost?.id ?? "", "wikilink")).toBe(true);
    expect(hasLink(g, "note:Notizen/Nennt.md", a, "note_session")).toBe(true);
    expect(hasLink(g, "note:01 Sessions/Log.md", a, "note_session")).toBe(true);

    // Grad = Anzahl unterschiedlicher Kanten; Waise = Grad 0
    expect(byId.get("note:Features/Graph.md")?.degree).toBe(1); // Index↔Graph in beide Richtungen = eine Kante
    expect(byId.get("note:Allein.md")?.degree).toBe(0);
    expect(g.stats.orphans).toBeGreaterThanOrEqual(1);
    expect(g.stats.sources).toEqual(expect.arrayContaining(["sessions", "vault"]));

    // Keine Kante zeigt ins Leere
    for (const l of g.links) {
      expect(byId.has(l.source)).toBe(true);
      expect(byId.has(l.target)).toBe(true);
    }
  });

  it("Dateien nur mit include=files; types und since filtern", async () => {
    const t = await seeded();
    const without = await getGraph(t);
    expect(without.nodes.some((n) => n.type === "file")).toBe(false);
    const withFiles = await getGraph(t, "?include=files");
    expect(withFiles.nodes.some((n) => n.id === "file:/repo/a.ts")).toBe(true);
    expect(hasLink(withFiles, `session:claude:${UUID_A}`, "file:/repo/a.ts", "touched_file")).toBe(true);
    // Grad der Session zählt die Datei-Kanten nicht (Größe bleibt beim Umschalten stabil)
    const deg = (g: GraphResponse) => g.nodes.find((n) => n.id === `session:claude:${UUID_A}`)?.degree;
    expect(deg(withFiles)).toBe(deg(without));

    const onlyNotes = await getGraph(t, "?types=note");
    expect(onlyNotes.nodes.every((n) => n.type === "note")).toBe(true);
    expect(onlyNotes.links.every((l) => l.kind === "wikilink")).toBe(true);

    const since = await getGraph(t, "?since=2026-09-21T00:00:00.000Z&types=session,note");
    expect(since.nodes.some((n) => n.type === "note")).toBe(false); // Notizen haben mtime 20.09.
    expect(since.nodes.some((n) => n.type === "session")).toBe(true);

    expect((await t.app.request("/api/graph?since=kaputt")).status).toBe(400);
    expect((await t.app.request("/api/graph?types=quatsch")).status).toBe(400);
  });

  it("Antwort kommt aus dem Cache (Version stabil, bis sich etwas ändert)", async () => {
    const t = await seeded();
    const a = await getGraph(t);
    const b = await getGraph(t);
    expect(b.version).toBe(a.version);
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "neu", title: "Neu" }))] });
    const c = await getGraph(t);
    expect(c.version).toBeGreaterThan(a.version);
    expect(c.nodes.some((n) => n.id === "session:claude:neu")).toBe(true);
  });
});

describe("Grenzfälle", () => {
  it("eine „heiße“ Datei, die fast jede Session schreibt (memory.md), erzeugt keine Kanten-Clique", async () => {
    const t = await setup();
    const items = Array.from({ length: 10 }, (_, i) =>
      summaryItem(summary({ sessionId: `s${i}`, title: `S${i}`, filesWritten: i < 2 ? ["/repo/memory.md", "/repo/x.ts"] : ["/repo/memory.md"] })),
    );
    await t.post("/ingest/events", { items });
    const g = await getGraph(t);
    const shared = g.links.filter((l) => l.kind === "shared_files");
    expect(shared).toHaveLength(1); // nur s0↔s1 über x.ts
    expect(shared[0]?.weight).toBe(1);
    // Grad zählt Nachbarn, nicht Kanten-Arten doppelt
    expect(g.nodes.find((n) => n.id === "session:claude:s5")?.degree).toBe(1); // nur die Art
  });

  it("Vollabgleich eines zweiten Vaults löscht die Notizen des ersten nicht", async () => {
    const t = await setup();
    await t.post("/ingest/vault", vault([note("A.md")], { root: "/vault/eins", syncId: "a1" }));
    await t.post("/ingest/vault", vault([note("B.md")], { root: "/vault/zwei", syncId: "b1" }));
    const g = await getGraph(t, "?types=note");
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["note:A.md", "note:B.md"]);
  });

  it("Zeitraum vergleicht Zeitpunkte, nicht Text (gleicher Tag), und liefert ISO-Zeiten", async () => {
    const t = await setup();
    await t.post("/ingest/vault", vault([note("Heute.md", { mtime: "2026-09-21T10:00:00.000Z" })]));
    const g = await getGraph(t, "?types=note&since=2026-09-21T09:00:00.000Z");
    expect(g.nodes.map((n) => n.id)).toEqual(["note:Heute.md"]);
    expect(g.nodes[0]?.ts).toBe("2026-09-21T10:00:00.000Z");
  });
});

describe("GET /api/graph/local/:nodeId", () => {
  it("liefert Nachbarschaft in Tiefe 1–3, nimmt auch die nackte Session-ID", async () => {
    const t = await seeded();
    const d1 = (await (await t.app.request(`/api/graph/local/${encodeURIComponent("note:Features/Graph.md")}?depth=1`)).json()) as GraphLocalResponse;
    expect(d1.center).toBe("note:Features/Graph.md");
    expect(d1.nodes.map((n) => n.id).sort()).toEqual(["note:Features/Graph.md", "note:Index.md"]);
    const d2 = (await (await t.app.request(`/api/graph/local/${encodeURIComponent("note:Features/Graph.md")}?depth=2`)).json()) as GraphLocalResponse;
    expect(d2.nodes.length).toBeGreaterThan(d1.nodes.length);
    expect(d2.nodes.some((n) => n.id === "note:01 Sessions/Log.md")).toBe(true);
    const d3 = (await (await t.app.request(`/api/graph/local/${encodeURIComponent("note:Features/Graph.md")}?depth=3`)).json()) as GraphLocalResponse;
    expect(d3.nodes.some((n) => n.id === `session:claude:${UUID_A}`)).toBe(true);
    for (const l of d3.links) {
      expect(d3.nodes.some((n) => n.id === l.source)).toBe(true);
      expect(d3.nodes.some((n) => n.id === l.target)).toBe(true);
    }

    const bare = await t.app.request(`/api/graph/local/${UUID_A}?depth=1`);
    expect(bare.status).toBe(200);
    expect(((await bare.json()) as GraphLocalResponse).center).toBe(`session:claude:${UUID_A}`);

    expect((await t.app.request(`/api/graph/local/${UUID_A}?depth=4`)).status).toBe(400);
    expect((await t.app.request(`/api/graph/local/unbekannt`)).status).toBe(404);
  });
});

describe("Live-Delta über /live", () => {
  it("neue Session kommt als kleines Delta (nur neue Knoten/Kanten), nicht als ganzer Graph", async () => {
    const t = await seeded();
    const first = await getGraph(t);
    const messages: unknown[] = [];
    t.hub.add({ send: (d) => messages.push(JSON.parse(d)) });
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "live-neu", title: "Live", filesWritten: ["/repo/a.ts"] }))] });
    const deadline = Date.now() + 2000;
    let delta: GraphDeltaMessage | undefined;
    while (Date.now() < deadline && !delta) {
      await new Promise((r) => setTimeout(r, 25));
      delta = messages.find((m): m is GraphDeltaMessage => (m as { type?: string }).type === "graph");
    }
    expect(delta).toBeDefined();
    expect(delta?.fromVersion).toBe(first.version);
    expect(delta?.addNodes.map((n) => n.id)).toContain("session:claude:live-neu");
    expect(delta?.addNodes.length).toBeLessThan(5);
    expect(delta?.addLinks.some((l) => l.kind === "shared_files")).toBe(true);
    expect(delta?.removeNodes).toEqual([]);
  });
});
