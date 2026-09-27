// Volltext-Suche: Titel, erster Prompt, Dateipfade und Chat-Text aller Sessions (auch
// geschlossener), nach einem festen API-Vertrag. Speichert Treffer vorverdaut in
// `search_docs` (db/schema.ts) statt bei jeder Suche neu zu parsen — s. Kommentar dort für die
// Spalten-Entscheidung (zwei tsvector-Spalten, Pfad-Zerlegung statt `pg_trgm`).
//
// Entwurfsentscheidungen:
// - **Deutscher Wortstamm UND Präfix zugleich, ohne Doppel-Stemming.** `websearch_to_tsquery`
//   parst die Nutzereingabe sicher (kein tsquery-Syntaxfehler bei `&`, `(`, `<script>` &c.) und
//   stemmt einmal korrekt. Für die Präfixsuche des letzten Worts (Tippen in ⌘K) wird an dessen
//   Text-Darstellung `:*` angehängt und über `to_tsquery('simple', …)` neu geparst — bewusst mit
//   der Konfiguration `simple`, NICHT noch einmal `german`: ein zweiter Lauf durch den deutschen
//   Stemmer würde ein bereits gestemmtes Wort ("sortier") ein zweites Mal verkürzen ("sorti") und
//   böte damit zufälligen kurzen Wörtern eine Trefferchance. Geprüft: eine Suche nach
//   "Sortierung" (Nomen, stemmt zu "sortier") findet damit korrekt Text mit "sortiert"/"sortierte"
//   (Verbformen, stemmen NICHT zu "sortier", s. Bericht) — die Präfixbeziehung "sortiert" beginnt
//   mit "sortier" trägt das, ohne unverwandte Wörter wie "sortenrein" mitzutreffen.
// - **Kein `HtmlEscape` bei `ts_headline`** — das gibt es in Postgres nicht (nur `MaxWords`,
//   `MinWords`, `MaxFragments`, `StartSel`, `StopSel`, `HighlightAll`, `FragmentDelimiter`).
//   `ts_headline` bekommt private Markierungen (U+0001/U+0002) als Start/Stop; der gesamte
//   zurückgegebene Text wird IMMER escaped (auch wörtliches `<script>` im Chat), erst danach
//   werden die Markierungen zu echten `<mark>`/`</mark>` — das sind die einzigen echten
//   HTML-Tags im Snippet.
import { and, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_QUERY_LENGTH,
  type SearchField,
  type SearchHit,
  type SearchResponse,
  type Tool,
} from "@nyxos/shared";
import type { Db } from "./db/client.js";
import { searchDocs, sessionEvents, sessionFiles, sessions } from "./db/schema.js";
import { loadMainTranscriptItems, type TranscriptCache } from "./transcript.js";

/** Eine offene Transaktion (Drizzle-Callback-Parameter von `Db["transaction"]`). */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Ausführbarer DB-Zugriff — entweder die Verbindung selbst oder eine offene Transaktion (`store.ts`). */
type Executor = Db | Tx;

/**
 *: Advisory-Lock je Session, gültig bis zum Ende der Transaktion —
 * verhindert Dubletten, wenn ein zweiter Ingest/Archiv-Upload/`reindex-search` für DIESELBE Session
 * gleichzeitig läuft (sonst könnten zwei Transaktionen denselben Bestand lesen und beide dieselben
 * Zeilen einfügen). Braucht zwingend eine schon offene Transaktion — sonst wäre der Lock sofort
 * wieder frei und nutzlos, deshalb nimmt diese Funktion bewusst nur `Tx`, nie die rohe Verbindung.
 * `hashtextextended(text, seed)` liefert den `bigint`, den `pg_advisory_xact_lock(bigint)` erwartet.
 */
async function lockSessionForIndexing(tx: Tx, sessionKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sessionKey}, 0))`);
}

/** Lange Chat-Nachrichten werden in Abschnitte dieser Länge geteilt (gleiche `position`, s. Auftrag). */
export const SEARCH_CHAT_CHUNK_SIZE = 2000;
/** Höchstens so viele Chat-Treffer je Session. */
export const SEARCH_MAX_CHAT_HITS_PER_SESSION = 3;

// ---------------------------------------------------------------------------------------------
// Titel / erster Prompt / Dateipfade — bei jedem Ingest für berührte Sessions, ersetzt statt angehängt.
// ---------------------------------------------------------------------------------------------

function extractPromptText(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.text === "string" && d.text.trim()) return d.text;
  if (typeof d.command === "string" && d.command.trim()) return `${d.command} ${typeof d.args === "string" ? d.args : ""}`.trim();
  return null;
}

/** `to_tsvector`-Ausdrücke für eine Zeile — `simple` bekommt bei `field = "file"` zusätzlich die
 * in Ordner-Segmente zerlegten Pfadteile (nur an `/` getrennt, s. Kommentar an `search_docs` in
 * db/schema.ts). Bewusst NICHT zusätzlich an `.`/`_`/`-` getrennt: Postgres' Text-Parser hält ein
 * einzelnes Segment wie `categorize.ts` ohnehin als EIN Lexem zusammen (wie eine Such-Eingabe
 * `categorize.ts` auch als ein Lexem geparst wird, s. Bericht) — eine zusätzliche Trennung an `.`
 * würde genau dieses Lexem zerstören und exakte Dateinamen-Treffer verhindern; die Präfixsuche
 * (`categ` findet `categorize.ts`) funktioniert unabhängig davon über den gemeinsamen Anfang. */
function docValues(sessionKey: string, field: SearchField, position: number | null, text: string) {
  const tsvSimple: SQL =
    field === "file"
      ? sql`to_tsvector('simple', ${text} || ' ' || replace(${text}, '/', ' '))`
      : sql`to_tsvector('simple', ${text})`;
  return {
    sessionKey,
    field,
    position,
    text,
    tsvGerman: sql`to_tsvector('german', ${text})` as unknown as string,
    tsvSimple: tsvSimple as unknown as string,
  };
}

async function insertDocs(db: Executor, rows: ReturnType<typeof docValues>[]): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) await db.insert(searchDocs).values(rows.slice(i, i + CHUNK));
}

/**
 * Titel/Prompt: ersetzen (löschen, dann einfügen) — höchstens zwei Zeilen, ein "ersetzen statt
 * anhängen" ist hier billiger als eine Inkrement-Logik. Datei-Dokumente:
 * NICHT mehr bei jedem Aufruf alle neu schreiben — `session_files` kann bei großen Sessions viele
 * Einträge haben, und die drei Felder wurden vorher bei JEDEM Hook komplett gelöscht+neu eingefügt.
 * Stattdessen nur die Pfade einfügen, die noch KEIN Dokument haben (Diff gegen den vorhandenen
 * Bestand) — unverändertes bleibt liegen. Läuft unter dem Advisory-Lock der aufrufenden Funktion.
 */
async function indexSessionMetaDocsCore(db: Executor, sessionKey: string): Promise<void> {
  const [session] = await db.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, sessionKey)).limit(1);
  if (!session) return;

  const [firstPromptRow] = await db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionKey, sessionKey), eq(sessionEvents.kind, "prompt")))
    .orderBy(sessionEvents.ts)
    .limit(1);
  const firstPrompt = firstPromptRow ? extractPromptText(firstPromptRow.data) : null;

  await db.delete(searchDocs).where(and(eq(searchDocs.sessionKey, sessionKey), inArray(searchDocs.field, ["title", "prompt"])));
  const metaRows: ReturnType<typeof docValues>[] = [];
  if (session.title?.trim()) metaRows.push(docValues(sessionKey, "title", null, session.title));
  if (firstPrompt?.trim()) metaRows.push(docValues(sessionKey, "prompt", null, firstPrompt.slice(0, SEARCH_CHAT_CHUNK_SIZE)));
  await insertDocs(db, metaRows);

  const files = await db.select({ path: sessionFiles.path }).from(sessionFiles).where(eq(sessionFiles.sessionKey, sessionKey));
  const paths = new Set(files.map((f) => f.path)); // session_files hat write/read als getrennte Zeilen für denselben Pfad
  if (paths.size === 0) return;

  const existingFileDocs = await db
    .select({ text: searchDocs.text })
    .from(searchDocs)
    .where(and(eq(searchDocs.sessionKey, sessionKey), eq(searchDocs.field, "file")));
  const known = new Set(existingFileDocs.map((r) => r.text));
  const newPaths = [...paths].filter((p) => !known.has(p));
  if (newPaths.length === 0) return;
  await insertDocs(db, newPaths.map((p) => docValues(sessionKey, "file", null, p)));
}

/** Für einen schon offenen Ingest (`store.ts`, `ingest()`) — Lock + Indizierung in derselben Transaktion. */
export async function indexSessionMetaDocsTx(tx: Tx, sessionKey: string): Promise<void> {
  await lockSessionForIndexing(tx, sessionKey);
  await indexSessionMetaDocsCore(tx, sessionKey);
}

/**
 * `ingest()` (`store.ts`) sperrt mehrere Sessions NACHEINANDER in EINER
 * Transaktion (eine je berührter Session) — in der Reihenfolge, in der sie im Batch vorkommen. Zwei
 * gleichzeitige Ingests, die dieselben zwei Sessions in VERTAUSCHTER Reihenfolge berühren (Ingest A:
 * [S1, S2], Ingest B: [S2, S1]), können sich sonst gegenseitig sperren: A hält S1 und wartet auf S2,
 * B hält S2 und wartet auf S1 — klassischer Deadlock (Postgres bricht danach eine der beiden
 * Transaktionen zwangsweise ab). Fix: Schlüssel vor dem Sperren IMMER in derselben (hier: lexikalischen)
 * Reihenfolge anfassen — dann kann diese Verschränkung nicht mehr entstehen (beide Transaktionen
 * würden in derselben Reihenfolge auf denselben ersten, noch freien Schlüssel warten, nie über Kreuz).
 */
export function sortSessionKeysForLocking(sessionKeys: Iterable<string>): string[] {
  return [...new Set(sessionKeys)].sort();
}

export async function indexSessionsMetaDocsTx(tx: Tx, sessionKeys: Iterable<string>): Promise<void> {
  for (const key of sortSessionKeysForLocking(sessionKeys)) await indexSessionMetaDocsTx(tx, key);
}

/** Für Aufrufer ohne schon offene Transaktion (CLI `reindex-search`) — öffnet selbst eine. */
export async function indexSessionMetaDocs(db: Db, sessionKey: string): Promise<void> {
  await db.transaction((tx) => indexSessionMetaDocsTx(tx, sessionKey));
}

// ---------------------------------------------------------------------------------------------
// Chat-Text — bei jedem Archiv-Upload der Hauptdatei, inkrementell (Position ≥ bisheriges Maximum).
// ---------------------------------------------------------------------------------------------

function chunkText(text: string, max = SEARCH_CHAT_CHUNK_SIZE): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}

/**
 * Indiziert den Chat-Text (nur user/assistant, kein Werkzeug, kein Denken) des Hauptverlaufs einer
 * Session neu. `position` = Index im Verlauf, wie `transcript.ts` ihn zählt (geteilte Funktion,
 * `loadMainTranscriptItems`). Bei einer neuen Archiv-Fassung werden nur Einträge ab der zuletzt
 * gespeicherten Position neu geschrieben (Löschen + Einfügen ab dort) — das deckt auch den Fall ab,
 * dass die zuletzt erfasste Nachricht beim vorigen Hochladen noch nicht vollständig war, ohne den
 * ganzen Verlauf neu einzufügen. Gibt die Anzahl neu geschriebener Dokument-Zeilen zurück.
 *
 *: Lesen (letzte Position) + Löschen + Einfügen läuft jetzt in EINER
 * Transaktion mit Advisory-Lock je Session (`lockSessionForIndexing`) — zwei gleichzeitige Archiv-
 * Uploads/`reindex-search` derselben Session lesen sonst denselben `previousMax` und erzeugen
 * Dubletten (bzw. verlieren Zeilen, wenn dazwischen ein Fehler auftritt). Ein Fehler hier rollt die
 * ganze Transaktion zurück — der vorherige Stand bleibt unangetastet, ein späterer Versuch (nächster
 * Upload/`reindex-search`) holt die Indizierung einfach nach (s. `app.ts`, das diesen Aufruf NICHT
 * mehr scheitern lässt). `loadMainTranscriptItems` liest bewusst VOR der Transaktion (unveränderliche,
 * schon archivierte Datei — keine Sperre nötig, kein Eingriff an `transcript.ts` nötig).
 */
export async function indexChatDocs(db: Db, cache: TranscriptCache, sessionKey: string): Promise<number> {
  const main = await loadMainTranscriptItems(db, cache, sessionKey);
  if (!main) return 0;
  const { items } = main;

  return db.transaction(async (tx) => {
    await lockSessionForIndexing(tx, sessionKey);

    const [maxRow] = await tx
      .select({ max: sql<number | null>`max(${searchDocs.position})` })
      .from(searchDocs)
      .where(and(eq(searchDocs.sessionKey, sessionKey), eq(searchDocs.field, "chat")));
    const previousMax = maxRow?.max ?? null;
    const startIdx = previousMax ?? 0;

    if (previousMax !== null) {
      await tx.delete(searchDocs).where(and(eq(searchDocs.sessionKey, sessionKey), eq(searchDocs.field, "chat"), gte(searchDocs.position, previousMax)));
    }

    const rows: ReturnType<typeof docValues>[] = [];
    for (let i = startIdx; i < items.length; i++) {
      const item = items[i];
      if (!item || (item.role !== "user" && item.role !== "assistant")) continue;
      const text = item.text?.trim();
      if (!text) continue;
      for (const chunk of chunkText(text)) rows.push(docValues(sessionKey, "chat", i, chunk));
    }
    await insertDocs(tx, rows);
    return rows.length;
  });
}

// ---------------------------------------------------------------------------------------------
// CLI `reindex-search`: alles aus DB + Archiv neu aufbauen (idempotent).
// ---------------------------------------------------------------------------------------------

export interface ReindexOutcome {
  /** Anzahl geschriebener Dokument-Zeilen je Feld. */
  byField: Record<SearchField, number>;
}

/** Baut den gesamten Index aus DB (Titel/Prompt/Dateien) + Archiv (Chat) neu auf. Idempotent: löscht
 * vorher alles in `search_docs`, danach steht exakt der Bestand aus dem aktuellen Datenstand da. */
export async function reindexSearch(db: Db, cache: TranscriptCache): Promise<ReindexOutcome> {
  await db.delete(searchDocs);
  const byField: Record<SearchField, number> = { title: 0, prompt: 0, file: 0, chat: 0 };

  const allSessions = await db.select({ id: sessions.id }).from(sessions);
  for (const s of allSessions) {
    await indexSessionMetaDocs(db, s.id);
    await indexChatDocs(db, cache, s.id);
  }

  const counts = await db.select({ field: searchDocs.field, n: sql<number>`count(*)::int` }).from(searchDocs).groupBy(searchDocs.field);
  for (const row of counts) byField[row.field as SearchField] = row.n;
  return { byField };
}

// ---------------------------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------------------------

/** Grenze an das letzte Lexem einer `websearch_to_tsquery(...)::text`-Ausgabe (für die Präfixsuche). */
const LAST_LEXEME_RE = "('(?:[^']|'')*')$";
/** Ersetzungs-Ausdruck für `regexp_replace`: hängt `:*` ans zurückverwiesene letzte Lexem (Gruppe 1).
 * Als gebundener Parameter statt wörtlich im SQL-Text, damit die Rückverweis-Schreibweise `\1` nie
 * durch die JS-Template-String-Auswertung laufen muss (dort wäre `\1` ein veralteter, im Strict-Mode
 * verbotener Oktal-Escape — als eigene, normal escapte JS-String-Konstante ist es eindeutig). */
const LAST_LEXEME_PREFIX_REPLACEMENT = "\\1:*";
const MARK_START = "\u0001";
const MARK_STOP = "\u0002";
const HEADLINE_OPTIONS = `StartSel=${MARK_START}, StopSel=${MARK_STOP}, MaxFragments=1, MaxWords=35, MinWords=5`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Wandelt die privaten Markierungen aus `ts_headline` in echte `<mark>`-Tags — erst NACH dem
 * HTML-Escapen des gesamten Textes, damit Roh-HTML im Chat (auch `<script>`) sicher escaped bleibt. */
function markify(headline: string): string {
  return escapeHtml(headline).split(MARK_START).join("<mark>").split(MARK_STOP).join("</mark>");
}

interface SearchRow {
  session_key: string;
  field: string;
  position: number | null;
  headline: string | null;
  text: string;
  tool: string;
  session_id: string;
  title: string | null;
  art: string | null;
  baustelle_slug: string | null;
  baustelle_label: string | null;
  state: string | null;
  closed: boolean;
}

/** `db.execute(sql\`…\`)` liefert je nach Treiber unterschiedlich: postgres-js (Produktion) gibt die
 * Zeilen als Array direkt zurück, PGlite (Tests) wickelt sie in `{ rows: [...] }` — beide Formen
 * normalisieren, statt eine Treiber-Verzweigung zu pflegen. */
function rowsOf(result: unknown): SearchRow[] {
  if (Array.isArray(result)) return result as SearchRow[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: SearchRow[] }).rows;
  return [];
}

/**
 * `GET /api/search`. `q` unter {@link SEARCH_MIN_QUERY_LENGTH} Zeichen (nach Trim) liefert
 * eine leere Liste ohne Datenbank-Zugriff. Ranking: Titel > Prompt > Datei > Chat, dann `ts_rank`,
 * dann jüngere Session. Höchstens {@link SEARCH_MAX_CHAT_HITS_PER_SESSION} Chat-Treffer je Session.
 */
export async function search(db: Db, qRaw: string, limitRaw: number): Promise<SearchResponse> {
  const t0 = performance.now();
  const q = qRaw.trim();
  const limit = Math.min(Math.max(Math.trunc(Number.isFinite(limitRaw) ? limitRaw : SEARCH_DEFAULT_LIMIT) || SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
  if (q.length < SEARCH_MIN_QUERY_LENGTH) return { hits: [], tookMs: Math.round(performance.now() - t0) };

  const result = await db.execute(sql`
    with q as (
      select
        to_tsquery('simple', regexp_replace(websearch_to_tsquery('german', ${q})::text, ${LAST_LEXEME_RE}, ${LAST_LEXEME_PREFIX_REPLACEMENT})) as tsq_german,
        to_tsquery('simple', regexp_replace(websearch_to_tsquery('simple', ${q})::text, ${LAST_LEXEME_RE}, ${LAST_LEXEME_PREFIX_REPLACEMENT})) as tsq_simple
    ),
    matched as (
      select
        sd.id as id,
        sd.session_key as session_key,
        sd.field as field,
        sd.position as position,
        sd.text as text,
        (sd.tsv_german @@ q.tsq_german) as matched_german,
        greatest(ts_rank(sd.tsv_german, q.tsq_german), ts_rank(sd.tsv_simple, q.tsq_simple)) as rank
      from search_docs sd, q
      where sd.tsv_german @@ q.tsq_german or sd.tsv_simple @@ q.tsq_simple
    ),
    ranked as (
      select
        m.*,
        s.tool as tool,
        s.session_id as session_id,
        s.title as title,
        s.category_art as art,
        s.category_baustelle_slug as baustelle_slug,
        s.category_baustelle_label as baustelle_label,
        s.state as state,
        (s.closed_at is not null) as closed,
        coalesce(s.last_activity_at, s.started_at) as recency,
        row_number() over (partition by m.session_key, m.field order by m.rank desc, m.id) as field_rn
      from matched m
      join sessions s on s.id = m.session_key and s.archived_at is null
    )
    select
      r.session_key, r.field, r.position, r.text, r.tool, r.session_id, r.title, r.art, r.baustelle_slug, r.baustelle_label, r.state, r.closed,
      ts_headline(
        (case when r.matched_german then 'german' else 'simple' end)::regconfig,
        r.text,
        (case when r.matched_german then q.tsq_german else q.tsq_simple end),
        ${HEADLINE_OPTIONS}
      ) as headline
    from ranked r, q
    where r.field <> 'chat' or r.field_rn <= ${SEARCH_MAX_CHAT_HITS_PER_SESSION}
    order by
      case r.field when 'title' then 0 when 'prompt' then 1 when 'file' then 2 else 3 end,
      r.rank desc,
      r.recency desc nulls last,
      r.session_key,
      r.position nulls first
    limit ${limit}
  `);

  const hits: SearchHit[] = rowsOf(result).map((row) => ({
    sessionKey: row.session_key,
    sessionId: row.session_id,
    tool: row.tool as Tool,
    title: row.title,
    art: row.art ?? "unsortiert",
    baustelle: row.baustelle_slug ? { slug: row.baustelle_slug, label: row.baustelle_label ?? row.baustelle_slug } : null,
    state: row.state,
    closed: row.closed,
    field: row.field as SearchField,
    snippet: markify(row.headline ?? row.text),
    position: row.field === "chat" ? row.position : null,
  }));

  return { hits, tookMs: Math.round(performance.now() - t0) };
}
