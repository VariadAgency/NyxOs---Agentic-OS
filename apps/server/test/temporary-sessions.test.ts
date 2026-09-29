// Wegwerf-Chats: temporäre Sessions und Haiku-Fäden. Auto-Markierung aus echten Daten
// (Stichprobe: Haiku-Läufe, Probe-Ordner, Selbsttests, zc-* auf dem Probe-Socket), Ablauf nach
// X Stunden (Fäden gelöscht, Sessions archiviert und aus allen Listen/Zählern), Einstellung 1–72 h.
import type { IngestItem, ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { archive, haikuMessages, haikuThreads, sessions } from "../src/db/schema.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

type Row = typeof sessions.$inferInsert;
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id: `claude:${id}`,
  tool: "claude",
  sessionId: id,
  machineId: "m1",
  status: "ended",
  cwd: "/Users/alex/projects",
  title: `Echte Arbeit ${id}`,
  titleSource: "ai",
  startedAt: hoursAgo(1),
  lastActivityAt: hoursAgo(1),
  categoryArt: "coding",
  ...over,
});

const hookStart = (sessionId: string, model: string, idSuffix = ""): IngestItem => ({
  type: "event",
  event: {
    id: `hook:SessionStart:${sessionId}${idSuffix}`,
    tool: "claude",
    sessionId,
    ts: new Date().toISOString(),
    kind: "hook",
    source: "hook",
    data: { event: "SessionStart", model, source: "startup", cwd: "/Users/alex/projects/tools/NyxOS" },
  },
});

interface SessionOut {
  id: string;
  temporarySince: string | null;
  temporaryReason: string | null;
  temporaryExpiresAt: string | null;
  archivedAt: string | null;
}

async function listSessions(app: { request: (p: string) => Response | Promise<Response> }): Promise<SessionOut[]> {
  return ((await (await app.request("/api/sessions")).json()) as { sessions: SessionOut[] }).sessions;
}

/** Eine Brücke im selben Prozess, die sich mit einem tmux-Socket meldet (wie `link.ts` „hello“). */
function bridgeOn(hub: BridgeHub, tmuxSocket: string, reply: (msg: ServerToBridge) => unknown = () => undefined) {
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        const answer = reply(msg);
        if (answer !== undefined) queueMicrotask(() => hub.handle(JSON.stringify(answer)));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "p3", tmuxSocket, caps: [] }));
}

describe("Auto-Markierung (Regeln aus der DB-Stichprobe)", () => {
  it("Haiku-Lauf (SessionStart mit Haiku-Modell) wird sofort beim Ingest temporär, eine Opus-Session nicht", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookStart("h1", "claude-haiku-4-5-20251001"), hookStart("o1", "claude-opus-5-5")] });
    const list = await listSessions(t.app);
    expect(list.find((s) => s.id === "claude:h1")).toMatchObject({ temporaryReason: "haiku_run" });
    expect(list.find((s) => s.id === "claude:h1")?.temporaryExpiresAt).toBeTruthy();
    expect(list.find((s) => s.id === "claude:o1")).toMatchObject({ temporarySince: null, temporaryReason: null, temporaryExpiresAt: null });
  });

  it("Probe-Ordner, Selbsttest-Prompt und zc-* auf dem Probe-Socket werden im Ticker markiert – normale Sessions nicht", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    bridgeOn(hub, "nyxos-probe");
    await t.db.insert(sessions).values([
      row("p1", { cwd: "/Users/alex/projects/tools/NyxOS/.probe/new-session-test" }),
      row("s1", { title: "Antworte nur mit OK.", titleSource: "prompt" }),
      row("z1", { tmuxName: "zc-claude-ab12cd34" }),
      row("n1"),
      // Titel von der KI (nicht der Prompt) – kein Selbsttest.
      row("n2", { title: "Antworte nur mit OK.", titleSource: "ai" }),
    ]);
    await t.tickStates(NOW);
    const list = await listSessions(t.app);
    const reason = (id: string) => list.find((s) => s.id === `claude:${id}`)?.temporaryReason ?? null;
    expect(reason("p1")).toBe("probe_folder");
    expect(reason("s1")).toBe("selftest");
    expect(reason("z1")).toBe("probe_tmux");
    expect(reason("n1")).toBeNull();
    expect(reason("n2")).toBeNull();
  });

  it("zc-* auf dem echten Socket „nyxos“ ist Alex' Arbeit – bleibt normal", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    bridgeOn(hub, "nyxos");
    await t.db.insert(sessions).values(row("z2", { tmuxName: "zc-claude-ef56ab78" }));
    await t.tickStates(NOW);
    expect((await listSessions(t.app)).find((s) => s.id === "claude:z2")?.temporaryReason).toBeNull();
  });

  it("„Behalten“: Markierung aufheben – die Automatik markiert die Session danach nie wieder", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookStart("h2", "claude-haiku-4-5-20251001")] });
    const res = await t.app.request("/api/sessions/claude:h2/temporary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ temporary: false }) });
    expect(res.status).toBe(200);
    await t.tickStates(NOW);
    await t.post("/ingest/events", { items: [hookStart("h2", "claude-haiku-4-5-20251001", ":nochmal")] });
    expect((await listSessions(t.app)).find((s) => s.id === "claude:h2")).toMatchObject({ temporarySince: null, temporaryReason: null });
  });
});

describe("Schalter „Temporär“ im Dialog „Neue Session“", () => {
  it("Claude: die gestartete Session ist sofort temporär (Grund „manual“)", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const sid = "0b5e2b1c-1111-4222-8333-944455556666";
    bridgeOn(hub, "nyxos", (m) =>
      m.op === "rpc" && m.method === "start" ? { op: "rpc_result", id: m.id, ok: true, result: { tmuxName: "zc-claude-q1w2e3r4", tool: "claude", sessionId: sid, startedMs: 5 } } : undefined,
    );
    const res = await t.app.request("/api/terminal/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", model: null, cwd: "/Users/x/projects", prompt: null, temporary: true }),
    });
    expect(res.status).toBe(200);
    expect((await listSessions(t.app)).find((s) => s.id === `claude:${sid}`)).toMatchObject({ temporaryReason: "manual" });
  });

  it("Codex (ID erst später bekannt): Markierung hängt am tmux-Namen und greift, sobald die Session erscheint", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    bridgeOn(hub, "nyxos", (m) =>
      m.op === "rpc" && m.method === "start" ? { op: "rpc_result", id: m.id, ok: true, result: { tmuxName: "zc-codex-aa11bb22", tool: "codex", sessionId: null, startedMs: 5 } } : undefined,
    );
    const res = await t.app.request("/api/terminal/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "codex", model: null, cwd: "/Users/x/projects", prompt: null, temporary: true }),
    });
    expect(res.status).toBe(200);
    await t.db.insert(sessions).values(row("c1", { id: "codex:c1", tool: "codex", tmuxName: "zc-codex-aa11bb22" }));
    await t.tickStates(NOW);
    expect((await listSessions(t.app)).find((s) => s.id === "codex:c1")).toMatchObject({ temporaryReason: "manual" });
  });
});

describe("Ablauf nach X Stunden", () => {
  it("nach 6 h: Session archiviert – raus aus Liste, Arten-Zählern und Überblick; Transkript-Archiv bleibt", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      row("old", { temporarySince: hoursAgo(7), temporaryReason: "manual", lastActivityAt: hoursAgo(7), state: "waiting" }),
      row("young", { temporarySince: hoursAgo(5), temporaryReason: "manual", lastActivityAt: hoursAgo(5), state: "waiting" }),
      row("keep", { lastActivityAt: hoursAgo(30), state: "waiting" }),
      // Sub-Agent der abgelaufenen Session verschwindet mit.
      row("old-sub", { parentId: "claude:old", lastActivityAt: hoursAgo(7) }),
    ]);
    await t.db.insert(archive).values({ sessionKey: "claude:old", tool: "claude", path: "/x/old.jsonl", sha256: "a", size: 1, gzSize: 1, storedPath: "/a/old.gz" });

    await t.tickStates(NOW);

    const ids = (await listSessions(t.app)).map((s) => s.id);
    expect(ids).toContain("claude:young");
    expect(ids).toContain("claude:keep");
    expect(ids).not.toContain("claude:old");
    expect(ids).not.toContain("claude:old-sub");

    const cats = (await (await t.app.request("/api/categories")).json()) as { categories: { art: string; count: number }[] };
    expect(cats.categories.find((c) => c.art === "coding")?.count).toBe(2);

    const overview = (await (await t.app.request("/api/overview")).json()) as { waitingSessions?: { id: string }[] } & Record<string, unknown>;
    expect(JSON.stringify(overview)).not.toContain("claude:old");

    const [kept] = await t.db.select().from(sessions).where(eq(sessions.id, "claude:old"));
    expect(kept?.archivedAt).toBeTruthy();
    expect(await t.db.select().from(archive).where(eq(archive.sessionKey, "claude:old"))).toHaveLength(1);
    // Direkter Link auf die Session geht weiter (Transkript bleibt lesbar).
    expect((await t.app.request("/api/sessions/claude:old")).status).toBe(200);
  });

  it("aktive Nutzung verlängert: Restzeit zählt ab der letzten Aktivität", async () => {
    const t = await setup();
    await t.db.insert(sessions).values(row("busy", { temporarySince: hoursAgo(10), temporaryReason: "manual", lastActivityAt: hoursAgo(1) }));
    await t.tickStates(NOW);
    const s = (await listSessions(t.app)).find((x) => x.id === "claude:busy");
    expect(s).toBeTruthy();
    expect(s?.temporaryExpiresAt).toBe(new Date(NOW + 5 * 3_600_000).toISOString());
  });

  it("Einstellung 3 h: gilt für Sessions und Fäden; 0 und 73 werden abgelehnt", async () => {
    const t = await setup();
    expect(((await (await t.app.request("/api/temporary/settings")).json()) as { hours: number }).hours).toBe(6);
    for (const bad of [0, 73, 2.5]) {
      const r = await t.app.request("/api/temporary/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hours: bad }) });
      expect(r.status, `hours=${bad}`).toBe(400);
    }
    const ok = await t.app.request("/api/temporary/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hours: 3 }) });
    expect(ok.status).toBe(200);
    await t.db.insert(sessions).values(row("four", { temporarySince: hoursAgo(4), temporaryReason: "manual", lastActivityAt: hoursAgo(4) }));
    const [th] = await t.db.insert(haikuThreads).values({ topic: "x", day: "2026-09-25", title: "Wegwerf", temporary: true, updatedAt: hoursAgo(4) }).returning();
    await t.tickStates(NOW);
    expect((await listSessions(t.app)).map((s) => s.id)).not.toContain("claude:four");
    expect(await t.db.select().from(haikuThreads).where(eq(haikuThreads.id, th?.id ?? -1))).toHaveLength(0);
  });

  it("Haiku-Faden: temporär + 6 h still → gelöscht samt Nachrichten; normale und junge Fäden bleiben", async () => {
    const t = await setup();
    const [gone] = await t.db.insert(haikuThreads).values({ topic: "x", day: "2026-09-25", title: "Weg", temporary: true, updatedAt: hoursAgo(7) }).returning();
    const [young] = await t.db.insert(haikuThreads).values({ topic: "x", day: "2026-09-25", title: "Jung", temporary: true, updatedAt: hoursAgo(2) }).returning();
    const [normal] = await t.db.insert(haikuThreads).values({ topic: "x", day: "2026-09-25", title: "Bleibt", updatedAt: hoursAgo(70) }).returning();
    await t.db.insert(haikuMessages).values({ threadId: gone?.id ?? -1, role: "user", text: "hallo" });
    await t.tickStates(NOW);
    const left = (await t.db.select({ id: haikuThreads.id }).from(haikuThreads)).map((r) => r.id).sort();
    expect(left).toEqual([young?.id, normal?.id].sort());
    expect(await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, gone?.id ?? -1))).toHaveLength(0);
  });
});
