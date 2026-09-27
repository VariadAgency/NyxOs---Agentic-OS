// „Was war die letzte Session?“ / „Was war die letzte Änderung?“ – vorher suchte Nyx sich das aus `sessions_suchen`
// und `git_lage` zusammen und antwortete ungenau („Ah nee, doch nicht. Ich habe es geprüft.“). Jetzt ein Werkzeug
// (`letzte_aktivitaet`), das genau diese Fragen beantwortet: jüngste Session (Titel, Werkzeug, Projekt, Zeit, was
// zuletzt gefragt/geantwortet wurde) und jüngster Commit (Nachricht, Repo, Zweig, Zeit, Autor, Umfang), dazu fertige Sätze.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionTitle } from "../overview/snapshot.js";
import { ref } from "./sources.js";
import { dateTimeFormat, localDayOf } from "@nyxos/shared";

const STATE_DE: Record<string, string> = { running: "läuft", waiting: "wartet auf den Nutzer", idle: "ruht", crashed: "abgestürzt", closed: "geschlossen" };
const TOOL_DE: Record<string, string> = { claude: "Claude", codex: "Codex" };
const PROMPT_CHARS = 240;
const ANSWER_CHARS = 320;

export interface LatestSessionRow {
  id: string;
  title: string | null;
  sessionId: string;
  tool: string;
  state: string | null;
  closedAt: string | null;
  cwd: string | null;
  baustelle: string | null;
  branch: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  lastPrompt: string | null;
  lastAnswer: string | null;
}

export interface LatestCommitRow {
  sha: string;
  subject: string;
  repo: string;
  branch: string;
  author: string | null;
  at: string;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  sessionKey: string | null;
}

const clip = (s: string | null, n: number): string | null => {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function localDay(d: Date): string {
  return localDayOf(d);
}

/** „heute 11:18“, „gestern 21:04“, sonst „Fr., 25.09., 14:02“ – so, wie man es sagt. */
export function spokenStamp(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = dateTimeFormat({ hour: "2-digit", minute: "2-digit" }).format(d);
  if (localDay(d) === localDay(now)) return `heute ${time}`;
  if (localDay(d) === localDay(new Date(now.getTime() - 86_400_000))) return `gestern ${time}`;
  return dateTimeFormat({ weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** „vor 2 Minuten“, „vor 3 Stunden“, „vor 2 Tagen“. */
export function ago(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} ${min === 1 ? "Minute" : "Minuten"}`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} ${h === 1 ? "Stunde" : "Stunden"}`;
  const days = Math.round(h / 24);
  return `vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
}

function project(s: LatestSessionRow): string | null {
  if (s.baustelle) return s.baustelle;
  const base = s.cwd?.split("/").filter(Boolean).pop();
  return base ?? null;
}

function sessionView(s: LatestSessionRow, now: Date) {
  return {
    ref: ref("session", s.id),
    titel: sessionTitle({ title: s.title, sessionId: s.sessionId, tool: s.tool, cwd: s.cwd, categoryBaustelleLabel: s.baustelle, startedAt: s.startedAt, lastActivityAt: s.lastActivityAt }),
    werkzeug: TOOL_DE[s.tool] ?? s.tool,
    projekt: project(s),
    zweig: s.branch,
    zustand: s.closedAt ? STATE_DE.closed : (STATE_DE[s.state ?? ""] ?? "beendet"),
    gestartet: spokenStamp(s.startedAt, now),
    zuletzt_aktiv: spokenStamp(s.lastActivityAt, now),
    vor: ago(s.lastActivityAt, now),
    zuletzt_gefragt: clip(s.lastPrompt, PROMPT_CHARS),
    zuletzt_geantwortet: clip(s.lastAnswer, ANSWER_CHARS),
  };
}

function commitView(c: LatestCommitRow, now: Date) {
  const size = c.filesChanged === null ? null : `${c.filesChanged} ${c.filesChanged === 1 ? "Datei" : "Dateien"}${c.insertions !== null && c.deletions !== null ? `, +${c.insertions} −${c.deletions}` : ""}`;
  return {
    titel: c.subject,
    repo: c.repo,
    zweig: c.branch,
    zeit: spokenStamp(c.at, now),
    vor: ago(c.at, now),
    autor: c.author,
    sha: c.sha.slice(0, 7),
    umfang: size,
    session: c.sessionKey ? ref("session", c.sessionKey) : null,
  };
}

export function latestActivityView(input: { sessions: LatestSessionRow[]; commits: LatestCommitRow[] }, now: Date) {
  const [first, ...more] = input.sessions.map((s) => sessionView(s, now));
  const [commit, ...moreCommits] = input.commits.map((c) => commitView(c, now));
  const where = first ? [first.werkzeug, first.projekt].filter(Boolean).join(", ") : "";
  return {
    hinweis: "Nenne Titel, Projekt und Zeit genau so. „vor“ ist relativ zu jetzt.",
    letzte_session: first ?? null,
    satz_session: first
      ? `Die letzte Session war „${first.titel}“${where ? ` (${where})` : ""}, zuletzt aktiv ${first.zuletzt_aktiv ?? "unbekannt"}.${first.zuletzt_gefragt ? ` Zuletzt ging es um: „${(clip(first.zuletzt_gefragt, 90) ?? "").replace(/[.!?…]+$/u, "")}“.` : ""}`
      : "Es ist noch keine Session erfasst.",
    weitere_sessions: more,
    letzte_aenderung: commit ?? null,
    satz_aenderung: commit ? `Die letzte Änderung war der Commit „${commit.titel}“ in ${commit.repo}, ${commit.zeit ?? "Zeit unbekannt"}${commit.autor ? `, von ${commit.autor}` : ""}.` : "Es ist noch kein Commit erfasst.",
    weitere_commits: moreCommits,
  };
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);
const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

function textOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.text === "string" && d.text.trim()) return d.text;
  if (typeof d.command === "string" && d.command.trim()) return `${d.command} ${typeof d.args === "string" ? d.args : ""}`.trim();
  return null;
}

/** Lädt jüngste Sessions (ohne Sub-Agenten, nur gezählte mit echter Frage) samt letzter Frage/Antwort und die jüngsten Commits. */
export async function loadLatestActivity(db: Db, o: { sessions: number; commits: number }): Promise<{ sessions: LatestSessionRow[]; commits: LatestCommitRow[] }> {
  const sRows = await db
    .execute(
      sql`select s.id, s.title, s.session_id, s.tool, s.state, s.closed_at, s.cwd, s.category_baustelle_label, s.git_branch, s.started_at, s.last_activity_at,
        (select e.data from session_events e where e.session_key = s.id and e.kind = 'prompt' order by e.ts desc limit 1) as last_prompt,
        (select e.data from session_events e where e.session_key = s.id and e.kind = 'assistant' order by e.ts desc limit 1) as last_answer
      from sessions s
      where s.parent_id is null and s.last_activity_at is not null
        -- wie countedSession/hasQuestion (db/visible.ts): keine archivierten, keine Prüfläufe, nur mit echter Frage
        and s.archived_at is null and (s.temporary_reason is null or s.temporary_reason = 'manual')
        and (s.title is not null or exists (select 1 from session_events q where q.session_key = s.id and q.kind = 'prompt'))
      order by s.last_activity_at desc limit ${o.sessions}`,
    )
    .then(rowsOf);
  const cRows = await db
    .execute(
      sql`select c.sha, c.subject, c.branch, c.author_name, coalesce(c.committed_at, c.author_date) as at, c.files_changed, c.insertions, c.deletions, c.session_key, r.label
      from git_commits c join git_repos r on r.id = c.repo_id
      where c.parent_count <= 1 and c.subject not like 'Merge %'
      order by at desc limit ${o.commits}`,
    )
    .then(rowsOf);
  return {
    sessions: sRows.map((r) => ({
      id: String(r.id),
      title: (r.title as string | null) ?? null,
      sessionId: String(r.session_id),
      tool: String(r.tool),
      state: (r.state as string | null) ?? null,
      closedAt: iso(r.closed_at),
      cwd: (r.cwd as string | null) ?? null,
      baustelle: (r.category_baustelle_label as string | null) ?? null,
      branch: (r.git_branch as string | null) ?? null,
      startedAt: iso(r.started_at),
      lastActivityAt: iso(r.last_activity_at),
      lastPrompt: textOf(r.last_prompt),
      lastAnswer: textOf(r.last_answer),
    })),
    commits: cRows.map((r) => ({
      sha: String(r.sha),
      subject: String(r.subject),
      repo: String(r.label),
      branch: String(r.branch),
      author: (r.author_name as string | null) ?? null,
      at: iso(r.at) ?? "",
      filesChanged: r.files_changed === null || r.files_changed === undefined ? null : Number(r.files_changed),
      insertions: r.insertions === null || r.insertions === undefined ? null : Number(r.insertions),
      deletions: r.deletions === null || r.deletions === undefined ? null : Number(r.deletions),
      sessionKey: (r.session_key as string | null) ?? null,
    })),
  };
}
