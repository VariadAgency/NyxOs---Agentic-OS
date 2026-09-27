import { describe, expect, it } from "vitest";
import type { Session } from "../src/lib/api";
import { countStates, groupSessions, statusCounterSentence } from "../src/lib/sessionOrder";

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: overrides.id ?? "claude:default",
    tool: "claude",
    sessionId: "default",
    machineId: null,
    parentId: null,
    title: "Titel",
    titleSource: null,
    status: "running",
    cwd: null,
    gitBranch: null,
    cliVersion: null,
    startedAt: "2026-09-24T10:00:00Z",
    lastActivityAt: "2026-09-24T10:00:00Z",
    endedAt: null,
    models: [],
    tokens: {},
    tokensTotal: 0,
    toolCalls: {},
    subagents: [],
    limits: null,
    parsedEventCount: 0,
    eventCount: 0,
    parseErrors: 0,
    state: "running",
    closedAt: null,
    closedBy: null,
    categoryRuleId: null,
    categoryManual: false,
    art: "coding",
    baustelle: null,
    reason: [],
    contextPct: null,
    contextWindow: null,
    contextWindowSource: null,
    ...overrides,
  };
}

describe("groupSessions", () => {
  it("sortiert offene Sessions: wartet auf dich → läuft → abgestürzt → ruht", () => {
    const sessions = [
      makeSession({ id: "a", state: "idle", lastActivityAt: "2026-09-24T09:00:00Z" }),
      makeSession({ id: "b", state: "crashed", lastActivityAt: "2026-09-24T09:30:00Z" }),
      makeSession({ id: "c", state: "running", lastActivityAt: "2026-09-24T09:45:00Z" }),
      makeSession({ id: "d", state: "waiting", lastActivityAt: "2026-09-24T08:00:00Z" }),
    ];
    const { open } = groupSessions(sessions);
    expect(open.map((row) => row.session.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("sortiert innerhalb desselben Zustands nach letzter Aktivität (neueste zuerst)", () => {
    const sessions = [
      makeSession({ id: "old", state: "running", lastActivityAt: "2026-09-24T08:00:00Z" }),
      makeSession({ id: "new", state: "running", lastActivityAt: "2026-09-24T09:00:00Z" }),
    ];
    const { open } = groupSessions(sessions);
    expect(open.map((row) => row.session.id)).toEqual(["new", "old"]);
  });

  it("zeigt Sub-Agenten unter ihrer Eltern-Session, nicht als eigene Karte", () => {
    const sessions = [
      makeSession({ id: "parent", state: "running" }),
      makeSession({ id: "child", parentId: "parent", state: "running" }),
    ];
    const { open } = groupSessions(sessions);
    expect(open).toHaveLength(1);
    expect(open[0]?.session.id).toBe("parent");
    expect(open[0]?.subagents.map((s) => s.id)).toEqual(["child"]);
  });

  it("legt eine Session mit fehlendem Eltern-Datensatz als eigene Karte an (Eltern nicht geladen)", () => {
    const sessions = [makeSession({ id: "orphan", parentId: "missing-parent", state: "running" })];
    const { open } = groupSessions(sessions);
    expect(open.map((row) => row.session.id)).toEqual(["orphan"]);
  });

  it("trennt geschlossen (state closed) von sauber beendet (state null)", () => {
    const sessions = [
      makeSession({ id: "open", state: "running" }),
      makeSession({ id: "closed", state: "closed", closedAt: "2026-09-24T10:00:00Z", closedBy: "user" }),
      makeSession({ id: "ended", state: null, status: "ended" }),
    ];
    const { open, closed, ended } = groupSessions(sessions);
    expect(open.map((r) => r.session.id)).toEqual(["open"]);
    expect(closed.map((s) => s.id)).toEqual(["closed"]);
    expect(ended.map((s) => s.id)).toEqual(["ended"]);
  });
});

describe("countStates / statusCounterSentence", () => {
  it("zählt Zustände offener Haupt-Sessions", () => {
    const sessions = [
      makeSession({ id: "a", state: "running" }),
      makeSession({ id: "b", state: "running" }),
      makeSession({ id: "c", state: "waiting" }),
    ];
    const { open } = groupSessions(sessions);
    expect(countStates(open)).toEqual({ running: 2, waiting: 1, idle: 0, crashed: 0 });
    expect(statusCounterSentence(open)).toBe("2 läuft · 1 wartet auf dich");
  });

  it("lässt Zustände mit 0 weg", () => {
    const sessions = [makeSession({ id: "a", state: "idle" })];
    const { open } = groupSessions(sessions);
    expect(statusCounterSentence(open)).toBe("1 ruht");
  });
});
