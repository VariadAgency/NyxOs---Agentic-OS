// Git-Stand (Tab "Git" + Konflikte). Die Brücke liest die Repos in den Projektordnern samt ihrer
// Worktrees NUR LESEND und schickt eine Momentaufnahme je Repo
// an den Server (POST /ingest/git). Der Server hält je Repo den letzten Stand plus eine kurze
// Commit-Historie für das 7-Tage-Diagramm.
import { z } from "zod";
import { numberFormat } from "./format.js";
import { t } from "./i18n/index.js";

/** Vier Gruppen für ungesicherte Änderungen. */
export type ChangeGroup = "code" | "doku" | "projekt" | "verschoben";

export interface UncommittedFile {
  path: string;
  /** Rohcode aus `git status --porcelain=v2` (z. B. ".M", "A.", "??", "R."). */
  statusCode: string;
  group: ChangeGroup;
  /** Nur bei Umbenennung/Verschiebung gesetzt (alter Pfad). */
  fromPath?: string;
}

export interface BranchInfo {
  name: string;
  /** SHAs der eigenen Commits dieses Zweigs (die `main` fehlen), neueste zuerst, höchstens 200. */
  aheadShas?: string[];
  /** Commits, die `main` fehlen (dieser Zweig hat sie, main nicht). */
  ahead: number;
  /** Commits, die diesem Zweig fehlen (main hat sie, der Zweig nicht). */
  behind: number;
  isCurrent: boolean;
  /** ISO-Zeit des letzten Commits auf diesem Zweig. */
  lastCommitAt: string | null;
  upstream: string | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  headSha: string | null;
  locked: boolean;
  /** Wird serverseitig aus `sessions.cwd`/`worktree` ergänzt (Bezug zu offenen Sessions), s. git/overview.ts. */
  activeSessionKeys?: string[];
}

/** eine geänderte Datei eines Commits (`git log --numstat`). `null` = Binärdatei. */
export interface CommitFileStat {
  path: string;
  add: number | null;
  del: number | null;
}

export interface CommitInfo {
  sha: string;
  authorDate: string;
  subject: string;
  branch: string;
  /** (optional, ältere Brücken schicken es nicht): */
  authorName?: string;
  /** Zeit des Commits selbst (nicht des Autors) — Grundlage der Session-Zuordnung. */
  committedAt?: string;
  /** Anzahl Eltern-Commits; ≥ 2 = echter Merge-Commit. */
  parents?: number;
  /** Geänderte Dateien (höchstens 300); die Summen unten gelten auch bei gekürzter Liste. */
  files?: CommitFileStat[];
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

/** Art einer Git-Aktion (aus dem Reflog gelesen, nie selbst ausgeführt). */
export type GitActionKind = "merge" | "pull" | "push" | "reset" | "checkout" | "rebase" | "cherry-pick" | "revert" | "amend" | "commit" | "worktree" | "other";

/** ein Reflog-Eintrag (`git log -g`), nur gelesen. */
export interface ReflogAction {
  /** Deterministisch (Repo, Ref, Zeit, Ziel-SHA, Text) — doppeltes Senden ist harmlos. */
  id: string;
  /** "HEAD" oder z. B. "refs/remotes/origin/main" (Push). */
  ref: string;
  /** Arbeitskopie, in der die Aktion lief (bei Push: Repo-Wurzel). */
  worktreePath: string;
  at: string;
  action: GitActionKind;
  subject: string;
  newSha: string | null;
  identity: string | null;
}

export type ProbeMergeStatus = "clean" | "conflict";

export interface ProbeMergeResult {
  branch: string;
  status: ProbeMergeStatus;
  conflictFiles: string[];
  checkedAt: string;
  /** Nachweis: Arbeitsbaum-Prüfsumme vor/nach dem Probe-Merge — müssen gleich sein. */
  workingTreeChecksumBefore: string;
  workingTreeChecksumAfter: string;
}

/** "other": weiteres Repo, in dem laut `sessions.cwd` gearbeitet wurde. */
export type RepoKind = "app" | "worktree" | "nyxos" | "other";

export interface RepoSnapshot {
  /** Stabiler Schlüssel, z. B. "app" oder "worktree:notifications". */
  repoId: string;
  label: string;
  kind: RepoKind;
  root: string;
  currentBranch: string | null;
  headSha: string | null;
  branches: BranchInfo[];
  uncommitted: UncommittedFile[];
  recentCommits: CommitInfo[];
  probeMerges: ProbeMergeResult[];
  /** Nur beim App-Repo gesetzt (dort leben die Worktrees). */
  worktrees?: WorktreeInfo[];
  tags: string[];
  scannedAt: string;
  /** zu welchem Repo eine Worktree gehört ("app", "nyxos", …). */
  parentRepoId?: string | null;
  /** Zweig, gegen den vor/hinter gemessen wird (meist "main"). */
  mainBranch?: string;
  /** zuletzt aktiv (Reflog, letzter Commit, zuletzt geänderte ungesicherte Datei). */
  lastActivityAt?: string | null;
  /** Reflog-Einträge (Merge, Push, Reset, Checkout …), nur gelesen. */
  reflog?: ReflogAction[];
}

/** Fortschritt eines Brücken-Scans (für „Brücke scannt gerade …“). */
export interface GitScanProgress {
  phase: "scanning" | "done" | "error";
  done: number;
  total: number;
  current: string | null;
  startedAt: string;
  finishedAt: string | null;
  error?: string | null;
}

export interface GitSnapshotPayload {
  repos: RepoSnapshot[];
  /** Nachzieh-Entscheidungen dieses Laufs, optional (nicht jeder Scan prüft Nachziehen). */
  catchups?: CatchupRecord[];
  collectedAt: string;
}

/** Ergebnis eines Nachzieh-Versuchs (bridge-seitig entschieden, s. apps/bridge/src/git/catchup.ts). */
export type CatchupOutcome = "merged" | "nachzieh-session" | "skipped-dirty";

export interface CatchupRecord {
  repoId: string;
  worktreePath: string;
  branch: string;
  outcome: CatchupOutcome;
  mainShaBefore: string;
  mainShaAfter: string | null;
  detail: string;
  at: string;
}

const isoDate = z.iso.datetime({ offset: true });

export const UncommittedFileSchema = z.object({
  path: z.string().min(1),
  statusCode: z.string().min(1).max(10),
  group: z.enum(["code", "doku", "projekt", "verschoben"]),
  fromPath: z.string().optional(),
});

export const BranchInfoSchema = z.object({
  name: z.string().min(1),
  aheadShas: z.array(z.string().min(4)).max(500).optional(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  isCurrent: z.boolean(),
  lastCommitAt: isoDate.nullable(),
  upstream: z.string().nullable(),
});

export const WorktreeInfoSchema = z.object({
  path: z.string().min(1),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  locked: z.boolean(),
});

export const CommitFileStatSchema = z.object({
  path: z.string().min(1),
  add: z.number().int().nonnegative().nullable(),
  del: z.number().int().nonnegative().nullable(),
});

export const CommitInfoSchema = z.object({
  sha: z.string().min(4),
  authorDate: isoDate,
  subject: z.string(),
  branch: z.string(),
  authorName: z.string().optional(),
  committedAt: isoDate.optional(),
  parents: z.number().int().nonnegative().optional(),
  files: z.array(CommitFileStatSchema).max(300).optional(),
  filesChanged: z.number().int().nonnegative().optional(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

export const GIT_ACTION_KINDS = ["merge", "pull", "push", "reset", "checkout", "rebase", "cherry-pick", "revert", "amend", "commit", "worktree", "other"] as const;

export const ReflogActionSchema = z.object({
  id: z.string().min(1).max(200),
  ref: z.string().min(1),
  worktreePath: z.string().min(1),
  at: isoDate,
  action: z.enum(GIT_ACTION_KINDS),
  subject: z.string(),
  newSha: z.string().nullable(),
  identity: z.string().nullable(),
});

export const GitScanProgressSchema = z.object({
  phase: z.enum(["scanning", "done", "error"]),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  current: z.string().nullable(),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
  error: z.string().nullable().optional(),
});

export const ProbeMergeResultSchema = z.object({
  branch: z.string().min(1),
  status: z.enum(["clean", "conflict"]),
  conflictFiles: z.array(z.string()),
  checkedAt: isoDate,
  workingTreeChecksumBefore: z.string().min(1),
  workingTreeChecksumAfter: z.string().min(1),
});

export const RepoSnapshotSchema = z.object({
  repoId: z.string().min(1).max(200),
  label: z.string().min(1),
  kind: z.enum(["app", "worktree", "nyxos", "other"]),
  root: z.string().min(1),
  currentBranch: z.string().nullable(),
  headSha: z.string().nullable(),
  branches: z.array(BranchInfoSchema),
  uncommitted: z.array(UncommittedFileSchema),
  recentCommits: z.array(CommitInfoSchema),
  probeMerges: z.array(ProbeMergeResultSchema),
  worktrees: z.array(WorktreeInfoSchema).optional(),
  tags: z.array(z.string()),
  scannedAt: isoDate,
  parentRepoId: z.string().nullable().optional(),
  mainBranch: z.string().optional(),
  lastActivityAt: isoDate.nullable().optional(),
  reflog: z.array(ReflogActionSchema).max(2000).optional(),
});

export const CatchupRecordSchema = z.object({
  repoId: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  outcome: z.enum(["merged", "nachzieh-session", "skipped-dirty"]),
  mainShaBefore: z.string().min(1),
  mainShaAfter: z.string().nullable(),
  detail: z.string(),
  at: isoDate,
});

export const GitSnapshotPayloadSchema = z.object({
  repos: z.array(RepoSnapshotSchema).max(200),
  catchups: z.array(CatchupRecordSchema).max(200).optional(),
  collectedAt: isoDate,
});

// ---------------------------------------------------------------------------------------------
// Antwort-Formen der neuen Git-Seite (`GET /api/git/dashboard` und die Großansichten).
// ---------------------------------------------------------------------------------------------

/** Wie sicher die Zuordnung Commit → Session ist (s. apps/server/src/git/attribution.ts). */
export type AttributionConfidence = "sicher" | "wahrscheinlich" | "vermutet" | "keine";

export interface GitSessionRef {
  key: string;
  title: string | null;
  tool: string;
  /** P2-Zustand (running/waiting/idle/crashed/closed) oder `null` = beendet. */
  state: string | null;
  lastActivityAt: string | null;
  cwd: string | null;
}

export interface CommitAttribution {
  confidence: AttributionConfidence;
  session: GitSessionRef | null;
  /** Ein Satz für den Nutzer, woran die Zuordnung hängt. */
  reason: string;
}

export interface GitCommitRow {
  repoId: string;
  repoLabel: string;
  kind: RepoKind;
  sha: string;
  subject: string;
  branch: string;
  authorName: string | null;
  committedAt: string;
  parents: number;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  attribution: CommitAttribution;
}

export interface GitCommitDetail extends GitCommitRow {
  files: CommitFileStat[];
  /** Mehr geänderte Dateien, als mitgeschickt wurden (Liste gekürzt). */
  filesTruncated: boolean;
  /** Worktree, in der der Zweig dieses Commits ausgecheckt ist (falls eine). */
  worktreePath: string | null;
}

export interface GitBranchRow {
  name: string;
  ahead: number;
  behind: number;
  isCurrent: boolean;
  lastCommitAt: string | null;
  upstream: string | null;
  probe: { status: ProbeMergeStatus; conflictFiles: string[]; checkedAt: string } | null;
  /** Worktree, in der dieser Zweig ausgecheckt ist (Repo-Ordner selbst oder eine Worktree). */
  checkedOutAt: string | null;
}

export interface GitUncommittedSummary {
  total: number;
  groups: Record<ChangeGroup, number>;
  /** Die ersten Dateien (für die Liste), vollständig in der Großansicht. */
  files: UncommittedFile[];
}

export type GitActionRowKind = GitActionKind | "probe-merge" | "catchup" | "reservation";

export interface GitActionRow {
  id: string;
  at: string;
  kind: GitActionRowKind;
  /** Kurzer deutscher Titel, z. B. „Merge“, „Push“, „Probe-Merge der NyxOS“. */
  label: string;
  detail: string;
  repoId: string | null;
  repoLabel: string | null;
  repoKind: RepoKind | null;
  /** Wo: Ordner (Repo oder Worktree). */
  where: string | null;
  sha: string | null;
  who: { type: "session" | "user" | "nyxos"; session: GitSessionRef | null; confidence: AttributionConfidence | null };
}

export interface GitRepoSection {
  repoId: string;
  label: string;
  kind: RepoKind;
  root: string;
  currentBranch: string | null;
  headSha: string | null;
  mainBranch: string;
  scannedAt: string;
  lastActivityAt: string | null;
  uncommitted: GitUncommittedSummary;
  branches: GitBranchRow[];
  commits30d: number;
  /** Commits je Tag, letzte 30 Tage (älteste zuerst), für die Sparkline. */
  commitsPerDay: number[];
  recentCommits: GitCommitRow[];
  tags: string[];
}

export interface GitWorktreeCard {
  repoId: string;
  label: string;
  path: string;
  parentRepoId: string | null;
  branch: string | null;
  headSha: string | null;
  ahead: number;
  behind: number;
  mainBranch: string;
  uncommitted: GitUncommittedSummary;
  lastActivityAt: string | null;
  sessions: { open: GitSessionRef[]; recent: GitSessionRef[]; total: number };
  probe: { status: ProbeMergeStatus; conflictFiles: string[] } | null;
  lastCommit: GitCommitRow | null;
  catchup: { outcome: CatchupOutcome; detail: string; at: string } | null;
}

export interface GitDashboard {
  scan: {
    /** never = Brücke hat noch nie gescannt; scanning = läuft gerade; idle = Stand da; error = letzter Lauf abgelehnt. */
    state: "never" | "scanning" | "idle" | "error";
    progress: GitScanProgress | null;
    lastScanAt: string | null;
    bridge: { state: "online" | "reconnecting" | "offline"; reason: string | null };
  };
  kpis: {
    commitsToday: number;
    commits7d: number;
    commitsPrev7d: number;
    commits30d: number;
    openBranches: number;
    worktrees: number;
    uncommittedFiles: number;
    uncommittedPlaces: number;
    /** dieselbe Zählung wie die Überblick-Kachel „Ungesichert“, aufgeschlüsselt. Fehlt bei einem Server
     * vor P2b — dann nur `uncommittedFiles`/`uncommittedPlaces` (Leser: `uncommittedTotalsOf`). */
    uncommitted?: UncommittedTotals;
  };
  /** Commits je Kalendertag (Zeitzone des Nutzers), letzte 84 Tage (12 Wochen), älteste zuerst. */
  heatmap: { day: string; app: number; nyxos: number; other: number }[];
  merges: GitCommitRow[];
  actions: GitActionRow[];
  app: GitRepoSection | null;
  appWorktrees: GitWorktreeCard[];
  nyxos: GitRepoSection | null;
  nyxosWorktrees: GitWorktreeCard[];
  others: GitRepoSection[];
}

export interface GitBranchDetail {
  repoId: string;
  repoLabel: string;
  kind: RepoKind;
  mainBranch: string;
  branch: GitBranchRow;
  commits: GitCommitRow[];
}

export interface GitWorktreeDetail {
  card: GitWorktreeCard;
  sessions: GitSessionRef[];
  commits: GitCommitRow[];
  uncommitted: UncommittedFile[];
  actions: GitActionRow[];
}

export function classifyPathGroup(path: string): ChangeGroup {
  const lower = path.toLowerCase();
  if (/(^|\/)docs?\//.test(lower) || lower.endsWith(".md") || lower.endsWith(".docx") || lower.endsWith(".pdf")) return "doku";
  if (lower.endsWith(".pbxproj") || lower.endsWith(".xcodeproj") || lower.endsWith(".xcworkspace") || /(^|\/)(package\.json|pnpm-lock\.yaml|\.env)$/.test(lower)) {
    return "projekt";
  }
  return "code";
}

/** „Ungesichert“ — EINE Definition für Überblick und Git: Dateien ohne Commit in allen Repos und
 * Worktrees, die der letzte Scan gesehen hat (Zeilen gelöschter Worktrees zählen nicht mit). */
export interface UncommittedTotals {
  files: number;
  /** Ordner (Repos + Worktrees) mit mindestens einer ungesicherten Datei. */
  places: number;
  repoFiles: number;
  repoPlaces: number;
  worktreeFiles: number;
  worktreePlaces: number;
}


/** „Dateien in 2 Repos“ – whole German source texts per count, translated. */
function filesInPlaces(kind: "repo" | "worktree", places: number): string {
  if (kind === "repo") return places === 1 ? t("Dateien in 1 Repo") : t("Dateien in {n} Repos", { n: places });
  return places === 1 ? t("Dateien in 1 Worktree") : t("Dateien in {n} Worktrees", { n: places });
}

/** „635 Dateien in 2 Repos“ – one key per singular/plural combination. */
const COUNTED_FILES_IN: Record<"repo" | "worktree", [string, string, string, string]> = {
  // [1 Datei · 1 Ort, 1 Datei · n Orte, n Dateien · 1 Ort, n Dateien · n Orte]
  repo: ["1 Datei in 1 Repo", "1 Datei in {places} Repos", "{files} Dateien in 1 Repo", "{files} Dateien in {places} Repos"],
  worktree: ["1 Datei in 1 Worktree", "1 Datei in {places} Worktrees", "{files} Dateien in 1 Worktree", "{files} Dateien in {places} Worktrees"],
};

function countedFilesIn(kind: "repo" | "worktree", files: number, places: number): string {
  const key = COUNTED_FILES_IN[kind][(files === 1 ? 0 : 2) + (places === 1 ? 0 : 1)] as string;
  return t(key, { files: numberFormat().format(files), places });
}

/** Kontextzeile der Kachel „Ungesichert“ (Überblick und Git gleich), kurz genug für eine schmale Kachel,
 * z. B. „635 in Repos · 2.022 in Worktrees“. Die lange Fassung steht in `uncommittedDetail`. */
export function uncommittedCaption(s: UncommittedTotals): string {
  if (s.files === 0) return t("Alles gesichert");
  if (s.worktreeFiles === 0) return filesInPlaces("repo", s.repoPlaces);
  if (s.repoFiles === 0) return filesInPlaces("worktree", s.worktreePlaces);
  return t("{repo} in Repos · {worktree} in Worktrees", { repo: numberFormat().format(s.repoFiles), worktree: numberFormat().format(s.worktreeFiles) });
}

/** `kpis.uncommitted` defensiv lesen — ein älterer Server liefert nur Summe und Ordnerzahl, dann
 * ohne Aufschlüsselung (`null`), statt die Git-Seite abstürzen zu lassen. */
export function uncommittedTotalsOf(kpis: { uncommittedFiles?: number; uncommittedPlaces?: number; uncommitted?: UncommittedTotals | null }): {
  files: number;
  places: number;
  split: UncommittedTotals | null;
} {
  if (kpis.uncommitted) return { files: kpis.uncommitted.files, places: kpis.uncommitted.places, split: kpis.uncommitted };
  return { files: kpis.uncommittedFiles ?? 0, places: kpis.uncommittedPlaces ?? 0, split: null };
}

/** Lange Fassung (Tooltip), z. B. „635 Dateien in 2 Repos · 2.022 Dateien in 4 Worktrees“. */
export function uncommittedDetail(s: UncommittedTotals): string {
  if (s.files === 0) return t("Alles gesichert");
  const parts: string[] = [];
  if (s.repoFiles > 0) parts.push(countedFilesIn("repo", s.repoFiles, s.repoPlaces));
  if (s.worktreeFiles > 0) parts.push(countedFilesIn("worktree", s.worktreeFiles, s.worktreePlaces));
  return parts.join(" · ");
}

/** Worktrees that NyxOS creates for tasks live inside the repository: `<repo>/.worktrees/<slug>`. */
export const WORKTREE_DIR = ".worktrees";
