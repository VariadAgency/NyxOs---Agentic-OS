// Baut eine `RepoSnapshot` für EIN Repo (App-Repo, eine Worktree, das NyxOS-Repo
// oder ein weiteres Repo) — nur lesende Git-Aufrufe (s. exec.ts: log, for-each-ref, rev-list,
// status --porcelain, worktree list, reflog), niemals `add`/`commit`/`checkout`/`push`/`fetch`/
// `merge`/`reset`.
//
// Zwei Arten:
// - voll (Repo selbst): alle Zweige mit vor/hinter, Commits aller Zweige der letzten 90 Tage mit
//   Datei-Statistik, Reflog (inkl. Push aus den Remote-Refs), Worktree-Liste, Tags.
// - leicht (`light`, eine Worktree): nur ihr eigener Zweig, ungesicherte Dateien, ihr Reflog und
//   „zuletzt aktiv“. Commits und Zweige teilt sie mit dem Eltern-Repo — die kommen von dort, nicht
//   doppelt je Worktree.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { BranchInfo, CommitInfo, ReflogAction, RepoKind, RepoSnapshot } from "@nyxos/shared";
import { runGit, runGitOrThrow } from "./exec.js";
import {
  branchInfoFrom,
  classifyReflogSubject,
  LOG_NUMSTAT_FORMAT,
  parseAheadBehindCount,
  parseForEachRefBranches,
  parseLogNumstat,
  parseReflog,
  parseStatusPorcelainV2,
  parseTags,
  parseWorktreeListPorcelain,
  REFLOG_FORMAT,
} from "./parse.js";

export interface ScanOptions {
  repoId: string;
  label: string;
  kind: RepoKind;
  root: string;
  /** Zweig, gegen den Vor-/Rückstand gemessen wird. Ohne Angabe: `main`, sonst `master`. */
  mainBranch?: string;
  /** Nur beim Repo selbst: liest zusätzlich `git worktree list`. */
  includeWorktrees?: boolean;
  /** Worktree: nur der eigene Zweig, keine Commits/Tags (s. Kopfkommentar). */
  light?: boolean;
  parentRepoId?: string | null;
  /** Commits dieser Tage (Heatmap 12 Wochen + Puffer). */
  sinceDays?: number;
  commitLimit?: number;
  branchLimit?: number;
}

const SINCE_DAYS = 90;
const REFLOG_LIMIT = 300;
const PUSH_REFS_LIMIT = 30;
const AHEAD_SHAS_LIMIT = 200;
const MTIME_FILES_LIMIT = 300;

/** Vor-/Rückstand EINES Zweigs gegenüber `mainBranch`. Existiert `mainBranch` lokal nicht → 0/0. */
async function aheadBehind(root: string, mainBranch: string, branch: string): Promise<{ ahead: number; behind: number }> {
  if (branch === mainBranch) return { ahead: 0, behind: 0 };
  const r = await runGit(root, ["rev-list", "--left-right", "--count", `${mainBranch}...${branch}`]);
  if (!r.ok) return { ahead: 0, behind: 0 };
  return parseAheadBehindCount(r.stdout);
}

/** Eigene Commits eines Zweigs (die `mainBranch` fehlen), neueste zuerst. */
async function aheadShas(root: string, mainBranch: string, branch: string): Promise<string[]> {
  if (branch === mainBranch) return [];
  const r = await runGit(root, ["rev-list", `--max-count=${AHEAD_SHAS_LIMIT}`, `${mainBranch}..${branch}`]);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter((l) => l.trim().length > 0);
}

/** `main`, sonst `master`, sonst der aktuelle Zweig — nie ein Absturz. */
export async function detectMainBranch(root: string, fallback: string | null): Promise<string> {
  for (const name of ["main", "master"]) {
    if ((await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).ok) return name;
  }
  return fallback ?? "main";
}

function actionId(parts: (string | null)[]): string {
  return createHash("sha1").update(parts.map((p) => p ?? "").join("|")).digest("hex");
}

/** Reflog einer Ref lesen und in Aktionen übersetzen. `keep` filtert (z. B. nur Push bei Remote-Refs). */
async function readReflog(opts: { root: string; repoId: string; ref: string; worktreePath: string; sinceMs: number; limit: number; keep?: (a: ReflogAction["action"]) => boolean }): Promise<{ actions: ReflogAction[]; latestAt: string | null }> {
  const r = await runGit(opts.root, ["log", "-g", "--date=unix", `--format=${REFLOG_FORMAT}`, "-n", String(opts.limit), opts.ref]);
  if (!r.ok) return { actions: [], latestAt: null };
  const entries = parseReflog(r.stdout);
  const latestAt = entries[0]?.at ?? null;
  // `git worktree add` hinterlässt einen Eintrag OHNE Text, oft direkt gefolgt von einem
  // wirkungslosen „reset: moving to HEAD“ in derselben Sekunde — zusammen EINE Aktion „Arbeitskopie angelegt“.
  const createdAt = new Set(entries.filter((e) => e.subject.trim() === "").map((e) => e.at));
  const actions: ReflogAction[] = [];
  for (const e of entries) {
    if (Date.parse(e.at) < opts.sinceMs) continue;
    if (e.subject.trim() === "reset: moving to HEAD" && createdAt.has(e.at)) continue;
    const kind = e.subject.trim() === "" ? { action: "worktree" as const } : classifyReflogSubject(e.subject);
    if (!kind || kind.action === "commit") continue; // einfache Commits stehen in der Commit-Liste
    if (opts.keep && !opts.keep(kind.action)) continue;
    actions.push({
      id: actionId([opts.repoId, opts.ref, opts.worktreePath, e.at, e.newSha, e.subject]),
      ref: opts.ref,
      worktreePath: opts.worktreePath,
      at: e.at,
      action: kind.action,
      subject: kind.action === "worktree" ? "Arbeitskopie angelegt" : e.subject.slice(0, 500),
      newSha: e.newSha,
      identity: e.identity,
    });
  }
  return { actions, latestAt };
}

/** Pushes stehen nur im Reflog der Remote-Refs („update by push“) — die lesen wir zusätzlich. */
async function readPushes(root: string, repoId: string, sinceMs: number): Promise<ReflogAction[]> {
  const refs = (await runGit(root, ["for-each-ref", "--format=%(refname)", "refs/remotes/"])).stdout
    .split("\n")
    .filter((r) => r && !r.endsWith("/HEAD"))
    .slice(0, PUSH_REFS_LIMIT);
  const out: ReflogAction[] = [];
  for (const ref of refs) {
    const { actions } = await readReflog({ root, repoId, ref, worktreePath: root, sinceMs, limit: 50, keep: (a) => a === "push" });
    out.push(...actions);
  }
  return out;
}

function maxIso(values: (string | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/** Jüngste Änderungszeit der ungesicherten Dateien (zeigt „es wird gerade gearbeitet“, ganz ohne Commit). */
function newestMtime(root: string, paths: string[]): string | null {
  let best = 0;
  for (const p of paths.slice(0, MTIME_FILES_LIMIT)) {
    try {
      const m = statSync(join(root, p)).mtimeMs;
      if (m > best) best = m;
    } catch {
      // gelöscht/verschoben — zählt nicht
    }
  }
  return best > 0 ? new Date(best).toISOString() : null;
}

/** Scannt EIN Repo — ein einzelner scheiternder Teilschritt liefert einen leeren Teilwert statt den
 * Scan zu kippen. Wirft nur, wenn `root` gar kein Git-Repo ist (`status` schlägt fehl). */
export async function scanRepo(opts: ScanOptions): Promise<RepoSnapshot> {
  const { root } = opts;
  const scannedAt = new Date().toISOString();
  const sinceMs = Date.now() - (opts.sinceDays ?? SINCE_DAYS) * 86_400_000;

  const statusOut = await runGitOrThrow(root, ["status", "--porcelain=v2", "--branch"]);
  const { currentBranch, files: uncommitted } = parseStatusPorcelainV2(statusOut);
  const headSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim() || null;
  const mainBranch = opts.mainBranch ?? (await detectMainBranch(root, currentBranch));
  const headReflog = await readReflog({ root, repoId: opts.repoId, ref: "HEAD", worktreePath: root, sinceMs, limit: REFLOG_LIMIT });
  const headCommitAt = (await runGit(root, ["log", "-1", "--format=%cI", "HEAD"])).stdout.trim() || null;
  const lastActivityAt = maxIso([headReflog.latestAt, headCommitAt, newestMtime(root, uncommitted.map((u) => u.path))]);

  const base = {
    repoId: opts.repoId,
    label: opts.label,
    kind: opts.kind,
    root,
    currentBranch,
    headSha,
    uncommitted,
    probeMerges: [], // separat befüllt (s. probeMerge.ts, eigener Takt)
    scannedAt,
    mainBranch,
    parentRepoId: opts.parentRepoId ?? null,
    lastActivityAt,
  };

  if (opts.light) {
    const branches: BranchInfo[] = [];
    if (currentBranch) {
      const [ab, shas] = await Promise.all([aheadBehind(root, mainBranch, currentBranch), aheadShas(root, mainBranch, currentBranch)]);
      branches.push({ name: currentBranch, ahead: ab.ahead, behind: ab.behind, isCurrent: true, lastCommitAt: headCommitAt, upstream: null, aheadShas: shas });
    }
    return { ...base, branches, recentCommits: [], tags: [], reflog: headReflog.actions };
  }

  const refsOut = (await runGit(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)|%(committerdate:iso-strict)|%(upstream:short)|%(HEAD)", "refs/heads/"])).stdout;
  const refs = parseForEachRefBranches(refsOut).slice(0, opts.branchLimit ?? 60);
  const branches = await Promise.all(
    refs.map(async (ref) => {
      const [ab, shas] = await Promise.all([aheadBehind(root, mainBranch, ref.name), aheadShas(root, mainBranch, ref.name)]);
      return { ...branchInfoFrom(ref, ab), aheadShas: shas };
    }),
  );

  // Commits ALLER lokalen Zweige (nicht nur des aktuellen) — sonst fehlen Worktree-Commits in der
  // Heatmap. Merges zeigen ihre Änderung gegenüber dem ersten Elternteil (= was der Merge brachte).
  const logOut = (
    await runGit(root, ["log", "--branches", "HEAD", `--since=${new Date(sinceMs).toISOString()}`, "-n", String(opts.commitLimit ?? 2000), "--numstat", "--no-renames", "--diff-merges=first-parent", `--format=${LOG_NUMSTAT_FORMAT}`])
  ).stdout;
  const branchOf = new Map<string, string>();
  // Der ausgecheckte Zweig zuerst: ein Commit, der auf mehreren Zweigen liegt, gehört „seinem“ Arbeitsplatz.
  for (const b of [...branches].sort((x, y) => Number(y.isCurrent) - Number(x.isCurrent))) for (const sha of b.aheadShas ?? []) if (!branchOf.has(sha)) branchOf.set(sha, b.name);
  const recentCommits: CommitInfo[] = parseLogNumstat(logOut).map((c) => ({
    sha: c.sha,
    authorDate: c.authorDate,
    committedAt: c.committedAt,
    subject: c.subject,
    branch: branchOf.get(c.sha) ?? mainBranch,
    authorName: c.authorName,
    parents: c.parents,
    files: c.files,
    filesChanged: c.filesChanged,
    insertions: c.insertions,
    deletions: c.deletions,
  }));

  const tags = parseTags((await runGit(root, ["tag", "--sort=-creatordate"])).stdout).slice(0, 20);

  let worktrees: RepoSnapshot["worktrees"];
  if (opts.includeWorktrees) {
    const wtOut = (await runGit(root, ["worktree", "list", "--porcelain"])).stdout;
    // Der erste Eintrag ist das Repo selbst — „Worktrees“ meint hier nur die ZUSÄTZLICHEN Arbeitskopien.
    worktrees = parseWorktreeListPorcelain(wtOut).filter((w) => w.path !== root);
  }

  const pushes = await readPushes(root, opts.repoId, sinceMs);
  return {
    ...base,
    branches,
    recentCommits,
    tags,
    reflog: [...headReflog.actions, ...pushes],
    ...(worktrees ? { worktrees } : {}),
  };
}
