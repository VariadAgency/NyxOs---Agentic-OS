// Git-Stand. Die Brücke schickt je Scan eine volle Momentaufnahme (`GitSnapshotPayload`) —
// Zweige/ungesicherte Änderungen/Worktrees/Probe-Merges werden je Repo ERSETZT (kein Ereignisstrom,
// s. Kommentar in db/schema.ts), Commits werden ANGEHÄNGT (dedupliziert über `sha`).
import type { CatchupRecord, CommitInfo, GitSnapshotPayload, ReflogAction, RepoSnapshot, WorktreeInfo } from "@nyxos/shared";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gitActions, gitBranches, gitCatchupHistory, gitCommits, gitProbeMerges, gitRepos, gitUncommitted, gitWorktrees, sessions } from "../db/schema.js";
import { recordConflictEvent } from "../conflicts/store.js";
import { attributeCommits } from "./attribution.js";
import { visibleSession } from "../db/visible.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function replaceBranches(tx: Tx, repoId: string, branches: RepoSnapshot["branches"]): Promise<void> {
  await tx.delete(gitBranches).where(eq(gitBranches.repoId, repoId));
  if (branches.length === 0) return;
  await tx.insert(gitBranches).values(
    branches.map((b) => ({
      repoId,
      name: b.name,
      ahead: b.ahead,
      behind: b.behind,
      isCurrent: b.isCurrent,
      lastCommitAt: b.lastCommitAt,
      upstream: b.upstream,
      aheadShas: b.aheadShas ?? [],
    })),
  );
}

/** Reflog-Aktionen anhängen (deterministische ID → doppelt senden ist harmlos). */
async function appendActions(tx: Tx, repoId: string, actions: ReflogAction[]): Promise<void> {
  if (actions.length === 0) return;
  for (let i = 0; i < actions.length; i += 500) {
    await tx
      .insert(gitActions)
      .values(actions.slice(i, i + 500).map((a) => ({ id: a.id, repoId, worktreePath: a.worktreePath, ref: a.ref, at: a.at, action: a.action, subject: a.subject, newSha: a.newSha, identity: a.identity })))
      // Gleiche ID = gleicher Reflog-Eintrag; Art/Text dürfen sich mit einer neueren Brücke ändern.
      .onConflictDoUpdate({ target: gitActions.id, set: { action: sql`excluded.action`, subject: sql`excluded.subject` } });
  }
}

async function replaceUncommitted(tx: Tx, repoId: string, files: RepoSnapshot["uncommitted"]): Promise<void> {
  await tx.delete(gitUncommitted).where(eq(gitUncommitted.repoId, repoId));
  if (files.length === 0) return;
  await tx.insert(gitUncommitted).values(
    files.map((f) => ({ repoId, path: f.path, statusCode: f.statusCode, group: f.group, fromPath: f.fromPath ?? null })),
  );
}

async function replaceWorktrees(tx: Tx, repoId: string, worktrees: WorktreeInfo[]): Promise<void> {
  await tx.delete(gitWorktrees).where(eq(gitWorktrees.repoId, repoId));
  if (worktrees.length === 0) return;
  await tx.insert(gitWorktrees).values(
    worktrees.map((w) => ({ repoId, path: w.path, branch: w.branch, headSha: w.headSha, locked: w.locked })),
  );
}

/** Commits anhängen. Schon bekannte Zeilen (z. B. aus einer älteren Brücke ohne Datei-Statistik)
 * bekommen die neuen Felder nachgetragen; Zweig und Session-Zuordnung bleiben, wie sie sind. */
async function appendCommits(tx: Tx, repoId: string, commits: CommitInfo[]): Promise<void> {
  if (commits.length === 0) return;
  for (let i = 0; i < commits.length; i += 300) {
    await tx
      .insert(gitCommits)
      .values(
        commits.slice(i, i + 300).map((c) => ({
          repoId,
          sha: c.sha,
          authorDate: c.authorDate,
          subject: c.subject,
          branch: c.branch,
          authorName: c.authorName ?? null,
          committedAt: c.committedAt ?? c.authorDate,
          parentCount: c.parents ?? 1,
          files: c.files ?? null,
          filesChanged: c.filesChanged ?? null,
          insertions: c.insertions ?? null,
          deletions: c.deletions ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [gitCommits.repoId, gitCommits.sha],
        set: {
          authorName: sql`coalesce(excluded.author_name, ${gitCommits.authorName})`,
          committedAt: sql`coalesce(excluded.committed_at, ${gitCommits.committedAt})`,
          parentCount: sql`excluded.parent_count`,
          files: sql`coalesce(excluded.files, ${gitCommits.files})`,
          filesChanged: sql`coalesce(excluded.files_changed, ${gitCommits.filesChanged})`,
          insertions: sql`coalesce(excluded.insertions, ${gitCommits.insertions})`,
          deletions: sql`coalesce(excluded.deletions, ${gitCommits.deletions})`,
        },
      });
  }
}

/** Probe-Merges upserten. Gibt neue Konflikte zurück (fürs Lernbuch, s. Aufrufer) statt sie
 * innerhalb der Transaktion zu protokollieren (`recordConflictEvent` braucht `Db`, nicht `Tx`). */
async function replaceProbeMerges(tx: Tx, repoId: string, repoRoot: string, merges: RepoSnapshot["probeMerges"]): Promise<{ folder: string; path: string }[]> {
  await tx.delete(gitProbeMerges).where(eq(gitProbeMerges.repoId, repoId));
  const newConflicts: { folder: string; path: string }[] = [];
  for (const m of merges) {
    await tx.insert(gitProbeMerges).values({
      repoId,
      branch: m.branch,
      status: m.status,
      conflictFiles: m.conflictFiles,
      checkedAt: m.checkedAt,
      checksumBefore: m.workingTreeChecksumBefore,
      checksumAfter: m.workingTreeChecksumAfter,
    });
    // "Ordner" fürs Lernbuch = Repo-Wurzel (ein Probe-Merge-Konflikt betrifft den ganzen Zweig,
    // nicht eine einzelne Datei).
    if (m.status === "conflict") newConflicts.push({ folder: repoRoot, path: `${repoRoot}@${m.branch}` });
  }
  return newConflicts;
}

/** Nimmt eine Momentaufnahme entgegen (idempotent — dieselbe Nachricht erneut senden ist harmlos). */
export async function upsertGitSnapshot(db: Db, payload: GitSnapshotPayload): Promise<void> {
  const newConflicts: { folder: string; path: string }[] = [];
  await db.transaction(async (tx) => {
    for (const repo of payload.repos) {
      await tx
        .insert(gitRepos)
        .values({
          id: repo.repoId,
          label: repo.label,
          kind: repo.kind,
          root: repo.root,
          currentBranch: repo.currentBranch,
          headSha: repo.headSha,
          tags: repo.tags,
          scannedAt: repo.scannedAt,
          parentId: repo.parentRepoId ?? null,
          mainBranch: repo.mainBranch ?? null,
          lastActivityAt: repo.lastActivityAt ?? null,
        })
        .onConflictDoUpdate({
          target: gitRepos.id,
          set: {
            label: repo.label,
            kind: repo.kind,
            root: repo.root,
            currentBranch: repo.currentBranch,
            headSha: repo.headSha,
            tags: repo.tags,
            scannedAt: repo.scannedAt,
            parentId: repo.parentRepoId ?? null,
            mainBranch: repo.mainBranch ?? null,
            lastActivityAt: repo.lastActivityAt ?? null,
          },
        });
      await replaceBranches(tx, repo.repoId, repo.branches);
      await replaceUncommitted(tx, repo.repoId, repo.uncommitted);
      await appendCommits(tx, repo.repoId, repo.recentCommits);
      await appendActions(tx, repo.repoId, repo.reflog ?? []);
      newConflicts.push(...(await replaceProbeMerges(tx, repo.repoId, repo.root, repo.probeMerges)));
      if (repo.worktrees) await replaceWorktrees(tx, repo.repoId, repo.worktrees);
    }
    if (payload.catchups && payload.catchups.length > 0) {
      await tx.insert(gitCatchupHistory).values(
        payload.catchups.map((c) => ({
          repoId: c.repoId,
          worktreePath: c.worktreePath,
          branch: c.branch,
          outcome: c.outcome,
          mainShaBefore: c.mainShaBefore,
          mainShaAfter: c.mainShaAfter,
          detail: c.detail,
          at: c.at,
        })),
      );
    }
  });
  for (const c of newConflicts) await recordConflictEvent(db, "merge", c.folder, c.path);
  // neue Commits (und noch unsichere ältere) einer Session zuordnen.
  if (payload.repos.length > 0) await attributeCommits(db);
}

export async function getCatchupHistory(db: Db, repoId?: string, limit = 50): Promise<CatchupRecord[]> {
  const rows = await db
    .select()
    .from(gitCatchupHistory)
    .where(repoId ? eq(gitCatchupHistory.repoId, repoId) : undefined)
    .orderBy(desc(gitCatchupHistory.at))
    .limit(limit);
  return rows.map((r) => ({ repoId: r.repoId, worktreePath: r.worktreePath, branch: r.branch, outcome: r.outcome as CatchupRecord["outcome"], mainShaBefore: r.mainShaBefore, mainShaAfter: r.mainShaAfter, detail: r.detail, at: r.at }));
}

/** Welche offenen Sessions arbeiten unter diesem Pfad (Präfix-Vergleich auf `sessions.cwd`)?
 * Serverseitig ergänzt statt in der Brücke,
 * die die Session-Tabelle nicht kennt. */
async function activeSessionsUnder(db: Db, path: string): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(isNull(sessions.closedAt), visibleSession, or(eq(sessions.cwd, path), sql`${sessions.cwd} like ${path + "/%"}`)));
  return rows.map((r) => r.id);
}

export type RepoDTO = RepoSnapshot;

export async function getGitSnapshot(db: Db): Promise<{ repos: RepoDTO[] }> {
  const repos = await db.select().from(gitRepos).orderBy(gitRepos.id);
  const out: RepoDTO[] = [];
  for (const repo of repos) {
    const [branches, uncommitted, worktreesRaw, probeMergesRaw, commits] = await Promise.all([
      db.select().from(gitBranches).where(eq(gitBranches.repoId, repo.id)).orderBy(gitBranches.name),
      db.select().from(gitUncommitted).where(eq(gitUncommitted.repoId, repo.id)).orderBy(gitUncommitted.path),
      db.select().from(gitWorktrees).where(eq(gitWorktrees.repoId, repo.id)).orderBy(gitWorktrees.path),
      db.select().from(gitProbeMerges).where(eq(gitProbeMerges.repoId, repo.id)).orderBy(gitProbeMerges.branch),
      db.select().from(gitCommits).where(eq(gitCommits.repoId, repo.id)).orderBy(desc(gitCommits.authorDate)).limit(50),
    ]);
    const worktrees: WorktreeInfo[] = [];
    for (const w of worktreesRaw) {
      worktrees.push({ path: w.path, branch: w.branch, headSha: w.headSha, locked: w.locked, activeSessionKeys: await activeSessionsUnder(db, w.path) });
    }
    out.push({
      repoId: repo.id,
      label: repo.label,
      kind: repo.kind as RepoSnapshot["kind"],
      root: repo.root,
      currentBranch: repo.currentBranch,
      headSha: repo.headSha,
      tags: repo.tags,
      scannedAt: repo.scannedAt,
      parentRepoId: repo.parentId,
      mainBranch: repo.mainBranch ?? "main",
      lastActivityAt: repo.lastActivityAt,
      branches: branches.map((b) => ({ name: b.name, ahead: b.ahead, behind: b.behind, isCurrent: b.isCurrent, lastCommitAt: b.lastCommitAt, upstream: b.upstream, aheadShas: b.aheadShas })),
      uncommitted: uncommitted.map((u) => ({ path: u.path, statusCode: u.statusCode, group: u.group as RepoSnapshot["uncommitted"][number]["group"], fromPath: u.fromPath ?? undefined })),
      recentCommits: commits.map((c) => ({ sha: c.sha, authorDate: c.authorDate, subject: c.subject, branch: c.branch })),
      probeMerges: probeMergesRaw.map((m) => ({
        branch: m.branch,
        status: m.status as "clean" | "conflict",
        conflictFiles: m.conflictFiles,
        checkedAt: m.checkedAt,
        workingTreeChecksumBefore: m.checksumBefore,
        workingTreeChecksumAfter: m.checksumAfter,
      })),
      worktrees: repo.kind === "worktree" ? undefined : worktrees,
    });
  }
  return { repos: out };
}

/** `db.execute(sql\`…\`)` liefert je nach Treiber unterschiedlich (wie in search.ts `rowsOf`):
 * postgres-js (Produktion) Array direkt, PGlite (Tests) `{ rows: [...] }`. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

/** Commits der letzten `days` Tage je Kalendertag (Überblick-Diagramm). Da Git-Commits kein
 * "Werkzeug" kennen, ist die Aufteilung Claude/Codex/Mensch erst mit GitNexus möglich (nicht
 * P5) — hier zählt nur die echte Gesamtzahl je Tag, ehrlich statt geraten. */
export async function getCommitsPerDay(db: Db, days = 7, opts: { timeZone?: string; now?: Date } = {}): Promise<{ date: string; count: number }[]> {
  const since = new Date((opts.now?.getTime() ?? Date.now()) - days * 24 * 60 * 60 * 1000).toISOString();
  // Bewusst eine feste Zeitzone ("AT TIME ZONE …"): die Server-Sitzung kann eine andere haben (beobachtet:
  // PGlite zeigte kurz nach Mitternacht UTC schon den nächsten Kalendertag). Die DB-Seite muss so runden
  // wie der Aufrufer seine Tagesliste baut, sonst klafft am Tageswechsel eine Lücke. Der
  // Überblick zählt Tage in der Zeitzone des Nutzers (wie `usage_daily`) und übergibt darum `timeZone()`.
  const tz = opts.timeZone ?? "UTC";
  const result = await db.execute(
    sql`select to_char(author_date at time zone ${tz}, 'YYYY-MM-DD') as date, count(distinct sha)::int as count
        from git_commits where author_date >= ${since}::timestamptz group by 1 order by 1`,
  );
  return rowsOf<{ date: string; count: number }>(result);
}

export async function countBranchesAheadBehind(db: Db): Promise<{ ahead: number; behind: number; branches: number }> {
  const [row] = await db
    .select({ ahead: sql<number>`coalesce(sum(${gitBranches.ahead}),0)::int`, behind: sql<number>`coalesce(sum(${gitBranches.behind}),0)::int`, branches: sql<number>`count(*)::int` })
    .from(gitBranches)
    .where(gte(gitBranches.ahead, 0));
  return row ?? { ahead: 0, behind: 0, branches: 0 };
}
