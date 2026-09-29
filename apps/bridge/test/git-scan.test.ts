// Git-Scan in der installierten Brücke + Daten für die Git-Seite.
// Echte `git`-Aufrufe gegen TEMPORÄRE Mini-Repos mit Worktree, Merge, Reset und Checkout —
// nie gegen ein echtes Repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { GitScanProgress, GitSnapshotPayload } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/daemon.js";
import { runGitCollector, scanAllRepos } from "../src/git/collector.js";
import { classifyReflogSubject, unquoteGitPath } from "../src/git/parse.js";
import { GitWatcher } from "../src/git/watch.js";
import { resolveRunOptions } from "../src/run-options.js";
import { noLog, sandbox } from "./helpers.js";

const dirs: string[] = [];
const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (;;) {
    const dir = dirs.pop();
    if (!dir) break;
    rmSync(dir, { recursive: true, force: true });
  }
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "NyxOS Test", GIT_COMMITTER_NAME: "NyxOS Test", GIT_AUTHOR_EMAIL: "t@z.local", GIT_COMMITTER_EMAIL: "t@z.local" } });
}

function initRepo(dir: string, branch = "main"): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t@z.local");
  git(dir, "config", "user.name", "NyxOS Test");
}

function commitFile(dir: string, name: string, content: string, msg: string): void {
  writeFileSync(join(dir, name), content);
  git(dir, "add", name);
  git(dir, "commit", "-q", "-m", msg);
}

/**
 * Baut einen Projektordner `<root>` mit drei Repos: `app` (+ Worktree unter `.worktrees`), `nyxos`
 * (+ Agenten-Worktree) und `misc/sites/2026/website` (master, zu tief für die Suche — nur über sessions.cwd).
 */
function buildTree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-h-")));
  dirs.push(root);
  const app = join(root, "app");
  initRepo(app);
  commitFile(app, "a.txt", "a\n", "init");
  git(app, "checkout", "-q", "-b", "feature/x");
  commitFile(app, "b.txt", "b1\nb2\n", "feat: b");
  git(app, "checkout", "-q", "main");
  commitFile(app, "c.txt", "c\n", "fix: c");
  git(app, "merge", "-q", "--no-ff", "feature/x", "-m", "Merge feature/x");
  git(app, "reset", "-q", "--soft", "HEAD");
  writeFileSync(join(app, ".git", "info", "exclude"), "/.worktrees/\n");
  const wt = join(app, ".worktrees", "wt1");
  git(app, "worktree", "add", "-q", "-b", "auftrag/wt1", wt, "main");
  commitFile(wt, "d.txt", "d\n", "feat: d im Worktree");
  writeFileSync(join(wt, "offen.md"), "ungesichert\n");

  const nyxos = join(root, "nyxos");
  initRepo(nyxos);
  commitFile(nyxos, "package.json", '{ "name": "nyxos" }\n', "init nyxos");
  const agentWt = join(nyxos, ".claude", "worktrees", "agent-x");
  git(nyxos, "worktree", "add", "-q", "-b", "worktree-agent-x", agentWt, "main");

  const website = join(root, "misc", "sites", "2026", "website");
  initRepo(website, "master");
  commitFile(website, "index.html", "<p>hi</p>\n", "init website");
  mkdirSync(join(website, "sub"), { recursive: true });

  return { root, app, wt, nyxos, agentWt, website };
}

/** Fingerabdruck eines Repos: HEAD, Status, Reflog-Länge — muss vor/nach dem Scan gleich sein. */
function fingerprint(dir: string): string {
  return [git(dir, "rev-parse", "HEAD"), git(dir, "status", "--porcelain=v2", "--branch"), git(dir, "reflog").split("\n").length].join("|");
}

describe("Git-Scan läuft in der installierten Brücke (run-options)", () => {
  it("ohne --data-dir (installierte Brücke) ist die Git-Erfassung AN", () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxos-run-h-"));
    dirs.push(dir);
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ serverUrl: "http://127.0.0.1:47801", token: "echt", projectRoots: ["/x/projekte"] }));
    const prev = process.env.NYXOS_GIT_CATCHUP_APPLY;
    delete process.env.NYXOS_GIT_CATCHUP_APPLY;
    try {
      const { daemonOpts } = resolveRunOptions([], configFile);
      expect(daemonOpts.git).toBeDefined();
      // Nachziehen bleibt ohne ausdrückliche Freigabe aus.
      expect(daemonOpts.git?.applyCatchups).toBe(false);
    } finally {
      if (prev !== undefined) process.env.NYXOS_GIT_CATCHUP_APPLY = prev;
    }
  });
});

describe("Reflog-Texte werden als Aktionen erkannt", () => {
  it.each([
    ["merge feature/x: Merge made by the 'ort' strategy.", "merge"],
    ["commit (merge): Merge branch 'x'", "merge"],
    ["pull: Fast-forward", "pull"],
    ["reset: moving to HEAD~1", "reset"],
    ["checkout: moving from main to feature/x", "checkout"],
    ["rebase (finish): returning to refs/heads/x", "rebase"],
    ["cherry-pick: fix", "cherry-pick"],
    ["revert: Revert \"x\"", "revert"],
    ["commit (amend): neu", "amend"],
    ["commit: feat: x", "commit"],
    ["update by push", "push"],
  ])("%s → %s", (subject, action) => {
    expect(classifyReflogSubject(subject)?.action).toBe(action);
  });

  it("Zwischenschritte eines Rebase zählen nicht als eigene Aktion", () => {
    expect(classifyReflogSubject("rebase (pick): x")).toBeNull();
    expect(classifyReflogSubject("rebase (start): checkout main")).toBeNull();
  });
});

describe("Dateinamen mit Umlauten/Sonderzeichen kommen lesbar an", () => {
  it("unquoteGitPath dekodiert Gits C-Anführungszeichen", () => {
    expect(unquoteGitPath('"docs/K\\303\\274nstler.txt"')).toBe("docs/Künstler.txt");
    expect(unquoteGitPath('"a\\"b.md"')).toBe('a"b.md');
    expect(unquoteGitPath("normal/pfad.swift")).toBe("normal/pfad.swift");
  });

  it("echter Scan: ungesicherte und committete Umlaut-Dateien ohne \\303-Salat", async () => {
    const t = buildTree();
    writeFileSync(join(t.app, "Künstler Übersicht.md"), "x\n");
    git(t.app, "add", "Künstler Übersicht.md");
    git(t.app, "commit", "-q", "-m", "docs: Künstler");
    writeFileSync(join(t.app, "Änderung.txt"), "neu\n");
    const repos = await scanAllRepos({ projectRoots: [t.root], log: noLog, sessionCwds: [] });
    const app = repos.find((r) => r.repoId === "repo:app");
    expect(app?.uncommitted.map((u) => u.path)).toContain("Änderung.txt");
    expect(app?.recentCommits.find((c) => c.subject === "docs: Künstler")?.files?.[0]?.path).toBe("Künstler Übersicht.md");
  });
});

describe("scanAllRepos gegen echte Mini-Repos (Worktree, Merge, Reset, Checkout)", () => {
  it("liefert jedes Repo im Projektordner (+ Worktrees), NyxOS und ein weiteres Repo aus sessions.cwd — nur lesend", async () => {
    const t = buildTree();
    const before = [t.app, t.wt, t.nyxos, t.agentWt, t.website].map(fingerprint);

    const repos = await scanAllRepos({ projectRoots: [t.root], log: noLog, sessionCwds: [join(t.website, "sub"), "/gibt/es/nicht"] });

    const byId = new Map(repos.map((r) => [r.repoId, r]));
    const app = byId.get("repo:app");
    expect(app?.kind).toBe("other");
    expect(app?.mainBranch).toBe("main");
    // Commits aller Zweige, mit Eltern und Datei-Statistik (Commit → Diff-Übersicht).
    const merge = app?.recentCommits.find((c) => c.subject === "Merge feature/x");
    expect(merge?.parents).toBe(2);
    const fixC = app?.recentCommits.find((c) => c.subject === "fix: c");
    expect(fixC?.files).toEqual([{ path: "c.txt", add: 1, del: 0 }]);
    expect(fixC?.insertions).toBe(1);
    const featB = app?.recentCommits.find((c) => c.subject === "feat: b");
    expect(featB?.files?.[0]).toEqual({ path: "b.txt", add: 2, del: 0 });
    expect(app?.recentCommits.some((c) => c.subject === "feat: d im Worktree")).toBe(true);
    // Zweig → Commits: eigene Commits des Worktree-Zweigs.
    const wtBranch = app?.branches.find((b) => b.name === "auftrag/wt1");
    expect(wtBranch?.ahead).toBe(1);
    expect(wtBranch?.aheadShas).toHaveLength(1);
    // Aktions-Log aus dem Reflog (nur gelesen).
    const actions = new Set(app?.reflog?.map((a) => a.action));
    expect(actions.has("merge")).toBe(true);
    expect(actions.has("checkout")).toBe(true);
    expect(actions.has("reset")).toBe(true);
    expect(app?.reflog?.every((a) => a.worktreePath === t.app)).toBe(true);
    // Worktrees des Repos (git worktree list).
    expect(app?.worktrees?.map((w) => w.path)).toContain(t.wt);

    const wt = byId.get("worktree:app:wt1");
    expect(wt?.kind).toBe("worktree");
    expect(wt?.parentRepoId).toBe("repo:app");
    expect(wt?.currentBranch).toBe("auftrag/wt1");
    expect(wt?.branches).toHaveLength(1);
    expect(wt?.branches[0]?.ahead).toBe(1);
    expect(wt?.uncommitted.map((u) => u.path)).toEqual(["offen.md"]);
    expect(wt?.lastActivityAt).toBeTruthy();
    // Commits gehören dem Eltern-Repo — die Worktree schickt sie nicht doppelt.
    expect(wt?.recentCommits).toEqual([]);
    expect(wt?.reflog?.length ?? 0).toBeGreaterThan(0);
    // Kein leerer Eintrag im Aktions-Log (git worktree add schreibt einen ohne Text).
    const allActions = [...(app?.reflog ?? []), ...(wt?.reflog ?? [])];
    expect(allActions.every((a) => a.subject.trim().length > 0)).toBe(true);

    const nyxos = byId.get("nyxos");
    expect(nyxos?.kind).toBe("nyxos");
    const agent = byId.get("worktree:nyxos:agent-x");
    expect(agent?.kind).toBe("worktree");
    expect(agent?.parentRepoId).toBe("nyxos");
    expect(agent?.currentBranch).toBe("worktree-agent-x");

    const website = byId.get("repo:misc/sites/2026/website");
    expect(website?.kind).toBe("other");
    expect(website?.mainBranch).toBe("master");
    expect(website?.recentCommits[0]?.subject).toBe("init website");

    // Nur lesend: nichts an den Repos hat sich verändert (HEAD, Status, Reflog).
    expect([t.app, t.wt, t.nyxos, t.agentWt, t.website].map(fingerprint)).toEqual(before);
  });
});

describe("Fortschritt wird gemeldet (für „Brücke scannt gerade …“)", () => {
  it("meldet Start (0 von N), jeden Schritt und das Ende; die Momentaufnahme enthält alle Repos", async () => {
    const t = buildTree();
    const progress: GitScanProgress[] = [];
    const snapshots: GitSnapshotPayload[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/ingest/git/progress")) progress.push(JSON.parse(String(init?.body)) as GitScanProgress);
      else if (u.endsWith("/ingest/git") && init?.method === "POST") snapshots.push(JSON.parse(String(init.body)) as GitSnapshotPayload);
      else if (u.endsWith("/ingest/git/roots")) return new Response(JSON.stringify({ cwds: [] }), { status: 200 });
      else if (u.endsWith("/api/git")) return new Response(JSON.stringify({ repos: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await runGitCollector({ projectRoots: [t.root], serverUrl: "http://fake", token: "x", log: noLog, fetchImpl, probe: true, progressEveryMs: 0 });

    expect(progress[0]?.phase).toBe("scanning");
    expect(progress[0]?.done).toBe(0);
    const total = progress[0]?.total ?? 0;
    expect(total).toBe(4); // app, wt1, nyxos, agent-x
    const last = progress.at(-1);
    expect(last?.phase).toBe("done");
    expect(last?.done).toBe(total);
    expect(progress.some((p) => p.phase === "scanning" && p.done > 0 && p.done < total)).toBe(true);
    const kinds = snapshots[0]?.repos.map((r) => r.kind).sort();
    expect(kinds).toEqual(["nyxos", "other", "worktree", "worktree"]);
    // Probe-Merge lief für den offenen Zweig.
    expect(snapshots[0]?.repos.find((r) => r.repoId === "repo:app")?.probeMerges.some((p) => p.branch === "auftrag/wt1")).toBe(true);
  });
});

describe("Datei-Wächter auf .git (HEAD/refs/logs)", () => {
  it("meldet einen neuen Commit, ignoriert aber reines Lesen", async () => {
    const t = buildTree();
    let hits = 0;
    const w = new GitWatcher(() => hits++, { debounceMs: 50, log: noLog });
    stops.push(() => w.close());
    w.update([join(t.app, ".git")]);
    await sleep(300);
    git(t.app, "status");
    git(t.app, "log", "-1");
    await sleep(400);
    expect(hits).toBe(0);
    commitFile(t.app, "neu.txt", "n\n", "feat: neu");
    for (let i = 0; i < 40 && hits === 0; i++) await sleep(100);
    expect(hits).toBeGreaterThan(0);
  });
});

describe("Brücke scannt sofort beim Start und nach jeder Änderung", () => {
  it("schickt eine Momentaufnahme gleich nach dem Start und nach einem Commit erneut", async () => {
    const t = buildTree();
    const sb = sandbox();
    const posts: number[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/ingest/git") && init?.method === "POST") posts.push(Date.now());
      if (u.endsWith("/ingest/git/roots")) return new Response(JSON.stringify({ cwds: [] }), { status: 200 });
      if (u.endsWith("/api/git")) return new Response(JSON.stringify({ repos: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const started = Date.now();
    const d = await startDaemon(
      { ...sb.cfg, projectRoots: [t.root] },
      {
        spoolDir: join(sb.home, "spool"),
        dbPath: join(sb.home, "support", "buffer.sqlite"),
        log: noLog,
        fetchImpl,
        vault: false,
        git: { intervalMs: 60 * 60_000, probeIntervalMs: 60 * 60_000, watchDebounceMs: 100, minGapMs: 0 },
      },
    );
    stops.push(() => d.stop());
    for (let i = 0; i < 100 && posts.length === 0; i++) await sleep(100);
    expect(posts.length).toBeGreaterThan(0);
    expect((posts[0] ?? 0) - started).toBeLessThan(10_000);
    const n = posts.length;
    commitFile(t.app, "e.txt", "e\n", "feat: e");
    for (let i = 0; i < 100 && posts.length === n; i++) await sleep(100);
    expect(posts.length).toBeGreaterThan(n);
  }, 30_000);
});

describe("Nur lesend: der Scan schreibt nie den Index (kein index.lock neben laufenden Sessions)", () => {
  it("nach einem Scan ist .git/index unverändert, auch wenn Git ihn gern auffrischen würde", async () => {
    const t = buildTree();
    // Gleicher Inhalt, neue Änderungszeit → ein normales `git status` würde den Index neu schreiben.
    const a = join(t.app, "a.txt");
    utimesSync(a, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const index = join(t.app, ".git", "index");
    await sleep(1100);
    const before = statSync(index).mtimeMs;
    await scanAllRepos({ projectRoots: [t.root], log: noLog, sessionCwds: [] });
    expect(statSync(index).mtimeMs).toBe(before);
  });
});

describe("Sicherheit: sessions.cwd kommt aus Verläufen — nur Repos in den Projektordnern", () => {
  it("ein Repo außerhalb, ein Symlink nach draußen und ein ..-Pfad werden nie gescannt", async () => {
    const t = buildTree();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-h-aussen-")));
    dirs.push(outside);
    initRepo(outside);
    commitFile(outside, "geheim.txt", "x\n", "fremdes Repo");
    mkdirSync(join(t.root, "neben", "tief", "unten"), { recursive: true });
    const link = join(t.root, "neben", "tief", "unten", "link-nach-aussen");
    symlinkSync(outside, link);
    const repos = await scanAllRepos({
      projectRoots: [t.root],
      log: noLog,
      sessionCwds: [outside, link, `${t.root}/../${basename(outside)}`],
    });
    expect(repos.some((r) => r.recentCommits.some((c) => c.subject === "fremdes Repo"))).toBe(false);
    expect(repos.every((r) => r.root.startsWith(`${t.root}/`))).toBe(true);
  });
});
