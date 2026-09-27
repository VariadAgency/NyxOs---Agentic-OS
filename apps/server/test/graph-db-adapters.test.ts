// Graph-Quellen aus der DB: `dbEntriesProvider`/`dbGitProvider` (graph/sources/{entries,git}.ts) gegen ECHTE
// Tabellen (PGlite, wie in helpers.ts `setup()`), nicht nur Fixtures (die bleiben in
// graph-adapters.test.ts als Vertrags-Test für `entriesSource`/`gitSource` selbst).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries as entriesTable } from "../src/db/schema.js";
import { createEntry, linkObjects } from "../src/entries/store.js";
import { dbEntriesProvider } from "../src/graph/sources/entries.js";
import { dbGitProvider } from "../src/graph/sources/git.js";
import { upsertGitSnapshot } from "../src/git/store.js";
import { setup } from "./helpers.js";

describe("dbEntriesProvider (echte entries/links-Tabellen)", () => {
  it("liest Einträge + Verknüpfungen", async () => {
    const { db } = await setup();
    const idea = await createEntry(db, { kind: "idee", title: "Graph wie Obsidian", source: "api" });
    const task = await createEntry(db, { kind: "aufgabe", title: "Gehirn-Tab bauen", source: "api" });
    await linkObjects(db, { fromType: "entry", fromId: String(idea.id), toType: "entry", toId: String(task.id), relation: "verwandt", source: "test" });

    const { entries, links } = await dbEntriesProvider(db).list();

    expect(entries).toContainEqual(expect.objectContaining({ id: String(idea.id), art: "idee", title: "Graph wie Obsidian" }));
    expect(entries).toContainEqual(expect.objectContaining({ id: String(task.id), art: "aufgabe", title: "Gehirn-Tab bauen" }));
    expect(links).toContainEqual({ from: { type: "entry", id: String(idea.id) }, to: { type: "entry", id: String(task.id) }, relation: "verwandt" });
  });

  it("Idee → Aufgabe: es gibt KEINE eigene Verknüpfungs-Zeile dafür — `promote` ändert `entries.kind` derselben Zeile, der Adapter muss danach dieselbe ID mit der NEUEN Art liefern (kein zweiter Knoten)", async () => {
    const { db } = await setup();
    const idea = await createEntry(db, { kind: "idee", title: "wird befördert", source: "api" });
    expect((await dbEntriesProvider(db).list()).entries).toContainEqual(expect.objectContaining({ id: String(idea.id), art: "idee" }));

    // Wie `POST /:id/promote` (routes/entries.ts): setzt NUR `kind` (+ `stage`), legt keine `links`-Zeile an.
    await db.update(entriesTable).set({ kind: "aufgabe", stage: "geplant" }).where(eq(entriesTable.id, idea.id));

    const { entries } = await dbEntriesProvider(db).list();
    expect(entries.filter((e) => e.id === String(idea.id))).toHaveLength(1);
    expect(entries).toContainEqual(expect.objectContaining({ id: String(idea.id), art: "aufgabe" }));
  });

  it("verknüpft einen Eintrag mit einer Session (Eintrag↔Session)", async () => {
    const { db } = await setup();
    const bug = await createEntry(db, { kind: "bug", title: "Flackern beim Filtern", source: "api" });
    await linkObjects(db, { fromType: "entry", fromId: String(bug.id), toType: "session", toId: "claude:abc", relation: "gefunden_in", source: "test" });

    const { links } = await dbEntriesProvider(db).list();
    expect(links).toContainEqual({ from: { type: "entry", id: String(bug.id) }, to: { type: "session", id: "claude:abc" }, relation: "gefunden_in" });
  });
});

describe("dbGitProvider (echte git_repos/git_commits/git_branches-Tabellen)", () => {
  it("liest Commits + Zweige aus einer echten Momentaufnahme (upsertGitSnapshot)", async () => {
    const { db } = await setup();
    await upsertGitSnapshot(db, {
      collectedAt: "2026-09-25T04:00:00.000Z",
      repos: [
        {
          repoId: "nyxos",
          label: "NyxOS",
          kind: "nyxos",
          root: "/Users/test/NyxOS",
          currentBranch: "main",
          headSha: "abc1234def",
          branches: [{ name: "main", ahead: 0, behind: 0, isCurrent: true, lastCommitAt: "2026-09-25T04:00:00.000Z", upstream: null }],
          uncommitted: [],
          recentCommits: [{ sha: "abc1234def", authorDate: "2026-09-25T04:00:00.000Z", subject: "PG: Graph-API", branch: "main" }],
          probeMerges: [],
          tags: [],
          scannedAt: "2026-09-25T04:00:00.000Z",
        },
      ],
    });

    const { commits, branches } = await dbGitProvider(db).list();
    expect(commits).toContainEqual(expect.objectContaining({ sha: "abc1234def", repo: "nyxos", subject: "PG: Graph-API", branch: "main", sessionKeys: [] }));
    expect(branches).toContainEqual({ repo: "nyxos", name: "main" });
  });
});

describe("Zusammenbau: /ingest/git und Einträge-Schreibzugriffe markieren die Graph-Quellen dirty", () => {
  it('POST /ingest/git ruft graph.markDirty(["git"]) — Graph baut mit der neuen Version neu', async () => {
    const { post, graph } = await setup();
    const before = (await graph.get()).version;
    const res = await post("/ingest/git", {
      collectedAt: "2026-09-25T04:00:00.000Z",
      repos: [
        {
          repoId: "app",
          label: "App",
          kind: "app",
          root: "/Users/test/App",
          currentBranch: "main",
          headSha: "def5678abc",
          branches: [],
          uncommitted: [],
          recentCommits: [{ sha: "def5678abc", authorDate: "2026-09-25T04:00:00.000Z", subject: "Test-Commit", branch: "main" }],
          probeMerges: [],
          tags: [],
          scannedAt: "2026-09-25T04:00:00.000Z",
        },
      ],
    });
    expect(res.status).toBe(200);
    const after = await graph.get();
    expect(after.version).toBeGreaterThan(before);
    expect(after.nodes.some((n) => n.id === "commit:app:def5678abc")).toBe(true);
  });

  it('POST /api/entries markiert die Graph-Quelle "entries" dirty — der neue Eintrag taucht im Graphen auf', async () => {
    const { post, graph } = await setup();
    const before = (await graph.get()).version;
    const res = await post("/api/entries", { kind: "bug", title: "Neuer Bug für den Graphen" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { entry: { id: number } };
    const after = await graph.get();
    expect(after.version).toBeGreaterThan(before);
    expect(after.nodes.some((n) => n.id === `entry:${body.entry.id}`)).toBe(true);
  });
});
