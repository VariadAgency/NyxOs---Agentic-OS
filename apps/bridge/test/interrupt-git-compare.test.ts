// Brücken-Seite: „Pausieren“ (Esc in tmux) und der NUR LESENDE Git-Vergleich.
// Echtes tmux auf einem Wegwerf-Socket, echte Wegwerf-Repos — nie App-/NyxOS-Repo.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCompareRawResult } from "@nyxos/shared";
import { afterAll, describe, expect, it } from "vitest";
import { findTmux } from "../src/config.js";
import { TerminalManager } from "../src/terminal/manager.js";
import { tmuxConf } from "../src/terminal/shell.js";
import { Tmux } from "../src/terminal/tmux.js";

const TMUX = findTmux();
const SOCKET = `zc-r1g-${process.pid}`;
const CONF = join(mkdtempSync(join(tmpdir(), "nyxos-r1g-conf-")), "tmux.conf");
writeFileSync(CONF, tmuxConf());
const tmux = new Tmux({ bin: TMUX, socket: SOCKET, conf: CONF });
afterAll(() => {
  spawnSync(TMUX, ["-L", SOCKET, "kill-server"]);
});

const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-r1g-")));
const root = join(base, "projekte");
mkdirSync(root, { recursive: true });
const manager = new TerminalManager({ tmux, projectRoots: [root], path: "/usr/bin:/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });

describe("interrupt („Beide pausieren“)", () => {
  it("arbeitende Session (esc to interrupt) → genau ein Esc in die tmux-Session", async () => {
    const name = "zc-claude-r1gesc01";
    await tmux.newSession({ name, cwd: tmpdir(), cols: 80, rows: 24, env: {}, command: ["/bin/sh", "-c", "stty -icanon -echo min 1; printf 'bereit · arbeitet (esc to interrupt)\\n'; dd bs=1 count=1 2>/dev/null | od -An -c; sleep 30"] });
    expect(await until(async () => (await tmux.capture(name)).includes("bereit"))).toBe(true);
    expect(await manager.rpc("interrupt", { tmuxName: name })).toEqual({ interrupted: true });
    expect(await until(async () => (await tmux.capture(name)).includes("033"))).toBe(true);
  });

  it("unbekannte Session → not_found; ungültiger Name wird nie an tmux gegeben", async () => {
    await expect(manager.rpc("interrupt", { tmuxName: "zc-claude-gibtsnic" })).rejects.toMatchObject({ code: "not_found" });
    await expect(manager.rpc("interrupt", { tmuxName: "; rm -rf /" })).rejects.toThrow();
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

describe("git_compare (nur lesend)", () => {
  const repo = join(root, "App");
  mkdirSync(join(repo, "docs"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const file = join(repo, "docs", "plan.md");
  writeFileSync(file, "eins\nzwei\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "erste Fassung");
  writeFileSync(file, "eins\nzwei neu\n");
  git(repo, "commit", "-q", "-am", "zweite Fassung");
  writeFileSync(file, "eins\nzwei neu\ndrei\n"); // noch nicht gespeichert (Arbeitskopie)
  const indexHash = () => createHash("sha1").update(readFileSync(join(repo, ".git", "index"))).digest("hex");

  it("ohne Stand: nur die letzten Commits der Datei", async () => {
    const r = (await manager.rpc("git_compare", { path: file })) as GitCompareRawResult;
    expect(r.repoRoot).toBe(repo);
    expect(r.relPath).toBe("docs/plan.md");
    expect(r.commits.map((c) => c.subject)).toEqual(["zweite Fassung", "erste Fassung"]);
    expect(r.diff).toBeNull();
  });

  it("zwei Commits vergleichen und Commit ↔ Arbeitskopie", async () => {
    const before = indexHash();
    const status = git(repo, "status", "--porcelain");
    const between = (await manager.rpc("git_compare", { path: file, from: "HEAD~1", to: "HEAD" })) as GitCompareRawResult;
    expect(between.diff).toContain("-zwei\n+zwei neu");
    const work = (await manager.rpc("git_compare", { path: file, from: "HEAD" })) as GitCompareRawResult;
    expect(work.diff).toContain("+drei");
    // nichts verändert: weder Arbeitskopie noch Index
    expect(git(repo, "status", "--porcelain")).toBe(status);
    expect(indexHash()).toBe(before);
  });

  it("noch nie committete Datei: Vergleich mit der Arbeitskopie zeigt sie ganz als neu (statt „keine Unterschiede“)", async () => {
    const fresh = join(repo, "docs", "neu.md");
    writeFileSync(fresh, "ganz\nneu\n");
    const r = (await manager.rpc("git_compare", { path: fresh, from: "HEAD" })) as GitCompareRawResult;
    expect(r.untracked).toBe(true);
    expect(r.diff).toContain("+ganz\n+neu");
    expect(git(repo, "status", "--porcelain")).toContain("?? docs/neu.md"); // weiter nicht hinzugefügt
  });

  it("ausgeblendete Dateien (.env), .git/ und Symlinks werden nie als Inhalt geliefert", async () => {
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, ".env"), "GEHEIM=1\n");
    await expect(manager.rpc("git_compare", { path: join(repo, ".env"), from: "HEAD" })).rejects.toMatchObject({ code: "bad_folder" });
    await expect(manager.rpc("git_compare", { path: join(repo, ".git", "config"), from: "HEAD" })).rejects.toMatchObject({ code: "bad_folder" });
    writeFileSync(join(base, "draussen.txt"), "fremd\n");
    symlinkSync(join(base, "draussen.txt"), join(repo, "docs", "link.md"));
    await expect(manager.rpc("git_compare", { path: join(repo, "docs", "link.md"), from: "HEAD" })).rejects.toMatchObject({ code: "bad_folder" });
  });

  it("Pfad wird wörtlich genommen — kein Pfadmuster über das ganze Repo", async () => {
    // Abgelehnt oder leer — aber nie der Diff von docs/plan.md (der zwischen HEAD~1 und HEAD existiert).
    const diffOf = (path: string) => manager.rpc("git_compare", { path, from: "HEAD~1", to: "HEAD" }).then((r) => (r as GitCompareRawResult).diff ?? "", () => "");
    expect(await diffOf(join(repo, "*"))).toBe("");
    expect(await diffOf(join(repo, ":(glob)**"))).toBe("");
    expect(await diffOf(join(repo, "docs", "*.md"))).toBe("");
    expect(await diffOf(file)).toContain("zwei neu"); // Gegenprobe: echter Pfad geht
  });

  it("„..“ im Pfad wird abgelehnt, auch wenn der Ordner darüber existiert", async () => {
    await expect(manager.rpc("git_compare", { path: `${repo}/docs/../../../fremd.md` })).rejects.toThrow();
    await expect(manager.rpc("git_compare", { path: `${repo}/docs/..` })).rejects.toThrow();
  });

  it("verweigert: außerhalb des Projektordners, unbekannter Stand, Option statt Stand, kein Git-Ordner", async () => {
    await expect(manager.rpc("git_compare", { path: join(base, "fremd.md") })).rejects.toMatchObject({ code: "bad_folder" });
    await expect(manager.rpc("git_compare", { path: file, from: "gibtsnicht123" })).rejects.toMatchObject({ code: "bad_ref" });
    await expect(manager.rpc("git_compare", { path: file, from: "--output=/tmp/x" })).rejects.toThrow();
    mkdirSync(join(root, "ohne-git"), { recursive: true });
    await expect(manager.rpc("git_compare", { path: join(root, "ohne-git", "a.md") })).rejects.toMatchObject({ code: "not_in_repo" });
  });
});
