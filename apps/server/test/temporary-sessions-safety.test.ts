// Wegwerf-Chats dürfen keine echte Arbeit verschlucken.
// Hintergrund aus echten Daten: zwei echte Recherche-Sessions vom Nutzer liefen
// komplett mit Haiku im Ordner /Users/alex/projects („Shop Bar-Systeme Recherche“ 4,2 Mio.,
// „DJ-Live research project planning“ 6 Mio. Tokens). Alle 40 Haiku-Selbsttests mit Inhalt lagen im
// NyxOS-Repo bzw. seinen Worktrees.
import type { IngestItem } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { setup } from "./helpers.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const hoursAgo = (h: number, from = NOW) => new Date(from - h * 3_600_000).toISOString();

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
  startedAt: hoursAgo(10),
  lastActivityAt: hoursAgo(10),
  categoryArt: "coding",
  ...over,
});

const hookStart = (sessionId: string, cwd: string): IngestItem => ({
  type: "event",
  event: {
    id: `hook:SessionStart:${sessionId}`,
    tool: "claude",
    sessionId,
    ts: new Date().toISOString(),
    kind: "hook",
    source: "hook",
    data: { event: "SessionStart", model: "claude-haiku-4-5-20251001", source: "startup", cwd },
  },
});

async function listIds(app: { request: (p: string) => Response | Promise<Response> }): Promise<string[]> {
  return ((await (await app.request("/api/sessions")).json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
}

describe("Auto-Regel „Haiku-Lauf“ trifft keine echte Arbeit", () => {
  it("eine Haiku-Session im Shop-Ordner (echte Recherche) bleibt normal", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [hookStart("real1", "/Users/alex/projects")] });
    await t.tickStates(NOW);
    const [r] = await t.db.select().from(sessions).where(eq(sessions.id, "claude:real1"));
    expect(r?.temporarySince ?? null).toBeNull();
  });

  it("Haiku-Selbsttests im NyxOS-Repo und in seinen Worktrees werden weiter markiert", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        hookStart("zt1", "/Users/alex/projects/tools/NyxOS"),
        hookStart("zt2", "/Users/alex/projects/tools/NyxOS/.claude/worktrees/agent-ad338c514dc8aeba8"),
      ],
    });
    const rows = await t.db.select({ id: sessions.id, reason: sessions.temporaryReason }).from(sessions);
    expect(rows.find((r) => r.id === "claude:zt1")?.reason).toBe("haiku_run");
    expect(rows.find((r) => r.id === "claude:zt2")?.reason).toBe("haiku_run");
  });
});

describe("Archivieren ist umkehrbar und trifft keine laufende Arbeit", () => {
  it("eine laufende Session (Prozess lebt) wird nicht archiviert, auch wenn sie lange still ist", async () => {
    const t = await setup();
    await t.db.insert(sessions).values(row("live", { status: "running", state: "waiting", temporarySince: hoursAgo(9), temporaryReason: "manual", lastActivityAt: hoursAgo(8) }));
    await t.tickStates(NOW);
    expect(await listIds(t.app)).toContain("claude:live");
  });

  it("neue Aktivität in einer archivierten Session holt sie samt Sub-Agenten zurück", async () => {
    const t = await setup();
    const now = Date.now();
    await t.db.insert(sessions).values([
      row("back", { temporarySince: hoursAgo(10, now), temporaryReason: "haiku_run", lastActivityAt: hoursAgo(9, now), archivedAt: hoursAgo(2, now) }),
      row("back-sub", { parentId: "claude:back", lastActivityAt: hoursAgo(9, now), archivedAt: hoursAgo(2, now) }),
    ]);
    const prompt: IngestItem = {
      type: "event",
      event: { id: "file:back:neu", tool: "claude", sessionId: "back", ts: new Date(now).toISOString(), kind: "prompt", source: "file", data: { text: "weiter geht's" } },
    };
    const res = await t.post("/ingest/events", { items: [prompt] });
    expect(res.status).toBe(200);
    const ids = await listIds(t.app);
    expect(ids).toContain("claude:back");
    expect(ids).toContain("claude:back-sub");
  });

  it("alte, nachgereichte Ereignisse (vor dem Archivieren) holen nichts zurück", async () => {
    const t = await setup();
    const now = Date.now();
    await t.db.insert(sessions).values(row("stay", { temporarySince: hoursAgo(10, now), temporaryReason: "selftest", lastActivityAt: hoursAgo(9, now), archivedAt: hoursAgo(2, now) }));
    const late: IngestItem = {
      type: "event",
      event: { id: "file:stay:alt", tool: "claude", sessionId: "stay", ts: hoursAgo(9.5, now), kind: "prompt", source: "file", data: { text: "alt" } },
    };
    await t.post("/ingest/events", { items: [late] });
    expect(await listIds(t.app)).not.toContain("claude:stay");
  });

  it("„Behalten“ an einer archivierten Session holt auch ihre Sub-Agenten zurück", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      row("k", { temporarySince: hoursAgo(10), temporaryReason: "haiku_run", archivedAt: hoursAgo(2) }),
      row("k-sub", { parentId: "claude:k", archivedAt: hoursAgo(2) }),
    ]);
    const res = await t.app.request("/api/sessions/claude:k/temporary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ temporary: false }) });
    expect(res.status).toBe(200);
    const ids = await listIds(t.app);
    expect(ids).toContain("claude:k");
    expect(ids).toContain("claude:k-sub");
  });

  it("das Archiv ist abrufbar (neueste zuerst, nur Haupt-Sessions) – sonst gibt es nichts zum Zurückholen", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      row("a1", { temporarySince: hoursAgo(20), temporaryReason: "selftest", archivedAt: hoursAgo(5) }),
      row("a2", { temporarySince: hoursAgo(20), temporaryReason: "probe_folder", archivedAt: hoursAgo(1), categoryBaustelleSlug: "nyxos" }),
      row("a2-sub", { parentId: "claude:a2", archivedAt: hoursAgo(1) }),
      row("vis"),
    ]);
    const res = await t.app.request("/api/temporary/archive");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string; href: string; temporaryReason: string | null; archivedAt: string }[] };
    expect(body.sessions.map((s) => s.id)).toEqual(["claude:a2", "claude:a1"]);
    expect(body.sessions[0]).toMatchObject({ href: "/sessions/coding/nyxos/a2", temporaryReason: "probe_folder" });
  });
});
