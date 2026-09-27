// Der Überblick bekommt die verwaisten Sessions (Aufräum-Zeile) und fertige Namen (`sessionLabel`)
// für „Kritische Sessions“, „Verwaist“ und „Zuletzt fertig“ – nie eine Kennung, nie „(noch ohne Titel)“.
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { getOverviewSnapshot, ORPHANED_LIMIT } from "../src/overview/aggregate.js";
import { setup } from "./helpers.js";

const NOW = new Date("2026-09-26T01:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
type Row = typeof sessions.$inferInsert;
const base = (id: string, over: Partial<Row> = {}): Row => ({
  id: `claude:${id}`,
  tool: "claude",
  sessionId: id,
  machineId: "m1",
  status: "running",
  state: "waiting",
  turnOpen: false,
  startedAt: hoursAgo(30),
  lastActivityAt: hoursAgo(30),
  ...over,
});
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}/i;

describe("Überblick: verwaiste Sessions und Namen", () => {
  it("liefert die verwaisten Sessions getrennt von „Kritische Sessions“, mit Namen und Link", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      base("8dcb7b0e-e737-4a1b-9c2d-000000000001", { title: null, cwd: "/Users/alex/projects/tools/NyxOS", parsedEventCount: 0, tokensTotal: 0 }),
      base("8dcb7b0e-e737-4a1b-9c2d-000000000002", { title: null, cwd: null, parsedEventCount: 3, tokensTotal: 900, startedAt: hoursAgo(2), lastActivityAt: hoursAgo(2) }),
    ]);
    const ov = await getOverviewSnapshot(t.db, "Alex", NOW);
    expect(ov.orphanedSessions.map((s) => s.sessionKey)).toEqual(["claude:8dcb7b0e-e737-4a1b-9c2d-000000000001"]);
    const [orphan] = ov.orphanedSessions;
    expect(orphan?.label).toMatch(/^NyxOS · Session vom /);
    expect(orphan?.reason).toMatch(/^verwaist/);
    expect(orphan?.href).toContain("8dcb7b0e-e737-4a1b-9c2d-000000000001");
    expect(ov.criticalSessions.map((s) => s.sessionKey)).toEqual(["claude:8dcb7b0e-e737-4a1b-9c2d-000000000002"]);
    for (const s of [...ov.criticalSessions, ...ov.orphanedSessions]) {
      expect(s.label).not.toMatch(UUID_LIKE);
      expect(s.label).not.toContain("ohne Titel");
    }
  });

  it("Liste begrenzt, Zahl vollständig; nur Namen/Grund/Link, kein Ordnerpfad", async () => {
    const t = await setup();
    const rows = Array.from({ length: ORPHANED_LIMIT + 3 }, (_, i) =>
      base(`0rph0000-0000-4000-8000-${String(i).padStart(12, "0")}`, { title: null, cwd: "/Users/alex/geheim/Projekt", parsedEventCount: 0, tokensTotal: 0 }),
    );
    await t.db.insert(sessions).values(rows);
    const ov = await getOverviewSnapshot(t.db, "Alex", NOW);
    expect(ov.orphanedSessions).toHaveLength(ORPHANED_LIMIT);
    expect(ov.orphanedTotal).toBe(ORPHANED_LIMIT + 3);
    expect(Object.keys(ov.orphanedSessions[0] ?? {}).sort()).toEqual(["href", "label", "reason", "sessionId", "sessionKey", "state", "title", "tool"]);
    expect(JSON.stringify(ov.orphanedSessions)).not.toContain("/Users/alex/geheim");
  });

  it("„Zuletzt fertig“ nennt Sessions ohne Titel nach Ordner + Zeit (wie überall)", async () => {
    const t = await setup();
    await t.db.insert(sessions).values(
      base("9a32111e-aaaa-4bbb-8ccc-000000000003", {
        // Kennung als Titel (so setzte ein alter Index ihn) – zählt als „ohne Titel“, steht aber im Rückblick.
        title: "9a32111e",
        cwd: "/Users/alex/projects/tools/NyxOS/.claude/worktrees/agent-x",
        status: "ended",
        state: null,
        parsedEventCount: 8,
        tokensTotal: 4000,
        endedAt: hoursAgo(1),
        sessionEndReceivedAt: hoursAgo(1),
        lastActivityAt: hoursAgo(1),
      }),
    );
    const ov = await getOverviewSnapshot(t.db, "Alex", NOW);
    const done = ov.recentDone.find((d) => d.kind === "session");
    expect(done?.title).toMatch(/^NyxOS · Session vom /);
  });
});
