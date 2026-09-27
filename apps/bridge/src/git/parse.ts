// Reine Parser für Git-Rohtext (getrennt von exec.ts, damit sie ohne echtes `git` getestet
// werden können — Muster wie packages/shared/src/parse/*.ts).
import { classifyPathGroup, type BranchInfo, type ChangeGroup, type ReflogAction, type UncommittedFile, type WorktreeInfo } from "@nyxos/shared";

/**
 * Git setzt „besondere“ Pfade in C-Anführungszeichen (`"a\\"b"`, `"\\303\\244.txt"` für „ä“).
 * Die Brücke ruft Git mit `core.quotePath=false` auf (Umlaute kommen dann direkt), trotzdem bleiben
 * Anführungszeichen, Backslash und Steuerzeichen gequotet — das hier macht daraus den echten Namen.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0] ?? "0";
      bytes.push(parseInt(oct, 8));
      i += oct.length;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `git status --porcelain=v2 --branch` — Format s. `git-status(1)` Abschnitt "Porcelain Format Version 2". */
export function parseStatusPorcelainV2(output: string): { currentBranch: string | null; files: UncommittedFile[] } {
  let currentBranch: string | null = null;
  const files: UncommittedFile[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      currentBranch = head === "(detached)" ? null : head;
      continue;
    }
    if (line.startsWith("#")) continue; // andere Header (branch.oid/branch.upstream/branch.ab)

    const kind = line[0];
    if (kind === "1" || kind === "2") {
      const parts = line.split(" ");
      const xy = parts[1] ?? "??";
      // Zeile "1": 8 Felder vor dem Pfad (1 XY sub mH mI mW hH hI). Zeile "2" (Umbenennung/Kopie)
      // hat zusätzlich ein Score-Feld ("<X><score>", z. B. "R100") davor und trägt den Pfad als
      // "<neu>\t<alt>" — sonst würde das Score-Feld fälschlich als Teil des Pfades gelesen.
      const rest = kind === "2" ? parts.slice(9).join(" ") : parts.slice(8).join(" ");
      const [pathPart, fromPath] = rest.split("\t");
      const path = unquoteGitPath(pathPart ?? rest);
      const group: ChangeGroup = /[RC]/.test(xy) ? "verschoben" : classifyPathGroup(path);
      files.push({ path, statusCode: xy, group, ...(fromPath ? { fromPath: unquoteGitPath(fromPath) } : {}) });
    } else if (kind === "u") {
      // Unmerged/Konflikt (kommt bei einem sauberen Nur-Lese-Scan praktisch nie vor, da wir nie
      // selbst mergen — trotzdem korrekt einordnen statt zu verschlucken).
      const parts = line.split(" ");
      const path = unquoteGitPath(parts.slice(10).join(" "));
      files.push({ path, statusCode: "UU", group: classifyPathGroup(path) });
    } else if (kind === "?") {
      const path = unquoteGitPath(line.slice(2));
      files.push({ path, statusCode: "??", group: classifyPathGroup(path) });
    }
  }
  return { currentBranch, files };
}

/** `git for-each-ref --format="%(refname:short)|%(committerdate:iso-strict)|%(upstream:short)|%(HEAD)" refs/heads/` */
export function parseForEachRefBranches(output: string): { name: string; lastCommitAt: string | null; upstream: string | null; isCurrent: boolean }[] {
  const out: { name: string; lastCommitAt: string | null; upstream: string | null; isCurrent: boolean }[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [name, date, upstream, head] = line.split("|");
    if (!name) continue;
    out.push({ name, lastCommitAt: date || null, upstream: upstream || null, isCurrent: head === "*" });
  }
  return out;
}

/** `git rev-list --left-right --count <main>...<branch>` → "<behind>\t<ahead>" (main...branch: links
 * main-exklusiv = "branch fehlt", rechts branch-exklusiv = "branch hat zusätzlich" = ahead). */
export function parseAheadBehindCount(output: string): { ahead: number; behind: number } {
  const [left, right] = output.trim().split(/\s+/);
  return { behind: Number(left) || 0, ahead: Number(right) || 0 };
}

const FIELD_SEP = "\x01";

export const LOG_FORMAT = `%H${FIELD_SEP}%aI${FIELD_SEP}%s`;

/** `git log --format=<LOG_FORMAT>` (ein Feld-Trenner \\x01, der in Commit-Nachrichten praktisch nie vorkommt). */
export function parseLog(output: string, branch: string): { sha: string; authorDate: string; subject: string; branch: string }[] {
  const out: { sha: string; authorDate: string; subject: string; branch: string }[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const first = line.indexOf(FIELD_SEP);
    const second = line.indexOf(FIELD_SEP, first + 1);
    if (first === -1 || second === -1) continue;
    out.push({ sha: line.slice(0, first), authorDate: line.slice(first + 1, second), subject: line.slice(second + 1), branch });
  }
  return out;
}

/** `git worktree list --porcelain` — Blöcke, getrennt durch Leerzeilen. */
export function parseWorktreeListPorcelain(output: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> & { locked?: boolean } = {};
  const flush = () => {
    if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null, headSha: cur.headSha ?? null, locked: cur.locked ?? false });
    cur = {};
  };
  for (const line of output.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) cur.path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) cur.headSha = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch refs/heads/".length);
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
  }
  flush();
  return out;
}

export function branchInfoFrom(ref: { name: string; lastCommitAt: string | null; upstream: string | null; isCurrent: boolean }, ab: { ahead: number; behind: number }): BranchInfo {
  return { name: ref.name, ahead: ab.ahead, behind: ab.behind, isCurrent: ref.isCurrent, lastCommitAt: ref.lastCommitAt, upstream: ref.upstream };
}

/** `git tag --sort=-creatordate` (ein Tag je Zeile, neueste zuerst). */
export function parseTags(output: string): string[] {
  return output.split("\n").filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------------------------------------
// Commits aller Zweige mit Datei-Statistik und das Reflog (Aktions-Log).
// ---------------------------------------------------------------------------------------------

const RECORD_SEP = "\x1e";
/** Kopfzeile je Commit: SHA, Autor-Zeit, Commit-Zeit, Eltern (Leerzeichen-getrennt), Autor, Betreff. */
export const LOG_NUMSTAT_FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%aI${FIELD_SEP}%cI${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%s`;
/** Höchstens so viele Dateien je Commit mitschicken (die Summen zählen trotzdem alle). */
export const MAX_FILES_PER_COMMIT = 300;

export interface ParsedCommit {
  sha: string;
  authorDate: string;
  committedAt: string;
  parents: number;
  authorName: string;
  subject: string;
  files: { path: string; add: number | null; del: number | null }[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** `git log --numstat --format=<LOG_NUMSTAT_FORMAT>`: je Commit eine Kopfzeile (beginnt mit \x1e), danach
 * `<plus>\t<minus>\t<pfad>`-Zeilen (`-\t-\t…` = Binärdatei). */
export function parseLogNumstat(output: string): ParsedCommit[] {
  const out: ParsedCommit[] = [];
  for (const chunk of output.split(RECORD_SEP)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const head = (lines[0] ?? "").split(FIELD_SEP);
    const [sha, authorDate, committedAt, parents, authorName, ...subjectParts] = head;
    if (!sha || !authorDate) continue;
    const files: ParsedCommit["files"] = [];
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [a, d, ...pathParts] = line.split("\t");
      const path = unquoteGitPath(pathParts.join("\t"));
      if (!path) continue;
      const add = a === "-" ? null : Number(a);
      const del = d === "-" ? null : Number(d);
      filesChanged++;
      insertions += add ?? 0;
      deletions += del ?? 0;
      if (files.length < MAX_FILES_PER_COMMIT) files.push({ path, add: Number.isFinite(add) ? add : null, del: Number.isFinite(del) ? del : null });
    }
    out.push({
      sha,
      authorDate,
      committedAt: committedAt || authorDate,
      parents: parents ? parents.split(" ").filter(Boolean).length : 0,
      authorName: authorName ?? "",
      subject: subjectParts.join(FIELD_SEP),
      files,
      filesChanged,
      insertions,
      deletions,
    });
  }
  return out;
}

/** `git log -g --date=unix --format=<REFLOG_FORMAT>`: neuer SHA, Selektor (`HEAD@{<unix>}`), Name, Text. */
export const REFLOG_FORMAT = `%H${FIELD_SEP}%gd${FIELD_SEP}%gn${FIELD_SEP}%gs`;

export interface ParsedReflog {
  newSha: string | null;
  at: string;
  identity: string | null;
  subject: string;
}

export function parseReflog(output: string): ParsedReflog[] {
  const out: ParsedReflog[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [sha, selector, name, ...subjectParts] = line.split(FIELD_SEP);
    const m = /@\{(\d+)\}$/.exec(selector ?? "");
    if (!m?.[1]) continue;
    out.push({ newSha: sha || null, at: new Date(Number(m[1]) * 1000).toISOString(), identity: name || null, subject: subjectParts.join(FIELD_SEP) });
  }
  return out;
}

/**
 * Reflog-Text → Aktion. `null` = kein eigener Eintrag im Aktions-Log (Zwischenschritte eines
 * Rebase, erster Commit). Einfache Commits heißen „commit“ — die Git-Seite zeigt sie in der
 * Commit-Liste, nicht doppelt im Aktions-Log.
 */
export function classifyReflogSubject(subject: string): { action: ReflogAction["action"] } | null {
  const s = subject.trim();
  if (s === "update by push" || s.startsWith("update by push")) return { action: "push" };
  if (s.startsWith("commit (merge)") || /^merge [^:]+:/.test(s) || s.startsWith("merge ")) return { action: "merge" };
  if (s.startsWith("pull")) return { action: "pull" };
  if (s.startsWith("reset:")) return { action: "reset" };
  if (s.startsWith("checkout:")) return { action: "checkout" };
  if (s.startsWith("rebase")) return /^rebase( -i| -r)? \((finish|abort)\)/.test(s) ? { action: "rebase" } : null;
  if (s.startsWith("cherry-pick")) return { action: "cherry-pick" };
  if (s.startsWith("revert")) return { action: "revert" };
  if (s.startsWith("commit (amend)")) return { action: "amend" };
  if (s.startsWith("commit (initial)")) return null;
  if (s.startsWith("commit:")) return { action: "commit" };
  return { action: "other" };
}
