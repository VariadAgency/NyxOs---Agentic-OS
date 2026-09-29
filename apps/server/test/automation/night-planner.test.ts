import type { NightReadyTask, NightSettings } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { nightRuns } from "../../src/db/schema.js";
import { NightPlanner } from "../../src/night/planner.js";
import { setup } from "../helpers.js";
import { FakeMacAvailability, FakeSessionStarter } from "./fakes.js";

const IN_WINDOW = new Date(2026, 0, 1, 23, 30); // 23:30, im Standardfenster 23:00–07:00
const OUTSIDE_WINDOW = new Date(2026, 0, 1, 12, 0);

function task(id: string, runsOn: "server" | "mac" = "server", estimatedTokens = 1000): NightReadyTask {
  return { taskId: id, title: `Aufgabe ${id}`, runsOn, estimatedTokens, goalPath: `auftraege/${id}/GOAL.md` };
}

function settings(overrides: Partial<NightSettings["budget"]> = {}): NightSettings {
  return {
    window: { start: "23:00", end: "07:00" },
    budget: { maxParallelOpus: 2, maxWeeklyFractionPerNight: 0.15, hardTokenLimitPerTask: 100_000, hardTimeLimitMinutesPerTask: 240, ...overrides },
    allApproved: true,
  };
}

describe("NightPlanner", () => {
  it("startet bis zur Parallel-Grenze, weitere Aufgaben bleiben in der Schlange", async () => {
    const { db } = await setup();
    const starter = new FakeSessionStarter();
    const mac = new FakeMacAvailability();
    const planner = new NightPlanner(db, starter, mac, settings({ maxParallelOpus: 2 }), 1_000_000);
    const result = await planner.tick(IN_WINDOW, [task("a1"), task("a2"), task("a3")]);
    expect(result.started).toEqual(["a1", "a2"]);
    expect(result.atCapacity).toBe(true);
    expect(starter.started.map((t) => t.taskId)).toEqual(["a1", "a2"]);
    const rows = await db.select().from(nightRuns);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "running")).toBe(true);
  });

  it("außerhalb des Fensters wird nichts gestartet und Laufendes sauber beendet (Fenster-Ende)", async () => {
    const { db } = await setup();
    const starter = new FakeSessionStarter();
    const mac = new FakeMacAvailability();
    const planner = new NightPlanner(db, starter, mac, settings(), 1_000_000);
    await planner.tick(IN_WINDOW, [task("a1")]);
    expect(planner.runningTaskIds()).toEqual(["a1"]);

    const result = await planner.tick(OUTSIDE_WINDOW, []);
    expect(result.outsideWindow).toBe(true);
    expect(result.stopped).toEqual([{ taskId: "a1", reason: "fenster_ende" }]);
    expect(starter.stopped).toHaveLength(1);
    expect(planner.runningTaskIds()).toEqual([]);
  });

  it("ein knapp gesetztes Token-Budget beendet den Auftrag sauber", async () => {
    const { db } = await setup();
    const starter = new FakeSessionStarter();
    const mac = new FakeMacAvailability();
    const planner = new NightPlanner(db, starter, mac, settings({ hardTokenLimitPerTask: 500 }), 1_000_000);
    await planner.tick(IN_WINDOW, [task("a1")]);
    const sessionKey = starter.started.length > 0 ? (await db.select().from(nightRuns))[0]?.sessionKey : null;
    expect(sessionKey).toBeTruthy();
    starter.setTokens(sessionKey as string, 600); // über der Grenze von 500

    const result = await planner.tick(new Date(IN_WINDOW.getTime() + 60_000), []);
    expect(result.stopped).toEqual([{ taskId: "a1", reason: "token_grenze" }]);
    const [row] = await db.select().from(nightRuns).where(eq(nightRuns.taskId, "a1"));
    expect(row?.status).toBe("stopped_budget");
    expect(row?.tokensUsed).toBe(600);
  });

  it("eine harte Zeitgrenze beendet den Auftrag sauber", async () => {
    const { db } = await setup();
    const starter = new FakeSessionStarter();
    const mac = new FakeMacAvailability();
    const planner = new NightPlanner(db, starter, mac, settings({ hardTimeLimitMinutesPerTask: 30 }), 1_000_000);
    await planner.tick(IN_WINDOW, [task("a1")]);
    const later = new Date(IN_WINDOW.getTime() + 31 * 60_000);
    const result = await planner.tick(later, []);
    expect(result.stopped).toEqual([{ taskId: "a1", reason: "zeit_grenze" }]);
    const [row] = await db.select().from(nightRuns).where(eq(nightRuns.taskId, "a1"));
    expect(row?.status).toBe("stopped_time");
  });

  it("Mac nicht verfügbar: Mac-Auftrag bleibt in der Schlange, Server-Aufträge laufen trotzdem", async () => {
    const { db } = await setup();
    const starter = new FakeSessionStarter();
    const mac = new FakeMacAvailability();
    mac.available = false;
    const planner = new NightPlanner(db, starter, mac, settings({ maxParallelOpus: 5 }), 1_000_000);
    const result = await planner.tick(IN_WINDOW, [task("mac-1", "mac"), task("server-1", "server")]);
    expect(result.skippedMacUnavailable).toEqual(["mac-1"]);
    expect(result.started).toEqual(["server-1"]);
  });

  it("respektiert die 15-%-Nachtgrenze des Wochenlimits", async () => {
    const { db } = await setup();
    const starter = new FakeSessionStarter();
    const mac = new FakeMacAvailability();
    // Wochenlimit 10.000, 15 % = 1.500 Tokens Nachtbudget — eine geschätzte 2000-Tokens-Aufgabe passt nicht mehr.
    const planner = new NightPlanner(db, starter, mac, settings({ maxParallelOpus: 5 }), 10_000);
    const result = await planner.tick(IN_WINDOW, [task("teuer", "server", 2000)]);
    expect(result.started).toEqual([]);
    expect(result.atCapacity).toBe(true);
  });
});
