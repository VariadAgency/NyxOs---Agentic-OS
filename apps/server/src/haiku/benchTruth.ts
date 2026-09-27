// Schritt 3 (Haiku-Prüfstand): die richtigen Antworten auf die Prüfstand-Fragen, direkt per SQL aus
// derselben DB, im selben Moment gerechnet. Bewusst EIGENE Abfragen (nicht Haikus Werkzeuge und nicht
// deren Hilfsfunktionen) — sonst prüfte der Prüfstand Haiku gegen denselben Fehler, den er finden soll.
// Einzige Ausnahme: „offene Build-Fehler“ kommt aus dem Überblick-Schnappschuss, weil genau DAS die Zahl
// ist, die der Nutzer im Überblick sieht (Bündelung + „behoben“-Regel sind dort definiert, nicht in SQL).
// Nur lesend. `scripts/haiku-bench.mjs` holt das über `GET /api/haiku/bench/truth`.
import { ORPHANED_AFTER_MS, timeZone } from "@nyxos/shared";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { takeSnapshot } from "../overview/snapshot.js";

export type TruthKind = "number" | "text" | "yesno";

export interface BenchTruth {
  id: string;
  question: string;
  kind: TruthKind;
  /** Zahl (number), true/false (yesno) oder die bevorzugte Nennung (text). `null` = es gibt keine (z. B. keine Codex-Session). */
  answer: number | boolean | string | null;
  /** Nur bei text: jede dieser Nennungen zählt als Treffer (Titel, Kurz-ID, Gleichstand). */
  accept: string[];
  /** Woher die Wahrheit kommt, in einem Satz (für ERGEBNIS.md). */
  source: string;
}

type Row = Record<string, unknown>;

async function rows(db: Db, q: SQL): Promise<Row[]> {
  const r = await db.execute(q);
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[];
}

async function num(db: Db, q: SQL): Promise<number> {
  const [r] = await rows(db, q);
  return Number(r?.n ?? 0);
}

/** Titel wie in der Oberfläche: Titel, sonst die ersten 8 Zeichen der Session-ID. */
function sessionNames(r: Row | undefined): string[] {
  if (!r) return [];
  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : null;
  const sid = String(r.session_id ?? "").slice(0, 8);
  return [...(title ? [title] : []), ...(sid ? [sid] : [])];
}

/** Top-Gruppe(n) mit Gleichstand: alle Namen mit der höchsten Zahl. */
function topGroup(list: Row[]): { names: string[]; n: number } {
  const n = Number(list[0]?.n ?? 0);
  return { names: list.filter((r) => Number(r.n) === n && r.name != null).map((r) => String(r.name)), n };
}

const MAIN = sql.raw("parent_id is null");
const OPEN = sql.raw("parent_id is null and closed_at is null");

export async function computeBenchTruth(db: Db, now = new Date()): Promise<{ at: string; truths: BenchTruth[] }> {
  const today = sql`(date_trunc('day', (${now.toISOString()}::timestamptz) at time zone ${timeZone()}) at time zone ${timeZone()})`;
  const state = (s: string) => num(db, sql`select count(*)::int as n from sessions where ${OPEN} and state = ${s}`);
  const t: BenchTruth[] = [];
  const add = (id: string, question: string, kind: TruthKind, answer: BenchTruth["answer"], source: string, accept: string[] = []) => t.push({ id, question, kind, answer, accept, source });

  // dieselbe Regel wie `isOrphanedSession` (shared) – verwaiste Geister zählen nicht als „wartet“.
  const waiting = await num(
    db,
    sql`select count(*)::int as n from sessions where ${OPEN} and state = 'waiting'
      and not coalesce(parsed_event_count = 0 and tokens_total = 0 and nullif(btrim(coalesce(title, '')), '') is null
        and coalesce(last_activity_at, started_at) < (${now.toISOString()}::timestamptz - make_interval(secs => ${ORPHANED_AFTER_MS / 1000})), false)`,
  );
  const running = await state("running");
  const crashed = await state("crashed");
  add("q01", "Wie viele Sessions warten gerade auf mich?", "number", waiting, "sessions: Zustand „wartet“, nicht geschlossen, ohne Sub-Agenten");
  add("q02", "Wie viele Sessions laufen gerade?", "number", running, "sessions: Zustand „läuft“, nicht geschlossen");
  add("q03", "Wie viele Sessions sind gerade abgestürzt?", "number", crashed, "sessions: Zustand „abgestürzt“, nicht geschlossen");
  add(
    "q04",
    "Wie viele Sessions sind gerade offen, also laufen, warten, ruhen oder sind abgestürzt?",
    "number",
    await num(db, sql`select count(*)::int as n from sessions where ${OPEN} and state in ('running','waiting','idle','crashed')`),
    "sessions: vier offene Zustände, nicht geschlossen",
  );
  add("q05", "Wie viele Codex-Sessions kennt die NyxOS insgesamt?", "number", await num(db, sql`select count(*)::int as n from sessions where ${MAIN} and tool = 'codex'`), "sessions: Werkzeug codex, ohne Sub-Agenten");
  add("q06", "Wie viele Claude-Sessions kennt die NyxOS insgesamt?", "number", await num(db, sql`select count(*)::int as n from sessions where ${MAIN} and tool = 'claude'`), "sessions: Werkzeug claude, ohne Sub-Agenten");
  add("q07", "Wie viele Sessions waren heute aktiv?", "number", await num(db, sql`select count(*)::int as n from sessions where ${MAIN} and last_activity_at >= ${today}`), "sessions: letzte Aktivität seit heute 0 Uhr (Zeitzone des Nutzers)");
  add("q08", "Wie viele Codex-Sessions waren heute aktiv?", "number", await num(db, sql`select count(*)::int as n from sessions where ${MAIN} and tool = 'codex' and last_activity_at >= ${today}`), "sessions: codex, letzte Aktivität seit heute 0 Uhr");
  // Freigabe-Karten aus `freigabe_anfragen` sind auch offene Freigaben (wie `lage`/`freigaben_liste`).
  add(
    "q09",
    "Wie viele Freigabe-Anfragen sind gerade offen?",
    "number",
    await num(db, sql`select ((select count(*) from approvals where status = 'pending') + (select count(*) from inbox_items where status = 'open' and fingerprint like 'freigabe:%'))::int as n`),
    "approvals: Status pending + Freigabe-Karten in der Inbox (freigabe:…, offen)",
  );
  add("q10", "Wie viele Punkte liegen offen in der Entscheidungs-Inbox?", "number", await num(db, sql`select count(*)::int as n from inbox_items where status = 'open'`), "inbox_items: Status open");
  add("q11", "Wie viele Aufgaben sind startklar?", "number", await num(db, sql`select count(*)::int as n from entries where stage = 'startklar'`), "entries: Stufe startklar");
  const snap = await takeSnapshot(db, now);
  add("q12", "Wie viele Build-Fehler sind gerade offen?", "number", snap.redBuilds.length, "Überblick-Schnappschuss: rote Build-Gruppen der letzten 24 Std");
  add("q13", "Wie viele Ideen gibt es in der Ablage?", "number", await num(db, sql`select count(*)::int as n from entries where kind = 'idee'`), "entries: Art idee");
  add("q14", "Wie viele Audit-Befunde gibt es?", "number", await num(db, sql`select count(*)::int as n from entries where kind = 'audit'`), "entries: Art audit");
  add("q15", "Wie viele Einträge der Art Aufgabe gibt es insgesamt?", "number", await num(db, sql`select count(*)::int as n from entries where kind = 'aufgabe'`), "entries: Art aufgabe");
  add("q16", "Wie viele Sessions wurden heute geschlossen?", "number", await num(db, sql`select count(*)::int as n from sessions where ${MAIN} and closed_at >= ${today}`), "sessions: geschlossen seit heute 0 Uhr");

  const [lastCodex] = await rows(db, sql`select session_id, title, git_branch, tokens_total from sessions where ${MAIN} and tool = 'codex' order by last_activity_at desc nulls last, id limit 1`);
  add("q17", "Wie heißt die zuletzt aktive Codex-Session?", "text", sessionNames(lastCodex)[0] ?? null, "sessions: codex mit der jüngsten Aktivität", sessionNames(lastCodex));
  const [oldestWaiting] = await rows(db, sql`select session_id, title from sessions where ${OPEN} and state = 'waiting' order by last_activity_at asc nulls last, id limit 1`);
  add("q18", "Welche Session wartet am längsten auf mich?", "text", sessionNames(oldestWaiting)[0] ?? null, "sessions: wartend, älteste letzte Aktivität", sessionNames(oldestWaiting));
  const [topTokens] = await rows(db, sql`select session_id, title from sessions where ${MAIN} order by tokens_total desc, id limit 1`);
  add("q19", "Welche Session hat insgesamt die meisten Tokens verbraucht?", "text", sessionNames(topTokens)[0] ?? null, "sessions: höchste Token-Summe", sessionNames(topTokens));
  const baustelle = topGroup(
    await rows(db, sql`select category_baustelle_label as name, count(*)::int as n from sessions where ${MAIN} and category_baustelle_label is not null group by 1 order by 2 desc, 1`),
  );
  add("q20", "Welche Baustelle hat die meisten Sessions?", "text", baustelle.names[0] ?? null, `sessions: Baustelle mit den meisten Sessions (${baustelle.n})`, baustelle.names);
  const art = topGroup(await rows(db, sql`select category_art as name, count(*)::int as n from sessions where ${MAIN} and category_art is not null group by 1 order by 2 desc, 1`));
  add("q21", "Welche Art (z. B. Coding, Audit, Planung) hat die meisten Sessions?", "text", art.names[0] ?? null, `sessions: Art mit den meisten Sessions (${art.n})`, art.names);
  const model = topGroup(await rows(db, sql`select m as name, count(*)::int as n from sessions, jsonb_array_elements_text(models) as m where ${MAIN} group by 1 order by 2 desc, 1`));
  add("q23", "Welches Modell kommt in den meisten Sessions vor?", "text", model.names[0] ?? null, `sessions.models: häufigstes Modell (${model.n} Sessions)`, model.names);
  add("q24", "In welchem Git-Zweig arbeitet die zuletzt aktive Codex-Session?", "text", (lastCodex?.git_branch as string | null) ?? null, "sessions: Zweig der jüngsten Codex-Session", lastCodex?.git_branch ? [String(lastCodex.git_branch)] : []);
  add("q25", "Wie viele Tokens hat die zuletzt aktive Codex-Session verbraucht?", "number", lastCodex ? Number(lastCodex.tokens_total ?? 0) : null, "sessions: Token-Summe der jüngsten Codex-Session");
  add("q26", "Wie viele Git-Repos und Worktrees beobachtet die NyxOS?", "number", await num(db, sql`select count(*)::int as n from git_repos`), "git_repos: alle Zeilen (App, Worktrees, NyxOS)");
  add(
    "q27",
    "Wie viele Commits gab es heute in allen Repos zusammen?",
    "number",
    await num(db, sql`select count(distinct sha)::int as n from git_commits where coalesce(committed_at, author_date) >= ${today}`),
    "git_commits: verschiedene Commits seit heute 0 Uhr",
  );
  add("q28", "Wie viele Nachtläufe sind gerade eingeplant?", "number", await num(db, sql`select count(*)::int as n from night_runs where status = 'queued'`), "night_runs: Status queued");
  add("q29", "Läuft gerade eine Codex-Session?", "yesno", (await num(db, sql`select count(*)::int as n from sessions where ${OPEN} and tool = 'codex' and state = 'running'`)) > 0, "sessions: codex im Zustand „läuft“");
  add("q30", "Wartet gerade mindestens eine Session auf mich?", "yesno", waiting > 0, "sessions: mindestens eine im Zustand „wartet“");
  return { at: now.toISOString(), truths: t };
}
