// Onboarding: which folders hold the user's projects? Works on any machine (macOS, every Linux, headless servers):
//
// 1. Strongest signal: where the user really worked. The `cwd` of recent Claude Code transcripts
//    (`<claudeDir>/projects/*/*.jsonl`, only the first KB of a few files per project) and Codex sessions
//    (`<codexDir>/sessions/YYYY/MM/DD/rollout-*.jsonl`, `session_meta` → `cwd`). Each cwd is mapped to its Git
//    top level and then to the folder that holds the repos (`~/code/app` → `~/code`). A repo directly in the home
//    folder is suggested itself (never the home folder, never `/`).
// 2. A bounded shallow scan of the home folder (depth ≤ 3, no hidden/system/media folders, time budget) for
//    folders that contain Git repos.
//
// Suggestions keep the path as the sessions wrote it (not the resolved symlink target): the bridge matches
// sessions to project folders by that path. Duplicates are removed by their real path (case-insensitive on macOS).
//
// macOS asks once per program before it may read ~/Documents, ~/Desktop, ~/Downloads, iCloud and external
// volumes, and every read there hangs until the user answers. All work below such a folder goes through
// `ProtectedGate`: one probe with a time limit, everything else skips the folder until the probe succeeded.
import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ProjectRootInfo } from "@nyxos/shared";
import { foldCase } from "./platform.js";

/** At most this many Claude project folders (newest first) and Codex session files are read. */
const MAX_CLAUDE_PROJECTS = 150;
const MAX_CODEX_FILES = 200;
/** Files tried per Claude project folder until one names its `cwd`. */
const CLAUDE_FILES_PER_PROJECT = 3;
/** Bytes read from the start of a transcript (the `cwd` appears in the first few KB). */
const HEAD_BYTES = 32 * 1024;
/** Distinct working folders that are mapped to a project folder. */
const MAX_CWDS = 300;
/** Suggestions returned. */
export const MAX_ROOT_SUGGESTIONS = 8;
/** Home scan: depth, time budget, folder reads. */
const SCAN_DEPTH = 3;
const SCAN_BUDGET_MS = 300;
const SCAN_MAX_READS = 2500;
/** Repo count of one folder: depth and folder reads. */
const COUNT_DEPTH = 2;
const COUNT_MAX_READS = 250;
/** macOS privacy prompt: how long the first read of a protected folder may take. */
const PROBE_TIMEOUT_MS = 1500;
/** A refused protected folder is tried again after this long (the user may allow it in the system settings). */
const PROBE_RETRY_MS = 60_000;
const IO_CONCURRENCY = 8;

/** Never a project folder, anywhere below the scanned folders. */
const SKIP_ANY = new Set(["node_modules", "vendor", "Pods", "DerivedData", "build", "dist", "target", "__pycache__", "venv", "site-packages"]);
/** Big system/media folders directly in the home folder. */
const SKIP_HOME = new Set(["Library", "Applications", "Movies", "Music", "Pictures", "Photos", "Videos", "Public", "snap", "Downloads", "go"]);

export type Tool = "claude" | "codex";

interface CwdStat {
  cwd: string;
  sessions: number;
  lastUsedMs: number;
  tools: Set<Tool>;
}

export interface DetectOptions {
  home: string;
  claudeDir: string;
  codexDir: string;
  platform?: NodeJS.Platform;
  gate?: ProtectedGate;
  /** Folders whose sessions are never suggested (temporary folders). Default: the system temp folders. */
  tmpDirs?: readonly string[];
  scanBudgetMs?: number;
  now?: () => number;
}

export interface DetectSnapshot {
  /** Ranked suggestions (most sessions first, then most repos), at most `MAX_ROOT_SUGGESTIONS`. */
  suggestions: ProjectRootInfo[];
  /** Working folders of recent sessions (for describing configured folders). */
  cwds: CwdStat[];
  /** `false` while macOS still waits for the user to allow a folder — worth asking again soon. */
  complete: boolean;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function listDir(dir: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Is `p` equal to or below `root`? (plain path comparison, case-insensitive on macOS) */
export function isUnder(p: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const a = foldCase(p, platform);
  const r = foldCase(root, platform).replace(/\/+$/, "");
  if (r === "") return true;
  return a === r || a.startsWith(r + "/");
}

/** First bytes of a file as text (a transcript line can be cut off — callers only search in it). */
async function readHead(file: string, bytes = HEAD_BYTES): Promise<string | null> {
  let fh;
  try {
    fh = await open(file, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** The first `"cwd":"…"` value in a transcript head (Claude lines and Codex `session_meta` both use this key). */
export function cwdFromHead(text: string): string | null {
  const m = CWD_RE.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(`"${m[1] ?? ""}"`) as unknown;
    return typeof v === "string" && isAbsolute(v) ? v : null;
  } catch {
    return null;
  }
}

// ─── macOS privacy gate ──────────────────────────────────────────────────────

type ProbeState = { status: "pending" | "ok" | "denied"; at: number; wait: Promise<boolean> | null };

/**
 * macOS asks before a program may read ~/Desktop, ~/Documents, ~/Downloads, iCloud Drive and external volumes;
 * until the user answers, every read there hangs. The gate probes such a folder once (with a time limit) and
 * lets callers skip it while the answer is outstanding. On other systems every folder is open.
 */
export class ProtectedGate {
  private readonly states = new Map<string, ProbeState>();

  constructor(
    private readonly o: {
      home: string;
      platform?: NodeJS.Platform;
      timeoutMs?: number;
      /** Tests: replaces the first read of a protected folder. */
      probe?: (dir: string) => Promise<unknown>;
      now?: () => number;
    },
  ) {}

  private get platform(): NodeJS.Platform {
    return this.o.platform ?? process.platform;
  }

  /** The protected folder that contains `path`, or `null`. */
  protectedRoot(path: string): string | null {
    if (this.platform !== "darwin") return null;
    const home = this.o.home;
    for (const name of ["Desktop", "Documents", "Downloads", join("Library", "Mobile Documents")]) {
      const root = join(home, name);
      if (isUnder(path, root, this.platform)) return root;
    }
    const vol = /^\/Volumes\/[^/]+/.exec(path);
    return vol ? vol[0] : null;
  }

  /** Is the answer for the protected folder of `path` still outstanding (probe hangs)? */
  pending(path: string): boolean {
    const root = this.protectedRoot(path);
    return root !== null && this.states.get(root)?.status === "pending";
  }

  /** May `path` be read right now, without starting a probe? */
  open(path: string): boolean {
    const root = this.protectedRoot(path);
    return root === null || this.states.get(root)?.status === "ok";
  }

  /** Waits (at most the time limit) until `path` may be read. Starts the probe when needed. */
  async allow(path: string): Promise<boolean> {
    const root = this.protectedRoot(path);
    if (root === null) return true;
    const now = (this.o.now ?? Date.now)();
    const s = this.states.get(root);
    if (s?.status === "ok") return true;
    if (s?.status === "pending") return s.wait ?? false;
    if (s?.status === "denied" && now - s.at < PROBE_RETRY_MS) return false;
    const state: ProbeState = { status: "pending", at: now, wait: null };
    this.states.set(root, state);
    const probe = (this.o.probe ?? ((d: string) => readdir(d)))(root).then(
      () => {
        state.status = "ok";
        return true;
      },
      () => {
        state.status = "denied";
        state.at = (this.o.now ?? Date.now)();
        return false;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((res) => {
      timer = setTimeout(() => res(false), this.o.timeoutMs ?? PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    state.wait = Promise.race([probe, timeout]).finally(() => {
      clearTimeout(timer);
      // Later callers must not wait again while the probe still hangs: they skip the folder right away.
      state.wait = null;
    });
    return state.wait;
  }
}

// ─── where did the user work? ───────────────────────────────────────────────

/** Working folders of recent Claude Code sessions: one `cwd` per project folder, sessions = transcripts there. */
async function claudeCwds(claudeDir: string): Promise<CwdStat[]> {
  const base = join(claudeDir, "projects");
  const dirs = (await listDir(base))?.filter((e) => e.isDirectory()) ?? [];
  const withTime = await mapLimit(dirs, IO_CONCURRENCY * 2, async (d) => {
    try {
      return { dir: join(base, d.name), mtimeMs: (await stat(join(base, d.name))).mtimeMs };
    } catch {
      return null;
    }
  });
  const newest = withTime
    .filter((d): d is { dir: string; mtimeMs: number } => d !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_CLAUDE_PROJECTS);
  const out = await mapLimit(newest, IO_CONCURRENCY, async ({ dir, mtimeMs }) => {
    const files = ((await listDir(dir)) ?? []).filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(dir, e.name));
    if (files.length === 0) return null;
    for (const file of files.slice(0, CLAUDE_FILES_PER_PROJECT)) {
      const head = await readHead(file);
      const cwd = head ? cwdFromHead(head) : null;
      if (cwd) return { cwd, sessions: files.length, lastUsedMs: mtimeMs, tools: new Set<Tool>(["claude"]) };
    }
    return null;
  });
  return out.filter((c): c is CwdStat => c !== null);
}

/** Newest Codex session files (`sessions/YYYY/MM/DD/rollout-*.jsonl`), newest day first. */
async function codexFiles(codexDir: string): Promise<string[]> {
  const out: string[] = [];
  const names = async (dir: string) =>
    ((await listDir(dir)) ?? [])
      .map((e) => e.name)
      .filter((n) => !n.startsWith("."))
      .sort()
      .reverse();
  const base = join(codexDir, "sessions");
  for (const y of await names(base)) {
    for (const m of await names(join(base, y))) {
      for (const d of await names(join(base, y, m))) {
        const dayDir = join(base, y, m, d);
        for (const f of await names(dayDir)) {
          if (!/^rollout-.*\.jsonl$/.test(f)) continue;
          out.push(join(dayDir, f));
          if (out.length >= MAX_CODEX_FILES) return out;
        }
      }
    }
  }
  return out;
}

async function codexCwds(codexDir: string): Promise<CwdStat[]> {
  const files = await codexFiles(codexDir);
  const rows = await mapLimit(files, IO_CONCURRENCY, async (file) => {
    const head = await readHead(file);
    const cwd = head ? cwdFromHead(head) : null;
    if (!cwd) return null;
    let lastUsedMs = 0;
    try {
      lastUsedMs = (await stat(file)).mtimeMs;
    } catch {
      // gone meanwhile
    }
    return { cwd, sessions: 1, lastUsedMs, tools: new Set<Tool>(["codex"]) };
  });
  return rows.filter((c): c is CwdStat => c !== null);
}

/** Sessions per working folder, newest first. */
export async function sessionCwds(o: { claudeDir: string; codexDir: string }): Promise<CwdStat[]> {
  const [claude, codex] = await Promise.all([claudeCwds(o.claudeDir), codexCwds(o.codexDir)]);
  const byCwd = new Map<string, CwdStat>();
  for (const row of [...claude, ...codex]) {
    const cwd = resolve(row.cwd);
    const prev = byCwd.get(cwd);
    if (!prev) byCwd.set(cwd, { ...row, cwd });
    else {
      prev.sessions += row.sessions;
      prev.lastUsedMs = Math.max(prev.lastUsedMs, row.lastUsedMs);
      for (const t of row.tools) prev.tools.add(t);
    }
  }
  return [...byCwd.values()].sort((a, b) => b.lastUsedMs - a.lastUsedMs);
}

// ─── path → project folder ──────────────────────────────────────────────────

export interface PathRules {
  home: string;
  platform: NodeJS.Platform;
  tmpDirs: readonly string[];
}

function defaultTmpDirs(): string[] {
  return [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/var/folders", "/private/var/folders"];
}

/** Home folder, `/` and everything above the home folder are never project folders. */
function tooBroad(p: string, r: PathRules): boolean {
  return p === "/" || isUnder(r.home, p, r.platform);
}

/**
 * The part of `p` before its first hidden folder: `~/code/app/.claude/worktrees/x` → `~/code/app`
 * (worktrees and tool folders belong to the project around them).
 */
export function visiblePart(p: string, r: PathRules): string {
  const base = isUnder(p, r.home, r.platform) ? r.home : "/";
  const rest = p.slice(base.length).split(sep).filter(Boolean);
  const cut = rest.findIndex((s) => s.startsWith("."));
  const parts = cut === -1 ? rest : rest.slice(0, cut);
  return parts.length === 0 ? base : join(base, ...parts);
}

/** The folder that should be suggested for a repo (or a working folder without Git). */
export function rootForProject(project: string, r: PathRules): string {
  const parent = dirname(project);
  return tooBroad(parent, r) ? project : parent;
}

/** Git top level of `dir`: the nearest folder upwards (below the home folder / `/`) that contains `.git`. */
async function gitTop(dir: string, r: PathRules): Promise<string | null> {
  let cur = dir;
  while (!tooBroad(cur, r)) {
    if (await exists(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/** Project folder candidate for one working folder, or `null` (temporary, home, gone, not readable yet). */
async function candidateForCwd(cwd: string, r: PathRules, gate: ProtectedGate): Promise<string | null> {
  const underHome = isUnder(cwd, r.home, r.platform);
  if (!underHome && r.tmpDirs.some((t) => isUnder(cwd, t, r.platform))) return null;
  let visible = visiblePart(cwd, r);
  if (tooBroad(visible, r)) return null;
  if (!(await gate.allow(visible))) return null;
  // A deleted subfolder (or project) still tells where the user works: take the nearest folder that exists.
  while (!(await isDirectory(visible))) {
    visible = dirname(visible);
    if (tooBroad(visible, r)) return null;
  }
  // Also skip temporary folders reached through a symlink (macOS: /tmp → /private/tmp).
  if (!underHome) {
    const real = await realpath(visible).catch(() => visible);
    if (r.tmpDirs.some((t) => isUnder(real, t, r.platform))) return null;
  }
  const top = await gitTop(visible, r);
  return top ? rootForProject(top, r) : visible;
}

// ─── bounded folder walks ───────────────────────────────────────────────────

interface WalkLimits {
  depth: number;
  maxReads: number;
  deadline: number;
  now: () => number;
}

/**
 * Breadth-first walk below `start` (not following symlinks) that reports every folder containing `.git` and does
 * not descend into it. `start` itself counts as a repo unless `startIsContainer` (the home folder may be a
 * dotfiles repo). Stops quietly at its limits (depth, folder reads, time).
 */
async function walkRepos(start: string, limits: WalkLimits, o: { home: string; gate: ProtectedGate; startIsContainer?: boolean; onRepo: (dir: string) => void }): Promise<void> {
  let reads = 0;
  let queue: { dir: string; depth: number }[] = [{ dir: start, depth: 0 }];
  while (queue.length > 0) {
    const next: { dir: string; depth: number }[] = [];
    const batch = queue.filter((q) => {
      if (reads >= limits.maxReads || limits.now() > limits.deadline) return false;
      // Never trigger the macOS permission prompt from a scan.
      if (!o.gate.open(q.dir)) return false;
      reads++;
      return true;
    });
    const listed = await mapLimit(batch, IO_CONCURRENCY, async (q) => ({ q, entries: await listDir(q.dir) }));
    for (const { q, entries } of listed) {
      if (!entries) continue;
      if (entries.some((e) => e.name === ".git") && !(q.depth === 0 && o.startIsContainer)) {
        o.onRepo(q.dir);
        continue;
      }
      if (q.depth >= limits.depth) continue;
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || SKIP_ANY.has(e.name)) continue;
        if (q.dir === o.home && SKIP_HOME.has(e.name)) continue;
        next.push({ dir: join(q.dir, e.name), depth: q.depth + 1 });
      }
    }
    queue = next;
  }
}

/** Git repos in `dir` (the folder itself, or up to two levels below). `null` when it may not be read yet. */
export async function countRepos(dir: string, o: { home: string; gate: ProtectedGate; now?: () => number }): Promise<number | null> {
  if (!(await o.gate.allow(dir))) return null;
  let n = 0;
  const now = o.now ?? Date.now;
  await walkRepos(dir, { depth: COUNT_DEPTH, maxReads: COUNT_MAX_READS, deadline: now() + SCAN_BUDGET_MS, now }, { home: o.home, gate: o.gate, onRepo: () => n++ });
  return n;
}

// ─── ranking ────────────────────────────────────────────────────────────────

interface Candidate {
  path: string;
  sessions: number;
  lastUsedMs: number;
  tools: Set<Tool>;
  repos: number | null;
}

function merge(into: Candidate, from: Candidate): void {
  if (from.repos !== null) into.repos = (into.repos ?? 0) + from.repos;
  into.sessions += from.sessions;
  into.lastUsedMs = Math.max(into.lastUsedMs, from.lastUsedMs);
  for (const t of from.tools) into.tools.add(t);
}

function rank(a: Candidate, b: Candidate): number {
  return b.sessions - a.sessions || (b.repos ?? 0) - (a.repos ?? 0) || b.lastUsedMs - a.lastUsedMs || a.path.localeCompare(b.path);
}

function info(c: Candidate): ProjectRootInfo {
  return {
    path: c.path,
    repos: c.repos,
    sessions: c.sessions,
    lastUsedAt: c.lastUsedMs > 0 ? new Date(c.lastUsedMs).toISOString() : null,
    tools: (["claude", "codex"] as const).filter((t) => c.tools.has(t)),
    recommended: c.sessions > 0,
  };
}

/** Sessions, tools and last use of a folder, summed over the working folders below it. */
export function sessionsUnder(path: string, cwds: readonly CwdStat[], platform: NodeJS.Platform = process.platform): Pick<Candidate, "sessions" | "lastUsedMs" | "tools"> {
  const out = { sessions: 0, lastUsedMs: 0, tools: new Set<Tool>() };
  for (const c of cwds) {
    if (!isUnder(c.cwd, path, platform)) continue;
    out.sessions += c.sessions;
    out.lastUsedMs = Math.max(out.lastUsedMs, c.lastUsedMs);
    for (const t of c.tools) out.tools.add(t);
  }
  return out;
}

/** Details of one (configured) folder for the onboarding list. */
export async function describeRoot(path: string, snapshot: Pick<DetectSnapshot, "cwds">, o: { home: string; gate: ProtectedGate; platform?: NodeJS.Platform }): Promise<ProjectRootInfo> {
  const s = sessionsUnder(path, snapshot.cwds, o.platform);
  return info({ path, ...s, repos: await countRepos(path, o) });
}

/** Full detection: session folders + home scan, merged, counted, ranked. */
export async function detectProjectRoots(o: DetectOptions): Promise<DetectSnapshot> {
  const platform = o.platform ?? process.platform;
  const now = o.now ?? Date.now;
  const home = resolve(o.home);
  const gate = o.gate ?? new ProtectedGate({ home, platform });
  const rules: PathRules = { home, platform, tmpDirs: o.tmpDirs ?? defaultTmpDirs() };
  let complete = true;

  // 1) Where the user worked.
  const cwds = (await sessionCwds(o)).slice(0, MAX_CWDS);
  const fromSessions = await mapLimit(cwds, IO_CONCURRENCY, async (c) => ({ c, root: await candidateForCwd(c.cwd, rules, gate) }));
  const candidates = new Map<string, Candidate>();
  const add = (path: string, extra: Omit<Candidate, "path">) => {
    const key = foldCase(path, platform);
    const prev = candidates.get(key);
    const next: Candidate = { path, repos: extra.repos, sessions: extra.sessions, lastUsedMs: extra.lastUsedMs, tools: new Set(extra.tools) };
    if (prev) merge(prev, next);
    else candidates.set(key, next);
  };
  for (const { c, root } of fromSessions) {
    if (root) add(root, { ...c, repos: null });
    else if (gate.pending(c.cwd)) complete = false;
  }

  // 2) Folders with Git repos in the home folder. On macOS, Documents and Desktop are asked for once (the system
  //    shows its permission dialog); until the answer is there, the scan leaves them out.
  if (platform === "darwin") await Promise.all(["Documents", "Desktop"].map((d) => gate.allow(join(home, d))));
  if (["Documents", "Desktop"].some((d) => gate.pending(join(home, d)))) complete = false;
  const scanStart = now();
  // A scan cut short by its time budget stays as it is (asking again would not find more).
  await walkRepos(
    home,
    { depth: SCAN_DEPTH, maxReads: SCAN_MAX_READS, deadline: scanStart + (o.scanBudgetMs ?? SCAN_BUDGET_MS), now },
    { home, gate, startIsContainer: true, onRepo: (dir) => add(rootForProject(dir, rules), { sessions: 0, lastUsedMs: 0, tools: new Set(), repos: 1 }) },
  );

  // 3) One suggestion per real folder, nested folders folded into the outer one (it covers them).
  const list = [...candidates.values()].sort((a, b) => a.path.length - b.path.length);
  const reals = await mapLimit(list, IO_CONCURRENCY, async (c) => ((await gate.allow(c.path)) ? realpath(c.path).catch(() => null) : c.path));
  const kept: { c: Candidate; real: string }[] = [];
  list.forEach((c, i) => {
    const real = reals[i];
    if (!real || tooBroad(real, rules)) return;
    const outer = kept.find((k) => isUnder(real, k.real, platform) || isUnder(c.path, k.c.path, platform));
    if (outer) merge(outer.c, c);
    else kept.push({ c, real });
  });

  // 4) Count repos of the strongest candidates, rank, cap.
  const top = kept
    .map((k) => k.c)
    .sort(rank)
    .slice(0, MAX_ROOT_SUGGESTIONS * 2);
  await mapLimit(top, 4, async (c) => {
    c.repos = await countRepos(c.path, { home, gate, now });
    if (c.repos === null && gate.pending(c.path)) complete = false;
  });
  const suggestions = top
    // A folder from the home scan without a readable repo is no suggestion.
    .filter((c) => c.sessions > 0 || (c.repos ?? 0) > 0)
    .sort(rank)
    .slice(0, MAX_ROOT_SUGGESTIONS)
    .map(info);
  return { suggestions, cwds, complete };
}
