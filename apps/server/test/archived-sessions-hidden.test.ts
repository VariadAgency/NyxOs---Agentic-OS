// Archivierte Wegwerf-Sessions (`sessions.archived_at`) verschwinden aus ALLEN
// Listen, Zählern und Schnappschüssen
// (Überblick-Schnappschuss, „Zuletzt geöffnet“, Arten-Zähler, Gehirn, Konflikte, Dateien, Agenten, …).
// Gemeinsame Regel: `src/db/visible.ts`. Jeder Test setzt eine sichtbare und eine archivierte Session
// gleicher Art an und scheitert, sobald die Archiv-Bedingung an seiner Stelle fehlt.
import { describe, expect, it } from "vitest";
import { sessionEvents, sessionFiles, sessionOpens, sessions } from "../src/db/schema.js";
import type { Db } from "../src/db/client.js";
import { listAgentRuns } from "../src/agents/runs.js";
import { ConflictModelService } from "../src/conflicts/model.js";
import { computeCollisionMap, countActiveConflicts } from "../src/conflicts/store.js";
import { listTouchedFiles, sessionsForFile } from "../src/files/query.js";
import { sessionsSource } from "../src/graph/sources/sessions.js";
import { collectFacts } from "../src/haiku/report.js";
import { buildDefaultRegistry } from "../src/haiku/tools.js";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { takeSnapshot } from "../src/overview/snapshot.js";
import { listCategories } from "../src/store.js";
import { eq } from "drizzle-orm";
import { setup } from "./helpers.js";

const NOW = new Date();
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const ARCHIVED_AT = minAgo(5);

type Row = typeof sessions.$inferInsert;
async function add(db: Db, id: string, over: Partial<Row> = {}): Promise<string> {
  const key = `${over.tool ?? "claude"}:${id}`;
  await db.insert(sessions).values({
    id: key,
    tool: "claude",
    sessionId: id,
    machineId: "m1",
    status: "active",
    cwd: "/Users/alex/projects",
    title: `Session ${id}`,
    startedAt: minAgo(60),
    lastActivityAt: minAgo(2),
    categoryArt: "coding",
    ...over,
  });
  return key;
}
const archived = { archivedAt: ARCHIVED_AT, temporarySince: minAgo(600), temporaryReason: "probe_folder" } satisfies Partial<Row>;

describe("Überblick-Schnappschuss (Kopf, Kacheln, kritische Sessions, Briefing, „Braucht dich“)", () => {
  it("zählt archivierte Sessions nicht und führt sie nicht unter „Braucht dich“", async () => {
    const { db } = await setup();
    await add(db, "wartet", { state: "waiting" });
    await add(db, "arch-wartet", { state: "waiting", ...archived });
    await add(db, "arch-crash", { state: "crashed", ...archived });
    await add(db, "arch-laeuft", { state: "running", ...archived });

    const snap = await takeSnapshot(db, NOW);
    expect(snap.counts).toMatchObject({ running: 0, waiting: 1, crashed: 0 });
    expect(snap.needsYou.map((i) => i.id)).toEqual(["session:claude:wartet"]);
    expect(snap.lage).toBe("Keine Session läuft, 1 wartet auf dich.");
  });

  it("Überblick-Seite: kritische Sessions und „Zuletzt fertig“ ohne archivierte", async () => {
    const { db } = await setup();
    await add(db, "wartet", { state: "waiting" });
    await add(db, "arch-wartet", { state: "waiting", ...archived });
    await add(db, "fertig", { state: "closed", closedAt: minAgo(3) });
    await add(db, "arch-fertig", { state: "closed", closedAt: minAgo(3), ...archived });

    const o = await getOverviewSnapshot(db, "Alex", NOW);
    const text = JSON.stringify(o);
    expect(text).toContain("claude:wartet");
    expect(text).not.toContain("arch-wartet");
    expect(o.recentDone.map((d) => d.id)).toContain("claude:fertig");
    expect(o.recentDone.map((d) => d.id)).not.toContain("claude:arch-fertig");
  });

  it("Briefing-Fakten (Haiku-Bericht) nennen archivierte Sessions nicht", async () => {
    const { db } = await setup();
    await add(db, "aktiv", { state: "idle", title: "Echte Arbeit" });
    await add(db, "arch-aktiv", { state: "idle", title: "Wegwerf-Test", ...archived });
    const facts = await collectFacts(db, "recap", NOW);
    const text = JSON.stringify(facts);
    expect(text).toContain("claude:aktiv");
    expect(text).not.toContain("arch-aktiv");
  });
});

describe("weitere Session-Listen", () => {
  it("„Zuletzt geöffnet“ ohne archivierte Sessions", async () => {
    const t = await setup();
    const vis = await add(t.db, "offen");
    const arch = await add(t.db, "arch-offen", archived);
    await t.db.insert(sessionOpens).values([
      { sessionKey: vis, lastOpenedAt: minAgo(10) },
      { sessionKey: arch, lastOpenedAt: minAgo(1) },
    ]);
    const res = (await (await t.app.request("/api/recent-sessions")).json()) as { items: { sessionKey: string }[] };
    expect(res.items.map((i) => i.sessionKey)).toEqual([vis]);
  });

  it("Arten-Zähler (listCategories, auch mit Werkzeug-Filter) ohne archivierte Sessions", async () => {
    const { db } = await setup();
    await add(db, "a", { state: "idle" });
    await add(db, "arch-a", { state: "idle", ...archived });
    const total = (rows: { count: number }[]) => rows.reduce((s, r) => s + r.count, 0);
    expect(total(await listCategories(db))).toBe(1);
    expect(total(await listCategories(db, "claude"))).toBe(1);
  });

  it("Haiku-Werkzeug „sessions_suchen“ findet archivierte Sessions nicht", async () => {
    const { db } = await setup();
    await add(db, "suche", { title: "Push-Dienst bauen" });
    await add(db, "arch-suche", { title: "Push-Dienst Test", ...archived });
    const res = (await buildDefaultRegistry().call("full", "sessions_suchen", { text: "Push" }, { db, scope: "full", ideaLink: null, ideas: null })) as { ref: string }[];
    expect(JSON.stringify(res)).toContain("claude:suche");
    expect(JSON.stringify(res)).not.toContain("arch-suche");
  });

  it("Gehirn: kein Session-Knoten und keine Datei-Knoten nur archivierter Sessions", async () => {
    const { db } = await setup();
    const vis = await add(db, "g");
    const arch = await add(db, "arch-g", archived);
    await db.insert(sessionFiles).values([
      { sessionKey: vis, path: "/x/sichtbar.ts", mode: "write" },
      { sessionKey: arch, path: "/x/nur-archiv.ts", mode: "write" },
    ]);
    const out = await sessionsSource(db).load();
    const ids = out.nodes.map((n) => n.id);
    expect(ids).toContain(`session:${vis}`);
    expect(ids).not.toContain(`session:${arch}`);
    expect(ids).not.toContain("file:/x/nur-archiv.ts");
  });

  it("Konflikte: eine archivierte Session zählt nicht als zweite Schreiberin", async () => {
    const { db } = await setup();
    const vis = await add(db, "k");
    const arch = await add(db, "arch-k", archived);
    await db.insert(sessionFiles).values([
      { sessionKey: vis, path: "/x/gemeinsam.ts", mode: "write" },
      { sessionKey: arch, path: "/x/gemeinsam.ts", mode: "write" },
    ]);
    const map = await computeCollisionMap(db);
    expect(map.find((e) => e.path === "/x/gemeinsam.ts")?.writers.map((w) => w.sessionKey)).toEqual([vis]);
    expect(await countActiveConflicts(db)).toBe(0);
  });

  it("Konflikte: Archivieren ändert den Stand des Konflikt-Modells (kein veralteter Zwischenspeicher)", async () => {
    const { db } = await setup();
    const a = await add(db, "k1");
    const b = await add(db, "k2");
    await db.insert(sessionFiles).values([
      { sessionKey: a, path: "/x/gemeinsam.ts", mode: "write" },
      { sessionKey: b, path: "/x/gemeinsam.ts", mode: "write" },
    ]);
    const svc = new ConflictModelService(db);
    const before = await svc.version();
    await db.update(sessions).set({ archivedAt: ARCHIVED_AT }).where(eq(sessions.id, b));
    svc.invalidate();
    expect(await svc.version()).not.toBe(before);
  });

  it("Dateien-Reiter: Liste, Zähler und „Wer hat die Datei angefasst“ ohne archivierte Sessions", async () => {
    const { db } = await setup();
    const vis = await add(db, "f");
    const arch = await add(db, "arch-f", archived);
    await db.insert(sessionFiles).values([
      { sessionKey: vis, path: "/Users/alex/projects/App/a.swift", mode: "read" },
      { sessionKey: arch, path: "/Users/alex/projects/App/a.swift", mode: "write" },
      { sessionKey: arch, path: "/Users/alex/projects/App/nur-archiv.swift", mode: "write" },
    ]);
    const all = await listTouchedFiles(db, {});
    expect(all.files.map((f) => f.path)).toEqual(["/Users/alex/projects/App/a.swift"]);
    expect(all.files[0]).toMatchObject({ changed: false, read: true, sessions: 1 });
    expect(all.sessions).toBe(1);
    expect((await listTouchedFiles(db, { mode: "gelesen" })).sessions).toBe(1);
    expect((await sessionsForFile(db, "/Users/alex/projects/App/a.swift")).map((s) => s.key)).toEqual([vis]);
  });

  it("Agenten: Sub-Agenten archivierter Sessions erscheinen nicht", async () => {
    const { db } = await setup();
    const vis = await add(db, "eltern");
    const arch = await add(db, "arch-eltern", archived);
    await db.insert(sessionEvents).values([
      { id: "e1", sessionKey: vis, ts: minAgo(3), kind: "tool_call", source: "file", data: { agentId: "ag1", name: "Read" } },
      { id: "e2", sessionKey: arch, ts: minAgo(3), kind: "tool_call", source: "file", data: { agentId: "ag2", name: "Read" } },
    ]);
    await add(db, "codex-eltern", { tool: "codex" });
    await add(db, "codex-kind", { tool: "codex", parentId: "codex:codex-eltern" });
    await add(db, "codex-arch-kind", { tool: "codex", parentId: "codex:codex-eltern", ...archived });
    const runs = await listAgentRuns(db);
    const ids = runs.map((r) => r.id);
    expect(ids).toContain(`${vis}:ag1`);
    expect(ids).not.toContain(`${arch}:ag2`);
    expect(ids).toContain("codex:codex-kind");
    expect(ids).not.toContain("codex:codex-arch-kind");
  });
});
