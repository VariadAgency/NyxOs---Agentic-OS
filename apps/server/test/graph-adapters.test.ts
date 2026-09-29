import { describe, expect, it } from "vitest";
import { mergeSources } from "../src/graph/build.js";
import { entriesSource, type EntriesProvider } from "../src/graph/sources/entries.js";
import { gitSource, type GitProvider } from "../src/graph/sources/git.js";

/**
 * Graph: Adapter-Schnittstellen für Einträge (+ `links`) und Git (Commits/Zweige). Die echten
 * Tabellen kommen erst mit dem Zusammenbau — hier nur der Vertrag mit Fixtures.
 */

const entries: EntriesProvider = {
  async list() {
    return {
      entries: [
        { id: "e1", art: "idee", title: "Graph wie Obsidian", state: "offen", createdAt: "2026-09-25T01:30:00.000Z" },
        { id: "e2", art: "aufgabe", title: "Gehirn-Tab bauen", state: "läuft", createdAt: "2026-09-25T01:40:00.000Z" },
        { id: "e3", art: "bug", title: "Flackern beim Filtern", state: null, createdAt: null },
        { id: "e4", art: "audit", title: "Befund X", state: null, createdAt: null },
        { id: "e5", art: "unbekannt", title: "Wird trotzdem angezeigt", state: null, createdAt: null },
      ],
      links: [
        { from: { type: "entry", id: "e1" }, to: { type: "entry", id: "e2" }, relation: "wurde_aufgabe" },
        { from: { type: "entry", id: "e3" }, to: { type: "session", id: "claude:abc" }, relation: "gefunden_in" },
        { from: { type: "entry", id: "e2" }, to: { type: "entry", id: "fehlt" }, relation: "blockiert" },
      ],
    };
  },
};

const git: GitProvider = {
  async list() {
    return {
      commits: [
        { sha: "abc1234def", repo: "nyxos", subject: "PG: Graph-API", committedAt: "2026-09-25T02:00:00.000Z", branch: "main", sessionKeys: ["claude:abc"] },
        { sha: "fff0000aaa", repo: "nyxos", subject: "ohne Session", committedAt: "2026-09-25T02:10:00.000Z", branch: null, sessionKeys: [] },
      ],
      branches: [{ name: "main", repo: "nyxos" }],
    };
  },
};

describe("Adapter Einträge", () => {
  it("bildet Arten auf Knotenarten ab und zieht Idee→Aufgabe und Eintrag↔Session", async () => {
    const res = await entriesSource(entries).load();
    const types = Object.fromEntries(res.nodes.map((n) => [n.id, n.type]));
    expect(types).toMatchObject({ "entry:e1": "idea", "entry:e2": "task", "entry:e3": "bug", "entry:e4": "finding", "entry:e5": "task" });
    expect(res.links).toContainEqual({ source: "entry:e1", target: "entry:e2", kind: "idea_task", weight: 1 });
    expect(res.links).toContainEqual({ source: "entry:e3", target: "session:claude:abc", kind: "entry_link", weight: 1 });
  });

  it("Kanten auf unbekannte Knoten fallen beim Zusammenführen weg", async () => {
    const session = { name: "sessions", nodes: [{ id: "session:claude:abc", type: "session" as const, label: "S", group: "coding", ref: { kind: "session" as const, sessionKey: "claude:abc", sessionId: "abc", tool: "claude", art: "coding", baustelleSlug: null } }], links: [] };
    const merged = mergeSources([session, { name: "entries", ...(await entriesSource(entries).load()) }]);
    expect(merged.links.some((l) => l.target === "entry:fehlt")).toBe(false);
    expect(merged.nodes.find((n) => n.id === "session:claude:abc")?.degree).toBe(1);
  });
});

describe("Adapter Git", () => {
  it("Commits, Zweige und Session↔Commit", async () => {
    const res = await gitSource(git).load();
    expect(res.nodes.find((n) => n.id === "commit:nyxos:abc1234def")?.label).toBe("abc1234 PG: Graph-API");
    expect(res.nodes.some((n) => n.id === "branch:nyxos:main" && n.type === "branch")).toBe(true);
    expect(res.links).toContainEqual({ source: "session:claude:abc", target: "commit:nyxos:abc1234def", kind: "commit", weight: 1 });
    expect(res.links).toContainEqual({ source: "commit:nyxos:abc1234def", target: "branch:nyxos:main", kind: "commit", weight: 1 });
  });
});
