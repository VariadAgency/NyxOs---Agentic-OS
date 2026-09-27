// Demo mode: the invented workspace fills every main table and the API answers with real content.
import { userInfo } from "node:os";
import { count } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  entries,
  gitCommits,
  haikuReports,
  haikuThreads,
  inboxItems,
  searchDocs,
  sessionEvents,
  sessionFiles,
  sessions,
  usageDaily,
  usageEvents,
  vaultNotes,
} from "../src/db/schema.js";
import { buildDemoData } from "../src/demo/data.js";
import { seedDemoIfEmpty } from "../src/demo/seed.js";
import { setup } from "./helpers.js";

const NOW = Date.parse("2026-09-26T10:30:00.000Z");

describe("demo data builder", () => {
  it("builds a rich, bilingual workspace", () => {
    const de = buildDemoData(NOW, "de");
    const en = buildDemoData(NOW, "en");
    expect(de.sessions.length).toBeGreaterThanOrEqual(25);
    expect(new Set(de.sessions.map((s) => s.spec.tool))).toEqual(new Set(["claude", "codex"]));
    expect(new Set(de.sessions.map((s) => s.spec.state))).toEqual(new Set(["running", "waiting", "idle", "crashed", "closed", "ended"]));
    expect(de.entries.length).toBeGreaterThanOrEqual(30);
    expect(de.git.commits.length).toBeGreaterThan(100);
    expect(de.usage.daily.length).toBeGreaterThan(60);
    // Same structure, other language.
    expect(en.sessions.map((s) => s.key)).toEqual(de.sessions.map((s) => s.key));
    expect(de.sessions[0]?.summary.title).not.toEqual(en.sessions[0]?.summary.title);
    // Transcripts parse without errors and produce chat content.
    for (const s of de.sessions) {
      expect(s.summary.parseErrors, s.spec.key).toBe(0);
      expect(s.events.some((e) => e.kind === "prompt"), s.spec.key).toBe(true);
    }
    // Nothing points at real people or the owner's machine.
    // (`usage` carries the server's fixed project bucket name, not user data.)
    const text = JSON.stringify({ ...de, usage: null, sessions: de.sessions.map((s) => s.transcript.files.map((f) => f.text)) });
    const osUser = userInfo().username.toLowerCase();
    if (osUser.length >= 3) expect(text.toLowerCase()).not.toContain(`/users/${osUser}/`);
  });
});

describe("seedDemoIfEmpty", () => {
  it("fills the database once and every main view has content", async () => {
    const { db, archiveDir, app } = await setup();
    const started = Date.now();
    const result = await seedDemoIfEmpty(db, { archiveDir, now: Date.now(), lang: "de" });
    const took = Date.now() - started;
    expect(result).not.toBeNull();
    expect(took).toBeLessThan(15_000);

    const n = async (table: PgTable) => (await db.select({ n: count() }).from(table))[0]?.n ?? 0;
    expect(await n(sessions)).toBeGreaterThanOrEqual(25);
    expect(await n(sessionEvents)).toBeGreaterThan(300);
    expect(await n(sessionFiles)).toBeGreaterThan(40);
    expect(await n(searchDocs)).toBeGreaterThan(50);
    expect(await n(entries)).toBeGreaterThanOrEqual(30);
    expect(await n(inboxItems)).toBeGreaterThanOrEqual(4);
    expect(await n(gitCommits)).toBeGreaterThan(100);
    expect(await n(usageEvents)).toBeGreaterThan(200);
    expect(await n(usageDaily)).toBeGreaterThan(60);
    expect(await n(haikuThreads)).toBe(4);
    expect(await n(haikuReports)).toBe(2);
    expect(await n(vaultNotes)).toBeGreaterThan(20);

    // Second call: nothing happens (the database has sessions now).
    expect(await seedDemoIfEmpty(db, { archiveDir, now: Date.now(), lang: "de" })).toBeNull();

    const get = async (path: string) => {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    // Sessions in every state, sorted into kinds and "Baustellen".
    const list = (await get("/api/sessions")).sessions as { id: string; state: string | null; art: string; baustelle: { slug: string } | null; title: string | null }[];
    const states = new Set(list.map((s) => s.state));
    for (const st of ["running", "waiting", "idle", "crashed", "closed"]) expect(states, st).toContain(st);
    const arts = new Set(list.map((s) => s.art));
    for (const a of ["coding", "audit", "planung", "recherche", "server"]) expect(arts, a).toContain(a);
    expect(list.every((s) => s.baustelle !== null)).toBe(true);
    expect(list.every((s) => s.title)).toBe(true);

    // The chat view reads the archived transcript.
    const running = list.find((s) => s.state === "running");
    const transcript = await get(`/api/sessions/${running?.id}/transcript`);
    const items = transcript.items as { role: string }[];
    expect(items.some((i) => i.role === "user")).toBe(true);
    expect(items.some((i) => i.role === "assistant")).toBe(true);
    expect(items.some((i) => i.role === "tool")).toBe(true);

    const entryList = (await get("/api/entries")).entries as { stage: string; kind: string }[];
    for (const st of ["geplant", "startklar", "laeuft", "pruefen", "erledigt"]) expect(entryList.map((e) => e.stage), st).toContain(st);
    for (const k of ["aufgabe", "bug", "audit", "idee", "entscheidung", "frage"]) expect(entryList.map((e) => e.kind), k).toContain(k);

    const overview = await get("/api/overview");
    expect(JSON.stringify(overview)).toContain("checkout");

    const usage = await get("/api/usage/daily?range=30");
    expect(JSON.stringify(usage)).toMatch(/claude/);

    const git = await get("/api/git/dashboard");
    expect(git.app).not.toBeNull();
    expect((git.appWorktrees as unknown[]).length).toBeGreaterThanOrEqual(2);

    const conflicts = await get("/api/conflicts/summary");
    expect(JSON.stringify(conflicts)).toContain("images.ts");

    const inbox = await get("/api/inbox?status=all");
    expect((inbox.items as unknown[]).length).toBeGreaterThanOrEqual(4);
    const approvalsRes = await get("/api/approvals?status=all");
    expect(JSON.stringify(approvalsRes)).toContain("git push origin feat/checkout-v2");

    const threads = await get("/api/haiku/threads");
    expect((threads.threads as unknown[]).length).toBe(4);

    const briefing = await get("/api/haiku/report?kind=briefing");
    const report = briefing.report as { mode: string; figures: unknown; stale: boolean } | null;
    expect(report?.mode).toBe("ok");
    expect(report?.figures).toBeTruthy();
    expect(report?.stale).toBe(false);

    const runs = await get("/api/agents/runs?limit=1000");
    expect(JSON.stringify(runs)).toMatch(/PASS/);

    const skillList = await get("/api/skills");
    expect(JSON.stringify(skillList)).toContain("deploy");

    const graph = await get("/api/graph");
    const nodes = graph.nodes as { type: string }[];
    const graphLinks = graph.links as { kind: string }[];
    expect(nodes.length).toBeGreaterThan(60);
    expect(graphLinks.length).toBeGreaterThan(100);
  }, 120_000);
  it("fails gracefully where the demo has no bridge and no AI engine", async () => {
    const { db, archiveDir, app } = await setup();
    await seedDemoIfEmpty(db, { archiveDir, now: Date.now(), lang: "en" });
    const send = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

    // Nyx chat: the engine is off → a clear error event in the stream, never a crash.
    const chat = await send("/api/haiku/chat", { message: "What is running right now?", context: { path: "/nyx", tab: "nyx", filters: {}, openSessionId: null, openEntryId: null } });
    expect(chat.status).toBe(200);
    const events = (await chat.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(events.some((e) => e.type === "error" && typeof e.message === "string" && e.message.length > 0)).toBe(true);

    // Starting a terminal needs the bridge → a plain "offline" answer (4xx/503), not a server error.
    const start = await send("/api/terminal/start", { tool: "claude", cwd: "/Users/demo/projects/atlas-web" });
    expect([400, 404, 409, 503, 504]).toContain(start.status);
    expect(((await start.json()) as { error?: string }).error).toBeTruthy();
  }, 120_000);
});
