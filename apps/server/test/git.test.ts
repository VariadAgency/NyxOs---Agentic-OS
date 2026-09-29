import type { GitSnapshotPayload } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { getCommitsPerDay, getGitSnapshot, upsertGitSnapshot } from "../src/git/store.js";
import { hashToken } from "../src/app.js";
import { sessions } from "../src/db/schema.js";
import { setup, TOKEN } from "./helpers.js";

function payload(over: Partial<GitSnapshotPayload["repos"][number]> = {}): GitSnapshotPayload {
  return {
    collectedAt: new Date().toISOString(),
    repos: [
      {
        repoId: "app",
        label: "App-Repo",
        kind: "app",
        root: "/Users/alex/projects/App",
        currentBranch: "feature/messenger-e2ee",
        headSha: "a389274d",
        branches: [
          { name: "main", ahead: 0, behind: 0, isCurrent: false, lastCommitAt: "2026-09-24T10:00:00.000Z", upstream: "origin/main" },
          { name: "feature/messenger-e2ee", ahead: 1, behind: 0, isCurrent: true, lastCommitAt: "2026-09-25T08:00:00.000Z", upstream: "origin/feature/messenger-e2ee" },
        ],
        uncommitted: [
          { path: "AGENTS.md", statusCode: ".M", group: "doku" },
          { path: "backend/BACKEND_STATUS.md", statusCode: ".M", group: "doku" },
          { path: "Xcode/App.xcodeproj/project.pbxproj", statusCode: ".M", group: "projekt" },
        ],
        recentCommits: [
          { sha: "a389274d", authorDate: "2026-09-24T10:00:00.000Z", subject: "backup: NAS-Snapshot", branch: "main" },
          { sha: "1dff4d0e", authorDate: "2026-09-23T10:00:00.000Z", subject: "feat: Moments-Feed", branch: "main" },
        ],
        probeMerges: [{ branch: "feature/messenger-e2ee", status: "clean", conflictFiles: [], checkedAt: new Date().toISOString(), workingTreeChecksumBefore: "abc", workingTreeChecksumAfter: "abc" }],
        worktrees: [
          { path: "/Users/alex/projects/.worktrees/notifications", branch: "feat/notification-service", headSha: "ed3e7ad0", locked: false },
          { path: "/Users/alex/projects/.worktrees/integration-verifiziert-2026-09-20", branch: "integration/full-merge-test-2026-09-20", headSha: "819b8c9d", locked: false },
        ],
        tags: ["v1.0"],
        scannedAt: new Date().toISOString(),
        ...over,
      },
    ],
  };
}

describe("Git-Stand", () => {
  it("upsertGitSnapshot + getGitSnapshot geben denselben Stand zurück", async () => {
    const { db } = await setup();
    await upsertGitSnapshot(db, payload());
    const { repos } = await getGitSnapshot(db);
    expect(repos).toHaveLength(1);
    const [app] = repos;
    expect(app).toBeDefined();
    if (!app) return;
    expect(app.currentBranch).toBe("feature/messenger-e2ee");
    expect(app.branches.find((b) => b.name === "feature/messenger-e2ee")?.ahead).toBe(1);
    expect(app.uncommitted).toHaveLength(3);
    expect(app.uncommitted.filter((u) => u.group === "doku")).toHaveLength(2);
    expect(app.uncommitted.filter((u) => u.group === "projekt")).toHaveLength(1);
    expect(app.recentCommits).toHaveLength(2);
    expect(app.probeMerges[0]?.status).toBe("clean");
    expect(app.worktrees).toHaveLength(2);
  });

  it("erneutes Senden ersetzt Zweige/Änderungen/Worktrees vollständig (kein Anhäufen)", async () => {
    const { db } = await setup();
    await upsertGitSnapshot(db, payload());
    // Zweiter Scan: eine Datei wurde committet (verschwindet aus uncommitted), ein Zweig gelöscht.
    const second = payload();
    const [secondRepo] = second.repos;
    if (!secondRepo) throw new Error("Test-Payload ohne Repo");
    secondRepo.uncommitted = secondRepo.uncommitted.slice(0, 1);
    secondRepo.branches = secondRepo.branches.slice(0, 1);
    await upsertGitSnapshot(db, second);
    const { repos } = await getGitSnapshot(db);
    const [after] = repos;
    expect(after?.uncommitted).toHaveLength(1);
    expect(after?.branches).toHaveLength(1);
  });

  it("Commits werden je Kalendertag aggregiert (Überblick-Diagramm)", async () => {
    const { db } = await setup();
    await upsertGitSnapshot(db, payload());
    const days = await getCommitsPerDay(db, 7);
    const total = days.reduce((a, d) => a + d.count, 0);
    expect(total).toBe(2);
  });

  it("Worktree-Zeile trägt die Session, die dort gerade arbeitet", async () => {
    const { db } = await setup();
    await db.insert(sessions).values({
      id: "claude:s1",
      tool: "claude",
      sessionId: "s1",
      cwd: "/Users/alex/projects/.worktrees/notifications",
    });
    await upsertGitSnapshot(db, payload());
    const { repos } = await getGitSnapshot(db);
    const worktrees = repos[0]?.worktrees ?? [];
    const wt = worktrees.find((w) => w.path.endsWith("notifications"));
    expect(wt?.activeSessionKeys).toEqual(["claude:s1"]);
    const other = worktrees.find((w) => w.path.endsWith("integration-verifiziert-2026-09-20"));
    expect(other?.activeSessionKeys).toEqual([]);
  });

  it("POST /ingest/git nimmt eine gültige Momentaufnahme an und lehnt eine kaputte ab", async () => {
    const { post, app } = await setup();
    const good = await post("/ingest/git", payload());
    expect(good.status).toBe(200);
    const bad = await app.request("/ingest/git", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ repos: "kaputt" }) });
    expect(bad.status).toBe(400);
  });

  it("GET /api/git liefert den gespeicherten Stand über HTTP", async () => {
    const { post, app } = await setup();
    await post("/ingest/git", payload());
    const res = await app.request("/api/git");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: unknown[] };
    expect(body.repos).toHaveLength(1);
  });

  it("hashToken bleibt für /ingest/git wie für /ingest/events (dieselbe Auth)", () => {
    expect(hashToken(TOKEN)).toHaveLength(64);
  });
});
