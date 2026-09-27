// Berliner Tagesfenster. (1) Tages-Trend „gestern bis zur gleichen Uhrzeit“ meint die Berliner Wanduhr — auch an den
// Tagen rund um die Zeitumstellung (23-/25-Stunden-Tag). Vorher wurde die vergangene Zeit seit Mitternacht auf
// gestern gelegt: am Montag nach der Winterzeit-Umstellung stand „bis 14:00“, gezählt wurde gestern aber nur bis 13:00.
// (2) Nyx (`git_lage`) zählt Worktrees und „Ungesichert“ wie Überblick und Git-Seite — ohne gelöschte Worktrees.
import { describe, expect, it } from "vitest";
import { getGitDashboard, getUncommittedTotals } from "../src/git/dashboard.js";
import { upsertGitSnapshot } from "../src/git/store.js";
import { buildDefaultRegistry } from "../src/haiku/tools.js";
import { dayWindows } from "../src/usage/periods.js";
import { setup } from "./helpers.js";

describe("dayWindows nach Berliner Wanduhr", () => {
  it("normaler Tag: gestern 00:00 bis gestern 14:00", () => {
    const w = dayWindows(new Date("2026-09-26T12:00:00.000Z")); // Sa 14:00 CEST
    expect(w.previous.start.toISOString()).toBe("2026-09-24T22:00:00.000Z");
    expect(w.previous.end.toISOString()).toBe("2026-09-25T12:00:00.000Z");
    expect(w.until).toBe("14:00");
    expect(w.comparable).toBe(true);
  });

  it("Montag nach der Umstellung auf Winterzeit (gestern 25 Std): gestern bis 14:00 Wanduhr, nicht 13:00", () => {
    const w = dayWindows(new Date("2026-10-26T13:00:00.000Z")); // Mo 14:00 CET
    expect(w.until).toBe("14:00");
    expect(w.previous.start.toISOString()).toBe("2026-10-24T22:00:00.000Z"); // So 00:00 CEST
    expect(w.previous.end.toISOString()).toBe("2026-10-25T13:00:00.000Z"); // So 14:00 CET
  });

  it("am Umstellungstag selbst (heute 25 Std): gestern bis 14:00 Sommerzeit, nicht 15:00", () => {
    const w = dayWindows(new Date("2026-10-25T13:00:00.000Z")); // So 14:00 CET
    expect(w.until).toBe("14:00");
    expect(w.previous.end.toISOString()).toBe("2026-10-24T12:00:00.000Z"); // Sa 14:00 CEST
  });

  it("Montag nach der Umstellung auf Sommerzeit (gestern 23 Std): gestern bis 14:00, nicht 15:00", () => {
    const w = dayWindows(new Date("2026-03-30T12:00:00.000Z")); // Mo 14:00 CEST
    expect(w.until).toBe("14:00");
    expect(w.previous.start.toISOString()).toBe("2026-03-28T23:00:00.000Z"); // So 00:00 CET
    expect(w.previous.end.toISOString()).toBe("2026-03-29T12:00:00.000Z"); // So 14:00 CEST
  });

  it("„ab 06:00“ ist Wanduhr: am 25-Std-Tag um 05:30 noch kein Vergleich (obwohl schon 6,5 Std vergangen)", () => {
    expect(dayWindows(new Date("2026-10-25T04:30:00.000Z")).comparable).toBe(false); // So 05:30 CET
    expect(dayWindows(new Date("2026-10-25T05:00:00.000Z")).comparable).toBe(true); // So 06:00 CET
    expect(dayWindows(new Date("2026-09-25T22:41:00.000Z")).comparable).toBe(false); // 00:41 CEST
  });

  it("gestern endet nie im heutigen Tag, und das Ende liegt nie vor dem Anfang", () => {
    for (const iso of ["2026-10-25T23:30:00.000Z", "2026-03-29T21:59:00.000Z", "2026-10-25T00:30:00.000Z", "2026-03-29T00:30:00.000Z"]) {
      const w = dayWindows(new Date(iso));
      expect(w.previous.end.getTime()).toBeLessThanOrEqual(w.today.start.getTime());
      expect(w.previous.end.getTime()).toBeGreaterThanOrEqual(w.previous.start.getTime());
    }
  });
});

const file = (path: string) => ({ path, statusCode: ".M", group: "projekt" as const });
function repo(over: Record<string, unknown>) {
  return { label: "Repo", kind: "app", root: "/x", currentBranch: "main", headSha: "abc", branches: [], uncommitted: [], recentCommits: [], probeMerges: [], tags: [], scannedAt: new Date().toISOString(), ...over };
}

describe("Nyx zählt „Ungesichert“ und Worktrees wie Überblick und Git", () => {
  it("git_lage lässt gelöschte Worktrees weg und nennt dieselbe Ungesichert-Zahl", async () => {
    const { db } = await setup();
    const now = Date.now();
    const old = new Date(now - 2 * 3_600_000).toISOString();
    await upsertGitSnapshot(db, { collectedAt: old, repos: [repo({ repoId: "wt-alt", label: "alt", kind: "worktree", root: "/wt/alt", parentRepoId: "app", uncommitted: [file("a"), file("b")], scannedAt: old })] } as never);
    const fresh = new Date(now).toISOString();
    await upsertGitSnapshot(db, {
      collectedAt: fresh,
      repos: [
        repo({ repoId: "app", label: "App-Repo", kind: "app", root: "/app", uncommitted: [file("x")], scannedAt: fresh }),
        repo({ repoId: "wt-neu", label: "neu", kind: "worktree", root: "/wt/neu", parentRepoId: "app", uncommitted: [file("p"), file("q"), file("r")], scannedAt: fresh }),
      ],
    } as never);

    const totals = await getUncommittedTotals(db);
    const git = await getGitDashboard(db, { now });
    const nyx = (await buildDefaultRegistry().call("full", "git_lage", {}, { db, scope: "full", ideaLink: null, ideas: null })) as {
      repos_gesamt: number;
      worktrees: number;
      repos: { name: string }[];
      ungesichert: { dateien: number; in_repos: number; in_worktrees: number; text: string };
    };

    expect(totals.files).toBe(4);
    expect(git.kpis.uncommitted?.files).toBe(4);
    expect(nyx.ungesichert).toEqual({ dateien: 4, in_repos: 1, in_worktrees: 3, text: "1 in Repos · 3 in Worktrees" });
    expect(nyx.worktrees).toBe(1);
    expect(nyx.repos_gesamt).toBe(2);
    expect(nyx.repos.map((r) => r.name)).not.toContain("alt");
  });
});
