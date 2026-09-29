// Orchestriert einen Git-Lauf: Repos finden (discover.ts) → scannen (mit Fortschritt an den Server)
// → Probe-Merges (eigener, langsamerer Takt) → Momentaufnahme senden → für die von NyxOS angelegten
// Worktrees (`<repo>/.worktrees/<slug>`) Nachziehen prüfen. NUR LESEND gegenüber den Repos, außer dem einen
// erlaubten `git merge` im klaren "sauber + ruhend"-Fall, und auch der nur mit ausdrücklicher
// Freigabe `NYXOS_GIT_CATCHUP_APPLY=1` (s. catchup.ts).
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { t, WORKTREE_DIR, type CatchupRecord, type GitScanProgress, type GitSnapshotPayload, type ProbeMergeResult, type RepoSnapshot } from "@nyxos/shared";
import { underRoot } from "../config.js";
import { decideCatchup, runCatchup } from "./catchup.js";
import { discoverRepos, type RepoTarget } from "./discover.js";
import { probeMergeAll } from "./probeMerge.js";
import { scanRepo } from "./scan.js";

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface CollectorOptions {
  projectRoots: readonly string[];
  serverUrl: string;
  token: string;
  log: Log;
  fetchImpl?: typeof fetch;
  /** Für Tests: welche Sessions gerade aktiv sind (sonst wird der Server gefragt). */
  activeSessionsFor?: (worktreePath: string) => boolean;
  /** Sicherheits-Standard `false` (s. catchup.ts `runCatchup`): ohne `true` wird nie wirklich
   * gemergt, nur die Entscheidung berichtet. `run-options.ts` setzt das NUR aus
   * `NYXOS_GIT_CATCHUP_APPLY=1` — bewusst kein Default-„an": ein automatischer Merge in einem echten
   * Repo ohne Zustimmung wäre nicht rückgängig zu machen. */
  applyCatchups?: boolean;
  /** Probe-Merges + Nachziehen in diesem Lauf (langsamer Takt). Standard: ja. */
  probe?: boolean;
  /** Session-Ordner (für weitere Repos). Ohne Angabe: vom Server geholt. */
  sessionCwds?: string[];
  /** Fortschritt höchstens so oft melden (Standard 700 ms). */
  progressEveryMs?: number;
  /** Gedächtnis zwischen Läufen (letzte Probe-Merges, schon gesendete Commits). */
  state?: CollectorState;
}

/** Was ein Lauf dem nächsten mitgibt. Gehört der Brücke (ein Objekt je Brücken-Prozess). */
export interface CollectorState {
  /** Letzte Probe-Merges je Repo — ohne neuen Probe-Lauf erneut mitschicken (der Server ersetzt sie je Scan). */
  probes: Map<string, ProbeMergeResult[]>;
  /** Schon erfolgreich gesendete Commits je Repo (spart das erneute Senden der 90-Tage-Historie). */
  sentShas: Map<string, Set<string>>;
  sentShasSince: number;
}

export function newCollectorState(): CollectorState {
  return { probes: new Map(), sentShas: new Map(), sentShasSince: Date.now() };
}

/** Nach dieser Zeit schickt die Brücke die volle Commit-Historie noch einmal (heilt verlorene Stände). */
const FULL_RESEND_MS = 6 * 60 * 60_000;
const SCAN_CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Scannt alle gefundenen Repos. Ein scheiterndes Einzel-Repo (z. B. eine Worktree mitten in
 * `git worktree remove`) fällt einfach weg, statt den ganzen Lauf zu kippen. */
export async function scanAllRepos(opts: {
  projectRoots: readonly string[];
  log: Log;
  sessionCwds?: string[];
  onProgress?: (p: { done: number; total: number; current: string | null }) => Promise<void> | void;
  targets?: RepoTarget[];
}): Promise<RepoSnapshot[]> {
  const targets = opts.targets ?? (await discoverRepos(opts));
  const total = targets.length;
  let done = 0;
  await opts.onProgress?.({ done, total, current: targets[0]?.label ?? null });
  // Eltern-Repos zuerst (ihr Hauptzweig gilt für die Worktrees).
  const parents = targets.filter((t) => !t.light);
  const children = targets.filter((t) => t.light);
  const mainOf = new Map<string, string>();
  const scanOne = async (t: RepoTarget): Promise<RepoSnapshot | null> => {
    try {
      const snap = await scanRepo({
        repoId: t.repoId,
        label: t.label,
        kind: t.kind,
        root: t.root,
        light: t.light,
        includeWorktrees: t.includeWorktrees,
        parentRepoId: t.parentRepoId,
        ...(t.parentRepoId && mainOf.has(t.parentRepoId) ? { mainBranch: mainOf.get(t.parentRepoId) } : {}),
      });
      if (!t.light && snap.mainBranch) mainOf.set(t.repoId, snap.mainBranch);
      return snap;
    } catch (e) {
      opts.log("git-scan-fehler", { repo: t.repoId, error: String(e) });
      return null;
    } finally {
      done++;
      await opts.onProgress?.({ done, total, current: t.label });
    }
  };
  const out: RepoSnapshot[] = [];
  for (const s of await mapLimit(parents, SCAN_CONCURRENCY, scanOne)) if (s) out.push(s);
  for (const s of await mapLimit(children, SCAN_CONCURRENCY, scanOne)) if (s) out.push(s);
  return out;
}

async function send(opts: CollectorOptions, path: string, body: unknown, timeoutMs = 30_000): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${opts.serverUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) opts.log("git-senden-abgelehnt", { path, status: res.status });
    return res.ok;
  } catch (e) {
    opts.log("git-senden-fehler", { path, error: String(e) });
    return false;
  }
}

/** Session-Ordner vom Server (nur Ordnernamen, Token-Auth). Antwortet der Server, aber ohne
 * brauchbare Liste → keine weiteren Repos. Ist er gar nicht erreichbar (Tunnel steht noch nicht) →
 * `null`: dann lohnt der ganze Scan nicht. */
async function fetchSessionCwds(opts: CollectorOptions): Promise<string[] | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.serverUrl}/ingest/git/roots`, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!res.ok) return [];
  try {
    const body = (await res.json()) as { cwds?: unknown };
    return Array.isArray(body.cwds) ? body.cwds.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

async function fetchGitState(opts: CollectorOptions): Promise<{ repos: RepoSnapshot[] } | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${opts.serverUrl}/api/git`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return (await res.json()) as { repos: RepoSnapshot[] };
  } catch {
    return null;
  }
}

/** Ein Lauf: finden → scannen (Fortschritt) → [Probe-Merges] → senden → [Nachziehen]. Gibt die
 * `.git`-Ordner der gescannten Repos zurück (für den Datei-Wächter). */
export async function runGitCollector(opts: CollectorOptions): Promise<{ gitDirs: string[] | null; repos: number; ok: boolean }> {
  const state = opts.state ?? newCollectorState();
  const probe = opts.probe ?? true;
  const startedAt = new Date().toISOString();
  const progress = (p: Partial<GitScanProgress> & { phase: GitScanProgress["phase"] }) =>
    send(opts, "/ingest/git/progress", { done: 0, total: 0, current: null, startedAt, finishedAt: null, ...p } satisfies GitScanProgress, 5_000);

  let lastProgressAt = 0;
  const sessionCwds = opts.sessionCwds ?? (await fetchSessionCwds(opts));
  if (sessionCwds === null) {
    // Server nicht erreichbar (z. B. Tunnel nach dem Brücken-Start noch nicht da): nichts scannen —
    // das Ergebnis könnte niemand annehmen. Der Takt versucht es gleich wieder (s. scheduler.ts).
    opts.log("git-scan-uebersprungen", { grund: "server-nicht-erreichbar" });
    return { gitDirs: null, repos: 0, ok: false };
  }
  const targets = await discoverRepos({ projectRoots: opts.projectRoots, sessionCwds });
  const repos = await scanAllRepos({
    projectRoots: opts.projectRoots,
    log: opts.log,
    targets,
    onProgress: async (p) => {
      // Höchstens alle 700 ms melden (plus Start) — 30 Repos sollen nicht 30 Anfragen durch den Tunnel schicken.
      const now = Date.now();
      if (p.done !== 0 && now - lastProgressAt < (opts.progressEveryMs ?? 700)) return;
      lastProgressAt = now;
      await progress({ phase: "scanning", ...p });
    },
  });

  for (const repo of repos) {
    if (repo.kind === "worktree") continue; // Zweige der Worktrees prüft das Eltern-Repo mit
    if (probe) {
      const branchNames = repo.branches.map((b) => b.name);
      repo.probeMerges = await probeMergeAll(repo.root, repo.mainBranch ?? "main", branchNames);
      state.probes.set(repo.repoId, repo.probeMerges);
    } else {
      const names = new Set(repo.branches.map((b) => b.name));
      repo.probeMerges = (state.probes.get(repo.repoId) ?? []).filter((p) => names.has(p.branch));
    }
  }

  // Schon gesendete Commits nicht erneut schicken (alle 6 h einmal voll, falls der Server etwas verlor).
  if (Date.now() - state.sentShasSince > FULL_RESEND_MS) {
    state.sentShas.clear();
    state.sentShasSince = Date.now();
  }
  const sending = repos.map((r) => {
    const sent = state.sentShas.get(r.repoId);
    return sent ? { ...r, recentCommits: r.recentCommits.filter((c) => !sent.has(c.sha)) } : r;
  });
  const ok = await send(opts, "/ingest/git", { repos: sending, collectedAt: new Date().toISOString() } satisfies GitSnapshotPayload);
  if (ok) {
    for (const r of repos) {
      const set = state.sentShas.get(r.repoId) ?? new Set<string>();
      for (const c of r.recentCommits) set.add(c.sha);
      state.sentShas.set(r.repoId, set);
    }
  }
  await progress({ phase: ok ? "done" : "error", done: targets.length, total: targets.length, finishedAt: new Date().toISOString(), error: ok ? null : t("Server hat den Git-Stand nicht angenommen") });
  opts.log("git-scan", { repos: repos.length, probe, ok });

  const gitDirs = targets.map((t) => t.gitDir).filter((d): d is string => d !== null);
  if (!ok || !probe) return { gitDirs, repos: repos.length, ok };
  await runCatchups(opts);
  return { gitDirs, repos: repos.length, ok };
}

/** Nachziehen (nur von NyxOS angelegte Worktrees unter `<repo>/.worktrees`), s. catchup.ts. Ohne Freigabe nur ein Vorschlag. */
async function runCatchups(opts: CollectorOptions): Promise<void> {
  const afterIngest = await fetchGitState(opts);
  if (!afterIngest) return;
  const catchups: CatchupRecord[] = [];
  for (const repo of afterIngest.repos) {
    if (repo.kind === "worktree" || !repo.worktrees) continue;
    // `git worktree list` liefert ALLE Worktrees eines Repos, nicht nur die von NyxOS angelegten — ein
    // Worktree an anderer Stelle darf nie automatisch nachgezogen werden. `wt.path` kommt aus einer Antwort
    // des Servers: `isManagedWorktreePath` löst Symlinks/`..` per `realpath` auf, BEVOR verglichen wird.
    const managedDir = join(repo.root, WORKTREE_DIR);
    for (const wt of repo.worktrees) {
      if (!wt.branch) continue;
      const real = isManagedWorktreePath(wt.path, managedDir);
      if (!real) continue;
      const hasActiveSession = opts.activeSessionsFor ? opts.activeSessionsFor(real) : (wt.activeSessionKeys?.length ?? 0) > 0;
      const record = await runCatchup({ repoId: repo.repoId, worktreePath: real, branch: wt.branch, mainBranch: repo.mainBranch ?? "main", hasActiveSession, apply: opts.applyCatchups ?? false });
      catchups.push(record);
      opts.log("git-catchup", { worktree: real, outcome: record.outcome });
    }
  }
  if (catchups.length > 0) await send(opts, "/ingest/git", { repos: [], catchups, collectedAt: new Date().toISOString() } satisfies GitSnapshotPayload);
}

/** Löst `candidate` und `managedDir` per `realpath` auf (Symlinks/`..` weg) und gibt den aufgelösten
 * Pfad NUR zurück, wenn er wirklich unter `managedDir` liegt — sonst `null`. Reine, direkt testbare
 * Funktion. Ein nicht (mehr) existierender Pfad ist nie „verwaltet". */
export function isManagedWorktreePath(candidate: string, managedDir: string): string | null {
  let realManaged: string;
  let realCandidate: string;
  try {
    realManaged = realpathSync(managedDir);
  } catch {
    return null;
  }
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return null;
  }
  return underRoot(realCandidate, realManaged) ? realCandidate : null;
}

// Re-Export für Tests/Aufrufer, die die reine Entscheidung ohne Netzwerk prüfen wollen.
export { decideCatchup };
