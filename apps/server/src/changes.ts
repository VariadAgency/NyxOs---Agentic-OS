// „Seit du weg warst“: sammelt NUR LESEND, was sich seit einem Zeitpunkt getan hat — aus denselben
// Tabellen und Regeln wie Überblick/Briefing (PRODUKT-AUDIT-R2 T1):
// - wartend/abgestürzt: der gemeinsame Schnappschuss (`overview/snapshot.ts`, gleiche Zahl wie die Kopfzeile),
// - fertig: wie „Zuletzt fertig“ (`countedHistorySession`, sauber beendet oder geschlossen), neu: Haupt-Sessions,
// - Commits je Repo (ein SHA nur einmal, wie „Commits · 7 Tage“; Worktrees beim Repo wie im Briefing), Aufträge/Ideen (`entries`),
// - Freigaben (`approvals`) und Fragen an den Nutzer (`inbox_items`), Deploys/Neustarts (`deploys`),
// - Nutzung je Werkzeug (`usage_events`, gleiche Summe wie der Nutzung-Tab).
// Jede Zahl ist genau die Länge der Liste; was über die Obergrenze geht, steht ehrlich in `more`.
import { CHANGES_DEFAULT_HOURS, CHANGES_ITEM_LIMIT, CHANGES_MAX_DAYS, formatTokensCompact, t, type ChangesGroup, type ChangesItem, type ChangesKind, type ChangesResponse } from "@nyxos/shared";
import { and, desc, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { approvals, deploys, entries, inboxItems, sessions } from "./db/schema.js";
import { countedHistorySession } from "./db/visible.js";
import { rowsOf } from "./haiku/tools.js";
import { ref, sessionHref } from "./haiku/sources.js";
import { sessionTitle, takeSnapshot, type SnapSession } from "./overview/snapshot.js";
import { addDays, localDay, localMidnight } from "./usage/periods.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ResolvedSince {
  since: Date;
  /** Der Wunsch lag weiter als 7 Tage zurück. */
  capped: boolean;
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * ISO-Zeitpunkt; ohne Zeitzone gilt Wanduhr des Nutzers (Nyx schreibt „2026-09-24“ oder „2026-09-25T08:00“ und meint
 * Zeitzone des Nutzers, der Server läuft in UTC). Mit `Z`/Versatz wörtlich (so schickt es der Browser).
 */
function parseLocalIso(s: string): Date | null {
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const [, day, hh, mm, ss, zone] = m;
  if (zone) {
    const ms = Date.parse(s.replace(" ", "T"));
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  if (Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
  const offset = (Number(hh ?? 0) * 3600 + Number(mm ?? 0) * 60 + Number(ss ?? 0)) * 1000;
  return new Date(localMidnight(day as string).getTime() + offset);
}

/**
 * `since` aus der Anfrage: leer = letzte 24 h, „8h“/„7d“ (relativ), „heute“/„gestern“ (Mitternacht in der Zeitzone des Nutzers)
 * oder ein ISO-Zeitpunkt. Zukunft zählt als „jetzt“ (Uhr des Browsers kann vorgehen), mehr als 7 Tage werden
 * gekappt. Alles andere → `null` (Route antwortet 400).
 */
export function resolveSince(input: string | undefined | null, now = new Date()): ResolvedSince | null {
  const raw = (input ?? "").trim().toLowerCase();
  let since: Date;
  if (!raw) since = new Date(now.getTime() - CHANGES_DEFAULT_HOURS * HOUR_MS);
  else if (raw === "heute" || raw === "today") since = localMidnight(localDay(now));
  else if (raw === "gestern" || raw === "yesterday") since = localMidnight(addDays(localDay(now), -1));
  else {
    const rel = /^(\d{1,4})\s*([hd])$/.exec(raw);
    if (rel) since = new Date(now.getTime() - Number(rel[1]) * (rel[2] === "h" ? HOUR_MS : DAY_MS));
    else {
      const at = parseLocalIso((input as string).trim());
      if (!at) return null;
      since = at;
    }
  }
  if (since.getTime() > now.getTime()) since = new Date(now.getTime());
  const floor = now.getTime() - CHANGES_MAX_DAYS * DAY_MS;
  if (since.getTime() < floor) return { since: new Date(floor), capped: true };
  return { since, capped: false };
}

/** Postgres- oder ISO-Zeit → ISO. */
function toIso(v: string | Date | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  if (!v) return new Date(0).toISOString();
  const ms = Date.parse(v);
  const t2 = Number.isNaN(ms) ? Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")) : ms;
  return new Date(Number.isNaN(t2) ? 0 : t2).toISOString();
}

function waitLabel(fromIso: string | null, now: Date): string {
  if (!fromIso) return t("wartet");
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (min < 1) return t("wartet seit eben");
  if (min < 60) return t("wartet seit {n} min", { n: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t("wartet seit {n} Std", { n: h }) : t("wartet seit {n} T", { n: Math.floor(h / 24) });
}

const byNewest = (a: ChangesItem, b: ChangesItem) => Date.parse(b.at) - Date.parse(a.at);

/** `total` = echte Trefferzahl, wenn die Abfrage schon in SQL gekürzt hat (sonst die Länge von `all`). */
function group(kind: ChangesKind, title: string, all: ChangesItem[], total = all.length): ChangesGroup | null {
  if (all.length === 0) return null;
  const items = [...all].sort(byNewest).slice(0, CHANGES_ITEM_LIMIT);
  return { kind, title, count: items.length, items, more: Math.max(0, total - items.length) };
}

/** Gesamtzahl aus `count(*) over ()` der ersten Zeile (die Abfrage selbst ist auf LIMIT gekürzt). */
const totalOf = (rows: { total: number | string }[]) => Number(rows[0]?.total ?? 0);

const ENTRY_KIND_LABEL: Record<string, string> = { bug: "Bug", aufgabe: "Aufgabe", audit: "Audit-Fund", problem: "Problem", idee: "Idee", frage: "Frage", entscheidung: "Entscheidung" };
const TOOL_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };
const APPROVAL_STATE: Record<string, string> = { pending: "wartet auf dich", approved: "freigegeben", consumed: "freigegeben und ausgeführt", denied: "abgelehnt", expired: "abgelaufen" };
const INBOX_STATE: Record<string, string> = { open: "wartet auf dich", answered: "beantwortet", dismissed: "verworfen" };
/** Gleiche Summe wie der Nutzung-Tab (`usage/compare.ts`). */
const TOTAL = sql.raw("(input_tokens + output_tokens + cache_read_tokens + cache_creation_5m_tokens + cache_creation_1h_tokens)");

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const snapItem = (s: SnapSession, detail: string): ChangesItem => ({ label: sessionTitle(s), detail, at: toIso(s.lastActivityAt), path: sessionHref(s), ref: ref("session", s.id) });

export async function getChanges(db: Db, opts: { since: Date; now?: Date; capped?: boolean }): Promise<ChangesResponse> {
  const now = opts.now ?? new Date();
  const since = opts.since.toISOString();
  const until = now.toISOString();
  const doneAt = sql`coalesce(${sessions.closedAt}, ${sessions.endedAt}, ${sessions.lastActivityAt})`;

  const [snap, doneRows, newRows, commitRows, entryRows, approvalRows, inboxRows, deployRows, usageRows] = await Promise.all([
    takeSnapshot(db, now),
    // wie „Zuletzt fertig“ im Überblick (aggregate.ts), nur mit Zeitgrenze
    db
      .select({
        id: sessions.id,
        sessionId: sessions.sessionId,
        title: sessions.title,
        categoryArt: sessions.categoryArt,
        categoryBaustelleSlug: sessions.categoryBaustelleSlug,
        closedAt: sessions.closedAt,
        at: sql<string>`${doneAt}`,
        total: sql<number>`count(*) over ()`,
      })
      .from(sessions)
      .where(
        and(
          isNull(sessions.parentId),
          countedHistorySession,
          or(sql`${sessions.closedAt} is not null`, and(sql`${sessions.status} = 'ended'`, or(sql`${sessions.sessionEndReceivedAt} is not null`, sql`${sessions.turnOpen} = false`))),
          sql`${doneAt} >= ${since}::timestamptz and ${doneAt} <= ${until}::timestamptz`,
        ),
      )
      .orderBy(desc(doneAt))
      .limit(CHANGES_ITEM_LIMIT),
    db
      .select({
        id: sessions.id,
        sessionId: sessions.sessionId,
        title: sessions.title,
        tool: sessions.tool,
        categoryArt: sessions.categoryArt,
        categoryBaustelleSlug: sessions.categoryBaustelleSlug,
        startedAt: sessions.startedAt,
        total: sql<number>`count(*) over ()`,
      })
      .from(sessions)
      .where(and(isNull(sessions.parentId), countedHistorySession, gte(sessions.startedAt, since), lte(sessions.startedAt, until)))
      .orderBy(desc(sessions.startedAt))
      .limit(CHANGES_ITEM_LIMIT),
    // Ein SHA nur einmal (wie „Commits · 7 Tage“), beim Haupt-Repo vor dem Worktree.
    // Worktrees zählen zu ihrem Repo (wie die Briefing-Grafik „Commits je Ordner“), der Link bleibt beim Fundort.
    // Je Repo nur die neuesten CHANGES_ITEM_LIMIT Zeilen laden, die echte Zahl kommt als `total` mit
    // (bei 500+ Commits am Tag sonst tausende Zeilen für eine Karte).
    db.execute(sql`
      with d as (
        select distinct on (c.sha) c.sha, c.subject, c.author_date, c.repo_id, coalesce(r.parent_id, r.id) as root_id,
               coalesce(p.label, r.label) as label, c.files_changed, c.parent_count
        from git_commits c join git_repos r on r.id = c.repo_id left join git_repos p on p.id = r.parent_id
        where c.author_date >= ${since}::timestamptz and c.author_date <= ${until}::timestamptz
        order by c.sha, (r.parent_id is not null), c.repo_id
      ), ranked as (
        select d.*, row_number() over (partition by root_id order by author_date desc, sha) as rn,
               count(*) over (partition by root_id)::int as total
        from d
      )
      select * from ranked where rn <= ${CHANGES_ITEM_LIMIT} order by root_id, author_date desc`),
    db
      .select({ id: entries.id, kind: entries.kind, title: entries.title, stage: entries.stage, sourceType: entries.sourceType, sourceId: entries.sourceId, createdAt: entries.createdAt, updatedAt: entries.updatedAt })
      .from(entries)
      .where(and(or(gte(entries.createdAt, since), gte(entries.updatedAt, since)), lte(entries.createdAt, until))),
    db
      .select({ id: approvals.id, status: approvals.status, command: approvals.command, createdAt: approvals.createdAt, decidedAt: approvals.decidedAt })
      .from(approvals)
      .where(or(and(gte(approvals.createdAt, since), lte(approvals.createdAt, until)), and(gte(approvals.decidedAt, since), lte(approvals.decidedAt, until)))),
    db
      .select({ id: inboxItems.id, status: inboxItems.status, title: inboxItems.title, createdAt: inboxItems.createdAt, answeredAt: inboxItems.answeredAt })
      .from(inboxItems)
      .where(or(and(gte(inboxItems.createdAt, since), lte(inboxItems.createdAt, until)), and(gte(inboxItems.answeredAt, since), lte(inboxItems.answeredAt, until)))),
    db
      .select({ id: deploys.id, project: deploys.project, containerName: deploys.containerName, source: deploys.source, createdAt: deploys.createdAt })
      .from(deploys)
      .where(and(gte(deploys.createdAt, since), lte(deploys.createdAt, until))),
    db.execute(sql`
      select tool, coalesce(sum(${TOTAL}), 0)::float8 as tokens, max(ts) as last
      from usage_events where ts >= ${since}::timestamptz and ts <= ${until}::timestamptz
      group by tool order by tool`),
  ]);

  const groups: (ChangesGroup | null)[] = [];

  groups.push(group("sessions_waiting", t("Wartet auf dich"), snap.waiting.map((s) => snapItem(s, waitLabel(s.lastActivityAt, now)))));
  groups.push(group("sessions_crashed", t("Abgestürzt"), snap.crashed.map((s) => snapItem(s, t("abgestürzt – neu starten oder schließen")))));

  const decisions: ChangesItem[] = [
    ...approvalRows.map((a) => {
      // „wartet“ nur, solange die Freigabe noch gilt (gleiche Regel wie der Schnappschuss).
      const stillPending = a.status === "pending" && snap.pendingApprovals.some((p) => p.id === a.id);
      const state = a.status === "pending" && !stillPending ? t("abgelaufen") : t(APPROVAL_STATE[a.status] ?? "entschieden");
      return { label: t("Freigabe: {command}", { command: short(a.command, 80) }), detail: state, at: toIso(a.decidedAt ?? a.createdAt), path: `/inbox#approval-${a.id}`, ref: ref("approval", a.id) };
    }),
    ...inboxRows.map((i) => ({ label: short(i.title, 100), detail: t(INBOX_STATE[i.status] ?? "erledigt"), at: toIso(i.answeredAt ?? i.createdAt), path: `/inbox#inbox-${i.id}`, ref: ref("inbox", i.id) })),
  ];
  groups.push(group("decisions", t("Freigaben und Fragen"), decisions));

  groups.push(
    group(
      "sessions_done",
      t("Sessions fertig"),
      doneRows.map((r) => ({ label: sessionTitle({ title: r.title, sessionId: r.sessionId, lastActivityAt: toIso(r.at) }), detail: r.closedAt ? t("geschlossen") : t("fertig"), at: toIso(r.at), path: sessionHref(r), ref: ref("session", r.id) })),
      totalOf(doneRows),
    ),
  );

  // Commits je Repo: das Repo mit dem jüngsten Commit zuerst.
  const commitsByRepo = new Map<string, { label: string; total: number; items: ChangesItem[] }>();
  for (const c of rowsOf(commitRows)) {
    const repoId = String(c.repo_id);
    const rootId = String(c.root_id ?? repoId);
    const bucket = commitsByRepo.get(rootId) ?? { label: String(c.label ?? rootId), total: Number(c.total ?? 0), items: [] };
    const files = c.files_changed == null ? null : Number(c.files_changed);
    const merge = Number(c.parent_count ?? 1) >= 2;
    const detail = [merge ? "Merge" : null, files == null || (merge && files === 0) ? null : files === 1 ? t("1 Datei") : t("{n} Dateien", { n: files })].filter(Boolean).join(" · ") || null;
    bucket.items.push({ label: short(String(c.subject), 120), detail, at: toIso(c.author_date as string), path: `/git?${new URLSearchParams({ g: "commit", r: repoId, k: String(c.sha) }).toString()}` });
    commitsByRepo.set(rootId, bucket);
  }
  const commitGroups = [...commitsByRepo.values()]
    .map((b) => group("commits", t("Commits · {repo}", { repo: b.label }), b.items, b.total))
    .filter((g): g is ChangesGroup => g !== null)
    .sort((a, b) => Date.parse(b.items[0]?.at ?? "") - Date.parse(a.items[0]?.at ?? ""));
  groups.push(...commitGroups);

  const entryItem = (e: (typeof entryRows)[number]): ChangesItem => {
    const kind = t(ENTRY_KIND_LABEL[e.kind] ?? "Eintrag");
    const createdIn = toIso(e.createdAt) >= since;
    const detail = e.stage === "erledigt" ? t("{kind} erledigt", { kind }) : createdIn ? t("{kind} neu", { kind }) : t("{kind} geändert", { kind });
    const path = `/tasks?e=${e.id}`;
    return { label: short(e.title, 120), detail, at: toIso(e.updatedAt), path, ref: ref("entry", e.id) };
  };
  groups.push(group("tasks", t("Aufträge"), entryRows.filter((e) => e.kind !== "idee").map(entryItem)));
  groups.push(group("ideas", t("Ideen"), entryRows.filter((e) => e.kind === "idee").map(entryItem)));

  groups.push(
    group(
      "sessions_new",
      t("Neue Sessions"),
      newRows.map((r) => ({ label: sessionTitle({ title: r.title, sessionId: r.sessionId, lastActivityAt: r.startedAt }), detail: TOOL_LABEL[r.tool] ?? null, at: toIso(r.startedAt), path: sessionHref(r), ref: ref("session", r.id) })),
      totalOf(newRows),
    ),
  );

  groups.push(
    group(
      "deploys",
      t("Deploys und Neustarts"),
      deployRows.map((d) => ({ label: d.containerName, detail: `${d.source === "deploy.sh" ? t("Deploy") : t("Container neu gestartet")} · ${d.project === "nyxos" ? "NyxOS" : d.project}`, at: toIso(d.createdAt), path: "/server" })),
    ),
  );

  const usage: ChangesItem[] = rowsOf(usageRows)
    .filter((u) => Number(u.tokens) > 0)
    .map((u) => ({ label: TOOL_LABEL[String(u.tool)] ?? String(u.tool), detail: t("{tokens} Tokens", { tokens: formatTokensCompact(Number(u.tokens)) }), at: toIso(u.last as string), path: "/usage" }));
  // Nutzung in fester Reihenfolge (Claude, Codex), nicht nach Zeit.
  if (usage.length > 0) groups.push({ kind: "usage", title: t("Nutzung"), count: usage.length, items: usage, more: 0 });

  return { since, until, capped: opts.capped ?? false, groups: groups.filter((g): g is ChangesGroup => g !== null) };
}
