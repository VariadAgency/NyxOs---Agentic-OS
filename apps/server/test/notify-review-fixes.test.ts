// Notifications – fixes from the independent review: quiet hours on the user's wall clock (server mode runs in
// UTC), phone immediately while away, agent worktree sessions count as sub-agents, no foreign links in Nyx' text,
// health check pinned to the checked address (DNS rebinding), waiting session not twice (Telegram + digest).
import { setTimeZone, type PushNotifyInput } from "@nyxos/shared";
import { desc } from "drizzle-orm";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AwayEvent } from "../src/away/notifier.js";
import { AwayWatcher } from "../src/away/watch.js";
import { pushLog, sessions } from "../src/db/schema.js";
import { checkHealthUrl } from "../src/hosting/check.js";
import { isWithinWindow, wallClockMinutes } from "../src/night/window.js";
import { checkNyxText, type NyxNotifyInput } from "../src/notifications/nyx.js";
import { runPipeline, type NotifyEnv } from "../src/notifications/pipeline.js";
import { isQuietNow } from "../src/push/deliver.js";
import { patchSettings } from "../src/push/settings.js";
import { setup } from "./helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

const NOON = new Date("2026-03-02T11:00:00Z");
const NO_QUIET = { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 };
const WORKTREE_AGENT = "/home/dev/projects/app/.claude/worktrees/agent-0123456789abcdef";

type Db = Awaited<ReturnType<typeof setup>>["db"];

function awayEnv(o: { telegram?: boolean; telegramQuestions?: boolean } = {}): NotifyEnv & { batch: AwayEvent[] } {
  const batch: AwayEvent[] = [];
  return {
    batch,
    isAway: () => true,
    enqueueAway: (e) => {
      batch.push(e);
      return true;
    },
    telegramCoversApprovals: () => o.telegram ?? false,
    telegramCoversSessionQuestions: () => o.telegramQuestions ?? false,
  };
}

async function lastRow(db: Db) {
  const [row] = await db.select().from(pushLog).orderBy(desc(pushLog.id)).limit(1);
  return row;
}

describe("Quiet hours on the user's wall clock (not the process zone)", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    setTimeZone(null);
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("22:00–08:00 in the configured zone while the process runs in UTC – summer, winter, DST night", () => {
    process.env.TZ = "UTC";
    setTimeZone("Europe/Berlin");
    const quiet = { quietStart: "22:00", quietEnd: "08:00" };
    expect(isQuietNow(quiet, new Date("2026-09-29T06:30:00Z"))).toBe(false); // 08:30 CEST
    expect(isQuietNow(quiet, new Date("2026-09-28T20:30:00Z"))).toBe(true); // 22:30 CEST
    expect(isQuietNow(quiet, new Date("2026-09-28T19:30:00Z"))).toBe(false); // 21:30 CEST
    expect(isQuietNow(quiet, new Date("2026-01-15T07:30:00Z"))).toBe(false); // 08:30 CET
    expect(isQuietNow(quiet, new Date("2026-01-15T06:30:00Z"))).toBe(true); // 07:30 CET
    expect(isQuietNow(quiet, new Date("2026-10-25T00:30:00Z"))).toBe(true); // 02:30 CEST
    expect(isQuietNow(quiet, new Date("2026-10-25T01:30:00Z"))).toBe(true); // 02:30 CET
    expect(isQuietNow(quiet, new Date("2026-10-25T07:10:00Z"))).toBe(false); // 08:10 CET
    expect(isWithinWindow({ start: "23:00", end: "07:00" }, new Date("2026-09-28T21:30:00Z"))).toBe(true);
    expect(isWithinWindow({ start: "23:00", end: "07:00" }, new Date("2026-09-29T05:30:00Z"))).toBe(false);
  });

  it("follows any zone – nothing is fixed to one country", () => {
    process.env.TZ = "UTC";
    setTimeZone("America/New_York");
    expect(wallClockMinutes(new Date("2026-07-01T03:30:00Z"))).toBe(23 * 60 + 30); // 23:30 EDT
    setTimeZone("Asia/Tokyo");
    expect(wallClockMinutes(new Date("2026-07-01T03:30:00Z"))).toBe(12 * 60 + 30);
  });

  it("an unknown zone name falls back to the process zone instead of crashing", () => {
    setTimeZone("Not/AZone");
    const now = new Date("2026-07-01T03:30:00Z");
    expect(wallClockMinutes(now)).toBe(now.getHours() * 60 + now.getMinutes());
  });
});

describe("Away: important occasions reach the phone immediately", () => {
  const cases: PushNotifyInput[] = [
    { kind: "usage_warning", title: "Nutzung hoch", message: "Claude: 5-Std-Fenster bei 85 %", what: "Claude: 5-Std-Fenster bei 85 %", path: "/usage" },
    { kind: "session_crashed", title: "Session abgestürzt", message: "ist abgestürzt", what: "ist abgestürzt", sessionKey: "claude:s1", path: "/sessions/x" },
    { kind: "approval_needed", title: "Freigabe nötig", message: "git push", what: "git push", sessionKey: "claude:s1", path: "/inbox", priority: "high" },
  ];
  for (const input of cases) {
    it(`${input.kind}: phone immediately (not into the digest)`, async () => {
      const t = await setup();
      const settings = await patchSettings(t.db, NO_QUIET);
      await t.db.insert(sessions).values({ id: "claude:s1", tool: "claude", sessionId: "s1", title: "Push umbauen", titleSource: "ai", state: "waiting" });
      const sender = new FakeNtfySender();
      const env = awayEnv();
      const res = await runPipeline(input, { db: t.db, sender, settings, now: NOON, env });
      expect(res.sent).toBe(true);
      expect(sender.sent[0]?.channels?.ntfy).not.toBe(false);
      expect(env.batch).toHaveLength(0);
    });
  }

  it("approval Telegram sends as a card: phone stays silent", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, NO_QUIET);
    const sender = new FakeNtfySender();
    const env = awayEnv({ telegram: true });
    await runPipeline({ kind: "approval_needed", title: "Freigabe nötig", message: "git push", what: "git push", path: "/inbox", priority: "high" }, { db: t.db, sender, settings, now: NOON, env });
    expect(sender.sent[0]?.channels?.ntfy).toBe(false);
    expect(env.batch).toHaveLength(0);
  });
});

describe("Away + Telegram asks itself: waiting session not twice", () => {
  const waiting: PushNotifyInput = { kind: "session_waiting", title: "Wartet auf dich", message: "Push umbauen", what: "wartet auf dich", sessionKey: "claude:s1", path: "/sessions/x" };

  it("session_waiting comes as a Telegram question – not additionally as a digest line", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, NO_QUIET);
    await t.db.insert(sessions).values({ id: "claude:s1", tool: "claude", sessionId: "s1", title: "Push umbauen", titleSource: "ai", state: "waiting" });
    const sender = new FakeNtfySender();
    const env = awayEnv({ telegramQuestions: true });
    await runPipeline(waiting, { db: t.db, sender, settings, now: NOON, env });
    expect(env.batch).toHaveLength(0);
    expect(sender.sent[0]?.channels?.ntfy).toBe(false);
    expect((await lastRow(t.db))?.decisionNote).toContain("Telegram-Frage");
  });

  it("without Telegram questions it stays in the digest", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, NO_QUIET);
    await t.db.insert(sessions).values({ id: "claude:s1", tool: "claude", sessionId: "s1", title: "Push umbauen", titleSource: "ai", state: "waiting" });
    const env = awayEnv();
    await runPipeline(waiting, { db: t.db, sender: new FakeNtfySender(), settings, now: NOON, env });
    expect(env.batch).toHaveLength(1);
  });
});

describe("Sessions an agent starts in its own worktree are sub-agents", () => {
  it("cwd …/.claude/worktrees/agent-<id> without parent_id → not reported", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, NO_QUIET);
    await t.db.insert(sessions).values({ id: "claude:probe", tool: "claude", sessionId: "probe", title: "Probelauf", titleSource: "ai", cwd: WORKTREE_AGENT, state: "waiting" });
    const sender = new FakeNtfySender();
    const res = await runPipeline(
      { kind: "session_waiting", title: "Wartet auf dich", message: "wartet auf dich", what: "wartet auf dich", sessionKey: "claude:probe", path: "/sessions/x" },
      { db: t.db, sender, settings, now: NOON, env: { isAway: () => false } },
    );
    expect(res).toMatchObject({ sent: false, reason: "sub_agent" });
    expect(sender.sent).toHaveLength(0);
    expect((await lastRow(t.db))?.decision).toBe("sub_agent");
  });

  it("Telegram question: the agent worktree session is not asked, the user's session is", async () => {
    const t = await setup();
    let now = Date.parse("2026-03-02T11:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const base = { tool: "claude", status: "running", state: "waiting", turnOpen: true, screenWaiting: true, stateObservedAt: iso(now - 3_600_000), turnObservedAt: iso(now), lastActivityAt: iso(now), titleSource: "ai" } as const;
    await t.db.insert(sessions).values([
      { ...base, id: "claude:mine", sessionId: "mine", title: "Meine Session", cwd: "/home/dev/projects/app" },
      { ...base, id: "claude:agent", sessionId: "agent", title: "Zahlen zählen", cwd: WORKTREE_AGENT },
    ]);
    const w = new AwayWatcher(t.db, () => now);
    const asked = async () => (await w.scan({ waitingAfterSeconds: 60, skipSubAgents: true })).openQuestions.filter((q) => q.kind === "session").map((q) => q.ref);
    expect(await asked()).toEqual([]);
    now += 2 * 60_000;
    expect(await asked()).toEqual(["claude:mine"]);
  });

  it("a normal session in a worktree folder (without agent-) stays a main session", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, NO_QUIET);
    await t.db.insert(sessions).values({ id: "claude:wt", tool: "claude", sessionId: "wt", title: "Terminal", titleSource: "ai", cwd: "/home/dev/worktrees/feat-x", state: "waiting" });
    const res = await runPipeline(
      { kind: "session_waiting", title: "Wartet auf dich", message: "wartet auf dich", what: "wartet auf dich", sessionKey: "claude:wt", path: "/sessions/x" },
      { db: t.db, sender: new FakeNtfySender(), settings, now: NOON, env: { isAway: () => false } },
    );
    expect(res.sent).toBe(true);
  });
});

describe("Health check (/api/hosting/check): DNS rebinding", () => {
  it("the connection uses the checked address – a second DNS look into the internal network is blocked", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, checks: { database: { ok: true } } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      // Rebinding: the first look (check) says "public", every further one "127.0.0.1".
      let calls = 0;
      const resolve = async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
      const r = await checkHealthUrl(`http://localhost.:${port}`, { policy: { allowPrivate: false, resolve }, allowedHosts: new Set(), timeoutMs: 3000 }, { hostMatters: false });
      expect(r.reachable).toBe(false);
      expect(r.code).toBe("blocked");
      // Counter-check: allowed address (local mode) → the pinned connection works and recognises NyxOS.
      const ok = await checkHealthUrl(`http://localhost.:${port}`, { policy: { allowPrivate: true, resolve: async () => ["127.0.0.1"] }, allowedHosts: new Set(), timeoutMs: 3000 }, { hostMatters: false });
      expect(ok).toMatchObject({ reachable: true, isNyx: true, status: 200, code: "no_https" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("Nyx writes: no addresses that are not in the data", () => {
  const input: NyxNotifyInput = {
    kind: "session_waiting",
    kindLabel: "Session wartet",
    priority: "default",
    away: true,
    time: "22:47",
    style: "zusammenhang",
    title: "Wartet auf dich",
    body: "„Push umbauen“ wartet seit 22:47 auf dich.",
    was: "wartet auf dich",
    details: null,
    session: null,
    important: "",
    examples: [],
    review: false,
    write: true,
  };
  it("link from an (injected) session text → template", () => {
    expect(checkNyxText("Wartet auf dich", "Bitte hier neu anmelden: https://evil.example/login", input)).not.toBeNull();
    expect(checkNyxText("Wartet auf dich", "Bitte auf evil-login.com bestätigen.", input)).not.toBeNull();
    expect(checkNyxText("Wartet auf dich", "Push umbauen wartet auf deine Antwort.", input)).toBeNull();
  });
});
