// Welche Repos scannt die Brücke? Jedes Git-Repo in den Projektordnern (der Ordner selbst oder bis zu zwei
// Ebenen darunter), dazu jeweils seine Worktrees (`git worktree list` UND die Ordner unter
// `<repo>/.worktrees`) und jedes weitere Repo, in dem laut `sessions.cwd` gearbeitet wurde. Nur lesend.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { WORKTREE_DIR, type RepoKind } from "@nyxos/shared";
import { accessRoots, underRoot } from "../config.js";
import { runGit } from "./exec.js";
import { parseWorktreeListPorcelain } from "./parse.js";

export interface RepoTarget {
  repoId: string;
  label: string;
  kind: RepoKind;
  root: string;
  parentRepoId: string | null;
  /** Worktree: nur eigener Zweig/Status/Reflog (s. scan.ts). */
  light: boolean;
  includeWorktrees: boolean;
  /** `.git`-Ordner des Repos (für den Datei-Wächter), nur bei Repos selbst. */
  gitDir: string | null;
}

/** Höchstens so viele Session-Ordner je Lauf prüfen (billig, aber nicht unbegrenzt). */
const MAX_SESSION_CWDS = 300;
/** Höchstens so viele Repos aus den Projektordnern (Schutz vor riesigen Ordnern). */
const MAX_REPOS = 100;
/** So tief sucht die Brücke unter einem Projektordner nach Repos (1 = direkte Unterordner). */
const SEARCH_DEPTH = 2;
/** Ordner, in denen nie ein eigenes Projekt-Repo steckt. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "Pods", "DerivedData", "build", "dist", "target", ".build"]);

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function isCheckout(dir: string): Promise<boolean> {
  return (await runGit(dir, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

async function worktreesOf(root: string): Promise<string[]> {
  const out = (await runGit(root, ["worktree", "list", "--porcelain"])).stdout;
  return parseWorktreeListPorcelain(out)
    .map((w) => w.path)
    .filter((p) => p !== root);
}

function repoTarget(root: string, repoId: string, label: string, kind: RepoKind): RepoTarget {
  const gitDir = join(root, ".git");
  return { repoId, label, kind, root, parentRepoId: null, light: false, includeWorktrees: true, gitDir: isDir(gitDir) ? gitDir : null };
}

function worktreeTarget(path: string, repoId: string, parentRepoId: string): RepoTarget {
  return { repoId, label: basename(path), kind: "worktree", root: path, parentRepoId, light: true, includeWorktrees: false, gitDir: null };
}

/** Hauptordner des Repos zu einem beliebigen Ordner darin (auch aus einer Worktree heraus). */
async function mainRootOf(dir: string): Promise<string | null> {
  const r = await runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok) return null;
  const common = r.stdout.trim();
  if (!common) return null;
  // Normalfall: <repo>/.git → Hauptordner <repo>. Ein „nacktes“ Repo hat keinen Arbeitsordner.
  return basename(common) === ".git" ? real(dirname(common)) : null;
}

/** Ist das das NyxOS-Repo selbst? (eigener Abschnitt auf der Git-Seite) */
function isNyxosRepo(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === "nyxos";
  } catch {
    return false;
  }
}

/**
 * Kandidaten für Repos in einem Projektordner: der Ordner selbst, wenn er ein Repo ist, sonst Unterordner
 * mit `.git` (Ordner oder Datei) bis `SEARCH_DEPTH`. In ein gefundenes Repo wird nicht weiter hineingesucht.
 */
function repoCandidates(root: string, limit: number): string[] {
  if (existsSync(join(root, ".git"))) return [root];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > SEARCH_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, ".git"))) out.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

export async function discoverRepos(opts: { projectRoots: readonly string[]; sessionCwds?: string[]; home?: string }): Promise<RepoTarget[]> {
  const targets: RepoTarget[] = [];
  const seenRoots = new Set<string>();
  const usedIds = new Set<string>();
  const add = (t: RepoTarget) => {
    if (seenRoots.has(t.root)) return;
    seenRoots.add(t.root);
    usedIds.add(t.repoId);
    targets.push(t);
  };
  const uniqueId = (base: string) => {
    let id = base;
    for (let i = 2; usedIds.has(id); i++) id = `${base}~${i}`;
    return id;
  };

  /** Ein Haupt-Repo samt Worktrees aufnehmen. `rel` = Pfad relativ zu seinem Projektordner (Kennung). */
  const addRepo = async (main: string, rel: string) => {
    if (seenRoots.has(main)) return;
    const nyxos = isNyxosRepo(main) && !usedIds.has("nyxos");
    const repoId = nyxos ? "nyxos" : uniqueId(`repo:${rel || basename(main)}`);
    add(repoTarget(main, repoId, nyxos ? "NyxOS" : basename(main), nyxos ? "nyxos" : "other"));
    const key = repoId.replace(/^repo:/, "");
    const paths = new Set(await worktreesOf(main));
    const managed = join(main, WORKTREE_DIR);
    try {
      for (const e of readdirSync(managed, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = real(join(managed, e.name));
        if (p && (await isCheckout(p))) paths.add(p);
      }
    } catch {
      // Ordner gibt es (noch) nicht
    }
    for (const p of [...paths].sort()) if (existsSync(p)) add(worktreeTarget(p, uniqueId(`worktree:${key}:${basename(p)}`), repoId));
  };

  const roots = opts.projectRoots.map((r) => real(r)).filter((r): r is string => r !== null);
  for (const root of roots) {
    for (const candidate of repoCandidates(root, Math.max(0, MAX_REPOS - targets.length))) {
      const dir = real(candidate);
      if (!dir || !(await isCheckout(dir))) continue;
      const main = await mainRootOf(dir);
      if (main) await addRepo(main, relative(root, main));
    }
  }

  // Weitere Repos, in denen Sessions gearbeitet haben — nur innerhalb der erlaubten Wurzeln.
  const allowed = accessRoots(roots, opts.home ?? homedir()).map((r) => real(r) ?? r);
  const cwds = [...new Set(opts.sessionCwds ?? [])].slice(0, MAX_SESSION_CWDS);
  const checkedMains = new Set<string>();
  for (const cwd of cwds) {
    const dir = real(cwd);
    if (!dir || !allowed.some((r) => underRoot(dir, r))) continue;
    if ([...seenRoots].some((r) => dir === r || underRoot(dir, r))) continue;
    const main = await mainRootOf(dir);
    if (!main || checkedMains.has(main)) continue;
    checkedMains.add(main);
    const base = allowed.find((r) => underRoot(main, r));
    if (seenRoots.has(main) || !base) continue;
    await addRepo(main, relative(base, main));
  }
  return targets;
}
