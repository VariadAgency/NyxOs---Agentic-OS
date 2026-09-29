// Git-Seite — Ingest (Reflog, Commits mit Dateien, Worktrees mit Eltern-Repo),
// Aggregation (Kennzahlen, Heatmap, Merges, Aktions-Log, getrennte Abschnitte) und die Zuordnung
// Commit → Session (Zeit + Ordner + `git commit`-Werkzeugaufrufe, mit Sicherheitsstufe).
import type { GitBranchDetail, GitCommitDetail, GitDashboard, GitSnapshotPayload, GitWorktreeDetail, RepoSnapshot } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { reservations, sessionEvents, sessions } from "../src/db/schema.js";
import { attributeCommits, matchCommit } from "../src/git/attribution.js";
import { getGitDashboard } from "../src/git/dashboard.js";
import { upsertGitSnapshot } from "../src/git/store.js";
import { setup, TOKEN } from "./helpers.js";

const NOW = Date.parse("2026-09-25T10:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const APP = "/Users/alex/projects/App";
const WT = "/Users/alex/projects/.worktrees/notifications";
const ZEN = "/Users/alex/projects/tools/NyxOS";
const ZWT = "/Users/alex/projects/tools/NyxOS/.claude/worktrees/agent-x";

function repo(over: Partial<RepoSnapshot> & Pick<RepoSnapshot, "repoId" | "kind" | "root">): RepoSnapshot {
  return {
    label: over.repoId,
    currentBranch: "main",
    headSha: "h",
    branches: [],
    uncommitted: [],
    recentCommits: [],
    probeMerges: [],
    tags: [],
    scannedAt: iso(0),
    mainBranch: "main",
    parentRepoId: null,
    ...over,
  };
}

function payload(): GitSnapshotPayload {
  return {
    collectedAt: iso(0),
    repos: [
      repo({
        repoId: "app",
        kind: "app",
        label: "App-Repo",
        root: APP,
        currentBranch: "main",
        branches: [
          { name: "main", ahead: 0, behind: 0, isCurrent: true, lastCommitAt: iso(2 * MIN), upstream: "origin/main", aheadShas: [] },
          { name: "feat/notification-service", ahead: 2, behind: 3, isCurrent: false, lastCommitAt: iso(30 * MIN), upstream: null, aheadShas: ["wt2", "wt1"] },
        ],
        uncommitted: [
          { path: "a.swift", statusCode: ".M", group: "code" },
          { path: "README.md", statusCode: ".M", group: "doku" },
        ],
        recentCommits: [
          { sha: "merge1", authorDate: iso(2 * MIN), committedAt: iso(2 * MIN), subject: "Merge feat/x", branch: "main", parents: 2, authorName: "Alex", files: [{ path: "x.swift", add: 10, del: 2 }], filesChanged: 1, insertions: 10, deletions: 2 },
          { sha: "c-today", authorDate: iso(60 * MIN), committedAt: iso(60 * MIN), subject: "fix: heute", branch: "main", parents: 1, authorName: "Alex", files: [{ path: "a.swift", add: 1, del: 1 }], filesChanged: 1, insertions: 1, deletions: 1 },
          { sha: "c-old", authorDate: iso(20 * DAY), committedAt: iso(20 * DAY), subject: "feat: alt", branch: "main", parents: 1, files: [], filesChanged: 0, insertions: 0, deletions: 0 },
          { sha: "wt1", authorDate: iso(40 * MIN), committedAt: iso(40 * MIN), subject: "feat: push-dienst", branch: "feat/notification-service", parents: 1, files: [{ path: "backend/push.go", add: 120, del: 0 }], filesChanged: 1, insertions: 120, deletions: 0 },
          { sha: "wt2", authorDate: iso(30 * MIN), committedAt: iso(30 * MIN), subject: "feat: push-test", branch: "feat/notification-service", parents: 1, files: [{ path: "backend/push_test.go", add: 40, del: 0 }], filesChanged: 1, insertions: 40, deletions: 0 },
        ],
        probeMerges: [{ branch: "feat/notification-service", status: "conflict", conflictFiles: ["backend/push.go"], checkedAt: iso(5 * MIN), workingTreeChecksumBefore: "a", workingTreeChecksumAfter: "a" }],
        worktrees: [{ path: WT, branch: "feat/notification-service", headSha: "wt2", locked: false }],
        reflog: [
          { id: "r-merge", ref: "HEAD", worktreePath: APP, at: iso(2 * MIN), action: "merge", subject: "merge feat/x: Merge made by the 'ort' strategy.", newSha: "merge1", identity: "Alex" },
          { id: "r-reset", ref: "HEAD", worktreePath: APP, at: iso(3 * MIN), action: "reset", subject: "reset: moving to HEAD~1", newSha: "c-today", identity: "Alex" },
          { id: "r-push", ref: "refs/remotes/origin/main", worktreePath: APP, at: iso(1 * MIN), action: "push", subject: "update by push", newSha: "merge1", identity: "Alex" },
          { id: "r-co", ref: "HEAD", worktreePath: APP, at: iso(4 * MIN), action: "checkout", subject: "checkout: moving from feat/x to main", newSha: "c-today", identity: "Alex" },
        ],
      }),
      repo({
        repoId: "worktree:notifications",
        kind: "worktree",
        label: "notifications",
        root: WT,
        parentRepoId: "app",
        currentBranch: "feat/notification-service",
        headSha: "wt2",
        branches: [{ name: "feat/notification-service", ahead: 2, behind: 3, isCurrent: true, lastCommitAt: iso(30 * MIN), upstream: null, aheadShas: ["wt2", "wt1"] }],
        uncommitted: [{ path: "backend/push.go", statusCode: ".M", group: "code" }],
        lastActivityAt: iso(10 * MIN),
      }),
      repo({
        repoId: "nyxos",
        kind: "nyxos",
        label: "NyxOS",
        root: ZEN,
        branches: [
          { name: "main", ahead: 0, behind: 0, isCurrent: true, lastCommitAt: iso(5 * DAY), upstream: null, aheadShas: [] },
          { name: "worktree-agent-x", ahead: 1, behind: 0, isCurrent: false, lastCommitAt: iso(3 * MIN), upstream: null, aheadShas: ["z1"] },
        ],
        recentCommits: [{ sha: "z1", authorDate: iso(3 * MIN), committedAt: iso(3 * MIN), subject: "Git neu", branch: "worktree-agent-x", parents: 1, files: [{ path: "apps/web/src/features/git/Git.tsx", add: 300, del: 200 }], filesChanged: 1, insertions: 300, deletions: 200 }],
        worktrees: [{ path: ZWT, branch: "worktree-agent-x", headSha: "z1", locked: true }],
      }),
      repo({
        repoId: "worktree:nyxos:agent-x",
        kind: "worktree",
        label: "agent-x",
        root: ZWT,
        parentRepoId: "nyxos",
        currentBranch: "worktree-agent-x",
        branches: [{ name: "worktree-agent-x", ahead: 1, behind: 0, isCurrent: true, lastCommitAt: iso(3 * MIN), upstream: null, aheadShas: ["z1"] }],
        lastActivityAt: iso(1 * MIN),
      }),
    ],
  };
}

async function addSession(db: Awaited<ReturnType<typeof setup>>["db"], id: string, cwd: string, over: Partial<typeof sessions.$inferInsert> = {}) {
  await db.insert(sessions).values({ id, tool: id.split(":")[0] ?? "claude", sessionId: id.split(":")[1] ?? id, cwd, title: `Session ${id}`, startedAt: iso(3 * 60 * MIN), lastActivityAt: iso(0), state: "running", ...over });
}

let evCounter = 0;
async function addToolCall(db: Awaited<ReturnType<typeof setup>>["db"], sessionKey: string, at: string, target: string) {
  evCounter++;
  await db.insert(sessionEvents).values({ id: `ev-${evCounter}`, sessionKey, ts: at, kind: "tool_call", source: "file", data: { name: "Bash", toolUseId: `tu-${evCounter}`, target } });
}

describe("Ingest + Aggregation für die neue Git-Seite", () => {
  it("Kennzahlen, Heatmap, Merges und getrennte Abschnitte (App, Worktrees, NyxOS)", async () => {
    const { db } = await setup();
    await upsertGitSnapshot(db, payload());
    const d: GitDashboard = await getGitDashboard(db, { now: NOW });

    // heute (Berlin): merge1, c-today, wt1, wt2, z1 = 5; 30 Tage: + c-old = 6
    expect(d.kpis.commitsToday).toBe(5);
    expect(d.kpis.commits7d).toBe(5);
    expect(d.kpis.commits30d).toBe(6);
    expect(d.kpis.openBranches).toBe(2); // feat/notification-service + worktree-agent-x
    expect(d.kpis.worktrees).toBe(2);
    expect(d.kpis.uncommittedFiles).toBe(3);
    expect(d.kpis.uncommittedPlaces).toBe(2);

    expect(d.heatmap).toHaveLength(84);
    const today = d.heatmap.at(-1);
    expect(today).toEqual({ day: "2026-09-25", app: 4, nyxos: 1, other: 0 });

    // Nur echte Merge-Commits.
    expect(d.merges.map((m) => m.sha)).toEqual(["merge1"]);

    // Abschnitte sind verschieden: App mit Zweigen/Probe-Merge, Worktree-Karte mit vor/hinter, NyxOS getrennt.
    expect(d.app?.kind).toBe("app");
    expect(d.app?.branches.find((b) => b.name === "feat/notification-service")?.probe?.status).toBe("conflict");
    expect(d.app?.branches.find((b) => b.name === "feat/notification-service")?.checkedOutAt).toBe(WT);
    expect(d.app?.uncommitted.groups).toMatchObject({ code: 1, doku: 1 });
    expect(d.app?.commitsPerDay).toHaveLength(30);
    expect(d.appWorktrees).toHaveLength(1);
    const card = d.appWorktrees[0];
    expect(card?.path).toBe(WT);
    expect(card?.ahead).toBe(2);
    expect(card?.behind).toBe(3);
    expect(card?.uncommitted.total).toBe(1);
    expect(card?.probe?.status).toBe("conflict");
    expect(card?.lastCommit?.sha).toBe("wt2");
    expect(d.nyxos?.kind).toBe("nyxos");
    expect(d.nyxosWorktrees.map((w) => w.path)).toEqual([ZWT]);
    expect(d.others).toEqual([]);
  });

  it("Aktions-Log: Merge, Push, Reset, Checkout aus dem Reflog + Probe-Merge von NyxOS + Reservierung, neueste zuerst", async () => {
    const { db } = await setup();
    await upsertGitSnapshot(db, payload());
    await db.insert(reservations).values({ pathGlob: "App/backend/**", label: "Push-Dienst", sessionKey: null, createdAt: iso(20 * MIN) });
    const d = await getGitDashboard(db, { now: NOW });
    const kinds = d.actions.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["merge", "push", "reset", "checkout", "probe-merge", "reservation"]));
    const push = d.actions.find((a) => a.kind === "push");
    expect(push?.label).toBe("Push");
    expect(push?.where).toBe(APP);
    const probe = d.actions.find((a) => a.kind === "probe-merge");
    expect(probe?.who.type).toBe("nyxos");
    // neueste zuerst
    const times = d.actions.map((a) => Date.parse(a.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // Reflog doppelt senden legt nichts doppelt an.
    await upsertGitSnapshot(db, payload());
    const again = await getGitDashboard(db, { now: NOW });
    expect(again.actions.filter((a) => a.kind === "push")).toHaveLength(1);
  });

  it("leerer Stand: Brücke hat noch nie gescannt → state 'never', keine erfundenen Zahlen", async () => {
    const { db } = await setup();
    const d = await getGitDashboard(db, { now: NOW });
    expect(d.scan.state).toBe("never");
    expect(d.scan.lastScanAt).toBeNull();
    expect(d.kpis.commits30d).toBe(0);
    expect(d.app).toBeNull();
    expect(d.appWorktrees).toEqual([]);
  });

  it("Repos, die die Brücke nicht mehr meldet (Worktree gelöscht), verschwinden aus der Ansicht", async () => {
    const { db } = await setup();
    const p = payload();
    await upsertGitSnapshot(db, p);
    // Zweiter Lauf eine Stunde später ohne die App-Worktree.
    const later = payload();
    later.repos = later.repos.filter((r) => r.repoId !== "worktree:notifications").map((r) => ({ ...r, scannedAt: new Date(NOW + 60 * MIN).toISOString() }));
    await upsertGitSnapshot(db, later);
    const d = await getGitDashboard(db, { now: NOW + 61 * MIN });
    expect(d.appWorktrees).toEqual([]);
    expect(d.app).not.toBeNull();
  });
});

describe("Commit → Session", () => {
  it("git commit in derselben Worktree kurz vor dem Commit → sicher", async () => {
    const { db } = await setup();
    await addSession(db, "claude:wt", WT);
    await addSession(db, "claude:app", APP);
    await addToolCall(db, "claude:wt", iso(40 * MIN + 20_000), 'git add -A && git commit -m "feat: push-dienst"');
    // Andere Session im App-Hauptordner schreibt nur Dateien.
    await addToolCall(db, "claude:app", iso(41 * MIN), "Edit a.swift");
    await upsertGitSnapshot(db, payload());
    await attributeCommits(db, { now: NOW });
    const d = await getGitDashboard(db, { now: NOW });
    const wt1 = d.app?.recentCommits.find((c) => c.sha === "wt1") ?? d.appWorktrees[0]?.lastCommit;
    const all = [...(d.app?.recentCommits ?? []), ...d.merges];
    const row = all.find((c) => c.sha === "wt1") ?? wt1;
    expect(row?.attribution.confidence).toBe("sicher");
    expect(row?.attribution.session?.key).toBe("claude:wt");
    expect(row?.attribution.reason).toMatch(/git commit/);
  });

  it("`git -C <worktree> commit` aus einem anderen Ordner zählt für die Worktree", async () => {
    const { db, app } = await setup();
    await addSession(db, "codex:x", "/Users/alex/projects");
    await addToolCall(db, "codex:x", iso(30 * MIN + 10_000), `git -C ${WT} commit -m test`);
    await upsertGitSnapshot(db, payload());
    await attributeCommits(db, { now: NOW });
    const detail = (await (await app.request("/api/git/commit/app/wt2")).json()) as GitCommitDetail;
    expect(detail.attribution.session?.key).toBe("codex:x");
    expect(detail.attribution.confidence).toBe("sicher");
  });

  it("nur Aktivität im Ordner, kein git-Befehl → vermutet; niemand da → keine", async () => {
    const { db, app } = await setup();
    await addSession(db, "claude:app", APP, { startedAt: iso(90 * MIN), lastActivityAt: iso(55 * MIN) });
    await upsertGitSnapshot(db, payload());
    await attributeCommits(db, { now: NOW });
    const req = async (u: string) => (await (await app.request(u)).json()) as GitCommitDetail;
    const today = await req("/api/git/commit/app/c-today");
    expect(today.attribution.confidence).toBe("vermutet");
    expect(today.attribution.session?.key).toBe("claude:app");
    const old = await req("/api/git/commit/app/c-old");
    expect(old.attribution.confidence).toBe("keine");
    expect(old.attribution.session).toBeNull();
    expect(old.attribution.reason.length).toBeGreaterThan(10);
  });

  it("matchCommit: `cd ~/… && git merge` aus einer anderen Session-Wurzel zählt für den Zielordner", () => {
    const t = NOW;
    const m = matchCommit(
      { at: new Date(t).toISOString(), checkout: ZEN, family: [ZEN, ZWT] },
      { calls: [{ sessionKey: "d", ts: new Date(t - 5_000).toISOString(), cmd: "cd ~/projects/tools/NyxOS && git merge --no-ff r1-h", cwd: "/Users/alex/projects" }], active: [] },
    );
    expect(m).toMatchObject({ sessionKey: "d", confidence: "sicher" });
  });

  it("Aktionen (Reset im Agenten-Ordner) zählen nur Befehle aus genau diesem Ordner", () => {
    const t = NOW;
    const call = { sessionKey: "dirigent", ts: new Date(t - 30_000).toISOString(), cmd: "git reset --hard main", cwd: ZEN };
    const loose = matchCommit({ at: new Date(t).toISOString(), checkout: ZWT, family: [ZEN, ZWT] }, { calls: [call], active: [] }, ["reset"]);
    expect(loose.confidence).toBe("wahrscheinlich");
    const strict = matchCommit({ at: new Date(t).toISOString(), checkout: ZWT, family: [ZEN, ZWT] }, { calls: [call], active: [] }, ["reset"], "Eintrag", { beforeS: 180, exactOnly: true });
    expect(strict).toMatchObject({ sessionKey: null, confidence: "keine" });
  });

  it("matchCommit: zwei Sessions mit git commit im selben Ordner → nur wahrscheinlich, die nähere gewinnt", () => {
    const t = NOW;
    const m = matchCommit(
      { at: new Date(t).toISOString(), checkout: WT, family: [APP, WT] },
      {
        calls: [
          { sessionKey: "a", ts: new Date(t - 30_000).toISOString(), cmd: "git commit -m a", cwd: WT },
          { sessionKey: "b", ts: new Date(t - 90_000).toISOString(), cmd: "git commit -m b", cwd: WT },
        ],
        active: [],
      },
    );
    expect(m.sessionKey).toBe("a");
    expect(m.confidence).toBe("wahrscheinlich");
  });
});

describe("Klick-Ziele (Großansichten) und Brücken-Wege", () => {
  it("Zweig → Commits, Worktree → Sessions, Commit → Dateien", async () => {
    const { db, app } = await setup();
    await addSession(db, "claude:wt", WT);
    await addSession(db, "claude:alt", `${WT}/backend`, { state: "closed", lastActivityAt: iso(2 * DAY) });
    await upsertGitSnapshot(db, payload());

    const branch = (await (await app.request("/api/git/branch/app?name=feat%2Fnotification-service")).json()) as GitBranchDetail;
    expect(branch.commits.map((c) => c.sha)).toEqual(["wt2", "wt1"]);
    expect(branch.branch.probe?.conflictFiles).toEqual(["backend/push.go"]);

    const wt = (await (await app.request(`/api/git/worktree/${encodeURIComponent("worktree:notifications")}`)).json()) as GitWorktreeDetail;
    expect(wt.sessions.map((s) => s.key).sort()).toEqual(["claude:alt", "claude:wt"]);
    expect(wt.card.sessions.open.map((s) => s.key)).toEqual(["claude:wt"]);
    expect(wt.commits.map((c) => c.sha)).toEqual(["wt2", "wt1"]);
    expect(wt.uncommitted.map((u) => u.path)).toEqual(["backend/push.go"]);

    const commit = (await (await app.request("/api/git/commit/app/merge1")).json()) as GitCommitDetail;
    expect(commit.parents).toBe(2);
    expect(commit.files).toEqual([{ path: "x.swift", add: 10, del: 2 }]);
    expect(commit.insertions).toBe(10);
    const missing = await app.request("/api/git/commit/app/gibtsnicht");
    expect(missing.status).toBe(404);

    // Heatmap-Zelle → Commits dieses Tages.
    const day = (await (await app.request("/api/git/commits?day=2026-09-25")).json()) as { commits: { sha: string }[] };
    expect(day.commits.map((c) => c.sha).sort()).toEqual(["c-today", "merge1", "wt1", "wt2", "z1"]);
    expect((await app.request("/api/git/commits?day=kaputt")).status).toBe(400);
  });

  it("Fortschritt der Brücke → „scannt gerade“; Session-Ordner für die Brücke nur mit Token", async () => {
    const { app, post, db } = await setup();
    await addSession(db, "claude:w", "/Users/alex/projects/tools/Website");
    const res = await post("/ingest/git/progress", { phase: "scanning", done: 3, total: 12, current: "App-Repo", startedAt: new Date().toISOString(), finishedAt: null });
    expect(res.status).toBe(200);
    const d = (await (await app.request("/api/git/dashboard")).json()) as GitDashboard;
    expect(d.scan.state).toBe("scanning");
    expect(d.scan.progress?.done).toBe(3);
    expect(d.scan.progress?.total).toBe(12);

    expect((await app.request("/ingest/git/roots")).status).toBe(401);
    const roots = (await (await app.request("/ingest/git/roots", { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { cwds: string[] };
    expect(roots.cwds).toContain("/Users/alex/projects/tools/Website");
  });
});

describe("Integration: archivierte Wegwerf-Sessions in der Git-Seite", () => {
  it("Worktree-Karte/-Großansicht listen sie nicht – die Commit→Session-Zuordnung bleibt erhalten", async () => {
    const { db, app } = await setup();
    await addSession(db, "claude:wt", WT);
    await addSession(db, "claude:weg", WT, { archivedAt: iso(MIN), temporarySince: iso(DAY), temporaryReason: "probe_folder" });
    await addToolCall(db, "claude:weg", iso(40 * MIN + 20_000), 'git commit -m "feat: push-dienst"');
    await upsertGitSnapshot(db, payload());
    await attributeCommits(db, { now: NOW });

    const wt = (await (await app.request(`/api/git/worktree/${encodeURIComponent("worktree:notifications")}`)).json()) as GitWorktreeDetail;
    expect(wt.sessions.map((s) => s.key)).toEqual(["claude:wt"]);
    expect(wt.card.sessions.open.map((s) => s.key)).toEqual(["claude:wt"]);
    expect(wt.card.sessions.total).toBe(1);

    // Urheberschaft bleibt bei der (archivierten) Session, statt fälschlich an den Nutzer zu fallen.
    const detail = (await (await app.request("/api/git/commit/app/wt1")).json()) as GitCommitDetail;
    expect(detail.attribution.session?.key).toBe("claude:weg");
  });
});
