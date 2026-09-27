// Last: der Git-Scan darf die (unter Last ohnehin knappe) Brücke nicht mit einem Schwall
// gleichzeitiger `git`-Prozesse fluten, und er darf nicht voll scannen, solange der Server (Tunnel)
// gar nicht erreichbar ist — sonst ist die Arbeit verloren und konkurriert nur mit dem Nachimport.
// Gezählt wird unabhängig von der Umsetzung direkt an `execFile`.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => ({ active: 0, peak: 0, total: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((file: string, args: string[], opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    counter.active++;
    counter.total++;
    counter.peak = Math.max(counter.peak, counter.active);
    return real.execFile(file, args, opts, (err, stdout, stderr) => {
      counter.active--;
      cb(err, String(stdout), String(stderr));
    });
  }) as unknown as typeof real.execFile;
  return { ...real, execFile };
});

const { runGitCollector } = await import("../src/git/collector.js");
const { scanRepo } = await import("../src/git/scan.js");
const { GitScheduler } = await import("../src/git/scheduler.js");

const dirs: string[] = [];
const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noLog = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_COMMITTER_NAME: "T", GIT_AUTHOR_EMAIL: "t@z.local", GIT_COMMITTER_EMAIL: "t@z.local" } });
}

/** Repo mit vielen Zweigen (z. B. viele Agenten-Zweige) in einem Projektordner. */
function repoWithBranches(n: number): { root: string; nyxos: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-h-last-")));
  dirs.push(root);
  const nyxos = join(root, "nyxos");
  mkdirSync(nyxos, { recursive: true });
  git(nyxos, "init", "-q", "-b", "main");
  writeFileSync(join(nyxos, "a.txt"), "a\n");
  git(nyxos, "add", "a.txt");
  git(nyxos, "commit", "-q", "-m", "init");
  for (let i = 0; i < n; i++) git(nyxos, "branch", `worktree-agent-${i}`);
  return { root, nyxos };
}

function reset() {
  counter.active = 0;
  counter.peak = 0;
  counter.total = 0;
}

describe("Last: höchstens wenige git-Prozesse gleichzeitig", () => {
  it("ein Repo mit 30 Zweigen startet nie mehr als 4 git-Prozesse auf einmal", async () => {
    const { nyxos } = repoWithBranches(30);
    reset();
    const snap = await scanRepo({ repoId: "nyxos", label: "NyxOS", kind: "nyxos", root: nyxos });
    expect(snap.branches).toHaveLength(31);
    expect(counter.total).toBeGreaterThan(30);
    expect(counter.peak).toBeLessThanOrEqual(4);
  });
});

describe("Last: kein Scan, solange der Server nicht erreichbar ist", () => {
  it("runGitCollector startet keinen git-Prozess, wenn /ingest/git/roots nicht antwortet", async () => {
    const { root } = repoWithBranches(3);
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    reset();
    const r = await runGitCollector({ projectRoots: [root], serverUrl: "http://127.0.0.1:1", token: "x", log: noLog, fetchImpl, probe: true });
    expect(r.ok).toBe(false);
    expect(counter.total).toBe(0);
  });

  it("der Takt holt den ersten Scan kurz nach, sobald der Server erreichbar ist (nicht erst nach 3 Min)", async () => {
    const { root } = repoWithBranches(2);
    let up = false;
    let refused = 0;
    const posts: number[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (!up) {
        refused++;
        throw new TypeError("fetch failed");
      }
      const u = String(url);
      if (u.endsWith("/ingest/git") && init?.method === "POST") posts.push(Date.now());
      if (u.endsWith("/ingest/git/roots")) return new Response(JSON.stringify({ cwds: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const s = new GitScheduler({ projectRoots: [root], serverUrl: "http://x", token: "x", log: noLog, fetchImpl, intervalMs: 60 * 60_000, probeIntervalMs: 60 * 60_000, retryMs: 200 });
    stops.push(() => s.stop());
    s.start();
    // Erst warten, bis der erste Lauf am fehlenden Server gescheitert ist (auch sein Fortschritt/Senden).
    for (let i = 0; i < 50 && refused < 3; i++) await sleep(100);
    await sleep(300);
    expect(posts).toHaveLength(0);
    up = true;
    for (let i = 0; i < 50 && posts.length === 0; i++) await sleep(100);
    expect(posts.length).toBeGreaterThan(0);
  });
});
