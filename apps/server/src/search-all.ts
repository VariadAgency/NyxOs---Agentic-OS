// `GET /api/search/all?q=` — ⌘K sucht alles. Eine Abfrage je Art, alle gleichzeitig, je Art
// höchstens SEARCH_ALL_PER_KIND Treffer. Sessions laufen über die vorhandene Volltext-Suche
// (`search.ts`, vorverdaut in `search_docs`); die übrigen Arten sind klein (Hunderte Zeilen) und
// werden direkt gesucht:
// - **Deutsche Volltextsuche, wo es geht:** besteht die Eingabe nur aus Buchstaben, Ziffern, Leerraum,
//   Bindestrich und Punkt, trifft zusätzlich `to_tsvector('german', …)` mit Präfix auf dem letzten Wort
//   (dieselbe Konstruktion wie in `search.ts`) — „Stimmen“ findet so auch „Stimme“.
// - **Sonst nur wörtlich (ILIKE):** Eingaben mit `% _ ' \` & Co. sucht die Palette genau so, wie sie
//   dastehen — `%`/`_`/`\` werden für LIKE escaped, alles läuft als gebundener Parameter.
// Der Text einer GOAL.md (Spiegel `docs`) zählt für ihren Auftrag mit, nur wörtlich (Dateien sind groß).
import {
  SEARCH_ALL_KINDS,
  SEARCH_ALL_LABEL,
  SEARCH_ALL_PER_KIND,
  SEARCH_MIN_QUERY_LENGTH,
  NYX_MEMORY_CATEGORY_LABELS,
  t,
  type NyxMemoryCategory,
  type SearchAllGroup,
  type SearchAllHit,
  type SearchAllKind,
  type SearchAllResponse,
} from "@nyxos/shared";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { search } from "./search.js";

/** Länge eines Ausschnitts (Zeichen). */
const SNIPPET_LEN = 160;
/** So viele Zeichen vor dem Treffer bleiben im Ausschnitt stehen. */
const SNIPPET_LEAD = 50;
/** Die Sessions-Suche liefert Treffer je Feld — etwas mehr holen, damit nach dem Zusammenfassen je Session 5 bleiben. */
const SESSION_RAW_LIMIT = 25;
/** Wie in `search.ts`: letztes Lexem einer `websearch_to_tsquery(...)::text`-Ausgabe → Präfix. */
const LAST_LEXEME_RE = "('(?:[^']|'')*')$";
const LAST_LEXEME_PREFIX_REPLACEMENT = "\\1:*";
/** Nur solche Eingaben gehen zusätzlich durch die Volltextsuche (sonst rein wörtlich). */
const FTS_SAFE_RE = /^[\p{L}\p{N}\s.-]+$/u;
const BAUSTELLE_NONE = "_";

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Ausschnitt um die erste wörtliche Fundstelle (sonst der Anfang), Leerraum zusammengezogen. */
export function snippetAround(text: string, q: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_LEN) return flat;
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  const start = at > SNIPPET_LEAD ? at - SNIPPET_LEAD : 0;
  const cut = flat.slice(start, start + SNIPPET_LEN).trim();
  return `${start > 0 ? "…" : ""}${cut}${start + SNIPPET_LEN < flat.length ? "…" : ""}`;
}

/** Snippet der Sessions-Suche ist HTML mit `<mark>` — hier zurück in reinen Text. */
function plainFromHtml(html: string): string {
  return html
    .replace(/<\/?mark>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

interface Query {
  q: string;
  pattern: string;
  /** `null` = nur wörtlich suchen. */
  tsq: SQL | null;
}

function buildQuery(q: string): Query {
  const tsq = FTS_SAFE_RE.test(q)
    ? sql`to_tsquery('simple', regexp_replace(websearch_to_tsquery('german', ${q.replace(/-/g, " ")})::text, ${LAST_LEXEME_RE}, ${LAST_LEXEME_PREFIX_REPLACEMENT}))`
    : null;
  return { q, pattern: `%${escapeLike(q)}%`, tsq };
}

/** Treffer-Bedingung über einen Text-Ausdruck (wörtlich ODER deutsch). */
function matches(query: Query, text: SQL): SQL {
  const like = sql`${text} ilike ${query.pattern} escape '\\'`;
  return query.tsq ? sql`(${like} or to_tsvector('german', ${text}) @@ ${query.tsq})` : like;
}

/** Rang: wörtlicher Titel-Treffer vor Volltext-Rang. */
function rank(query: Query, title: SQL, text: SQL): SQL {
  const titleHit = sql`(case when ${title} ilike ${query.pattern} escape '\\' then 1 else 0 end)`;
  return query.tsq ? sql`${titleHit} + ts_rank(to_tsvector('german', ${text}), ${query.tsq})` : titleHit;
}

async function searchSessions(db: Db, q: string): Promise<SearchAllHit[]> {
  const { hits } = await search(db, q, SESSION_RAW_LIMIT);
  const seen = new Set<string>();
  const out: SearchAllHit[] = [];
  for (const h of hits) {
    if (seen.has(h.sessionKey)) continue;
    seen.add(h.sessionKey);
    const base = `/sessions/${encodeURIComponent(h.art)}/${encodeURIComponent(h.baustelle?.slug ?? BAUSTELLE_NONE)}/${encodeURIComponent(h.sessionId)}`;
    out.push({
      kind: "session",
      title: h.title ?? h.sessionId,
      snippet: snippetAround(plainFromHtml(h.snippet), q),
      path: h.position !== null ? `${base}?at=${h.position}` : base,
    });
    if (out.length >= SEARCH_ALL_PER_KIND) break;
  }
  return out;
}

interface EntryRow {
  id: number;
  kind: string;
  title: string;
  description: string | null;
  source_type: string | null;
  source_id: string | null;
  doc: string | null;
}

/** Ideen, Aufträge/Aufgaben und Audits aus `entries` — eine Abfrage je Gruppe (je Gruppe eigene Grenze). */
async function searchEntries(db: Db, query: Query, group: "idee" | "auftrag" | "audit"): Promise<SearchAllHit[]> {
  const kindFilter = group === "idee" ? sql`e.kind = 'idee'` : group === "audit" ? sql`e.kind = 'audit'` : sql`e.kind not in ('idee', 'audit')`;
  const text = sql`(e.title || ' ' || coalesce(e.description, ''))`;
  // GOAL.md-Text nur für Aufträge aus Dateien, nur wörtlich.
  const docHit = sql`(e.source_type = 'goal' and d.content ilike ${query.pattern} escape '\\')`;
  const result = await db.execute(sql`
    select e.id, e.kind, e.title, e.description, e.source_type, e.source_id,
      case when ${docHit} and not (${text} ilike ${query.pattern} escape '\\') then d.content else null end as doc
    from entries e
    left join docs d on e.source_type = 'goal' and d.path = e.source_id
    where ${kindFilter} and (${matches(query, text)} or ${docHit})
    order by ${rank(query, sql`e.title`, text)} desc, e.source_removed_at is not null, e.updated_at desc, e.id desc
    limit ${SEARCH_ALL_PER_KIND}
  `);
  return rowsOf<EntryRow>(result).map((r) => {
    const snippet = snippetAround(r.doc ?? r.description ?? "", query.q);
    let path: string;
    if (group === "audit") path = `/audits?e=${r.id}`;
    else path = `/tasks?e=${r.id}`;
    return { kind: group, title: r.title, snippet, path };
  });
}

async function searchSkills(db: Db, query: Query): Promise<SearchAllHit[]> {
  const text = sql`(s.key || ' ' || s.name || ' ' || coalesce(s.description, ''))`;
  const result = await db.execute(sql`
    select s.key, s.name, s.description from skills s
    where s.missing_since is null and ${matches(query, text)}
    order by ${rank(query, sql`(s.key || ' ' || s.name)`, text)} desc, s.pinned desc, s.key
    limit ${SEARCH_ALL_PER_KIND}
  `);
  return rowsOf<{ key: string; name: string; description: string | null }>(result).map((r) => ({
    kind: "skill",
    title: r.name,
    snippet: snippetAround(r.description ?? "", query.q),
    path: `/skills/${encodeURIComponent(r.key)}`,
  }));
}

async function searchMemory(db: Db, query: Query): Promise<SearchAllHit[]> {
  const text = sql`m.fact`;
  const result = await db.execute(sql`
    select m.category, m.fact from nyx_memory m
    where ${matches(query, text)}
    order by ${rank(query, text, text)} desc, m.updated_at desc, m.id desc
    limit ${SEARCH_ALL_PER_KIND}
  `);
  return rowsOf<{ category: string; fact: string }>(result).map((r) => ({
    kind: "gedaechtnis",
    title: t(NYX_MEMORY_CATEGORY_LABELS[r.category as NyxMemoryCategory] ?? "Gedächtnis"),
    snippet: snippetAround(r.fact, query.q),
    path: "/nyx?r=gedaechtnis",
  }));
}

async function searchAgents(db: Db, query: Query): Promise<SearchAllHit[]> {
  const text = sql`(a.name || ' ' || coalesce(a.description, ''))`;
  // Derselbe Agent kann von mehreren Maschinen/Quellen gemeldet sein — je Name nur einmal.
  const result = await db.execute(sql`
    select distinct on (a.name) a.name, a.description, ${rank(query, sql`a.name`, text)} as rk from agent_catalog a
    where a.kind = 'agent' and ${matches(query, text)}
    order by a.name, a.seen_at desc
  `);
  return rowsOf<{ name: string; description: string | null; rk: number }>(result)
    .sort((a, b) => Number(b.rk) - Number(a.rk) || a.name.localeCompare(b.name))
    .slice(0, SEARCH_ALL_PER_KIND)
    .map((r) => ({
      kind: "agent",
      title: r.name,
      snippet: snippetAround(r.description ?? "", query.q),
      path: `/agents?agent=${encodeURIComponent(r.name)}`,
    }));
}

/** Kern von `GET /api/search/all`. `q` (getrimmt) unter {@link SEARCH_MIN_QUERY_LENGTH} → leer ohne DB-Zugriff. */
export async function searchAll(db: Db, qRaw: string): Promise<SearchAllResponse> {
  const t0 = performance.now();
  const q = qRaw.trim();
  if (q.length < SEARCH_MIN_QUERY_LENGTH) return { q, groups: [], tookMs: Math.round(performance.now() - t0) };
  const query = buildQuery(q);
  const [session, idee, auftrag, audit, skill, gedaechtnis, agent] = await Promise.all([
    searchSessions(db, q),
    searchEntries(db, query, "idee"),
    searchEntries(db, query, "auftrag"),
    searchEntries(db, query, "audit"),
    searchSkills(db, query),
    searchMemory(db, query),
    searchAgents(db, query),
  ]);
  const byKind: Record<SearchAllKind, SearchAllHit[]> = { session, idee, auftrag, audit, skill, gedaechtnis, agent };
  const groups: SearchAllGroup[] = SEARCH_ALL_KINDS.filter((k) => byKind[k].length > 0).map((k) => ({ kind: k, label: SEARCH_ALL_LABEL[k], hits: byKind[k] }));
  return { q, groups, tookMs: Math.round(performance.now() - t0) };
}
