// Zahlen, die stimmen. (1) „Ungesichert“ ist im Überblick und auf Git derselbe Wert aus EINER
// Quelle (nur Repos/Worktrees, die der letzte Scan gesehen hat — vorher zählte der Überblick auch Zeilen
// längst gelöschter Worktrees: 10.473 statt 2.657). (2) Der Tages-Trend „Tokens heute“ vergleicht mit
// gestern bis zur gleichen Uhrzeit (Europe/Berlin) und zeigt vor 06:00 gar keinen Vergleich.
import { describe, expect, it } from "vitest";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { upsertGitSnapshot } from "../src/git/store.js";
import { getGitDashboard } from "../src/git/dashboard.js";
import { getUsageComparison } from "../src/usage/compare.js";
import { setup } from "./helpers.js";

const file = (path: string) => ({ path, statusCode: ".M", group: "projekt" as const });

function repo(over: Record<string, unknown>) {
  return {
    label: "Repo",
    kind: "app",
    root: "/x",
    currentBranch: "main",
    headSha: "abc",
    branches: [],
    uncommitted: [],
    recentCommits: [],
    probeMerges: [],
    tags: [],
    scannedAt: new Date().toISOString(),
    ...over,
  };
}

const usageRow = (ts: string, input: number, tool = "claude") => ({
  ts,
  tool,
  model: tool === "claude" ? "claude-opus-5" : "gpt-6",
  project: "andere",
  sessionKey: null,
  input,
  output: 0,
  cacheRead: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  reasoning: 0,
});

describe("„Ungesichert“ überall derselbe Wert", () => {
  it("Überblick und Git zählen nur, was der letzte Scan gesehen hat, mit Aufschlüsselung Repos · Worktrees", async () => {
    const { db } = await setup();
    const now = Date.now();
    // Ein Worktree, den es nicht mehr gibt: vor 2 Std zuletzt gescannt, seine Zeilen liegen noch in der DB.
    await upsertGitSnapshot(db, {
      collectedAt: new Date(now - 2 * 3_600_000).toISOString(),
      repos: [repo({ repoId: "wt-alt", label: "alt", kind: "worktree", root: "/wt/alt", parentRepoId: "app", uncommitted: [file("a"), file("b"), file("c"), file("d"), file("e")], scannedAt: new Date(now - 2 * 3_600_000).toISOString() })],
    } as never);
    await upsertGitSnapshot(db, {
      collectedAt: new Date(now).toISOString(),
      repos: [
        repo({ repoId: "app", label: "App-Repo", kind: "app", root: "/app", uncommitted: [file("x"), file("y"), file("z")], scannedAt: new Date(now).toISOString() }),
        repo({ repoId: "wt-neu", label: "neu", kind: "worktree", root: "/wt/neu", parentRepoId: "app", uncommitted: [file("p"), file("q")], scannedAt: new Date(now).toISOString() }),
      ],
    } as never);

    const git = await getGitDashboard(db, { now });
    const overview = await getOverviewSnapshot(db, "Alex", new Date(now));
    const tile = overview.metrics.find((m) => m.key === "uncommitted");

    expect(git.kpis.uncommittedFiles).toBe(5);
    expect(tile?.value).toBe(git.kpis.uncommittedFiles);
    expect(git.kpis.uncommitted).toEqual({ files: 5, places: 2, repoFiles: 3, repoPlaces: 1, worktreeFiles: 2, worktreePlaces: 1 });
    expect(tile?.caption).toBe("3 in Repos · 2 in Worktrees");
    expect(tile?.href).toBe("/git");
  });
});

describe("Tages-Trend gegen gestern bis zur gleichen Uhrzeit", () => {
  it("14:00 Berlin: gestern zählt nur bis 14:00, nicht der ganze Tag", async () => {
    const { db, post } = await setup();
    const res = await post("/ingest/usage", {
      items: [
        usageRow("2026-09-25T10:00:00.000Z", 100), // gestern 12:00 Berlin → zählt
        usageRow("2026-09-25T15:00:00.000Z", 900), // gestern 17:00 Berlin → nach der Uhrzeit, zählt nicht
        usageRow("2026-09-26T09:00:00.000Z", 50), // heute 11:00 Berlin
        usageRow("2026-09-26T09:30:00.000Z", 30, "codex"),
      ],
    });
    expect(res.status).toBe(200);
    const now = new Date("2026-09-26T12:00:00.000Z"); // 14:00 Berlin (Sommerzeit)

    const cmp = await getUsageComparison(db, now);
    expect(cmp.day.comparable).toBe(true);
    expect(cmp.day.until).toBe("14:00");
    expect(cmp.day.today).toMatchObject({ tokens: 80, byTool: { claude: 50, codex: 30 } });
    expect(cmp.day.previous).toMatchObject({ tokens: 100, byTool: { claude: 100, codex: 0 } });

    const overview = await getOverviewSnapshot(db, "Alex", now);
    const tile = overview.metrics.find((m) => m.key === "tokens_today");
    expect(tile?.value).toBe(80);
    expect(tile?.trend).toMatchObject({ current: 80, previous: 100, period: "Tokens heute ggü. gestern bis 14:00" });
  });

  it("00:41 Berlin: kein Trend-Chip (kein „▼ 99 %“ gegen den ganzen Vortag)", async () => {
    const { db, post } = await setup();
    await post("/ingest/usage", {
      items: [usageRow("2026-09-25T12:00:00.000Z", 5_000_000), usageRow("2026-09-25T22:30:00.000Z", 10)], // gestern 14:00, heute 00:30 Berlin
    });
    const now = new Date("2026-09-25T22:41:00.000Z"); // 00:41 Berlin am 26.09.

    const cmp = await getUsageComparison(db, now);
    expect(cmp.day.comparable).toBe(false);
    expect(cmp.day.today.tokens).toBe(10);

    const overview = await getOverviewSnapshot(db, "Alex", now);
    const tile = overview.metrics.find((m) => m.key === "tokens_today");
    expect(tile?.value).toBe(10);
    expect(tile?.trend).toBeNull();
  });
});
