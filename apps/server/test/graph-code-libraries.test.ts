// Gehirn-Graph: Code-Notizen tragen ihre Quelldatei (Frontmatter `path`) → der Graph
// kennt die Fremd-Bibliothek (`lib`), damit das Gehirn sie eigens einfärbt. Info-Karte liefert Text
// statt rohem Markdown (Zeilen bleiben erhalten).
import { emptyTokens, GRAPH_EXCERPT_MAX, type GraphNodeDetail, type GraphResponse, type SessionSummary, type VaultNote } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries, sessionEvents } from "../src/db/schema.js";
import { libPackage } from "../src/graph/sources/vault.js";
import { setup } from "./helpers.js";

const note = (path: string, over: Partial<VaultNote> = {}): VaultNote => ({
  path,
  title: path.replace(/^.*\//, "").replace(/\.md$/, ""),
  heading: null,
  folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  tags: [],
  links: [],
  mentions: [],
  mtime: "2026-09-20T10:00:00.000Z",
  size: 100,
  ...over,
});

describe("libPackage (Quelldatei → Bibliothek)", () => {
  it("erkennt Swift-Pakete aus .build/checkouts und SourcePackages, sonst null", () => {
    expect(libPackage("App/backend/services/user-service/.build/checkouts/swift-collections/Sources/SortedCollections/BTree/_BTree.swift")).toBe("swift-collections");
    expect(libPackage("DerivedData/X/SourcePackages/checkouts/mapbox-maps-ios/Sources/A.swift")).toBe("mapbox-maps-ios");
    expect(libPackage("web/node_modules/@scope/pkg/index.js")).toBe("@scope/pkg");
    expect(libPackage("App/Xcode/Shop MVP App/Shop MVP App/Features/Feed/Views/EventDetailView.swift")).toBeNull();
    expect(libPackage(null)).toBeNull();
  });
});

describe("Vault-Quelle: Code-Notizen mit Bibliothek", () => {
  it("Frontmatter-Quelldatei kommt an, Graph-Knoten trägt `lib`, eigener Code nicht; Info-Karte nennt Quelldatei", async () => {
    const t = await setup();
    const res = await t.post("/ingest/vault", {
      root: "/Users/x/Vault",
      syncId: "s1",
      mode: "full",
      done: true,
      deleted: [],
      notes: [
        note("02 Code/Views/_BTree.md", { source: "App/backend/services/user-service/.build/checkouts/swift-collections/Sources/_BTree.swift" }),
        note("02 Code/Views/EventDetailView.md", { source: "App/Xcode/Shop MVP App/Shop MVP App/Features/Feed/Views/EventDetailView.swift" }),
        note("04 Planung/Heatmap.md"), // ohne Quelldatei (auch: ältere Brücke)
      ],
    });
    expect(res.status).toBe(200);
    const g = (await (await t.app.request("/api/graph")).json()) as GraphResponse;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("note:02 Code/Views/_BTree.md")?.lib).toBe("swift-collections");
    expect(byId.get("note:02 Code/Views/EventDetailView.md")?.lib ?? null).toBeNull();
    expect(byId.get("note:04 Planung/Heatmap.md")?.lib ?? null).toBeNull();

    const d = (await (await t.app.request(`/api/graph/node/${encodeURIComponent("note:02 Code/Views/_BTree.md")}`)).json()) as GraphNodeDetail;
    const facts = Object.fromEntries(d.facts);
    expect(facts.Bibliothek).toBe("swift-collections");
    expect(facts.Quelldatei).toContain("_BTree.swift");
  });

  it("Delta: Bibliothek kommt nach (neue Brücke) → Knoten wird aktualisiert", async () => {
    const t = await setup();
    const base = { root: "/Users/x/Vault", syncId: "s1", deleted: [], done: true };
    await t.post("/ingest/vault", { ...base, mode: "full", notes: [note("02 Code/Views/Deque.md")] });
    const g1 = (await (await t.app.request("/api/graph")).json()) as GraphResponse;
    expect(g1.nodes.find((n) => n.id === "note:02 Code/Views/Deque.md")?.lib ?? null).toBeNull();
    await t.post("/ingest/vault", { ...base, mode: "delta", notes: [note("02 Code/Views/Deque.md", { source: "a/.build/checkouts/swift-collections/Sources/Deque.swift" })] });
    const g2 = (await (await t.app.request("/api/graph")).json()) as GraphResponse;
    expect(g2.nodes.find((n) => n.id === "note:02 Code/Views/Deque.md")?.lib).toBe("swift-collections");
  });
});

describe("Info-Karte blockiert den Server nicht bei riesigen Nachrichten", () => {
  it("clipText wandelt nur den Anfang um (1,2 MB Chat-Text → schnell, Ergebnis ≤ GRAPH_EXCERPT_MAX)", async () => {
    const { clipText } = await import("../src/graph/detail.js");
    const big = "- **Punkt** mit `code` und [Link](http://x) <b>fett</b>\n".repeat(20_000) + "<script>".repeat(20_000);
    const t0 = performance.now();
    const out = clipText(big);
    const ms = performance.now() - t0;
    expect(out?.startsWith("• Punkt mit code und Link fett")).toBe(true);
    expect((out ?? "").length).toBeLessThanOrEqual(GRAPH_EXCERPT_MAX);
    expect(ms).toBeLessThan(150);
  });
});

describe("Info-Karte: Text statt rohem Markdown", () => {
  const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef";
  const summary = (): SessionSummary => ({
    sessionId: UUID,
    tool: "claude",
    parentSessionId: null,
    cwd: "/Users/x",
    title: "Markdown",
    titleSource: null,
    startedAt: "2026-09-24T10:00:00.000Z",
    lastActivityAt: "2026-09-24T11:00:00.000Z",
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
  });

  it("Session-Nachricht, Auftrag und Eintragstext kommen ohne Backticks/Sternchen/Striche, Zeilen bleiben", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [{ type: "summary", summary: summary() }] });
    await t.db.insert(sessionEvents).values([{ id: "m1", sessionKey: `claude:${UUID}`, ts: "2026-09-24T10:00:00.000Z", kind: "prompt", source: "hook", data: { text: "## Auftrag\nBitte `pnpm test` **grün** machen" } }]);
    await t.db.execute(
      sql`insert into search_docs (session_key, field, position, text, tsv_german, tsv_simple) values (${`claude:${UUID}`}, 'chat', 3, ${"**Fertig:**\n- Punkt eins\n- Punkt zwei mit `code`"}, to_tsvector('german', 'x'), to_tsvector('simple', 'x'))`,
    );
    // vor der ersten Abfrage anlegen (der Graph wird danach zwischengespeichert)
    const [e] = await t.db.insert(entries).values({ kind: "aufgabe", title: "X", description: "- [ ] **Schritt** eins\n- [x] `zwei`", stage: "geplant" }).returning({ id: entries.id });
    const s = (await (await t.app.request(`/api/graph/node/${encodeURIComponent(`session:claude:${UUID}`)}`)).json()) as GraphNodeDetail;
    expect(s.excerpt?.text).toBe("Fertig:\n• Punkt eins\n• Punkt zwei mit code");
    expect(s.extra?.text).toBe("Auftrag\nBitte pnpm test grün machen");

    const d = (await (await t.app.request(`/api/graph/node/${encodeURIComponent(`entry:${e?.id ?? 0}`)}`)).json()) as GraphNodeDetail;
    expect(d.excerpt?.text).toBe("• Schritt eins\n• zwei");
  });
});
