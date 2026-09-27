// alles, was die neue Git-Seite braucht, in EINER Antwort (Kennzahlen, Heatmap, Merges,
// Aktions-Log, getrennte Abschnitte App/Worktrees/NyxOS/weitere) plus die Großansichten
// (Commit, Zweig, Worktree). Nur Lesen aus den `git_*`-Tabellen, `sessions` und `session_events`.
import type {
  AttributionConfidence,
  CatchupOutcome,
  ChangeGroup,
  GitActionRow,
  GitActionRowKind,
  GitBranchDetail,
  GitBranchRow,
  GitCommitDetail,
  GitCommitRow,
  GitDashboard,
  GitRepoSection,
  GitScanProgress,
  GitSessionRef,
  GitUncommittedSummary,
  GitWorktreeCard,
  GitWorktreeDetail,
  RepoKind,
  UncommittedFile,
  UncommittedTotals,
} from "@nyxos/shared";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { visibleSession } from "../db/visible.js";
import { gitActions, gitBranches, gitCatchupHistory, gitCommits, gitProbeMerges, gitRepos, gitUncommitted, gitWorktrees, reservations, sessions } from "../db/schema.js";
import { ACTION_VERBS, checkoutOf, clusterTimes, loadEvidence, loadFamilies, matchCommit, targetFor, type CallRow, type RepoFamilies } from "./attribution.js";
import { localDayOf, t } from "@nyxos/shared";

const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 84;
/** Repos, die seit so langer Zeit nicht mehr mitgemeldet wurden (während andere frisch sind), gelten als weg. */
const STALE_MS = 30 * 60_000;
const OPEN_STATES = new Set(["running", "waiting", "idle"]);

export type RepoRow = typeof gitRepos.$inferSelect;

/** Kalendertag (Zeitzone des Nutzers) (YYYY-MM-DD) — dieselbe Konvention wie Nutzung/Überblick. */
export function localDay(ms: number): string {
  return localDayOf(new Date(ms));
}
/** Die letzten `n` Kalendertage (Zeitzone des Nutzers), ältester zuerst. */
function lastDays(now: number, n: number): string[] {
  const out: string[] = [];
  // Mittags rechnen, damit Sommer-/Winterzeit keinen Tag doppelt oder gar nicht liefert.
  const noon = Date.parse(`${localDay(now)}T12:00:00Z`);
  for (let i = n - 1; i >= 0; i--) out.push(localDay(noon - i * DAY_MS));
  return out;
}

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

function familyKind(repo: RepoRow | undefined, repos: Map<string, RepoRow>): RepoKind {
  if (!repo) return "app";
  if (repo.kind !== "worktree") return repo.kind as RepoKind;
  const parent = repos.get(repo.parentId ?? "app");
  return (parent?.kind as RepoKind | undefined) ?? "app";
}

function emptyGroups(): Record<ChangeGroup, number> {
  return { code: 0, doku: 0, projekt: 0, verschoben: 0 };
}

function summarize(files: UncommittedFile[], limit = 30): GitUncommittedSummary {
  const groups = emptyGroups();
  for (const f of files) groups[f.group] = (groups[f.group] ?? 0) + 1;
  return { total: files.length, groups, files: files.slice(0, limit) };
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

type SessionRow = { key: string; title: string | null; tool: string; state: string | null; lastActivityAt: string | null; cwd: string | null; closedAt: string | null };

function toRef(s: SessionRow): GitSessionRef {
  return { key: s.key, title: s.title, tool: s.tool, state: s.closedAt ? "closed" : s.state, lastActivityAt: iso(s.lastActivityAt), cwd: s.cwd };
}

function isOpen(s: SessionRow): boolean {
  return !s.closedAt && s.state !== null && OPEN_STATES.has(s.state);
}

/** Sessions je Repo (Listen „offen/zuletzt“, Zähler). ohne archivierte Wegwerf-Sessions. */
async function loadSessionsWithCwd(db: Db, limit = 5000): Promise<SessionRow[]> {
  return db
    .select({ key: sessions.id, title: sessions.title, tool: sessions.tool, state: sessions.state, lastActivityAt: sessions.lastActivityAt, cwd: sessions.cwd, closedAt: sessions.closedAt })
    .from(sessions)
    .where(and(isNotNull(sessions.cwd), visibleSession))
    .orderBy(sql`${sessions.lastActivityAt} desc nulls last`)
    .limit(limit);
}

/**
 * Session-Verweise an Commits/Aktionen (Commit→Session). B3 bewusst OHNE Archiv-Filter: eine
 * archivierte Wegwerf-Session bleibt Urheberin „ihres“ Commits (sonst fiele er fälschlich an den Nutzer);
 * in Session-Listen erscheint sie trotzdem nicht (`loadSessionsWithCwd`).
 */
async function sessionRefs(db: Db, keys: string[]): Promise<Map<string, GitSessionRef>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ key: sessions.id, title: sessions.title, tool: sessions.tool, state: sessions.state, lastActivityAt: sessions.lastActivityAt, cwd: sessions.cwd, closedAt: sessions.closedAt })
    .from(sessions)
    .where(inArray(sessions.id, unique));
  return new Map(rows.map((r) => [r.key, toRef(r)]));
}

// ---------------------------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------------------------

type CommitDbRow = typeof gitCommits.$inferSelect;

async function toCommitRows(db: Db, rows: CommitDbRow[], repos: Map<string, RepoRow>): Promise<GitCommitRow[]> {
  const refs = await sessionRefs(
    db,
    rows.map((r) => r.sessionKey).filter((k): k is string => !!k),
  );
  const seen = new Set<string>();
  const out: GitCommitRow[] = [];
  for (const r of rows) {
    if (seen.has(r.sha)) continue; // ältere Brücken schickten denselben Commit auch je Worktree
    seen.add(r.sha);
    const repo = repos.get(r.repoId);
    const rootId = repo?.kind === "worktree" ? (repo.parentId ?? "app") : r.repoId;
    const root = repos.get(rootId) ?? repo;
    const confidence = (r.sessionConfidence ?? "keine") as AttributionConfidence;
    out.push({
      repoId: rootId,
      repoLabel: root?.label ?? rootId,
      kind: familyKind(repo, repos),
      sha: r.sha,
      subject: r.subject,
      branch: r.branch,
      authorName: r.authorName,
      committedAt: iso(r.committedAt ?? r.authorDate) ?? r.authorDate,
      parents: r.parentCount,
      filesChanged: r.filesChanged,
      insertions: r.insertions,
      deletions: r.deletions,
      attribution: {
        confidence: r.sessionKey && refs.has(r.sessionKey) ? confidence : "keine",
        session: r.sessionKey ? (refs.get(r.sessionKey) ?? null) : null,
        reason: r.sessionReason ?? t("Wird gerade zugeordnet — gleich wieder hineinschauen."),
      },
    });
  }
  return out;
}

const commitAt = sql`coalesce(${gitCommits.committedAt}, ${gitCommits.authorDate})`;

function familyRepoIds(rootId: string, repos: RepoRow[]): string[] {
  return repos.filter((r) => r.id === rootId || r.parentId === rootId || (rootId === "app" && r.kind === "worktree" && !r.parentId)).map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------

export interface DashboardDeps {
  now?: number;
  progress?: GitScanProgress | null;
  bridge?: { state: "online" | "reconnecting" | "offline"; reason: string | null };
}

function scanState(progress: GitScanProgress | null | undefined, hasRepos: boolean, now: number): GitDashboard["scan"]["state"] {
  if (progress?.phase === "scanning" && now - Date.parse(progress.startedAt) < 15 * 60_000) return "scanning";
  if (!hasRepos) return "never";
  if (progress?.phase === "error") return "error";
  return "idle";
}

/** Sichtbare Repos: alles, was im letzten Lauf mitkam (weggeräumte Worktrees verschwinden). */
function visibleRepos(all: RepoRow[]): RepoRow[] {
  const newest = Math.max(0, ...all.map((r) => Date.parse(r.scannedAt)));
  return all.filter((r) => Date.parse(r.scannedAt) >= newest - STALE_MS);
}

/** dieselbe Auswahl für Git-Seite, Überblick und Nyx (`git_lage`). „Gelöscht“ steht in keiner
 * Spalte: ein weggeräumter Worktree bleibt in `git_repos` stehen, aber sein `scanned_at` bleibt hinter dem letzten
 * Lauf zurück (Brücke scannt alle 3 Min; älter als `STALE_MS` = nicht mehr da). */
export async function getVisibleRepos(db: Db): Promise<RepoRow[]> {
  return visibleRepos(await db.select().from(gitRepos));
}

/** „Ungesichert“ je Repo-Art zusammenzählen — EINE Rechnung für Git-Kennzahl und Überblick-Kachel. */
function totalUncommitted(repos: RepoRow[], countByRepo: Map<string, number>): UncommittedTotals {
  const out: UncommittedTotals = { files: 0, places: 0, repoFiles: 0, repoPlaces: 0, worktreeFiles: 0, worktreePlaces: 0 };
  for (const r of repos) {
    const n = countByRepo.get(r.id) ?? 0;
    if (n === 0) continue;
    out.files += n;
    out.places++;
    if (r.kind === "worktree") {
      out.worktreeFiles += n;
      out.worktreePlaces++;
    } else {
      out.repoFiles += n;
      out.repoPlaces++;
    }
  }
  return out;
}

/** „Ungesichert“ ohne das ganze Dashboard zu laden (Überblick). Nur Repos/Worktrees, die der
 * letzte Scan gesehen hat — vorher zählte der Überblick auch Zeilen längst gelöschter Worktrees mit. */
export async function getUncommittedTotals(db: Db, visible?: RepoRow[]): Promise<UncommittedTotals> {
  const repos = visible ?? (await getVisibleRepos(db));
  if (repos.length === 0) return totalUncommitted([], new Map());
  const rows = await db
    .select({ repoId: gitUncommitted.repoId, n: sql<number>`count(*)::int` })
    .from(gitUncommitted)
    .where(inArray(gitUncommitted.repoId, repos.map((r) => r.id)))
    .groupBy(gitUncommitted.repoId);
  return totalUncommitted(repos, new Map(rows.map((r) => [r.repoId, Number(r.n)])));
}

interface Ctx {
  now: number;
  repos: RepoRow[];
  byId: Map<string, RepoRow>;
  branches: (typeof gitBranches.$inferSelect)[];
  uncommitted: Map<string, UncommittedFile[]>;
  probes: (typeof gitProbeMerges.$inferSelect)[];
  families: RepoFamilies;
  sessions: SessionRow[];
  checkoutPaths: string[];
}

/**
 * Hauptprojekt der Git-Seite (Abschnitt „app“): ein Repo der Art `app`, sonst das zuletzt aktive
 * eigene Repo (Art `other`, nicht NyxOS selbst). Es wird in der Ansicht wie `app` behandelt (Farbe im
 * Heatmap, eigener Abschnitt mit Worktrees); die übrigen Repos bleiben unter „Weitere“.
 */
export function withPrimaryRepo(repos: RepoRow[]): RepoRow[] {
  if (repos.some((r) => r.kind === "app")) return repos;
  const lastMs = (r: RepoRow) => Date.parse(String(r.lastActivityAt ?? r.scannedAt ?? "")) || 0;
  const primary = repos.filter((r) => r.kind === "other").sort((a, b) => lastMs(b) - lastMs(a) || a.id.localeCompare(b.id))[0];
  return primary ? repos.map((r) => (r === primary ? { ...r, kind: "app" } : r)) : repos;
}

async function loadCtx(db: Db, now: number): Promise<Ctx> {
  const repos = withPrimaryRepo(await getVisibleRepos(db));
  const ids = repos.map((r) => r.id);
  const [branches, unc, probes, families, sess, wts] = await Promise.all([
    ids.length ? db.select().from(gitBranches).where(inArray(gitBranches.repoId, ids)) : Promise.resolve([]),
    ids.length ? db.select().from(gitUncommitted).where(inArray(gitUncommitted.repoId, ids)).orderBy(gitUncommitted.path) : Promise.resolve([]),
    ids.length ? db.select().from(gitProbeMerges).where(inArray(gitProbeMerges.repoId, ids)) : Promise.resolve([]),
    loadFamilies(db),
    loadSessionsWithCwd(db),
    ids.length ? db.select({ path: gitWorktrees.path }).from(gitWorktrees).where(inArray(gitWorktrees.repoId, ids)) : Promise.resolve([]),
  ]);
  const uncommitted = new Map<string, UncommittedFile[]>();
  for (const u of unc) {
    const list = uncommitted.get(u.repoId) ?? [];
    list.push({ path: u.path, statusCode: u.statusCode, group: u.group as ChangeGroup, ...(u.fromPath ? { fromPath: u.fromPath } : {}) });
    uncommitted.set(u.repoId, list);
  }
  const checkoutPaths = [...new Set([...repos.map((r) => r.root), ...wts.map((w) => w.path)])];
  return { now, repos, byId: new Map(repos.map((r) => [r.id, r])), branches, uncommitted, probes, families, sessions: sess, checkoutPaths };
}

function branchRows(ctx: Ctx, repo: RepoRow): GitBranchRow[] {
  const familyRoot = repo.id;
  const checkouts = ctx.families.checkouts.get(familyRoot);
  return ctx.branches
    .filter((b) => b.repoId === repo.id)
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || (Date.parse(b.lastCommitAt ?? "") || 0) - (Date.parse(a.lastCommitAt ?? "") || 0))
    .map((b) => {
      const probe = ctx.probes.find((p) => p.repoId === repo.id && p.branch === b.name);
      return {
        name: b.name,
        ahead: b.ahead,
        behind: b.behind,
        isCurrent: b.isCurrent,
        lastCommitAt: iso(b.lastCommitAt),
        upstream: b.upstream,
        probe: probe ? { status: probe.status as "clean" | "conflict", conflictFiles: probe.conflictFiles, checkedAt: iso(probe.checkedAt) ?? probe.checkedAt } : null,
        checkedOutAt: checkouts?.get(b.name) ?? null,
      };
    });
}

function sessionsAt(ctx: Ctx, path: string): SessionRow[] {
  return ctx.sessions.filter((s) => checkoutOf(s.cwd, ctx.checkoutPaths) === path);
}

async function worktreeCard(db: Db, ctx: Ctx, repo: RepoRow, headCommits: Map<string, GitCommitRow>, catchups: Map<string, { outcome: string; detail: string; at: string }>): Promise<GitWorktreeCard> {
  const own = ctx.branches.find((b) => b.repoId === repo.id && b.name === repo.currentBranch);
  const parentId = repo.parentId ?? "app";
  const probe = ctx.probes.find((p) => p.repoId === parentId && p.branch === repo.currentBranch);
  const here = sessionsAt(ctx, repo.root);
  const open = here.filter(isOpen);
  const lastSessionAt = here[0]?.lastActivityAt ?? null;
  const catchup = catchups.get(repo.root);
  return {
    repoId: repo.id,
    label: repo.label,
    path: repo.root,
    parentRepoId: parentId,
    branch: repo.currentBranch,
    headSha: repo.headSha,
    ahead: own?.ahead ?? 0,
    behind: own?.behind ?? 0,
    mainBranch: repo.mainBranch ?? "main",
    uncommitted: summarize(ctx.uncommitted.get(repo.id) ?? [], 12),
    lastActivityAt: [iso(repo.lastActivityAt), iso(lastSessionAt)].filter((v): v is string => !!v).sort().at(-1) ?? null,
    sessions: { open: open.slice(0, 5).map(toRef), recent: here.filter((s) => !isOpen(s)).slice(0, 3).map(toRef), total: here.length },
    probe: probe ? { status: probe.status as "clean" | "conflict", conflictFiles: probe.conflictFiles } : null,
    lastCommit: (repo.headSha ? headCommits.get(repo.headSha) : undefined) ?? null,
    catchup: catchup ? { outcome: catchup.outcome as CatchupOutcome, detail: catchup.detail, at: catchup.at } : null,
  };
}

async function repoSection(db: Db, ctx: Ctx, repo: RepoRow, commitsByFamily: Map<string, { sha: string; at: number }[]>): Promise<GitRepoSection> {
  const famIds = familyRepoIds(repo.id, ctx.repos);
  const recent = await db
    .select()
    .from(gitCommits)
    .where(inArray(gitCommits.repoId, famIds))
    .orderBy(desc(commitAt))
    .limit(20);
  const days = lastDays(ctx.now, 30);
  const perDay = new Map<string, Set<string>>();
  for (const c of commitsByFamily.get(repo.id) ?? []) {
    const d = localDay(c.at);
    const s = perDay.get(d) ?? new Set<string>();
    s.add(c.sha);
    perDay.set(d, s);
  }
  const commitsPerDay = days.map((d) => perDay.get(d)?.size ?? 0);
  return {
    repoId: repo.id,
    label: repo.label,
    kind: repo.kind as RepoKind,
    root: repo.root,
    currentBranch: repo.currentBranch,
    headSha: repo.headSha,
    mainBranch: repo.mainBranch ?? "main",
    scannedAt: iso(repo.scannedAt) ?? repo.scannedAt,
    lastActivityAt: iso(repo.lastActivityAt),
    uncommitted: summarize(ctx.uncommitted.get(repo.id) ?? []),
    branches: branchRows(ctx, repo),
    commits30d: commitsPerDay.reduce((a, b) => a + b, 0),
    commitsPerDay,
    recentCommits: (await toCommitRows(db, recent, ctx.byId)).slice(0, 8),
    tags: repo.tags.slice(0, 10),
  };
}

const ACTION_LABEL: Record<GitActionRowKind, string> = {
  merge: "Merge",
  pull: "Pull",
  push: "Push",
  reset: "Reset",
  checkout: "Zweig gewechselt",
  rebase: "Rebase",
  "cherry-pick": "Cherry-Pick",
  revert: "Revert",
  amend: "Commit geändert",
  commit: "Commit",
  worktree: "Arbeitskopie angelegt",
  other: "Git-Aktion",
  "probe-merge": "Probe-Merge von NyxOS",
  catchup: "Nachgezogen (NyxOS)",
  reservation: "Bereich reserviert",
};

/** Aktions-Log: Reflog + eigene Aktionen der NyxOS, neueste zuerst, mit „wer“. */
async function actionLog(db: Db, ctx: Ctx, limit = 60): Promise<GitActionRow[]> {
  const ids = ctx.repos.map((r) => r.id);
  const out: GitActionRow[] = [];
  const reflog = ids.length
    ? await db
        .select()
        .from(gitActions)
        .where(and(inArray(gitActions.repoId, ids), gte(gitActions.at, new Date(ctx.now - 90 * DAY_MS).toISOString())))
        .orderBy(desc(gitActions.at))
        .limit(limit)
    : [];

  // Wer? Einmal die Belege (git-Befehle der Sessions) für das Zeitfenster laden.
  const evidence: { calls: CallRow[]; active: { sessionKey: string; cwd: string | null; startedAt: string | null; lastActivityAt: string | null }[] } = { calls: [], active: [] };
  for (const w of clusterTimes(reflog.map((a) => Date.parse(a.at)))) {
    const e = await loadEvidence(db, w.from, w.to);
    evidence.calls.push(...e.calls);
    evidence.active.push(...e.active);
  }
  const whoKeys: string[] = [];
  const matched = reflog.map((a) => {
    const repo = ctx.byId.get(a.repoId);
    const target = targetFor(ctx.families, a.repoId, null, iso(a.at) ?? a.at);
    target.checkout = checkoutOf(a.worktreePath, target.family) ?? a.worktreePath;
    const verbs = ACTION_VERBS[a.action as keyof typeof ACTION_VERBS] ?? [];
    // Aktionen (Reset, Wechsel …) sind schnell: nur Befehle im selben Ordner, höchstens 3 Min vorher.
    const m = verbs.length > 0 ? matchCommit(target, evidence, verbs, "Eintrag", { beforeS: 180, exactOnly: true }) : null;
    if (m?.sessionKey) whoKeys.push(m.sessionKey);
    return { a, repo, m };
  });
  const refs = await sessionRefs(db, whoKeys);
  for (const { a, repo, m } of matched) {
    const root = repo?.kind === "worktree" ? ctx.byId.get(repo.parentId ?? "app") : repo;
    const session = m?.sessionKey ? (refs.get(m.sessionKey) ?? null) : null;
    out.push({
      id: `reflog:${a.id}`,
      at: iso(a.at) ?? a.at,
      kind: a.action as GitActionRowKind,
      label: t(ACTION_LABEL[a.action as GitActionRowKind] ?? "Git-Aktion"),
      detail: a.subject,
      repoId: root?.id ?? a.repoId,
      repoLabel: root?.label ?? null,
      repoKind: familyKind(repo, ctx.byId),
      where: a.worktreePath,
      sha: a.newSha,
      who: session && m && m.confidence !== "keine" ? { type: "session", session, confidence: m.confidence } : { type: "user", session: null, confidence: m?.confidence ?? null },
    });
  }

  // Probe-Merges der NyxOS: je Repo ein Eintrag mit dem letzten Stand.
  const byRepo = new Map<string, (typeof gitProbeMerges.$inferSelect)[]>();
  for (const p of ctx.probes) byRepo.set(p.repoId, [...(byRepo.get(p.repoId) ?? []), p]);
  for (const [repoId, list] of byRepo) {
    const repo = ctx.byId.get(repoId);
    const conflicts = list.filter((p) => p.status === "conflict");
    const at = list.map((p) => iso(p.checkedAt) ?? p.checkedAt).sort().at(-1) ?? new Date(ctx.now).toISOString();
    out.push({
      id: `probe:${repoId}:${at}`,
      at,
      kind: "probe-merge",
      label: t(ACTION_LABEL["probe-merge"]),
      detail:
        conflicts.length === 0
          ? list.length === 1
            ? t("1 Zweig lässt sich sauber in {main} mergen.", { main: repo?.mainBranch ?? "main" })
            : t("{n} Zweige lassen sich sauber in {main} mergen.", { n: list.length, main: repo?.mainBranch ?? "main" })
          : t("{n} von {total} Zweigen hätten Konflikte: {branches}", { n: conflicts.length, total: list.length, branches: conflicts.map((c) => c.branch).join(", ") }),
      repoId,
      repoLabel: repo?.label ?? repoId,
      repoKind: familyKind(repo, ctx.byId),
      where: repo?.root ?? null,
      sha: null,
      who: { type: "nyxos", session: null, confidence: null },
    });
  }

  // Nachgezogen (nur echte Merges der NyxOS, nicht jeder Vorschlag).
  const merged = await db.select().from(gitCatchupHistory).where(eq(gitCatchupHistory.outcome, "merged")).orderBy(desc(gitCatchupHistory.at)).limit(20);
  for (const c of merged) {
    const repo = ctx.byId.get(c.repoId);
    out.push({ id: `catchup:${c.id}`, at: iso(c.at) ?? c.at, kind: "catchup", label: t(ACTION_LABEL.catchup), detail: `${c.branch}: ${c.detail}`, repoId: c.repoId, repoLabel: repo?.label ?? c.repoId, repoKind: familyKind(repo, ctx.byId), where: c.worktreePath, sha: c.mainShaAfter, who: { type: "nyxos", session: null, confidence: null } });
  }

  // Reservierungen (NyxOS).
  const res = await db.select().from(reservations).orderBy(desc(reservations.createdAt)).limit(20);
  const resRefs = await sessionRefs(
    db,
    res.map((r) => r.sessionKey).filter((k): k is string => !!k),
  );
  for (const r of res) {
    const session = r.sessionKey ? (resRefs.get(r.sessionKey) ?? null) : null;
    out.push({
      id: `reservation:${r.id}`,
      at: iso(r.createdAt) ?? r.createdAt,
      kind: "reservation",
      label: t(ACTION_LABEL.reservation),
      detail: `${r.label} (${r.pathGlob})`,
      repoId: null,
      repoLabel: null,
      repoKind: null,
      where: r.pathGlob,
      sha: null,
      who: session ? { type: "session", session, confidence: "sicher" } : { type: "nyxos", session: null, confidence: null },
    });
  }

  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

export async function getGitDashboard(db: Db, deps: DashboardDeps = {}): Promise<GitDashboard> {
  const now = deps.now ?? Date.now();
  const ctx = await loadCtx(db, now);
  const bridge = deps.bridge ?? { state: "offline" as const, reason: null };
  const lastScanAt = ctx.repos.length ? (ctx.repos.map((r) => iso(r.scannedAt) ?? "").sort().at(-1) ?? null) : null;
  const scan = { state: scanState(deps.progress, ctx.repos.length > 0, now), progress: deps.progress ?? null, lastScanAt, bridge };

  const roots = ctx.repos.filter((r) => r.kind !== "worktree");
  const children = ctx.repos.filter((r) => r.kind === "worktree");

  // Commits der letzten 84 Tage (Heatmap, Kennzahlen, Sparklines) — Tage in Zeitzone des Nutzers.
  const since = new Date(now - (HEATMAP_DAYS + 1) * DAY_MS).toISOString();
  const recentAll = ctx.repos.length
    ? await db
        .select({ repoId: gitCommits.repoId, sha: gitCommits.sha, at: sql<string>`${commitAt}` })
        .from(gitCommits)
        .where(and(inArray(gitCommits.repoId, ctx.repos.map((r) => r.id)), sql`${commitAt} >= ${since}::timestamptz`))
    : [];
  const commitsByFamily = new Map<string, { sha: string; at: number }[]>();
  const heat = new Map<string, { app: Set<string>; nyxos: Set<string>; other: Set<string> }>();
  const allByDay = new Map<string, Set<string>>();
  for (const c of recentAll) {
    const repo = ctx.byId.get(c.repoId);
    const rootId = repo?.kind === "worktree" ? (repo.parentId ?? "app") : c.repoId;
    const at = Date.parse(new Date(c.at).toISOString());
    commitsByFamily.set(rootId, [...(commitsByFamily.get(rootId) ?? []), { sha: c.sha, at }]);
    const day = localDay(at);
    const kind = familyKind(repo, ctx.byId);
    const bucket = heat.get(day) ?? { app: new Set(), nyxos: new Set(), other: new Set() };
    (kind === "nyxos" ? bucket.nyxos : kind === "other" ? bucket.other : bucket.app).add(c.sha);
    heat.set(day, bucket);
    allByDay.set(day, (allByDay.get(day) ?? new Set()).add(c.sha));
  }
  const days = lastDays(now, HEATMAP_DAYS);
  const heatmap = days.map((day) => {
    const b = heat.get(day);
    return { day, app: b?.app.size ?? 0, nyxos: b?.nyxos.size ?? 0, other: b?.other.size ?? 0 };
  });
  const countDays = (from: number, to: number) => {
    const set = new Set<string>();
    for (const d of days.slice(from, to)) for (const s of allByDay.get(d) ?? []) set.add(s);
    return set.size;
  };
  const n = days.length;
  const openBranches = ctx.branches.filter((b) => {
    const repo = ctx.byId.get(b.repoId);
    return repo && repo.kind !== "worktree" && b.name !== (repo.mainBranch ?? "main") && b.ahead > 0;
  }).length;
  const uncommitted = totalUncommitted(ctx.repos, new Map([...ctx.uncommitted].map(([id, list]) => [id, list.length])));
  const kpis = {
    commitsToday: countDays(n - 1, n),
    commits7d: countDays(n - 7, n),
    commitsPrev7d: countDays(n - 14, n - 7),
    commits30d: countDays(n - 30, n),
    openBranches,
    worktrees: children.length,
    uncommittedFiles: uncommitted.files,
    uncommittedPlaces: uncommitted.places,
    uncommitted,
  };

  const mergeRows = ctx.repos.length
    ? await db
        .select()
        .from(gitCommits)
        .where(and(inArray(gitCommits.repoId, ctx.repos.map((r) => r.id)), gte(gitCommits.parentCount, 2)))
        .orderBy(desc(commitAt))
        .limit(24)
    : [];
  const merges = (await toCommitRows(db, mergeRows, ctx.byId)).slice(0, 12);

  // Letzter Commit je Worktree (ihr HEAD).
  const heads = children.map((c) => c.headSha).filter((s): s is string => !!s);
  const headRows = heads.length ? await db.select().from(gitCommits).where(inArray(gitCommits.sha, heads)) : [];
  const headCommits = new Map((await toCommitRows(db, headRows, ctx.byId)).map((c) => [c.sha, c]));
  const catchRows = await db.select().from(gitCatchupHistory).orderBy(desc(gitCatchupHistory.at)).limit(500);
  const catchups = new Map<string, { outcome: string; detail: string; at: string }>();
  for (const c of catchRows) if (!catchups.has(c.worktreePath)) catchups.set(c.worktreePath, { outcome: c.outcome, detail: c.detail, at: iso(c.at) ?? c.at });

  const appRepo = roots.find((r) => r.kind === "app");
  const cardsFor = async (parent: string) => {
    const list = children.filter((c) => (c.parentId ?? appRepo?.id) === parent);
    const cards = await Promise.all(list.map((c) => worktreeCard(db, ctx, c, headCommits, catchups)));
    return cards.sort((a, b) => (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0));
  };
  const zRepo = roots.find((r) => r.kind === "nyxos");
  return {
    scan,
    kpis,
    heatmap,
    merges,
    actions: await actionLog(db, ctx),
    app: appRepo ? await repoSection(db, ctx, appRepo, commitsByFamily) : null,
    appWorktrees: appRepo ? await cardsFor(appRepo.id) : [],
    nyxos: zRepo ? await repoSection(db, ctx, zRepo, commitsByFamily) : null,
    nyxosWorktrees: zRepo ? await cardsFor(zRepo.id) : [],
    others: await Promise.all(roots.filter((r) => r.kind === "other").map((r) => repoSection(db, ctx, r, commitsByFamily))),
  };
}

// ---------------------------------------------------------------------------------------------
// Großansichten
// ---------------------------------------------------------------------------------------------

export async function getCommitDetail(db: Db, repoId: string, sha: string): Promise<GitCommitDetail | null> {
  const all = await db.select().from(gitRepos);
  const byId = new Map(all.map((r) => [r.id, r]));
  const famIds = familyRepoIds(byId.get(repoId)?.kind === "worktree" ? (byId.get(repoId)?.parentId ?? "app") : repoId, all);
  const rows = await db
    .select()
    .from(gitCommits)
    .where(and(inArray(gitCommits.repoId, famIds.length ? famIds : [repoId]), eq(gitCommits.sha, sha)))
    .limit(5);
  const row = rows.find((r) => r.files !== null) ?? rows[0];
  if (!row) return null;
  const [base] = await toCommitRows(db, [row], byId);
  if (!base) return null;
  const families = await loadFamilies(db);
  const files = row.files ?? [];
  return {
    ...base,
    files,
    filesTruncated: (row.filesChanged ?? files.length) > files.length,
    worktreePath: targetFor(families, row.repoId, row.branch, base.committedAt).checkout,
  };
}

export async function getBranchDetail(db: Db, repoId: string, name: string): Promise<GitBranchDetail | null> {
  const ctx = await loadCtx(db, Date.now());
  const repo = ctx.byId.get(repoId);
  if (!repo) return null;
  const branch = branchRows(ctx, repo).find((b) => b.name === name);
  if (!branch) return null;
  const raw = ctx.branches.find((b) => b.repoId === repoId && b.name === name);
  const famIds = familyRepoIds(repoId, ctx.repos);
  const shas = raw?.aheadShas ?? [];
  let rows: CommitDbRow[];
  if (shas.length > 0) {
    rows = await db.select().from(gitCommits).where(and(inArray(gitCommits.repoId, famIds), inArray(gitCommits.sha, shas))).orderBy(desc(commitAt));
  } else {
    rows = await db.select().from(gitCommits).where(and(inArray(gitCommits.repoId, famIds), eq(gitCommits.branch, name))).orderBy(desc(commitAt)).limit(60);
  }
  return { repoId, repoLabel: repo.label, kind: repo.kind as RepoKind, mainBranch: repo.mainBranch ?? "main", branch, commits: await toCommitRows(db, rows, ctx.byId) };
}

export async function getWorktreeDetail(db: Db, repoId: string): Promise<GitWorktreeDetail | null> {
  const ctx = await loadCtx(db, Date.now());
  const repo = ctx.byId.get(repoId);
  if (!repo || repo.kind !== "worktree") return null;
  const own = ctx.branches.find((b) => b.repoId === repo.id && b.name === repo.currentBranch);
  const famIds = familyRepoIds(repo.parentId ?? "app", ctx.repos);
  const shas = own?.aheadShas ?? [];
  const commitRows = shas.length ? await db.select().from(gitCommits).where(and(inArray(gitCommits.repoId, famIds), inArray(gitCommits.sha, shas))).orderBy(desc(commitAt)) : [];
  const commits = await toCommitRows(db, commitRows, ctx.byId);
  const headCommits = new Map(commits.map((c) => [c.sha, c]));
  const catchRows = await db.select().from(gitCatchupHistory).where(eq(gitCatchupHistory.worktreePath, repo.root)).orderBy(desc(gitCatchupHistory.at)).limit(1);
  const catchups = new Map(catchRows.map((c) => [c.worktreePath, { outcome: c.outcome, detail: c.detail, at: iso(c.at) ?? c.at }]));
  const card = await worktreeCard(db, ctx, repo, headCommits, catchups);
  const actionRows = await db.select().from(gitActions).where(eq(gitActions.worktreePath, repo.root)).orderBy(desc(gitActions.at)).limit(30);
  const actions: GitActionRow[] = actionRows.map((a) => ({
    id: `reflog:${a.id}`,
    at: iso(a.at) ?? a.at,
    kind: a.action as GitActionRowKind,
    label: t(ACTION_LABEL[a.action as GitActionRowKind] ?? "Git-Aktion"),
    detail: a.subject,
    repoId: repo.parentId ?? "app",
    repoLabel: ctx.byId.get(repo.parentId ?? "app")?.label ?? null,
    repoKind: familyKind(repo, ctx.byId),
    where: a.worktreePath,
    sha: a.newSha,
    who: { type: "user", session: null, confidence: null },
  }));
  return { card, sessions: sessionsAt(ctx, repo.root).slice(0, 50).map(toRef), commits, uncommitted: ctx.uncommitted.get(repo.id) ?? [], actions };
}

/** Heatmap-Zelle → Commits dieses Kalendertag (Zeitzone des Nutzers)s (alle Repos), neueste zuerst. */
export async function getCommitsOfDay(db: Db, day: string): Promise<GitCommitRow[] | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const mid = Date.parse(`${day}T12:00:00Z`);
  if (Number.isNaN(mid)) return null;
  const all = await db.select().from(gitRepos);
  const rows = await db
    .select()
    .from(gitCommits)
    .where(and(sql`${commitAt} >= ${new Date(mid - DAY_MS).toISOString()}::timestamptz`, sql`${commitAt} <= ${new Date(mid + DAY_MS).toISOString()}::timestamptz`))
    .orderBy(desc(commitAt))
    .limit(1000);
  const onDay = rows.filter((r) => localDay(Date.parse(new Date(r.committedAt ?? r.authorDate).toISOString())) === day);
  return toCommitRows(db, onDay, new Map(all.map((r) => [r.id, r])));
}

/** Session-Ordner für die Brücke (weitere Repos finden). Nur Ordnernamen, letzte 60 Tage. */
export async function sessionCwds(db: Db, now = Date.now()): Promise<string[]> {
  const rows = await db
    .selectDistinct({ cwd: sessions.cwd })
    .from(sessions)
    .where(and(isNotNull(sessions.cwd), sql`coalesce(${sessions.lastActivityAt}, ${sessions.createdAt}) >= ${new Date(now - 60 * DAY_MS).toISOString()}::timestamptz`))
    .limit(1000);
  return rows.map((r) => r.cwd).filter((c): c is string => !!c);
}
