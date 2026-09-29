// reine Logik der Konflikte-Seite — aus der ganzen Kollisionskarte (tausende Zeilen)
// wird eine kleine Zusammenfassung (Ordner-Gruppen + „Was muss ich entscheiden?“). Details holt
// die Web-App seitenweise (`queryConflictEntries`). Server und Tests (auch Playwright-Stresstest)
// nutzen dieselbe Funktion — keine zweite Zählung.
import type {
  CollisionEntry,
  ConflictDecision,
  ConflictEntriesPage,
  ConflictGroupSummary,
  ConflictSeverity,
  ConflictsSummary,
  DecisionDismissal,
  DecisionSession,
  Reservation,
} from "./conflicts.js";
import { WORKTREE_DIR } from "./git.js";

/** Sammel-Ordner im Home, unter denen die eigentlichen Repos liegen (`~/projects/<repo>`). */
const HOME_CONTAINERS = new Set(["code", "projects", "project", "dev", "developer", "src", "work", "workspace", "workspaces", "git", "github", "repos", "repositories", "sites"]);

/** Wo in einem ABSOLUTEN Pfad (Teile ohne das leere erste Element) das Repo beginnt (Index des
 * Repo-Namens; `null` = nicht unter einem Home-Ordner) und ob die Datei in
 * einem Worktree liegt (`<repo>/.worktrees/<slug>/…`, auch `.claude/worktrees/<slug>`). `session_files`
 * liefert absolute Pfade — ohne Zuschnitt fielen alle Repos in eine Gruppe „Users/<name>/…“. */
export function repoLocation(parts: string[]): { worktree: { slug: string; inside: string[] } | null; repoStart: number | null } {
  for (let k = 0; k < parts.length - 1; k++) {
    const own = parts[k] === WORKTREE_DIR ? k + 1 : parts[k] === ".claude" && parts[k + 1] === "worktrees" ? k + 2 : -1;
    const slug = own === -1 ? undefined : parts[own];
    if (slug) return { worktree: { slug, inside: parts.slice(own + 1) }, repoStart: null };
  }
  let i: number;
  if ((parts[0] === "Users" || parts[0] === "home") && parts.length > 2) i = 2;
  else if (parts[0] === "root" && parts.length > 1) i = 1;
  else return { worktree: null, repoStart: null };
  while (i < parts.length - 1 && HOME_CONTAINERS.has((parts[i] ?? "").toLowerCase())) i++;
  return { worktree: null, repoStart: i };
}

function repoRelativeParts(dirParts: string[], absolute: boolean): string[] {
  if (!absolute) return dirParts; // schon repo-relativ (z. B. in Tests) — unverändert
  const at = repoLocation(dirParts);
  if (at.worktree) return [`Worktree:${at.worktree.slug}`, ...at.worktree.inside];
  return at.repoStart === null ? dirParts : dirParts.slice(at.repoStart);
}

/** Ordner-Schlüssel (2–3 Ebenen, repo-relativ) einer Datei — die Gruppierung der Kollisionskarte. */
export function folderKey(path: string, depth = 3): string {
  const parts = path.split("/").filter(Boolean);
  const dirParts = repoRelativeParts(parts.slice(0, -1), path.startsWith("/")); // letzter Teil ist der Dateiname
  if (dirParts.length === 0) return "(Repo-Wurzel)";
  return dirParts.slice(0, depth).join("/");
}

/** Glob-Vergleich, absichtlich klein: `*` = beliebig viele Zeichen, sonst wörtlich. Zwei Globs
 * überlappen, wenn einer Präfix des anderen ist (nach Abschneiden des `*`) oder einer den anderen trifft. */
export function globOverlaps(a: string, b: string): boolean {
  const toRe = (glob: string) => new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  const stripStar = (g: string) => (g.endsWith("*") ? g.slice(0, -1) : g);
  const pa = stripStar(a);
  const pb = stripStar(b);
  if (pa.startsWith(pb) || pb.startsWith(pa)) return true;
  return toRe(a).test(b) || toRe(b).test(a);
}

/** Volltextsuche über Pfad + beteiligte Session-Titel. */
export function matchesConflictQuery(entry: CollisionEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (entry.path.toLowerCase().includes(q)) return true;
  return [...entry.writers, ...entry.readers].some((p) => (p.title ?? p.sessionKey).toLowerCase().includes(q));
}

/**
 * Bereich für „Reservieren“: die eine Datei, sonst gemeinsamer Ordner + `/**`. null, wenn der
 * gemeinsame Ordner zu grob wäre (ein ganzes Repo, ein ganzer Worktree oder höher) — dann würde eine
 * Reservierung alles sperren.
 */
export function areaGlobFor(paths: string[]): string | null {
  const first = paths[0];
  if (first === undefined) return null;
  if (new Set(paths).size === 1) return first;
  let common = first.split("/").slice(0, -1);
  for (const p of paths) {
    const d = p.split("/").slice(0, -1);
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  const nonEmpty = common.filter(Boolean);
  if (nonEmpty.length === 0) return null;
  if (common[0] === "") {
    // Nie ein ganzes Repo sperren — mindestens ein Ordner IM Repo bzw. im Worktree.
    const at = repoLocation(nonEmpty);
    if (at.worktree) {
      if (at.worktree.inside.length === 0) return null;
    } else if (at.repoStart !== null) {
      if (nonEmpty.length - at.repoStart < 2) return null;
    } else if (nonEmpty.length < 3) return null; // z. B. /srv/app
  }
  return `${common.join("/")}/**`;
}

export function severityFor(fileCount: number, sessionCount: number): ConflictSeverity {
  if (sessionCount >= 3 || fileCount >= 10) return "high";
  if (fileCount >= 3) return "medium";
  return "low";
}

const SEVERITY_RANK: Record<ConflictSeverity, number> = { high: 0, medium: 1, low: 2 };
const STATE_RANK: Record<CollisionEntry["state"], number> = { conflict: 0, "shared-read": 1, past: 2, ok: 3 };

export interface ConflictSessionMeta {
  title: string | null;
  tool: string | null;
  inNyxOS: boolean;
}

export interface ConflictModelInput {
  map: CollisionEntry[];
  reservations: Reservation[];
  dismissals: Map<string, DecisionDismissal>;
  sessions: Map<string, ConflictSessionMeta>;
  version: string;
  generatedAt: string;
  bridgeOnline: boolean;
}

export interface ConflictModel {
  summary: ConflictsSummary;
  byGroup: Map<string, CollisionEntry[]>;
  all: CollisionEntry[];
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function sortEntries(list: CollisionEntry[]): CollisionEntry[] {
  return list.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.path.localeCompare(b.path));
}

interface DecisionAcc {
  key: string;
  kind: ConflictDecision["kind"];
  folder: string;
  paths: string[];
  perSession: Map<string, { title: string | null; count: number }>;
  reservation: Reservation | null;
  latestAt: string | null;
}

export function buildConflictModel(input: ConflictModelInput): ConflictModel {
  const all = sortEntries([...input.map]);
  const byGroup = new Map<string, CollisionEntry[]>();
  const decisions = new Map<string, DecisionAcc>();
  let conflicts = 0;
  let sharedRead = 0;
  let past = 0;

  for (const entry of all) {
    const folder = folderKey(entry.path);
    const list = byGroup.get(folder);
    if (list) list.push(entry);
    else byGroup.set(folder, [entry]);
    if (entry.state === "shared-read") sharedRead++;
    if (entry.state === "past") past++;
    if (entry.state !== "conflict") continue;
    conflicts++;

    // gefragt wird nur nach Sessions, die noch leben — eine beendete Beteiligte
    // kann niemand mehr anhalten oder vorlassen.
    const liveWriters = entry.writers.filter((w) => w.alive !== false);
    const writerKeys = liveWriters.map((w) => w.sessionKey).sort();
    const together = liveWriters.length >= 2;
    const key = together ? `${folder}|${writerKeys.join("+")}` : `res${entry.reservation?.id ?? "?"}|${writerKeys.join("+")}`;
    let acc = decisions.get(key);
    if (!acc) {
      acc = { key, kind: together ? "together" : "reserved-area", folder, paths: [], perSession: new Map(), reservation: together ? null : entry.reservation, latestAt: null };
      decisions.set(key, acc);
    }
    acc.paths.push(entry.path);
    for (const w of liveWriters) {
      const s = acc.perSession.get(w.sessionKey) ?? { title: w.title, count: 0 };
      s.count++;
      acc.perSession.set(w.sessionKey, s);
      acc.latestAt = laterOf(acc.latestAt, w.firstSeenAt);
    }
  }

  const decisionList: ConflictDecision[] = [];
  for (const acc of decisions.values()) {
    const sessions: DecisionSession[] = [...acc.perSession.entries()]
      .map(([sessionKey, s]) => {
        const meta = input.sessions.get(sessionKey);
        return { sessionKey, title: meta?.title ?? s.title, tool: meta?.tool ?? null, inNyxOS: meta?.inNyxOS ?? false, fileCount: s.count };
      })
      // Feste Reihenfolge → die Buchstaben A/B/C bleiben dieselben, solange dieselben Sessions beteiligt sind.
      .sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
    const areaGlob = acc.kind === "together" ? areaGlobFor(acc.paths) : null;
    let status: ConflictDecision["status"] = input.dismissals.get(acc.key) ?? "open";
    let reservation = acc.reservation;
    if (status === "open" && acc.kind === "together") {
      // Nur eine Reservierung ohne Session oder für eine der Beteiligten entscheidet diese Frage —
      // hat eine DRITTE Session dort Vorrang, schreiben beide fremd hinein: weiter offen.
      const covering = input.reservations.find((r) => (r.sessionKey === null || acc.perSession.has(r.sessionKey)) && acc.paths.every((p) => globOverlaps(r.pathGlob, p)));
      if (covering) {
        status = "reserved";
        reservation = covering;
      }
    }
    decisionList.push({
      key: acc.key,
      kind: acc.kind,
      folder: acc.folder,
      areaGlob,
      sessions,
      fileCount: acc.paths.length,
      samplePaths: acc.paths.slice(0, 3),
      severity: severityFor(acc.paths.length, sessions.length),
      status,
      reservation,
      latestAt: acc.latestAt,
    });
  }
  decisionList.sort(
    (a, b) =>
      Number(a.status !== "open") - Number(b.status !== "open") ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.fileCount - a.fileCount ||
      a.key.localeCompare(b.key),
  );

  const groups: ConflictGroupSummary[] = [];
  for (const [key, list] of byGroup) {
    const writers = new Map<string, string | null>();
    let conflictCount = 0;
    let groupShared = 0;
    let groupPast = 0;
    let maxWriters = 0;
    let latestAt: string | null = null;
    for (const e of list) {
      if (e.state === "conflict") {
        conflictCount++;
        maxWriters = Math.max(maxWriters, e.writers.length);
      } else if (e.state === "shared-read") groupShared++;
      else if (e.state === "past") groupPast++;
      for (const w of e.writers) {
        if (!writers.has(w.sessionKey)) writers.set(w.sessionKey, w.title);
        latestAt = laterOf(latestAt, w.firstSeenAt);
      }
    }
    groups.push({
      key,
      fileCount: list.length,
      conflictCount,
      sharedReadCount: groupShared,
      pastCount: groupPast,
      severity: conflictCount > 0 ? severityFor(conflictCount, maxWriters) : null,
      writers: [...writers.entries()].slice(0, 8).map(([sessionKey, title]) => ({ sessionKey, title })),
      writerCount: writers.size,
      latestAt,
    });
  }
  groups.sort((a, b) => b.conflictCount - a.conflictCount || b.sharedReadCount - a.sharedReadCount || a.key.localeCompare(b.key));

  return {
    all,
    byGroup,
    summary: {
      version: input.version,
      generatedAt: input.generatedAt,
      bridgeOnline: input.bridgeOnline,
      totals: { files: all.length, conflicts, sharedRead, groups: groups.length, openDecisions: decisionList.filter((d) => d.status === "open").length, past },
      decisions: decisionList,
      groups,
      reservations: input.reservations,
    },
  };
}

export const CONFLICT_PAGE_MAX = 200;

/** Bezeichnungs-Anfang der Reservierungen, die über eine Konflikt-Entscheidung entstehen — nur diese
 * darf „Schon entschieden → Reservierung aufheben“ wieder löschen (nie eine fremde, z. B.
 * die eines laufenden Auftrags). */
export const DECISION_PREFER_LABEL = "Vorrang: ";
export const DECISION_RESERVE_LABEL = "Gesperrt: ";

export function isDecisionReservation(label: string): boolean {
  return label.startsWith(DECISION_PREFER_LABEL) || label.startsWith(DECISION_RESERVE_LABEL);
}

/** Details seitenweise: eine Gruppe, eine Suche oder genau ein Pfad. */
export function queryConflictEntries(model: ConflictModel, opts: { group?: string | null; q?: string | null; path?: string | null; offset?: number; limit?: number }): ConflictEntriesPage {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(CONFLICT_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? 50)));
  let list: CollisionEntry[];
  if (opts.path) list = model.all.filter((e) => e.path === opts.path);
  else list = opts.group ? (model.byGroup.get(opts.group) ?? []) : model.all;
  if (opts.q) {
    const q = opts.q;
    list = list.filter((e) => matchesConflictQuery(e, q));
  }
  return { total: list.length, offset, limit, entries: list.slice(offset, offset + limit) };
}
