// Wegwerf-Chats: temporäre Sessions und Haiku-Fäden.
//
// Markieren: Schalter „Temporär“ beim Start (Claude: Schlüssel sofort bekannt, Codex: über den tmux-Namen,
// `temporary_marks`) oder Auto-Regeln. Die Regeln stammen aus einer Stichprobe echter Sessions: Test- und
// Hilfsläufe wurden alle von genau diesen vier Mustern erfasst, keine echte Arbeits-Session getroffen:
//   haiku_run    SessionStart-Hook mit Haiku-Modell IM NYXOS-REPO (oder einer seiner Worktrees) – Selbsttests
//                (Terminal-/Brücken-Prüfungen, Lastläufe). Haikus Motor läuft im Server-Container und kommt gar
//                nicht über den Ingest; ohne Ordner-Bedingung träfe die Regel jede Haiku-Session – echte
//                Recherche mit Haiku in anderen Projekten bleibt so unberührt.
//   probe_folder Arbeitsordner unter `.probe/` (Test-Ordner der Probe, z. B. new-session-test, crash-test).
//   selftest     Titel aus dem ersten Prompt „Antworte nur mit …“ (Selbsttests von Brücke und Terminal).
//   probe_tmux   `zc-*`-tmux-Session, solange die verbundene Brücke NICHT der echte Socket „nyxos“ ist
//                (`scripts/dev.mjs`: Socket „nyxos-probe“).
// „Behalten“ hebt die Markierung auf und sperrt die Automatik für diese Session (`temporary_kept`).
//
// Ablauf (60-s-Ticker in `app.ts`): X Stunden (Einstellung, 1–72) nach der letzten Aktivität werden
// Haiku-Fäden GELÖSCHT (Einstellung des Nutzers) und Sessions ARCHIVIERT: sie
// verschwinden aus Listen und Zählern, Zeile, Ereignisse und Transkript-Archiv bleiben. Auf dem Rechner wird
// nichts gelöscht. Eine Session mit lebendem Prozess wird nie archiviert; neue Aktivität holt
// eine archivierte Session samt Sub-Agenten zurück; „Behalten“ ebenso; das Archiv ist abrufbar
// (`listArchived`, Einstellungen → Temporäre Chats und Sessions).
import { PRODUCTION_TMUX_SOCKET, TEMPORARY_HOURS_DEFAULT, temporaryExpiresAt, type TemporaryReason } from "@nyxos/shared";
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { haikuThreads, sessions, temporaryMarks, temporarySettings } from "./db/schema.js";
import { sessionHref } from "./haiku/sources.js";

/** Sichtbare Sessions: überall, wo gelistet oder gezählt wird (nicht archiviert). Quelle: `db/visible.ts`. */
export { visibleSession } from "./db/visible.js";

export async function loadTemporaryHours(db: Db): Promise<number> {
  const [r] = await db.select({ hours: temporarySettings.hours }).from(temporarySettings).where(eq(temporarySettings.id, 1)).limit(1);
  return r?.hours ?? TEMPORARY_HOURS_DEFAULT;
}

export async function saveTemporaryHours(db: Db, hours: number): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(temporarySettings).values({ id: 1, hours, updatedAt: now }).onConflictDoUpdate({ target: temporarySettings.id, set: { hours, updatedAt: now } });
}

/** Wann eine Session abläuft (null = nicht temporär). Dieselbe Regel wie die Marke im Web (`@nyxos/shared`). */
export function sessionExpiresAt(row: { temporarySince: string | null; lastActivityAt: string | null }, hours: number): string | null {
  return row.temporarySince ? temporaryExpiresAt(row.temporarySince, row.lastActivityAt, hours) : null;
}

/** Wann ein Haiku-Faden gelöscht wird: X Stunden nach der letzten Nachricht (bzw. dem Umschalten). */
export function threadExpiresAt(row: { temporary: boolean; updatedAt: string }, hours: number): string | null {
  return row.temporary ? temporaryExpiresAt(row.updatedAt, null, hours) : null;
}

/** Ordnername des NyxOS-Repos (Selbsttests beim Entwickeln von NyxOS), ohne Groß-/Kleinschreibung. */
const NYXOS_REPO_DIR = "nyxos";

const HAIKU_START = sql`exists (
  select 1 from session_events e
  where e.session_key = ${sessions.id} and e.kind = 'hook'
    and e.data->>'event' = 'SessionStart'
    and coalesce(e.data->>'source', 'startup') = 'startup'
    and e.data->>'model' like 'claude-haiku%'
    and (lower(e.data->>'cwd') like ${"%/" + NYXOS_REPO_DIR} or lower(e.data->>'cwd') like ${"%/" + NYXOS_REPO_DIR + "/%"})
)`;
/** dieselbe Regel ohne Hook (aus dem Verlauf eingelesene Sessions): NUR Haiku-Modelle benutzt und
 * im NyxOS-Repo/Worktree gearbeitet. Gemischte Modelle (Haiku + Opus) gelten als echte Arbeit. */
const HAIKU_MODELS = sql`(jsonb_array_length(${sessions.models}) > 0
  and not exists (select 1 from jsonb_array_elements_text(${sessions.models}) m(v) where m.v not like 'claude-haiku%')
  and (lower(${sessions.cwd}) like ${"%/" + NYXOS_REPO_DIR} or lower(${sessions.cwd}) like ${"%/" + NYXOS_REPO_DIR + "/%"}))`;
const PROBE_FOLDER = sql`(${sessions.cwd} like '%/.probe/%' or ${sessions.cwd} like '%/.probe')`;
const SELFTEST = sql`(${sessions.titleSource} = 'prompt' and ${sessions.title} like 'Antworte nur mit %')`;
const MARKED = sql`${sessions.tmuxName} in (select ${temporaryMarks.tmuxName} from ${temporaryMarks})`;
const ZC = sql`${sessions.tmuxName} like 'zc-%'`;

/** Ist die verbundene Brücke eine Probe (eigener tmux-Socket)? `null` = keine Brücke verbunden. */
export function isProbeSocket(tmuxSocket: string | null): boolean {
  return tmuxSocket !== null && tmuxSocket !== PRODUCTION_TMUX_SOCKET;
}

/**
 * Wendet Start-Markierungen und Auto-Regeln an. `keys` begrenzt auf frisch eingelesene Sessions (Ingest),
 * ohne `keys` prüft der Ticker alle. Nur Haupt-Sessions (Sub-Agenten folgen ihrer Session beim Archivieren).
 * Liefert die neu markierten Schlüssel.
 */
export async function applyTemporaryMarks(db: Db, opts: { probeSocket: boolean; keys?: string[]; now?: Date }): Promise<string[]> {
  if (opts.keys && opts.keys.length === 0) return [];
  const now = (opts.now ?? new Date()).toISOString();
  const rules: [TemporaryReason, SQL][] = [
    ["manual", MARKED],
    ...(opts.probeSocket ? ([["probe_tmux", ZC]] as [TemporaryReason, SQL][]) : []),
    ["probe_folder", PROBE_FOLDER],
    ["selftest", SELFTEST],
    ["haiku_run", HAIKU_START],
    ["haiku_run", HAIKU_MODELS],
  ];
  const reason = sql.join([sql`case`, ...rules.map(([r, cond]) => sql`when ${cond} then ${sql.raw(`'${r}'`)}`), sql`end`], sql` `);
  const any = or(...rules.map(([, cond]) => cond)) as SQL;
  const conds = [isNull(sessions.parentId), isNull(sessions.temporarySince), isNull(sessions.archivedAt), any];
  // „Behalten“ sperrt nur die Automatik; ein ausdrücklicher Start-Schalter gilt trotzdem.
  conds.push(sql`(not ${sessions.temporaryKept} or ${MARKED})`);
  if (opts.keys) conds.push(inArray(sessions.id, opts.keys));
  const marked = await db
    .update(sessions)
    .set({ temporarySince: now, temporaryReason: reason, updatedAt: now })
    .where(and(...conds))
    .returning({ id: sessions.id, tmuxName: sessions.tmuxName });
  const used = marked.map((m) => m.tmuxName).filter((n): n is string => !!n);
  if (used.length) await db.delete(temporaryMarks).where(inArray(temporaryMarks.tmuxName, used));
  // Nie erschienene Start-Markierungen (Start abgebrochen) nach einem Tag aufräumen.
  await db.delete(temporaryMarks).where(lt(temporaryMarks.createdAt, new Date(Date.parse(now) - 86_400_000).toISOString()));
  return marked.map((m) => m.id);
}

/** Schalter beim Start: Claude-Sessions direkt am Schlüssel, Codex über den tmux-Namen (Ticker/Ingest greift). */
export async function markStartedTemporary(db: Db, started: { key: string | null; tmuxName: string }, now = new Date()): Promise<void> {
  const iso = now.toISOString();
  if (started.key) {
    await db
      .update(sessions)
      .set({ temporarySince: iso, temporaryReason: "manual", temporaryKept: false, archivedAt: null, updatedAt: iso })
      .where(eq(sessions.id, started.key));
    return;
  }
  await db.insert(temporaryMarks).values({ tmuxName: started.tmuxName, createdAt: iso }).onConflictDoNothing();
}

/** Knopf an der Session: temporär machen oder „Behalten“ (Automatik danach gesperrt). */
export async function setSessionTemporary(db: Db, idOrUuid: string, temporary: boolean, now = new Date()): Promise<{ id: string } | null> {
  const iso = now.toISOString();
  const where = or(eq(sessions.id, idOrUuid), eq(sessions.sessionId, idOrUuid));
  const [row] = await db
    .update(sessions)
    .set(
      temporary
        ? { temporarySince: iso, temporaryReason: "manual", temporaryKept: false, updatedAt: iso }
        : { temporarySince: null, temporaryReason: null, temporaryKept: true, archivedAt: null, updatedAt: iso },
    )
    .where(where)
    .returning({ id: sessions.id });
  // Sub-Agenten wurden mit der Session archiviert – „Behalten“ holt sie mit zurück.
  if (row && !temporary) await db.update(sessions).set({ archivedAt: null, updatedAt: iso }).where(and(eq(sessions.parentId, row.id), isNotNull(sessions.archivedAt)));
  return row ?? null;
}

/**
 * Neue Aktivität nach dem Archivieren (z. B. `claude --resume`) holt die Session samt Sub-Agenten zurück –
 * sonst liefe echte Arbeit unsichtbar weiter. Nachgereichte ältere Ereignisse zählen nicht. Liefert die
 * zurückgeholten Schlüssel.
 */
export async function reviveArchived(db: Db, keys: string[], now = new Date()): Promise<string[]> {
  if (keys.length === 0) return [];
  const iso = now.toISOString();
  const revived = (
    await db
      .update(sessions)
      .set({ archivedAt: null, updatedAt: iso })
      .where(and(inArray(sessions.id, keys), isNotNull(sessions.archivedAt), sql`${sessions.lastActivityAt} > ${sessions.archivedAt}`))
      .returning({ id: sessions.id })
  ).map((r) => r.id);
  if (revived.length === 0) return [];
  const subs = await db
    .update(sessions)
    .set({ archivedAt: null, updatedAt: iso })
    .where(and(inArray(sessions.parentId, revived), isNotNull(sessions.archivedAt)))
    .returning({ id: sessions.id });
  return [...revived, ...subs.map((r) => r.id)];
}

export interface ArchivedSession {
  id: string;
  sessionId: string;
  tool: string;
  title: string | null;
  href: string;
  temporaryReason: string | null;
  archivedAt: string;
  lastActivityAt: string | null;
}

/** Das Archiv: archivierte Haupt-Sessions, zuletzt archivierte zuerst (zum Ansehen und Zurückholen). */
export async function listArchived(db: Db, limit = 100): Promise<ArchivedSession[]> {
  const rows = await db
    .select({
      id: sessions.id,
      sessionId: sessions.sessionId,
      tool: sessions.tool,
      title: sessions.title,
      categoryArt: sessions.categoryArt,
      categoryBaustelleSlug: sessions.categoryBaustelleSlug,
      temporaryReason: sessions.temporaryReason,
      archivedAt: sessions.archivedAt,
      lastActivityAt: sessions.lastActivityAt,
    })
    .from(sessions)
    .where(and(isNotNull(sessions.archivedAt), isNull(sessions.parentId)))
    .orderBy(desc(sessions.archivedAt), sessions.id)
    .limit(limit);
  return rows.map(({ categoryArt, categoryBaustelleSlug, archivedAt, ...r }) => ({
    ...r,
    archivedAt: archivedAt ?? "",
    href: sessionHref({ sessionId: r.sessionId, categoryArt, categoryBaustelleSlug }),
  }));
}

/**
 * Abgelaufenes aufräumen: Sessions (samt Sub-Agenten) archivieren, Haiku-Fäden löschen.
 * Liefert die archivierten Session-Schlüssel und die Zahl gelöschter Fäden.
 */
export async function expireTemporary(db: Db, now = new Date()): Promise<{ archived: string[]; threadsDeleted: number }> {
  const hours = await loadTemporaryHours(db);
  const nowMs = now.getTime();
  const iso = now.toISOString();

  const candidates = await db
    .select({ id: sessions.id, temporarySince: sessions.temporarySince, lastActivityAt: sessions.lastActivityAt })
    .from(sessions)
    // Lebt der Prozess noch (status „running“), bleibt die Session sichtbar – egal wie lange sie still ist.
    .where(and(isNotNull(sessions.temporarySince), isNull(sessions.archivedAt), ne(sessions.status, "running")));
  const due = candidates.filter((r) => Date.parse(sessionExpiresAt(r, hours) ?? "") <= nowMs).map((r) => r.id);
  let archived: string[] = [];
  if (due.length) {
    archived = (
      await db
        .update(sessions)
        .set({ archivedAt: iso, updatedAt: iso })
        .where(and(isNull(sessions.archivedAt), or(inArray(sessions.id, due), inArray(sessions.parentId, due))))
        .returning({ id: sessions.id })
    ).map((r) => r.id);
  }

  const threads = await db.select({ id: haikuThreads.id, temporary: haikuThreads.temporary, updatedAt: haikuThreads.updatedAt }).from(haikuThreads).where(eq(haikuThreads.temporary, true));
  const dueThreads = threads.filter((t) => Date.parse(threadExpiresAt(t, hours) ?? "") <= nowMs).map((t) => t.id);
  if (dueThreads.length) await db.delete(haikuThreads).where(inArray(haikuThreads.id, dueThreads));

  return { archived, threadsDeleted: dueThreads.length };
}

/** Ein Durchlauf des Aufräum-Tickers (im 60-s-Takt von `app.ts`). */
export async function runTemporaryTicker(db: Db, opts: { probeSocket: boolean; now?: Date }): Promise<{ marked: string[]; archived: string[]; threadsDeleted: number }> {
  const now = opts.now ?? new Date();
  const marked = await applyTemporaryMarks(db, { probeSocket: opts.probeSocket, now });
  const { archived, threadsDeleted } = await expireTemporary(db, now);
  return { marked, archived, threadsDeleted };
}
