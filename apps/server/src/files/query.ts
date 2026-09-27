// „Dateien“ aus `session_files` — welche Datei haben welche Sessions gelesen/geändert.
// Entscheidung: bauen statt ausblenden. Die Daten sind da (am 25.09. rund 4.300 Pfade, 1.900
// Schreibvorgänge), und die Frage „wer war an dieser Datei dran?“ beantwortet sonst keine Ansicht
// (Konflikte zeigt nur offene Überschneidungen, Sessions nur die Dateien EINER Session).
import type { FileAreaId, FileAreaSummary, FileModeFilter, FileSession, FilesOverview, TouchedFile } from "@nyxos/shared";
import { FILE_AREAS, repoLocation } from "@nyxos/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionFiles, sessions } from "../db/schema.js";
import { visibleSession, visibleSessionSql } from "../db/visible.js";
import { sessionHref } from "../haiku/sources.js";

const FOLDER_DEPTH = 3;
export const FILES_LIMIT = 300;

function splitRel(parts: string[]): { rel: string; folder: string; name: string } {
  const name = parts[parts.length - 1] ?? "";
  const dirs = parts.slice(0, -1);
  return { rel: parts.join("/"), folder: dirs.slice(0, FOLDER_DEPTH).join("/"), name };
}

/** Ordnet einen absoluten Pfad einem Bereich zu: Worktree (`<repo>/.worktrees/<slug>`, Slug als erste
 * Ebene), Projekt (ab dem Repo-Namen unter dem Home-Ordner) oder außerhalb (versteckte Ordner im Home
 * wie `~/.claude`, alles außerhalb des Home-Ordners). */
export function classifyPath(abs: string): Pick<TouchedFile, "area" | "rel" | "folder" | "name"> {
  const parts = abs.split("/").filter(Boolean);
  const at = repoLocation(parts);
  if (at.worktree) return { area: "worktrees", ...splitRel([at.worktree.slug, ...at.worktree.inside]) };
  const repo = at.repoStart === null ? undefined : parts[at.repoStart];
  if (at.repoStart !== null && repo && !repo.startsWith(".") && parts.length - at.repoStart > 1) return { area: "projekte", ...splitRel(parts.slice(at.repoStart)) };
  const home = at.repoStart !== null && (parts[0] === "Users" || parts[0] === "home") ? ["~", ...parts.slice(2)] : parts;
  return { area: "sonstiges", ...splitRel(home) };
}

interface Row {
  path: string;
  changed: boolean;
  read: boolean;
  sessions: number;
  last_at: string | null;
}

/** nur Zugriffe sichtbarer Sessions zählen (archivierte Wegwerf-Sessions nicht). */
const byVisibleSession = sql`exists (select 1 from ${sessions} vs where vs.id = ${sessionFiles.sessionKey} and ${visibleSessionSql("vs")})`;

function rowsOf(result: unknown): Row[] {
  const r = result as { rows?: Row[] } | Row[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function listTouchedFiles(db: Db, opts: { q?: string; mode?: FileModeFilter; area?: FileAreaId; limit?: number }): Promise<FilesOverview> {
  const needle = opts.q?.trim() ?? "";
  const like = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
  const where = needle ? sql`where ${sessionFiles.path} ilike ${like} and ${byVisibleSession}` : sql`where ${byVisibleSession}`;
  const result = await db.execute(sql`
    select ${sessionFiles.path} as path,
           bool_or(${sessionFiles.mode} = 'write') as changed,
           bool_or(${sessionFiles.mode} = 'read') as read,
           count(distinct ${sessionFiles.sessionKey})::int as sessions,
           max(${sessionFiles.firstSeenAt}) as last_at
    from ${sessionFiles} ${where}
    group by ${sessionFiles.path}`);
  const mode = opts.mode ?? "alle";
  const all = rowsOf(result)
    .filter((r) => (mode === "geaendert" ? r.changed : mode === "gelesen" ? !r.changed : true))
    .map((r): TouchedFile => ({ path: r.path, ...classifyPath(r.path), changed: !!r.changed, read: !!r.read, sessions: Number(r.sessions), lastAt: iso(r.last_at) }));

  const areas: FileAreaSummary[] = FILE_AREAS.map(({ id, label }) => {
    const inArea = all.filter((f) => f.area === id);
    const lastAt = inArea.reduce<string | null>((m, f) => (f.lastAt && (!m || f.lastAt > m) ? f.lastAt : m), null);
    return { id, label, files: inArea.length, changed: inArea.filter((f) => f.changed).length, lastAt };
  }).filter((a) => a.files > 0);

  const sessionCount = await countSessions(db, needle ? like : null, mode);
  const inArea = opts.area ? all.filter((f) => f.area === opts.area) : all;
  inArea.sort((x, y) => (y.lastAt ?? "").localeCompare(x.lastAt ?? "") || x.path.localeCompare(y.path));
  const limit = Math.min(Math.max(opts.limit ?? FILES_LIMIT, 1), 1000);
  return { total: all.length, sessions: sessionCount, areas, files: inArea.slice(0, limit), truncated: inArea.length > limit };
}

async function countSessions(db: Db, like: string | null, mode: FileModeFilter): Promise<number> {
  // „Nur gelesen“ = Dateien ohne Schreibzugriff — die zählenden Sessions sind dann die Leser dieser Dateien.
  const byMode =
    mode === "geaendert"
      ? sql`${sessionFiles.mode} = 'write'`
      : mode === "gelesen"
        ? sql`not exists (select 1 from ${sessionFiles} w join ${sessions} ws on ws.id = w.session_key where w.path = ${sessionFiles.path} and w.mode = 'write' and ${visibleSessionSql("ws")})`
        : sql`true`;
  const byPath = like ? sql`${sessionFiles.path} ilike ${like}` : sql`true`;
  const result = await db.execute(sql`select count(distinct ${sessionFiles.sessionKey})::int as n from ${sessionFiles} where ${byPath} and ${byMode} and ${byVisibleSession}`);
  const row = rowsOf(result)[0] as unknown as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

export async function sessionsForFile(db: Db, path: string): Promise<FileSession[]> {
  const rows = await db
    .select({
      key: sessions.id,
      sessionId: sessions.sessionId,
      title: sessions.title,
      tool: sessions.tool,
      state: sessions.state,
      closedAt: sessions.closedAt,
      lastActivityAt: sessions.lastActivityAt,
      categoryArt: sessions.categoryArt,
      categoryBaustelleSlug: sessions.categoryBaustelleSlug,
      mode: sessionFiles.mode,
      firstSeenAt: sessionFiles.firstSeenAt,
    })
    .from(sessionFiles)
    .innerJoin(sessions, eq(sessions.id, sessionFiles.sessionKey))
    .where(and(eq(sessionFiles.path, path), visibleSession))
    .limit(1000);
  const byKey = new Map<string, FileSession>();
  for (const r of rows) {
    const seen = byKey.get(r.key);
    const mode = r.mode === "write" ? "write" : "read";
    if (seen) {
      if (!seen.modes.includes(mode)) seen.modes.push(mode);
      const first = iso(r.firstSeenAt);
      if (first && (!seen.firstSeenAt || first < seen.firstSeenAt)) seen.firstSeenAt = first;
      continue;
    }
    byKey.set(r.key, {
      key: r.key,
      title: r.title,
      tool: r.tool,
      modes: [mode],
      firstSeenAt: iso(r.firstSeenAt),
      lastActivityAt: iso(r.lastActivityAt),
      state: r.state,
      closed: r.closedAt !== null,
      href: sessionHref(r),
    });
  }
  return [...byKey.values()].sort((a, b) => (b.lastActivityAt ?? b.firstSeenAt ?? "").localeCompare(a.lastActivityAt ?? a.firstSeenAt ?? ""));
}
