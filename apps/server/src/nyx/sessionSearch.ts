// Suche in alten Nyx-/Haiku-Chats, ohne Modell. Übernommen (angepasst, nach TypeScript/Postgres) aus
// Hermes Agent `tools/session_search_tool.py` (MIT, © 2025 Nous Research): vier Formen an den Argumenten erkannt
// (Suchen · um eine Nachricht herum lesen · ganzen Faden lesen · letzte Fäden), relative Zeitfilter („7d“, „24h“),
// automatische Fäden (Nyx-Meldungen) abgewertet statt versteckt. Volltext mit Postgres-Konfiguration `german`
// (Index `haiku_messages_fts_idx`), bei null Treffern Rückfall auf Teilwort-Suche (ILIKE) – deckt Tippfehler/Wortteile ab.
// `pg_trgm` bewusst nicht: die DB-Rolle `nyxos` darf keine Erweiterungen anlegen, und PGlite (Tests) kennt sie nicht.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { localStamp, rowsOf } from "../haiku/tools.js";

/** Themen automatischer Fäden (werden abgewertet, nicht versteckt – sonst „Erinnerungs-Blindheit“). */
export const AUTO_TOPIC_PREFIX = "nyx-";

export interface ChatSearchArgs {
  query?: string;
  threadId?: number;
  aroundMessageId?: number;
  after?: string;
  before?: string;
  limit?: number;
}

/** „7d“, „24h“, „2w“, „30m“ oder ISO-Datum → ISO-Zeitpunkt; sonst null. */
export function parseWhen(v: string | undefined, now = new Date()): string | null {
  if (!v) return null;
  const m = /^(\d{1,4})\s*(m|h|d|w)$/i.exec(v.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(m[2] ?? "d").toLowerCase() as "m" | "h" | "d" | "w"];
    return new Date(now.getTime() - n * unit).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ").trim();

/** Ausschnitt um den ersten Treffer eines Suchworts. */
function snippet(text: string, words: string[], n = 240): string {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const w of words) {
    const stem = w.toLowerCase().slice(0, Math.max(4, w.length - 2));
    pos = lower.indexOf(stem);
    if (pos >= 0) break;
  }
  if (pos < 0 || text.length <= n) return cut(text, n);
  const start = Math.max(0, pos - Math.floor(n / 3));
  return `${start > 0 ? "…" : ""}${cut(text.slice(start), n)}`;
}

interface MsgRow {
  id: number;
  thread_id: number;
  role: string;
  text: string;
  created_at: string | Date;
  title: string;
  topic: string;
  rank?: number;
}
const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
const msgOut = (r: MsgRow, max = 600) => ({ nachricht_id: r.id, von: r.role === "user" ? "Nutzer" : "Nyx", zeit: localStamp(iso(r.created_at)), text: cut(r.text, max) });

async function windowAround(db: Db, threadId: number, messageId: number, radius: number) {
  const rows = rowsOf(
    await db.execute(sql`
      (select id, thread_id, role, text, created_at from haiku_messages where thread_id = ${threadId} and id <= ${messageId} order by id desc limit ${radius + 1})
      union all
      (select id, thread_id, role, text, created_at from haiku_messages where thread_id = ${threadId} and id > ${messageId} order by id asc limit ${radius})
      order by id`),
  ) as unknown as MsgRow[];
  return rows.map((r) => msgOut(r));
}

export async function searchChats(db: Db, a: ChatSearchArgs, now = new Date()) {
  const limit = Math.min(Math.max(a.limit ?? 5, 1), 10);
  const after = parseWhen(a.after, now);
  const before = parseWhen(a.before, now);
  const timeCond = sql`${after ? sql`and m.created_at >= ${after}` : sql``} ${before ? sql`and m.created_at < ${before}` : sql``}`;

  // Form 2: um eine Nachricht herum lesen
  if (a.threadId && a.aroundMessageId) {
    return { form: "umgebung", faden_id: a.threadId, nachrichten: await windowAround(db, a.threadId, a.aroundMessageId, 5) };
  }
  // Form 3: ganzen Faden lesen (je Nachricht gekappt)
  if (a.threadId) {
    const rows = rowsOf(
      await db.execute(sql`select m.id, m.thread_id, m.role, m.text, m.created_at, t.title, t.topic from haiku_messages m join haiku_threads t on t.id = m.thread_id
        where t.scope = 'full' and m.thread_id = ${a.threadId} order by m.id limit 80`),
    ) as unknown as MsgRow[];
    if (rows.length === 0) return { form: "faden", faden_id: a.threadId, fehler: "Diesen Chat gibt es nicht (mehr)." };
    return { form: "faden", faden_id: a.threadId, titel: rows[0]?.title, nachrichten: rows.map((r) => msgOut(r, 2000)) };
  }
  // Form 4: letzte Fäden
  const q = a.query?.trim() ?? "";
  if (!q) {
    const rows = rowsOf(
      await db.execute(sql`select t.id, t.title, t.topic, t.updated_at, (select count(*)::int from haiku_messages m where m.thread_id = t.id) as n
        from haiku_threads t where t.scope = 'full' order by t.updated_at desc limit ${limit}`),
    );
    return { form: "letzte", faeden: rows.map((r) => ({ faden_id: Number(r.id), titel: r.title, zuletzt: localStamp(iso(r.updated_at as string)), nachrichten: Number(r.n) })) };
  }
  // Form 1: suchen – deutscher Volltext, gerankt; automatische Fäden halb gewichtet. Erst alle Wörter (UND),
  // sonst irgendeins (ODER, Rang ordnet), sonst Wortteil (ILIKE).
  const fts = async (any: boolean) =>
    rowsOf(
      await db.execute(sql`
      with q as (select ${any ? sql`replace(websearch_to_tsquery('german', ${q})::text, ' & ', ' | ')::tsquery` : sql`websearch_to_tsquery('german', ${q})`} as tq)
      select m.id, m.thread_id, m.role, m.text, m.created_at, t.title, t.topic,
        ts_rank(to_tsvector('german', m.text), q.tq) * (case when t.topic like ${`${AUTO_TOPIC_PREFIX}%`} then 0.5 else 1 end) as rank
      from haiku_messages m join haiku_threads t on t.id = m.thread_id, q
      where t.scope = 'full' and to_tsvector('german', m.text) @@ q.tq ${timeCond}
      order by rank desc, m.id desc limit 60`),
    ) as unknown as MsgRow[];
  let hits = await fts(false);
  if (hits.length === 0) hits = await fts(true);
  let mode = "volltext";
  if (hits.length === 0) {
    const words = q.split(/\s+/).filter((w) => w.length >= 3).slice(0, 5);
    if (words.length > 0) {
      const conds = sql.join(
        words.map((w) => sql`m.text ilike ${`%${w.replace(/[%_\\]/g, "\\$&")}%`}`),
        sql` and `,
      );
      hits = rowsOf(
        await db.execute(sql`select m.id, m.thread_id, m.role, m.text, m.created_at, t.title, t.topic, (case when t.topic like ${`${AUTO_TOPIC_PREFIX}%`} then 0.5 else 1 end)::float8 as rank
          from haiku_messages m join haiku_threads t on t.id = m.thread_id
          where t.scope = 'full' and ${conds} ${timeCond} order by rank desc, m.id desc limit 60`),
      ) as unknown as MsgRow[];
      mode = "teilwort";
    }
  }
  if (hits.length === 0) return { form: "suche", suche: q, gesamt: 0, faeden: [], hinweis: "Nichts in früheren Chats gefunden. Das heißt nicht, dass es das nicht gibt – direkte Quellen (Sessions, Aufträge) zuerst prüfen." };
  // Je Faden der beste Treffer; der beste Faden bekommt ± 3 Nachrichten Umgebung (Hermes: nur der beste voll).
  const byThread = new Map<number, MsgRow>();
  for (const h of hits) if (!byThread.has(h.thread_id)) byThread.set(h.thread_id, h);
  const top = [...byThread.values()].slice(0, limit);
  const words = q.split(/\s+/).filter(Boolean);
  const best = top[0] as MsgRow;
  const umgebung = await windowAround(db, best.thread_id, best.id, 3);
  return {
    form: "suche",
    suche: q,
    art: mode,
    gesamt: byThread.size,
    faeden: top.map((h, i) => ({
      faden_id: h.thread_id,
      titel: h.title,
      automatisch: h.topic.startsWith(AUTO_TOPIC_PREFIX),
      treffer: { nachricht_id: h.id, von: h.role === "user" ? "Nutzer" : "Nyx", zeit: localStamp(iso(h.created_at)), ausschnitt: snippet(h.text, words) },
      ...(i === 0 ? { umgebung } : {}),
    })),
  };
}
