// Briefing (morgens), Recap (abends), „Läuft ohne dich“/„Braucht dich“, „Leichter Tag“.
// Erst deterministisch: Fakten mit Quellen aus der DB. Haiku formuliert nur um – jeder Satz muss
// Fakten-IDs nennen, jede Zahl im Satz muss in diesen Fakten stehen, sonst gilt der Regel-Satz.
//
// Alles „Jetzt“ (läuft, wartet, abgestürzt, Freigaben, Build-Fehler, Lage-Satz, „Braucht dich“)
// kommt aus EINEM Schnappschuss (`overview/snapshot.ts`) — demselben, aus dem der Überblick zählt. Der
// Bericht speichert diesen Stand (Zeit + Fingerabdruck) und zeigt Sätze und Listen NUR aus ihm; passt
// der Stand nicht mehr zum Überblick, heißt der Bericht „veraltet“ (`stale`) statt still falsch zu sein.
// Haikus Zahlen werden geprüft: falsch → einmal neu schreiben lassen, sonst der Daten-Satz mit Marke.
import { BRIEF_CHART_KEYS, BRIEF_TILE_KEYS, formatTokensCompact, getLang, greetingLine, locale, quote, t, orderCharts, parseBriefingModel, type BriefingModelOutput, type HaikuReport, type HaikuSource, type LightDay, type ReportItem, type ReportStatement, timeZone } from "@nyxos/shared";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { buildRuns, haikuNotes, haikuReports, nightRuns, sessions } from "../db/schema.js";
import { countedHistorySession } from "../db/visible.js";
import { buildGroupLabel, sessionSource, sessionTitle, takeSnapshot, type LiveSnapshot, type SnapSession } from "../overview/snapshot.js";
import { collectFigures, type PeriodCounts } from "./figures.js";
import { extractJson } from "./json.js";
import type { HaikuRuntime } from "./runtime.js";
import { greetingNameOf } from "../nyx/profile.js";
import { localDay, usageByDay } from "./settings.js";

export interface Fact {
  id: string;
  section: string;
  text: string;
  sources: HaikuSource[];
}

type SessionRow = Pick<SnapSession, "title" | "sessionId">;

const list = (rows: SessionRow[], n = 3) =>
  rows
    .slice(0, n)
    .map((r) => quote(sessionTitle(r).slice(0, 60)))
    .join(", ") + (rows.length > n ? t(" und {n} weitere", { n: rows.length - n }) : "");

/** Ganzer Satz je Einzahl/Mehrzahl: „1 Session wartet“ / „3 Sessions warten“ (Plural-Fehler „1 Sessions laufen“). */
const plural = (n: number, one: string, many: string, vars: Record<string, string | number> = {}) => t(n === 1 ? one : many, { n, ...vars });

/** Beginn eines Tage (Zeitzone des Nutzers)s als ISO-Zeit. */
function dayStartIso(db: Db, day: string): Promise<string> {
  return db.execute(sql`select ((${day}::date)::timestamp at time zone ${timeZone()}) as t`).then((r) => {
    const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
    const t = (rows[0] as { t: string | Date } | undefined)?.t;
    return t instanceof Date ? t.toISOString() : new Date(String(t)).toISOString();
  });
}

const sessionCols = {
  id: sessions.id,
  sessionId: sessions.sessionId,
  title: sessions.title,
  state: sessions.state,
  categoryArt: sessions.categoryArt,
  categoryBaustelleSlug: sessions.categoryBaustelleSlug,
  lastActivityAt: sessions.lastActivityAt,
};

/**
 * Fakten für Briefing/Recap. Zeitraum-Fakten („Was lief seit gestern 0 Uhr“, „heute geschafft“) kommen aus
 * der DB, alles „Jetzt“ aus dem Schnappschuss `snap` (ohne Angabe wird er hier genommen) — damit sagt der
 * Bericht nie etwas anderes als der Überblick zum selben Zeitpunkt.
 */
export async function collectFacts(db: Db, kind: "briefing" | "recap", now: Date, snap?: LiveSnapshot): Promise<Fact[]> {
  return (await gatherFacts(db, kind, now, snap)).facts;
}

/** Fakten plus die Zeitraum-Zähler, aus denen sie stammen (dieselben Zahlen in den Kacheln). */
async function gatherFacts(db: Db, kind: "briefing" | "recap", now: Date, snap?: LiveSnapshot): Promise<{ facts: Fact[]; period: PeriodCounts }> {
  const live = snap ?? (await takeSnapshot(db, now));
  const facts: Fact[] = [];
  const add = (section: string, text: string, sources: HaikuSource[]) => facts.push({ id: `f${facts.length + 1}`, section, text, sources });
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getTime() - 86400_000));
  const todayStart = await dayStartIso(db, today);
  const yStart = await dayStartIso(db, yesterday);
  const [from, to] = kind === "briefing" ? [yStart, now.toISOString()] : [todayStart, now.toISOString()];
  const periodLabel = kind === "briefing" ? t("seit gestern 0 Uhr") : t("heute");
  // nur sichtbare Haupt-Sessions (archivierte Wegwerf-Sessions nicht), gemeinsame Regel `db/visible.ts`.
  // automatisch erkannte Test-Sessions zählen nie mit (`countedSession`).
  // beendete temporäre Sessions (jeder Grund) nie in „Was lief“ – laufende zählen weiter (`countedHistorySession`).
  const main = sql`${sessions.parentId} is null and ${countedHistorySession}`;

  const active = await db.select(sessionCols).from(sessions).where(and(main, gte(sessions.lastActivityAt, from), lt(sessions.lastActivityAt, to))).orderBy(desc(sessions.lastActivityAt));
  const closed = await db.select(sessionCols).from(sessions).where(and(main, gte(sessions.closedAt, from))).orderBy(desc(sessions.closedAt));
  const builds = await db.select().from(buildRuns).where(gte(buildRuns.startedAt, from)).orderBy(desc(buildRuns.startedAt));
  const nights = await db.select().from(nightRuns).where(gte(nightRuns.createdAt, from)).orderBy(desc(nightRuns.createdAt));
  const { waiting, running, crashed, pendingApprovals, openInbox, redBuilds } = live;

  const secDone = kind === "briefing" ? t("Was lief") : t("Geschafft");
  if (active.length > 0) add(secDone, plural(active.length, "{n} Session war {period} aktiv, zuletzt {list}.", "{n} Sessions waren {period} aktiv, zuletzt {list}.", { period: periodLabel, list: list(active) }), active.slice(0, 5).map(sessionSource));
  else add(secDone, t("Keine Session war {period} aktiv.", { period: periodLabel }), []);
  if (closed.length > 0) add(secDone, plural(closed.length, "{n} Session wurde {period} geschlossen: {list}.", "{n} Sessions wurden {period} geschlossen: {list}.", { period: periodLabel, list: list(closed) }), closed.slice(0, 5).map(sessionSource));
  const green = builds.filter((b) => b.status === "green");
  if (green.length > 0) add(secDone, plural(green.length, "{n} Build-Lauf war {period} grün.", "{n} Build-Läufe waren {period} grün.", { period: periodLabel }), green.slice(0, 3).map((b) => ({ kind: "build" as const, id: String(b.id), label: `Build ${b.kind} #${b.id}`, href: null })));
  if (nights.length > 0) {
    const done = nights.filter((n) => n.status === "done").length;
    add(secDone, plural(nights.length, "{n} Nachtlauf eingeplant, davon {done} fertig.", "{n} Nachtläufe eingeplant, davon {done} fertig.", { done }), nights.slice(0, 3).map((n) => ({ kind: "night" as const, id: String(n.id), label: n.title, href: null })));
  }

  const secWait = kind === "briefing" ? t("Was wartet") : t("Offen");
  if (waiting.length > 0) add(secWait, plural(waiting.length, "{n} Session wartet auf dich: {list}.", "{n} Sessions warten auf dich: {list}.", { list: list(waiting) }), waiting.slice(0, 5).map(sessionSource));
  if (running.length > 0) add(secWait, plural(running.length, "{n} Session läuft gerade.", "{n} Sessions laufen gerade."), running.slice(0, 5).map(sessionSource));
  if (pendingApprovals.length > 0)
    add(secWait, plural(pendingApprovals.length, "{n} Freigabe-Anfrage ist offen (z. B. {rule}).", "{n} Freigabe-Anfragen sind offen (z. B. {rule}).", { rule: pendingApprovals[0]?.rule ?? "" }), pendingApprovals.slice(0, 5).map((a) => ({ kind: "approval" as const, id: String(a.id), label: t("Freigabe #{id}", { id: a.id }), href: `/inbox#approval-${a.id}` })));
  if (openInbox.length > 0) add(secWait, plural(openInbox.length, "{n} Punkt liegt in der Entscheidungs-Inbox.", "{n} Punkte liegen in der Entscheidungs-Inbox."), openInbox.slice(0, 5).map((i) => ({ kind: "inbox" as const, id: String(i.id), label: i.title.slice(0, 80), href: `/inbox#inbox-${i.id}` })));
  if (waiting.length + pendingApprovals.length + openInbox.length === 0) add(secWait, t("Nichts wartet auf dich."), []);

  const secBad = kind === "briefing" ? t("Was ist kaputt") : t("Neue Probleme");
  if (crashed.length > 0) add(secBad, plural(crashed.length, "{n} Session ist abgestürzt: {list}.", "{n} Sessions sind abgestürzt: {list}.", { list: list(crashed) }), crashed.slice(0, 5).map(sessionSource));
  // gleiche Fehler zählen einmal (gebündelt); behobene (Ordner wieder grün) zählen nicht.
  if (redBuilds.length > 0) {
    add(secBad, plural(redBuilds.length, "{n} Build-Fehler ist offen: {list}.", "{n} Build-Fehler sind offen: {list}.", { list: redBuilds.map(buildGroupLabel).join(", ") }), redBuilds.slice(0, 5).map((g) => ({ kind: "build" as const, id: String(g.lastId), label: g.headline, href: "/server" })));
  }
  if (crashed.length + redBuilds.length === 0) add(secBad, t("Keine Abstürze und keine offenen Build-Fehler."), []);

  if (kind === "recap") {
    const tokens = active.length > 0 ? await db.select({ t: sql<number>`coalesce(sum(${sessions.tokensTotal}),0)::float8` }).from(sessions).where(and(main, gte(sessions.lastActivityAt, from))) : [{ t: 0 }];
    const haiku = (await usageByDay(db, 1, now)).find((u) => u.day === today);
    // dieselbe Schreibweise wie überall („3,9 Mrd.“ statt „3874,2 Mio.“).
    const amount = formatTokensCompact(Number(tokens[0]?.t ?? 0));
    add(t("Nutzung"), t("Alle heute aktiven Sessions zusammen: {amount} Tokens seit ihrem Start (nicht nur heute).", { amount }), active.slice(0, 3).map(sessionSource));
    //: „Haiku hat dich 54 Mal aufgerufen“ – die Richtung war verdreht. Es sind Läufe VON Haiku.
    const cost = (haiku?.costUsd ?? 0).toLocaleString(locale(), { minimumFractionDigits: 3, maximumFractionDigits: 3, useGrouping: false });
    add(t("Nutzung"), t("Nyx lief heute {n} Mal (Chat, Berichte, Rundgang) – Gegenwert {cost} USD.", { n: haiku?.calls ?? 0, cost }), [{ kind: "usage", id: `haiku:${today}`, label: t("Nyx-Verbrauch heute"), href: "/einstellungen/nyx/motor" }]);
  }
  return { facts, period: { periodLabel, activeInPeriod: active.length, closedInPeriod: closed.length } };
}

/** Kernaussage in einem Satz aus dem Schnappschuss (Rückfall, wenn Nyx keine gültige liefert). */
export function ruleHeadline(snap: LiveSnapshot): ReportStatement {
  const n = snap.needsYou.length;
  const running = snap.counts.running;
  const trouble = snap.counts.crashed + snap.redBuilds.length;
  let text: string;
  if (n === 0) text = running > 0 ? plural(running, "Nichts wartet auf dich – {n} Session arbeitet von selbst.", "Nichts wartet auf dich – {n} Sessions arbeiten von selbst.") : t("Alles ruhig – nichts wartet auf dich.");
  else if (trouble > 0) text = trouble === 1 ? plural(n, "{n} Punkt braucht dich, davon 1 Störung – am besten zuerst die.", "{n} Punkte brauchen dich, davon 1 Störung – am besten zuerst die.") : plural(n, "{n} Punkt braucht dich, davon {trouble} Störungen – am besten zuerst die.", "{n} Punkte brauchen dich, davon {trouble} Störungen – am besten zuerst die.", { trouble });
  else if (running > 0) text = running === 1 ? plural(n, "{n} Punkt braucht dich, 1 Session arbeitet weiter.", "{n} Punkte brauchen dich, 1 Session arbeitet weiter.") : plural(n, "{n} Punkt braucht dich, {running} Sessions arbeiten weiter.", "{n} Punkte brauchen dich, {running} Sessions arbeiten weiter.", { running });
  else text = plural(n, "{n} Punkt braucht dich.", "{n} Punkte brauchen dich.");
  return { text, sources: snap.needsYou[0]?.sources.slice(0, 1) ?? [], estimate: false, author: "regeln" };
}

/** „Als Nächstes“ aus den Daten, wenn Nyx keinen Vorschlag gemacht hat. */
function ruleNextSteps(snap: LiveSnapshot): ReportStatement[] {
  const first = snap.needsYou[0];
  if (first) {
    const text = first.minutes <= 0 ? t("Als Erstes: „{title}“ (ein Klick).", { title: first.title }) : t("Als Erstes: „{title}“ (etwa {min} Min).", { title: first.title, min: first.minutes });
    return [{ text, sources: first.sources.slice(0, 1).map((src) => ({ ...src, href: src.href ?? first.href })), estimate: false, author: "regeln" }];
  }
  if (snap.counts.startklar > 0) return [{ text: plural(snap.counts.startklar, "{n} Aufgabe ist startklar – eine davon starten.", "{n} Aufgaben sind startklar – eine davon starten."), sources: [], estimate: false, author: "regeln" }];
  return [{ text: t("Nichts drängt – Zeit für eine neue Aufgabe oder Idee."), sources: [], estimate: false, author: "regeln" }];
}

/** „Braucht dich“/„Läuft ohne dich“ — live aus dem Schnappschuss (für „Leichter Tag“). */
export async function buildItems(db: Db): Promise<{ runsWithoutYou: ReportItem[]; needsYou: ReportItem[] }> {
  const snap = await takeSnapshot(db);
  return { runsWithoutYou: snap.runsWithoutYou, needsYou: snap.needsYou };
}

/** „Leichter Tag“: nur Freigaben + höchstens 2 Ja/Nein-Fragen; der Rest wird still verschoben. */
export async function lightDay(db: Db): Promise<LightDay> {
  const { runsWithoutYou, needsYou } = await buildItems(db);
  const approvalsItems = needsYou.filter((i) => i.kind === "approval");
  const yesNo = needsYou.filter((i) => i.kind === "question" && i.zeroEnergy).slice(0, 2);
  const items = [...approvalsItems, ...yesNo];
  return { items, deferred: needsYou.length + runsWithoutYou.length - items.length };
}

/** dieselbe Regel wie Briefing-Kopf, Überblick und Vorlesen (`greetingLine` in shared, Zeitzone des Nutzers). */
export function greetingFor(now: Date, name?: string | null): string {
  return greetingLine(now, name);
}

/** BC: Zahlwörter zählen wie Ziffern („Drei Sessions warten“ gegen „2 Sessions warten“). Bewusst
 * ohne „ein/eine/einer“ — das sind fast immer Artikel, eine Prüfung darauf würde richtige Sätze verwerfen. */
const NUMBER_WORDS: Record<string, string> = {
  null: "0",
  eins: "1",
  zwei: "2",
  drei: "3",
  vier: "4",
  fünf: "5",
  sechs: "6",
  sieben: "7",
  acht: "8",
  neun: "9",
  zehn: "10",
  elf: "11",
  zwölf: "12",
  zwanzig: "20",
  dreißig: "30",
  vierzig: "40",
  fünfzig: "50",
  hundert: "100",
  // English (again without „one“ – mostly an article or pronoun).
  zero: "0",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  hundred: "100",
};
/** Ein ganzes Wort (Umlaute zählen als Buchstaben: „Zweig“ enthält kein „zwei“). */
const wordRe = (w: string, flags = "iu") => new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, flags);
const NUMBER_WORD_RES = Object.entries(NUMBER_WORDS).map(([w, n]) => [wordRe(w, "giu"), n] as const);
/** Größenordnung gehört zur Zahl — „1,5 Mrd.“ darf nicht als „1,5“ durchgehen, wenn der
 * Fakt „1,5 Mio.“ sagt. Schreibweisen (Mio./Mio/Millionen) werden auf eine Einheit gebracht. */
const MAGNITUDES: [RegExp, string][] = [
  [/^(tsd|tausend|k|thousand)$/i, "e3"],
  [/^(mio|millionen?|m|millions?)$/i, "e6"],
  [/^(mrd|milliarden?|b|bn|billions?)$/i, "e9"],
  [/^(bio|billionen?|trillions?)$/i, "e12"],
];
// English short forms („34.5M“, „950K“) as the page writes them; German „Bio.“ = English „trillion“.
const NUMBER_RE = /(\d+(?:[.,]\d+)?)(?:\s*(tsd|tausend|mio|millionen?|mrd|milliarden?|bio|billionen?|thousand|millions?|billions?|trillions?|bn|k|m|b)(?![\p{L}]))?/giu;
export const numbersIn = (s: string) => {
  const out = new Set<string>();
  for (const m of s.matchAll(NUMBER_RE)) {
    const unit = m[2] ? (MAGNITUDES.find(([re]) => re.test(m[2] ?? ""))?.[1] ?? "") : "";
    out.add(`${m[1]}${unit}`);
  }
  for (const [re, n] of NUMBER_WORD_RES) if (s.match(re)) out.add(n);
  return out;
};
/** BC: „Keine Session läuft“ ist auch eine Zahl (0) — genau der F02-Widerspruch. Ein verneinender
 * Satz ist nur erlaubt, wenn auch einer seiner Fakten verneint („Nichts wartet auf dich.“). */
const NEGATION_RE = wordRe("(kein|keine|keiner|keinen|keinem|keines|nichts|niemand|no|none|nothing|nobody|no one)");
const negates = (s: string) => NEGATION_RE.test(s);
/** Zeitwörter, die ein Satz nur tragen darf, wenn sie auch in seinen Fakten stehen („Gestern liefen 30“-Fund der Kritik). */
const TIME_WORDS = ["gestern", "heute", "morgen", "nachts", "heute nacht", "letzte nacht", "diese woche", "vorhin", "yesterday", "today", "tomorrow", "tonight", "last night", "this week", "earlier"];
export const timeWordsIn = (s: string) => TIME_WORDS.filter((w) => new RegExp(`(^|[^a-zäöü])${w}([^a-zäöü]|$)`, "i").test(s));

/** Prüft Haikus Satz: nennt er gültige Fakten und nur Zahlen, die in diesen Fakten stehen? */
export function validateStatement(text: string, factIds: string[], facts: Fact[]): { ok: boolean; cited: Fact[] } {
  const cited = factIds.map((id) => facts.find((f) => f.id === id)).filter((f): f is Fact => !!f);
  if (cited.length === 0) return { ok: false, cited };
  const allowed = new Set<string>();
  for (const f of cited) for (const n of numbersIn(f.text)) allowed.add(n);
  for (const n of numbersIn(text)) if (!allowed.has(n)) return { ok: false, cited };
  const factText = cited.map((f) => f.text).join(" ");
  if (negates(text) && !negates(factText)) return { ok: false, cited };
  //: Haiku-Läufe sind Aufrufe VON Haiku, nicht an den Nutzer – verdrehte Richtung ablehnen.
  if (/\b(hat|haben)\s+dich\b[^.!?]{0,60}\b(aufgerufen|angerufen|kontaktiert)\b/i.test(text)) return { ok: false, cited };
  for (const w of timeWordsIn(text)) if (!timeWordsIn(factText).includes(w)) return { ok: false, cited };
  return { ok: true, cited };
}

const REPORT_SYSTEM = `Du bist Nyx, der persönliche Assistent des Nutzers in „NyxOS“ (Kommandozentrale für seine KI-Sessions).
Du formulierst ein kurzes, freundliches Briefing bzw. einen Recap. Regeln:
- Verwende NUR die gegebenen Fakten. Erfinde nichts, keine eigenen Zahlen, keine Namen, die nicht in den Fakten stehen.
- Zeitangaben („seit gestern 0 Uhr“, „heute“, „gerade“) übernimmst du wörtlich – nie „gestern“ daraus machen.
- Jeder Satz nennt die Fakten-IDs, auf denen er beruht.
- Einfache Sprache, kurze Sätze, kein Fachchinesisch. Anführungszeichen in Sätzen nur als „…“ (auf Englisch “…”), nie als gerade Zeichen (").
- „Nyx lief N Mal“ sind Läufe von Nyx selbst – nie „Nyx hat dich … aufgerufen“.
- "kernaussage": EIN kurzer Satz, der das Wichtigste des Tages sagt (Zahlen nur aus den genannten Fakten).
- "hervorhebungen": bis zu 3 Kacheln, die heute wichtig sind, aus: ${BRIEF_TILE_KEYS.join(", ")}.
- "graphen": die Diagramme nach Wichtigkeit, aus: ${BRIEF_CHART_KEYS.join(", ")}. Kennzahlen und Diagramme füllt NyxOS selbst – schreib keine eigenen Zahlenfelder.
Antworte ausschließlich mit JSON in genau dieser Form:
{"kernaussage":{"text":"<ein Satz>","fakten":["f1"]},"saetze":[{"abschnitt":"<Abschnitt aus den Fakten>","text":"<ein Satz>","fakten":["f1"]}],"vorschlag":{"text":"<ein Satz Vorschlag für heute/morgen>","fakten":["f2"]},"hervorhebungen":["needs_you"],"graphen":["usage_7d"]}`;


type Draft = { abschnitt?: string; text?: string; fakten?: string[] };
/** nur, was das feste Schema erlaubt (`parseBriefingModel`) — nie Zahlenfelder des Modells. */
type Parsed = BriefingModelOutput | null;

/** Grund in einfachen Worten, warum der Bericht ohne Haiku entstand. */
function reasonFor(res: { code: string; message: string }): string {
  if (res.code === "timeout") return t("Nyx hat nicht rechtzeitig geantwortet.");
  return res.message || t("Nyx konnte nicht antworten.");
}

/** Zahlen im Vorschlag müssen aus den genannten Fakten stammen (ohne Fakten: keine Zahl erlaubt). */
function suggestionNumbersOk(text: string, factIds: string[], facts: Fact[]): boolean {
  const allowed = new Set<string>();
  for (const id of factIds) for (const n of numbersIn(facts.find((f) => f.id === id)?.text ?? "")) allowed.add(n);
  return [...numbersIn(text)].every((n) => allowed.has(n));
}

/** Laufende Erstellung je Laufzeit + Art: „Jetzt neu erstellen“, Takt und Auto-Aktualisierung teilen sich einen Lauf. */
/** Regel-Satz ohne Quelle, der „nichts“ meldet (keine Schätzung) — in beiden App-Sprachen. */
const RULE_NEGATIVE = /^(Keine|Nichts|Alles ruhig|No |Nothing|All quiet)/;

const inflight = new WeakMap<HaikuRuntime, Map<string, Promise<HaikuReport>>>();

export function generateReport(runtime: HaikuRuntime, kind: "briefing" | "recap", now = new Date()): Promise<HaikuReport> {
  let perRuntime = inflight.get(runtime);
  if (!perRuntime) inflight.set(runtime, (perRuntime = new Map()));
  const running = perRuntime.get(kind);
  if (running) return running;
  const job = writeReport(runtime, kind, now).finally(() => perRuntime.delete(kind));
  perRuntime.set(kind, job);
  return job;
}

async function writeReport(runtime: HaikuRuntime, kind: "briefing" | "recap", now: Date): Promise<HaikuReport> {
  const db = runtime.db;
  const snap = await takeSnapshot(db, now);
  const { facts, period } = await gatherFacts(db, kind, now, snap);
  // alle Kennzahlen und Diagramm-Reihen aus demselben Stand — nie aus dem Modelltext.
  const figures = await collectFigures(db, snap, period, now);
  const sectionOrder = [...new Set(facts.map((f) => f.section))];
  const bySection = new Map<string, ReportStatement[]>(sectionOrder.map((s) => [s, []]));
  const corrected = new Set<string>();
  const ruleStatement = (f: Fact): ReportStatement => ({
    text: f.text,
    sources: f.sources,
    estimate: f.sources.length === 0 && !RULE_NEGATIVE.test(f.text),
    author: "regeln",
    ...(corrected.has(f.id) ? { corrected: true } : {}),
  });

  let mode: HaikuReport["mode"] = "nur-daten";
  let modeReason: string | null = null;
  let callId: number | null = null;
  const covered = new Set<string>();
  const basePrompt = `Art: ${kind === "briefing" ? "Morgen-Briefing" : "Abend-Recap mit Vorschlag für morgen"}\nFakten:\n${JSON.stringify(facts.map((f) => ({ id: f.id, abschnitt: f.section, text: f.text })), null, 1)}\nOffene Punkte für den Nutzer: ${snap.needsYou.length}`;

  const acceptedTexts = new Set<string>();
  const accept = (raw: Draft): boolean => {
    if (!raw.text || !Array.isArray(raw.fakten)) return false;
    // Prüfstand (ohne Denkpause): Haiku schrieb Fakten-IDs „[f1]“ in den Satz und denselben Fakt zweimal.
    const s = { ...raw, text: raw.text.replace(/\s*\[f\d+(?:\s*,\s*f\d+)*\]/g, "").trim() };
    if (acceptedTexts.has(s.text)) return true; // beim Neuschreiben doppelt geliefert
    const v = validateStatement(s.text as string, s.fakten as string[], facts);
    if (!v.ok) return false;
    if (v.cited.every((f) => covered.has(f.id))) return true; // Fakt schon gesagt → kein zweiter Satz
    const section = v.cited[0]?.section ?? s.abschnitt ?? sectionOrder[0] ?? t("Lage");
    const sources = v.cited.flatMap((f) => f.sources).filter((src, i, arr) => arr.findIndex((x) => x.kind === src.kind && x.id === src.id) === i);
    bySection.get(section)?.push({ text: s.text.trim(), sources, estimate: sources.length === 0 && v.cited.every((f) => f.sources.length === 0) && !v.cited.every((f) => RULE_NEGATIVE.test(f.text)), author: "haiku" });
    for (const f of v.cited) covered.add(f.id);
    acceptedTexts.add(s.text.trim());
    return true;
  };
  /** Abgelehnt wegen einer Zahl (auch Zahlwort oder „keine/nichts“, nicht nur unbelegt) → Kandidat fürs Neuschreiben. */
  const hasNumber = (s: Draft) => numbersIn(s.text ?? "").size > 0 || negates(s.text ?? "");
  let suggestion: { text: string; fakten: string[] } | null = null;
  let hasSuggestion = false;
  let headline: ReportStatement | null = null;
  let highlights: HaikuReport["highlights"] = [];
  let chartOrder: HaikuReport["chartOrder"] = [...BRIEF_CHART_KEYS];
  const takeSuggestion = (v: Parsed): boolean => {
    const text = v?.vorschlag?.text?.trim();
    if (!text) return true;
    const ids = v?.vorschlag?.fakten ?? [];
    if (!suggestionNumbersOk(text, ids, facts)) return false;
    suggestion = { text, fakten: ids };
    return true;
  };

  const res = await runtime.run({ kind, scope: "none", systemPrompt: REPORT_SYSTEM, prompt: basePrompt });
  if (res.type === "error") modeReason = reasonFor(res);
  if (res.type === "final") {
    callId = res.callId;
    const parsed: Parsed = parseBriefingModel(extractJson(res.rawText));
    if (!parsed) {
      // Nachvollziehbar statt still: warum der Bericht auf „nur Daten“ zurückfiel.
      await db.insert(haikuNotes).values({ kind: "bericht-json-fehler", text: res.rawText.slice(0, 1500), data: { callId: res.callId, kind } });
      modeReason = t("Nyx hat keine lesbare Antwort geliefert.");
    } else {
      mode = "ok";
      // Kernaussage: gleiche Zahlen-Prüfung wie jeder Satz; falsch → Kernaussage aus den Daten.
      // Fakten-Marken („[f1]“) wie bei den Sätzen vorher entfernen — sonst zählt die Marke als Zahl.
      const k = parsed.kernaussage ? { ...parsed.kernaussage, text: parsed.kernaussage.text.replace(/\s*\[f\d+(?:\s*,\s*f\d+)*\]/g, "").trim() } : null;
      const kv = k?.text ? validateStatement(k.text, k.fakten, facts) : null;
      if (k && kv?.ok) headline = { text: k.text, sources: kv.cited.flatMap((f) => f.sources).slice(0, 3), estimate: false, author: "haiku" };
      highlights = parsed.hervorhebungen;
      chartOrder = orderCharts(parsed.graphen);
      const wrong = parsed.saetze.filter((s) => s.text && Array.isArray(s.fakten) && !accept(s)).filter(hasNumber);
      const suggestionOk = takeSuggestion(parsed);
      // Jede Zahl wird gegen die Fakten (= den Schnappschuss) geprüft. Falsche Sätze schreibt
      // Haiku EINMAL neu; was dann noch falsch ist, ersetzt der Satz aus den Daten — markiert.
      if (wrong.length > 0 || !suggestionOk) {
        const lines = [...wrong.map((s) => `- ${s.text} (Fakten: ${(s.fakten ?? []).join(", ")})`), ...(suggestionOk ? [] : [`- Vorschlag: ${parsed.vorschlag?.text ?? ""}`])];
        const retry = await runtime.run({
          kind,
          scope: "none",
          systemPrompt: REPORT_SYSTEM,
          prompt: `${basePrompt}\n\nDiese Sätze stimmen nicht mit den Fakten überein (eine Zahl, ein Zahlwort, ein „keine/nichts“ oder ein Zeitwort steht nicht so in den genannten Fakten). Schreib nur diese Sätze neu, mit genau den Zahlen aus den Fakten, gleiche JSON-Form:\n${lines.join("\n")}`,
        });
        const again: Parsed = retry.type === "final" ? parseBriefingModel(extractJson(retry.rawText)) : null;
        const stillWrong = (again?.saetze ?? []).filter((s) => s.text && Array.isArray(s.fakten) && !accept(s)).filter(hasNumber);
        if (!suggestionOk) takeSuggestion(again);
        for (const s of [...wrong, ...stillWrong]) for (const id of s.fakten ?? []) if (!covered.has(id)) corrected.add(id);
      }
      const chosen = suggestion as { text: string; fakten: string[] } | null;
      if (chosen) {
        // Ein Vorschlag darf „heute/morgen“ sagen (er blickt nach vorn) – Zahlen müssen trotzdem aus den Fakten stammen.
        const v = validateStatement(chosen.text.replace(/\b(heute|morgen)\b/gi, ""), chosen.fakten, facts);
        const title = kind === "briefing" ? t("Vorschlag für heute") : t("Vorschlag für morgen");
        hasSuggestion = true;
        bySection.set(title, [{ text: chosen.text, sources: v.cited.flatMap((f) => f.sources).slice(0, 5), estimate: !v.ok, author: "haiku" }]);
      }
    }
  }
  // Was Haiku nicht (gültig) abgedeckt hat, kommt als Regel-Satz dazu — nie fehlt ein Fakt.
  for (const f of facts) if (!covered.has(f.id)) bySection.get(f.section)?.push(ruleStatement(f));
  // „Was als Nächstes“ gibt es immer — ohne Vorschlag von Nyx aus den Daten.
  if (!hasSuggestion) bySection.set(t("Als Nächstes"), ruleNextSteps(snap));
  const sections = [...bySection.entries()].filter(([, st]) => st.length > 0).map(([title, statements]) => ({ title, statements }));
  const content: Omit<HaikuReport, "id" | "createdAt"> = {
    kind,
    day: localDay(now),
    greeting: greetingFor(now, await greetingNameOf(db)),
    lage: snap.lage,
    sections,
    runsWithoutYou: snap.runsWithoutYou,
    needsYou: snap.needsYou,
    mode,
    modeReason: mode === "ok" ? null : modeReason,
    callId,
    snapshot: { at: snap.at, counts: snap.counts, lage: snap.lage, needsYouCount: snap.needsYou.length, fingerprint: snap.fingerprint },
    headline: headline ?? ruleHeadline(snap),
    figures,
    highlights,
    chartOrder,
    lang: getLang(),
  };
  const [row] = await db.insert(haikuReports).values({ kind, day: content.day, content, facts, callId }).returning({ id: haikuReports.id, createdAt: haikuReports.createdAt });
  return { ...content, stale: false, id: (row as { id: number }).id, createdAt: (row as { createdAt: string }).createdAt };
}

/**
 * Der zuletzt geschriebene Bericht — Sätze UND Listen aus seinem eigenen Stand (vorher: Listen live, Sätze
 * alt → Widerspruch). `stale` sagt, ob sich seither etwas geändert hat (Fingerabdruck ≠ jetzt).
 */
export async function latestReport(db: Db, kind: "briefing" | "recap", now = new Date()): Promise<HaikuReport | null> {
  const [row] = await db.select().from(haikuReports).where(eq(haikuReports.kind, kind)).orderBy(desc(haikuReports.id)).limit(1);
  if (!row) return null;
  const content = row.content as HaikuReport;
  const live = await takeSnapshot(db, now);
  // Written in another app language (e.g. before the switch to English in onboarding): rewrite it like a stale one.
  const stale = !content.snapshot || content.snapshot.fingerprint !== live.fingerprint || (content.lang ?? "de") !== getLang();
  return { ...content, snapshot: content.snapshot ?? null, modeReason: content.modeReason ?? null, stale, id: row.id, createdAt: row.createdAt };
}

/** ein gespeicherter Bericht nach Nummer (für die Sprechfassung), ohne Neuberechnung. */
export async function reportById(db: Db, id: number): Promise<HaikuReport | null> {
  const [row] = await db.select().from(haikuReports).where(eq(haikuReports.id, id)).limit(1);
  if (!row) return null;
  const content = row.content as HaikuReport;
  return { ...content, snapshot: content.snapshot ?? null, modeReason: content.modeReason ?? null, id: row.id, createdAt: row.createdAt };
}

export async function hasReportForDay(db: Db, kind: "briefing" | "recap", day: string): Promise<boolean> {
  const [row] = await db.select({ id: haikuReports.id }).from(haikuReports).where(and(eq(haikuReports.kind, kind), eq(haikuReports.day, day))).limit(1);
  return !!row;
}

