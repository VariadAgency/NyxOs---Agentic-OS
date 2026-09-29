// Sessions ohne eine einzige Frage vom Nutzer (leere/abgebrochene Starts, nur Hook-Ereignisse,
// kein Titel) stehen weder in „Zuletzt fertig“ noch im Briefing unter „Was lief“.
import { describe, expect, it } from "vitest";
import { sessionEvents, sessions } from "../src/db/schema.js";
import { collectFacts } from "../src/haiku/report.js";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { setup } from "./helpers.js";

const NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
type Row = typeof sessions.$inferInsert;
const ended = (id: string, m: number, over: Partial<Row> = {}): Row => ({
  id: `claude:${id}`,
  tool: "claude",
  sessionId: id,
  machineId: "m1",
  status: "ended",
  state: null,
  turnOpen: false,
  cwd: "/Users/alex/projects",
  startedAt: minsAgo(m + 5),
  sessionEndReceivedAt: minsAgo(m),
  endedAt: minsAgo(m),
  lastActivityAt: minsAgo(m),
  ...over,
});

describe("leere Sessions ohne Frage", () => {
  it("fehlen in „Zuletzt fertig“ und „Was lief“, Sessions mit Frage bleiben (auch ohne Titel)", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([ended("leer", 1, { title: null }), ended("frage-ohne-titel", 2, { title: null }), ended("echt", 3, { title: "Echte Arbeit" })]);
    await t.db.insert(sessionEvents).values([
      { id: "e1", sessionKey: "claude:leer", ts: minsAgo(1), kind: "hook", source: "hook", data: {} },
      { id: "e2", sessionKey: "claude:frage-ohne-titel", ts: minsAgo(2), kind: "prompt", source: "transcript", data: { text: "Bau mir X" } },
    ]);
    const o = await getOverviewSnapshot(t.db, "Alex", NOW);
    const done = JSON.stringify(o.recentDone);
    expect(done).not.toContain("claude:leer");
    expect(done).toContain("frage-ohne-titel");
    expect(done).toContain("Echte Arbeit");
    const lief = JSON.stringify((await collectFacts(t.db, "briefing", NOW)).filter((f) => f.section === "Was lief"));
    expect(lief).not.toContain("claude:leer");
  });
});

describe("Titel-Ersatz statt Kennung", () => {
  it("ohne Titel: „Session vom TT.MM., HH:MM“ statt der 8-stelligen Kennung", async () => {
    const { sessionTitle } = await import("../src/overview/snapshot.js");
    expect(sessionTitle({ title: null, sessionId: "9a32111e-aaaa-bbbb", lastActivityAt: "2026-09-25T12:05:00.000Z" })).toBe("Session vom 25.09., 14:05");
    expect(sessionTitle({ title: null, sessionId: "9a32111e-aaaa-bbbb", lastActivityAt: null })).not.toContain("9a32111e");
    expect(sessionTitle({ title: "Echte Arbeit", sessionId: "x", lastActivityAt: null })).toBe("Echte Arbeit");
  });
});
