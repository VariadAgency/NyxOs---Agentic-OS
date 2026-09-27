// Welche Session hat diesen Commit (oder diese Git-Aktion) gemacht?
//
// Belege, in dieser Reihenfolge:
// 1. Werkzeug-Aufruf `git commit|merge|…` einer Session (aus dem Verlauf bzw. Hook, `session_events`
//    kind=tool_call, `data.target` = Befehl) kurz VOR dem Commit, im selben Ordner. Der Ordner kommt
//    aus `git -C <pfad>`, einem vorangestellten `cd <pfad> &&` oder dem Arbeitsordner der Session.
// 2. Sonst: eine Session, die zur selben Zeit im selben Ordner aktiv war (nur „vermutet“).
// 3. Sonst: keine Session — vermutlich von Hand.
//
// Wie sicher die Zuordnung ist, steht in `confidence` und in einem Satz für den Nutzer (`reason`).
// Die Zuordnung wird beim Ingest gespeichert und unsichere Fälle werden später neu geprüft (Verläufe
// kommen manchmal erst nach dem Git-Scan an).
import { posix } from "node:path";
import type { AttributionConfidence, GitActionKind } from "@nyxos/shared";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gitCommits, gitRepos, gitWorktrees, sessionEvents, sessions } from "../db/schema.js";
import { dateTimeFormat, t } from "@nyxos/shared";

export interface CallRow {
  sessionKey: string;
  ts: string;
  cmd: string;
  cwd: string | null;
}

export interface ActiveRow {
  sessionKey: string;
  cwd: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
}

export interface MatchTarget {
  at: string;
  /** Ordner, in dem der Zweig ausgecheckt ist (genauester Ort), `null` = unbekannt. */
  checkout: string | null;
  /** Alle Arbeitsordner desselben Repos (Hauptordner + Worktrees). */
  family: string[];
}

export interface MatchResult {
  sessionKey: string | null;
  confidence: AttributionConfidence;
  reason: string;
}

/** Git-Befehle, die einen Commit erzeugen. */
export const COMMIT_VERBS = ["commit", "merge", "cherry-pick", "revert", "pull", "rebase", "am"];

/** Befehle, die zu einer Reflog-Aktion passen. */
export const ACTION_VERBS: Partial<Record<GitActionKind, string[]>> = {
  merge: ["merge", "pull"],
  pull: ["pull"],
  push: ["push"],
  reset: ["reset"],
  checkout: ["checkout", "switch", "worktree"],
  rebase: ["rebase", "pull"],
  "cherry-pick": ["cherry-pick"],
  revert: ["revert"],
  amend: ["commit"],
  worktree: ["worktree"],
};

const BEFORE_S = 1200; // Befehl höchstens 20 Min vor dem Commit (Hooks/Tests können dauern)
const AFTER_S = 60; // Uhren-Versatz: Befehl darf minimal „nach“ dem Commit liegen
const STRONG_S = 300; // „sicher“ nur, wenn der Befehl höchstens 5 Min vorher lief

const QUOTED = `"[^"]*"|'[^']*'|[^\\s;&|]+`;

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function resolveDir(raw: string, base: string | null): string | null {
  let p = unquote(raw);
  // `~/…`: das Home-Verzeichnis steckt im Arbeitsordner der Session (/Users/<name>/… bzw. /home/<name>/…).
  const home = /^\/(?:Users|home)\/[^/]+/.exec(base ?? "")?.[0];
  if ((p === "~" || p.startsWith("~/")) && home) p = home + p.slice(1);
  if (!p || p.startsWith("~") || p.includes("$")) return null;
  if (p.startsWith("/")) return posix.normalize(p).replace(/\/+$/, "") || "/";
  return base ? posix.normalize(posix.join(base, p)).replace(/\/+$/, "") : null;
}

/** Zerlegt einen Shell-Befehl: welches Git-Verb (aus `verbs`) und in welchem Ordner? */
export function parseGitCall(cmd: string, cwd: string | null, verbs: string[]): { verb: string; dir: string | null } | null {
  const verbRe = new RegExp(`\\bgit\\b((?:\\s+(?:-C\\s+(?:${QUOTED})|-c\\s+\\S+|--no-pager|--no-optional-locks))*)\\s+(${verbs.map((v) => v.replace(/-/g, "\\-")).join("|")})\\b`);
  const m = verbRe.exec(cmd);
  if (!m) return null;
  const verb = m[2] ?? "";
  const opts = m[1] ?? "";
  // `git -C <pfad>` hat Vorrang, sonst das letzte `cd <pfad>` vor dem git-Aufruf, sonst der Arbeitsordner.
  let dir: string | null = cwd;
  const cdRe = new RegExp(`(?:^|&&|;|\\|\\||\\()\\s*cd\\s+(${QUOTED})`, "g");
  for (const cd of cmd.slice(0, m.index).matchAll(cdRe)) {
    const r = resolveDir(cd[1] ?? "", dir);
    if (r) dir = r;
  }
  const c = new RegExp(`-C\\s+(${QUOTED})`).exec(opts);
  if (c?.[1]) dir = resolveDir(c[1], dir) ?? dir;
  return { verb, dir };
}

/** Genauester Arbeitsordner der Familie, der `dir` enthält (Worktrees liegen z. T. IM Hauptordner). */
export function checkoutOf(dir: string | null, family: string[]): string | null {
  if (!dir) return null;
  let best: string | null = null;
  for (const f of family) {
    if (dir === f || dir.startsWith(f + "/")) {
      if (!best || f.length > best.length) best = f;
    }
  }
  return best;
}

const hhmm = () => dateTimeFormat({ hour: "2-digit", minute: "2-digit" });

function delta(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return t("{n} s", { n: s });
  return t("{n} Min", { n: Math.round(s / 60) });
}

/** „12 s vor dem Commit“ — ganze Wendung je Bezugsgröße (übersetzt beim Erzeugen). */
function beforeLabel(seconds: number, what: string): string {
  const d = delta(seconds);
  if (what === "Commit") return t("{delta} vor dem Commit", { delta: d });
  if (what === "Eintrag") return t("{delta} vor dem Eintrag", { delta: d });
  return `${d} vor dem ${what}`;
}

/** Reine Zuordnung (testbar ohne DB). `verbs` = welche Git-Befehle als Beleg zählen. */
export function matchCommit(target: MatchTarget, data: { calls: CallRow[]; active: ActiveRow[] }, verbs: string[] = COMMIT_VERBS, what = "Commit", opt: { beforeS?: number; exactOnly?: boolean } = {}): MatchResult {
  const atMs = Date.parse(target.at);
  const cands: { call: CallRow; verb: string; d: number; exact: boolean; strong: boolean }[] = [];
  for (const call of data.calls) {
    const parsed = parseGitCall(call.cmd, call.cwd, verbs);
    if (!parsed) continue;
    const d = (atMs - Date.parse(call.ts)) / 1000;
    if (d < -AFTER_S || d > (opt.beforeS ?? BEFORE_S)) continue;
    const co = checkoutOf(parsed.dir, target.family);
    if (!co) continue;
    const exact = target.checkout ? co === target.checkout : true;
    if (opt.exactOnly && !exact) continue;
    cands.push({ call, verb: parsed.verb, d, exact, strong: exact && d <= STRONG_S });
  }
  cands.sort((a, b) => Number(b.exact) - Number(a.exact) || Math.abs(a.d) - Math.abs(b.d));
  const best = cands[0];
  if (best) {
    const strongSessions = new Set(cands.filter((c) => c.strong).map((c) => c.call.sessionKey));
    const when = hhmm().format(new Date(best.call.ts));
    const before = beforeLabel(best.d, what);
    if (best.strong && strongSessions.size === 1) {
      return { sessionKey: best.call.sessionKey, confidence: "sicher", reason: t("Diese Session hat um {time} „git {verb}“ in diesem Ordner ausgeführt ({before}).", { time: when, verb: best.verb, before }) };
    }
    if (strongSessions.size > 1) {
      return { sessionKey: best.call.sessionKey, confidence: "wahrscheinlich", reason: t("{n} Sessions haben kurz davor „git {verb}“ hier ausgeführt — die zeitlich nächste ist gewählt.", { n: strongSessions.size, verb: best.verb }) };
    }
    return {
      sessionKey: best.call.sessionKey,
      confidence: "wahrscheinlich",
      reason: best.exact
        ? t("Diese Session hat um {time} „git {verb}“ in diesem Ordner ausgeführt ({before}).", { time: when, verb: best.verb, before })
        : t("Diese Session hat um {time} „git {verb}“ im selben Repo, aber in einem anderen Ordner ausgeführt.", { time: when, verb: best.verb }),
    };
  }

  const place = target.checkout;
  const active = data.active
    .filter((s) => {
      const co = checkoutOf(s.cwd, target.family);
      if (!co || (place && co !== place)) return false;
      const start = s.startedAt ? Date.parse(s.startedAt) : Number.NEGATIVE_INFINITY;
      const last = s.lastActivityAt ? Date.parse(s.lastActivityAt) : start;
      return start <= atMs + 60_000 && last >= atMs - 5 * 60_000;
    })
    .sort((a, b) => Math.abs(Date.parse(a.lastActivityAt ?? "") - atMs) - Math.abs(Date.parse(b.lastActivityAt ?? "") - atMs));
  const first = active[0];
  if (first) {
    return {
      sessionKey: first.sessionKey,
      confidence: "vermutet",
      reason:
        active.length === 1
          ? t("Kein git-Befehl gefunden, aber diese Session arbeitete zur selben Zeit in diesem Ordner.")
          : t("Kein git-Befehl gefunden; {n} Sessions arbeiteten zur selben Zeit in diesem Ordner — die zuletzt aktive ist gewählt.", { n: active.length }),
    };
  }
  return { sessionKey: null, confidence: "keine", reason: t("Keine Session hat zu dieser Zeit in diesem Ordner gearbeitet — vermutlich von Hand gemacht.") };
}

// ---------------------------------------------------------------------------------------------
// DB-Teil
// ---------------------------------------------------------------------------------------------

export interface RepoFamilies {
  /** repoId → Familien-Wurzel (Repo selbst oder Eltern-Repo). */
  rootOf: Map<string, string>;
  /** Familien-Wurzel → alle Arbeitsordner. */
  paths: Map<string, string[]>;
  /** Familien-Wurzel → Zweig → Ordner, in dem er ausgecheckt ist. */
  checkouts: Map<string, Map<string, string>>;
}

export async function loadFamilies(db: Db): Promise<RepoFamilies> {
  const repos = await db.select({ id: gitRepos.id, kind: gitRepos.kind, root: gitRepos.root, parentId: gitRepos.parentId, currentBranch: gitRepos.currentBranch }).from(gitRepos);
  const wts = await db.select({ repoId: gitWorktrees.repoId, path: gitWorktrees.path, branch: gitWorktrees.branch }).from(gitWorktrees);
  const rootOf = new Map<string, string>();
  for (const r of repos) rootOf.set(r.id, r.parentId ?? (r.kind === "worktree" ? "app" : r.id));
  const paths = new Map<string, string[]>();
  const checkouts = new Map<string, Map<string, string>>();
  const add = (root: string, path: string, branch: string | null) => {
    const list = paths.get(root) ?? [];
    if (!list.includes(path)) list.push(path);
    paths.set(root, list);
    if (branch) {
      const m = checkouts.get(root) ?? new Map<string, string>();
      if (!m.has(branch)) m.set(branch, path);
      checkouts.set(root, m);
    }
  };
  for (const r of repos) add(rootOf.get(r.id) ?? r.id, r.root, r.currentBranch);
  for (const w of wts) add(rootOf.get(w.repoId) ?? w.repoId, w.path, w.branch);
  return { rootOf, paths, checkouts };
}

export function targetFor(f: RepoFamilies, repoId: string, branch: string | null, at: string): MatchTarget {
  const root = f.rootOf.get(repoId) ?? repoId;
  return { at, checkout: branch ? (f.checkouts.get(root)?.get(branch) ?? null) : null, family: f.paths.get(root) ?? [] };
}

/** Werkzeug-Aufrufe mit „git“ und aktive Sessions in einem Zeitfenster (ein Zugriff je Fenster). */
export async function loadEvidence(db: Db, fromMs: number, toMs: number): Promise<{ calls: CallRow[]; active: ActiveRow[] }> {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const calls = await db
    .select({ sessionKey: sessionEvents.sessionKey, ts: sessionEvents.ts, cmd: sql<string>`${sessionEvents.data}->>'target'`, cwd: sessions.cwd })
    .from(sessionEvents)
    .innerJoin(sessions, eq(sessions.id, sessionEvents.sessionKey))
    .where(and(eq(sessionEvents.kind, "tool_call"), gte(sessionEvents.ts, from), lte(sessionEvents.ts, to), sql`${sessionEvents.data}->>'target' ilike '%git%'`));
  const startExpr = sql<string>`coalesce(${sessions.startedAt}, ${sessions.createdAt})`;
  const lastExpr = sql<string>`coalesce(${sessions.lastActivityAt}, ${sessions.startedAt}, ${sessions.createdAt})`;
  const active = await db
    .select({ sessionKey: sessions.id, cwd: sessions.cwd, startedAt: startExpr, lastActivityAt: lastExpr })
    .from(sessions)
    .where(and(isNotNull(sessions.cwd), sql`${startExpr} <= ${to}::timestamptz`, sql`${lastExpr} >= ${from}::timestamptz`));
  return {
    calls: calls.filter((c): c is CallRow => typeof c.cmd === "string").map((c) => ({ ...c, ts: new Date(c.ts).toISOString() })),
    active: active.map((a) => ({ ...a, startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : null, lastActivityAt: a.lastActivityAt ? new Date(a.lastActivityAt).toISOString() : null })),
  };
}

/** Zeitpunkte zu Fenstern bündeln (Lücke > 6 h → neues Fenster), damit alte Einzel-Commits nicht
 * ein riesiges Fenster über Wochen aufspannen. */
export function clusterTimes(times: number[], gapMs = 6 * 3_600_000): { from: number; to: number }[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: { from: number; to: number }[] = [];
  for (const t of sorted) {
    const last = out.at(-1);
    if (last && t - last.to <= gapMs) last.to = t;
    else out.push({ from: t, to: t });
  }
  return out.map((w) => ({ from: w.from - BEFORE_S * 1000 - 5 * 60_000, to: w.to + AFTER_S * 1000 + 60_000 }));
}

/**
 * Ordnet Commits einer Session zu und speichert das Ergebnis. Geprüft werden neue Commits und
 * noch nicht sichere ältere (höchstens alle 15 Min neu; jüngere als 14 Tage öfter, ältere alle 6 h).
 */
export async function attributeCommits(db: Db, opts: { now?: number; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const atExpr = sql<string>`coalesce(${gitCommits.committedAt}, ${gitCommits.authorDate})`;
  const iso = (ms: number) => new Date(ms).toISOString();
  const due = await db
    .select({ id: gitCommits.id, repoId: gitCommits.repoId, branch: gitCommits.branch, at: atExpr })
    .from(gitCommits)
    .where(
      or(
        isNull(gitCommits.attributedAt),
        and(
          sql`coalesce(${gitCommits.sessionConfidence}, 'keine') <> 'sicher'`,
          lt(gitCommits.attributedAt, iso(now - 15 * 60_000)),
          or(sql`${atExpr} > ${iso(now - 14 * 86_400_000)}::timestamptz`, lt(gitCommits.attributedAt, iso(now - 6 * 3_600_000))),
        ),
      ),
    )
    .orderBy(desc(atExpr))
    .limit(opts.limit ?? 400);
  if (due.length === 0) return 0;
  const families = await loadFamilies(db);
  const rows = due.map((d) => ({ ...d, at: new Date(d.at).toISOString() }));
  const results: { id: number; m: MatchResult }[] = [];
  for (const w of clusterTimes(rows.map((r) => Date.parse(r.at)))) {
    const evidence = await loadEvidence(db, w.from, w.to);
    for (const r of rows) {
      const t = Date.parse(r.at);
      if (t < w.from || t > w.to) continue;
      results.push({ id: r.id, m: matchCommit(targetFor(families, r.repoId, r.branch, r.at), evidence) });
    }
  }
  const stamp = iso(now);
  await db.transaction(async (tx) => {
    for (const { id, m } of results) {
      await tx.update(gitCommits).set({ sessionKey: m.sessionKey, sessionConfidence: m.confidence, sessionReason: m.reason, attributedAt: stamp }).where(eq(gitCommits.id, id));
    }
  });
  return results.length;
}

/** Für Aufrufer, die nur die IDs brauchen (Graph: Commit ↔ Session bei sicher/wahrscheinlich). */
export async function attributedSessionKeys(db: Db, commitIds: number[]): Promise<Map<number, string>> {
  if (commitIds.length === 0) return new Map();
  const rows = await db
    .select({ id: gitCommits.id, key: gitCommits.sessionKey })
    .from(gitCommits)
    .where(and(inArray(gitCommits.id, commitIds), isNotNull(gitCommits.sessionKey), inArray(gitCommits.sessionConfidence, ["sicher", "wahrscheinlich"])));
  return new Map(rows.filter((r): r is { id: number; key: string } => r.key !== null).map((r) => [r.id, r.key]));
}
