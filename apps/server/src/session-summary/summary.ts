// „Nyx fasst zusammen“. Nyx liest einen Auszug des Verlaufs (Anfang + letzte Runden, ausgelassene Mitte
// sichtbar markiert) plus eine Werkzeug-/Datei-Übersicht über den GANZEN Verlauf und schreibt eine ausführliche,
// gegliederte Zusammenfassung in Markdown. Läuft über die bestehende Nyx-Laufzeit (`runtime.ask`, Art „auswertung“,
// ohne Werkzeuge) – gleiches Budget, gleiche Warteschlange, eigenes Zeitlimit. Der Text strömt in die Zeile, damit die
// Karte schon während des Schreibens wächst; am Ende prüft NyxOS Pfade/Commits/Zahlen gegen den Verlauf.
import { t, type NyxSessionSummary, type TranscriptItem } from "@nyxos/shared";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionFiles, sessions, sessionSummaries } from "../db/schema.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { digestTranscript } from "../session-audit/audit.js";
import type { TranscriptCache } from "../transcript.js";
import { loadMainTranscriptItems } from "../transcript.js";

const FILES_MAX = 60;
const OVERVIEW_TOOLS_MAX = 12;
const HIGHLIGHTS_MAX = 25;
/** Ausführlich braucht länger als eine Kurz-Antwort – eigenes Zeitlimit statt des Nyx-Standards. */
export const SUMMARY_TIMEOUT_MS = 180_000;
/** Kürzer als das ist keine gegliederte Zusammenfassung, sondern eine Absage. */
const MIN_CHARS = 80;
/** Beim Strömen höchstens so oft in die DB schreiben. */
const STREAM_FLUSH_MS = 700;
/** Eine hängengebliebene Zusammenfassung (Server-Neustart mitten im Lauf) sperrt nicht für immer. */
const RUNNING_STALE_MS = 10 * 60_000;

/** Überschriften in der Sprache der Oberfläche (die Laufzeit hängt „Antworte auf Deutsch/Englisch“ an). */
export function summarySystem(): string {
  return `Du bist Nyx und fasst für den Nutzer eine Claude-/Codex-Session zusammen, damit er den Chat nicht selbst durchlesen muss. Schreib einfach und klar, ohne Fachchinesisch, aber ausführlich und konkret.
Antworte NUR mit Markdown in genau dieser Gliederung (Überschriften genau so, wörtlich):
## ${t("Ziel der Session")}
(1–3 Sätze: was der Nutzer wollte)
## ${t("Was erledigt wurde")}
(Stichpunkte in der Reihenfolge der Arbeit: Schritte, geänderte Dateien, Commits, Tests/Builds mit Ergebnis)
## ${t("Was gerade läuft")}
(woran die Session zuletzt gearbeitet hat bzw. ob sie wartet oder fertig ist)
## ${t("Offene Punkte und Fragen an dich")}
(Stichpunkte; was noch fehlt, was unklar ist, worauf die Session wartet – „Keine.“, wenn es nichts gibt)
## ${t("Nächster sinnvoller Schritt")}
(1–2 Sätze)
Regeln: Nur, was im Verlauf oder in der Übersicht steht – nichts erfinden, nichts schönreden. Dateipfade, Commit-Kennungen und Zahlen nur genau so, wie sie dort stehen (Pfade in \`Backticks\`). „Erledigt“ nur, wenn die Session es selbst sagt oder ein Test/Build es zeigt. Wenn die Mitte ausgelassen ist, sag das nicht – die Werkzeug-Übersicht deckt sie ab. Höchstens 12 Stichpunkte je Abschnitt.`;
}

const time = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 16);
};

/** Zählt nur echte Nachrichten (Nutzer + Claude/Codex mit Text) – das, was der Nutzer als „Nachricht“ sieht. */
export const isMessage = (i: TranscriptItem) => (i.role === "user" || i.role === "assistant") && !!i.text?.trim();

const HIGHLIGHT = /\bgit (commit|push|merge|tag)\b|\b(pnpm|npm|yarn|bun)( run)? (test|typecheck|lint|build)\b|\bvitest\b|\bplaywright\b|\bxcodebuild\b|\bcargo (test|build)\b|\bpytest\b/i;

/**
 * Werkzeug-/Datei-Übersicht über den GANZEN Verlauf – deckt die Mitte ab, die der Auszug auslässt: wie oft welches
 * Werkzeug, Fehlschläge, Sub-Agenten und die wichtigen Befehle (Commits, Tests, Builds) mit Uhrzeit.
 */
function overviewOf(items: TranscriptItem[]): string {
  const counts = new Map<string, { n: number; errors: number }>();
  const highlights: string[] = [];
  const agents: string[] = [];
  for (const i of items) {
    if (i.role === "tool" && i.tool) {
      const c = counts.get(i.tool.name) ?? { n: 0, errors: 0 };
      c.n += 1;
      if (i.tool.status === "error") c.errors += 1;
      counts.set(i.tool.name, c);
      const target = i.tool.target ?? "";
      if (HIGHLIGHT.test(target)) highlights.push(`- ${time(i.ts)} ${target.replace(/\s+/g, " ").slice(0, 220)}${i.tool.status === "error" ? " ✗ (Fehler)" : ""}`);
    }
    if (i.role === "subagent" && i.subagent) agents.push(i.subagent.title ?? i.subagent.id);
  }
  const tools = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, OVERVIEW_TOOLS_MAX)
    .map(([name, c]) => `${name} ×${c.n}${c.errors ? ` (${c.errors} mit Fehler)` : ""}`);
  const parts = [`Werkzeuge im ganzen Verlauf: ${tools.length ? tools.join(", ") : "keine"}`];
  if (agents.length) parts.push(`Sub-Agenten (${agents.length}): ${agents.slice(0, 12).join(" · ")}`);
  if (highlights.length) {
    const shown = highlights.length > HIGHLIGHTS_MAX ? [...highlights.slice(0, 5), `- … ${highlights.length - HIGHLIGHTS_MAX} weitere …`, ...highlights.slice(-(HIGHLIGHTS_MAX - 5))] : highlights;
    parts.push(`Wichtige Befehle (Commits, Tests, Builds):\n${shown.join("\n")}`);
  }
  return parts.join("\n");
}

/** Auszug (Anfang + letzte Runden, wie „Session prüfen“) plus Übersicht über alles. */
export function summaryDigest(items: TranscriptItem[], who: string): { text: string; overview: string; itemsRead: number; itemsTotal: number } {
  const d = digestTranscript(items, who);
  return { ...d, overview: overviewOf(items) };
}

// ── Faktenprüfung (wie `speechNarrative.ts`: was nicht in den Daten steht, fliegt raus) ─────────────────────────────

const PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|sql|swift|css|html|ya?ml|sh|py|go|rs|toml|lock|txt)\b/g;
const HASH_RE = /\b[0-9a-f]{7,40}\b/g;
const NUMBER_RE = /\b\d{3,}(?:[.,]\d+)?\b/g;

/** Zahlen „1.234“ und „1234“ gelten als gleich. */
const normNumber = (n: string) => n.replace(/[.,](?=\d{3}\b)/g, "");

function claimsOf(line: string): { kind: "path" | "hash" | "number"; value: string }[] {
  const out: { kind: "path" | "hash" | "number"; value: string }[] = [];
  const code = line.replace(/https?:\/\/\S+/g, " ");
  for (const m of code.match(PATH_RE) ?? []) {
    // „z. B./u. a.“ und Brüche („1/2“) sind keine Pfade.
    if (/^[\d/.]+$/.test(m) || m.length < 4) continue;
    out.push({ kind: "path", value: m.replace(/[.,:;)]+$/, "") });
  }
  for (const m of code.match(HASH_RE) ?? []) if (/\d/.test(m) && /[a-f]/.test(m)) out.push({ kind: "hash", value: m });
  const withoutPaths = code.replace(PATH_RE, " ").replace(HASH_RE, " ");
  for (const m of withoutPaths.match(NUMBER_RE) ?? []) out.push({ kind: "number", value: m });
  return out;
}

/**
 * Prüft jede Zeile: Pfade, Commit-Kennungen und Zahlen ab drei Stellen müssen im Quelltext (Auszug + Übersicht +
 * Dateiliste) vorkommen. Zeilen mit einer unbelegten Angabe fliegen raus – Überschriften bleiben immer.
 */
export function checkSummaryFacts(markdown: string, source: string): { text: string; dropped: number } {
  const numbers = new Set((source.match(NUMBER_RE) ?? []).map(normNumber));
  const kept: string[] = [];
  let dropped = 0;
  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      kept.push(line);
      continue;
    }
    const ok = claimsOf(line).every((c) => (c.kind === "number" ? numbers.has(normNumber(c.value)) : source.includes(c.value)));
    if (ok) kept.push(line);
    else dropped += 1;
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), dropped };
}

// ── Speichern / Laden ─────────────────────────────────────────────────────────────────────────────────────────────

export function toSummary(r: typeof sessionSummaries.$inferSelect): NyxSessionSummary {
  return {
    id: r.id,
    sessionKey: r.sessionKey,
    status: r.status as NyxSessionSummary["status"],
    text: r.text,
    error: r.error,
    messagesCovered: r.messagesCovered,
    coveredUntil: r.coveredUntil,
    itemsRead: r.itemsRead,
    itemsTotal: r.itemsTotal,
    dropped: r.dropped,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  };
}

export async function closeStaleSummaries(db: Db, sessionKey: string, now = Date.now()): Promise<void> {
  const before = new Date(now - RUNNING_STALE_MS).toISOString();
  await db
    .update(sessionSummaries)
    .set({ status: "error", error: t("Die Zusammenfassung ist nicht fertig geworden (der Server wurde neu gestartet). Bitte neu erstellen."), finishedAt: new Date(now).toISOString() })
    .where(and(eq(sessionSummaries.sessionKey, sessionKey), eq(sessionSummaries.status, "running"), lt(sessionSummaries.createdAt, before)));
}

export async function runningSummary(db: Db, sessionKey: string, now = Date.now()) {
  const since = new Date(now - RUNNING_STALE_MS).toISOString();
  const [row] = await db
    .select({ id: sessionSummaries.id })
    .from(sessionSummaries)
    .where(and(eq(sessionSummaries.sessionKey, sessionKey), eq(sessionSummaries.status, "running"), gte(sessionSummaries.createdAt, since)))
    .limit(1);
  return row ?? null;
}

export async function latestSummary(db: Db, sessionKey: string, status?: NyxSessionSummary["status"]) {
  const where = status ? and(eq(sessionSummaries.sessionKey, sessionKey), eq(sessionSummaries.status, status)) : eq(sessionSummaries.sessionKey, sessionKey);
  const [row] = await db.select().from(sessionSummaries).where(where).orderBy(desc(sessionSummaries.id)).limit(1);
  return row ?? null;
}

/** Neue Nachrichten seit dem Stand einer fertigen Zusammenfassung (nach der abgedeckten Nachricht, sonst nach Anzahl). */
export function newMessagesSince(items: TranscriptItem[], row: Pick<typeof sessionSummaries.$inferSelect, "coveredUntilItem" | "messagesCovered">): number {
  const messages = items.filter(isMessage);
  const at = row.coveredUntilItem ? messages.findIndex((m) => m.id === row.coveredUntilItem) : -1;
  if (at >= 0) return messages.length - at - 1;
  return Math.max(0, messages.length - row.messagesCovered);
}

export interface SummaryDeps {
  db: Db;
  runtime: HaikuRuntime;
  cache: TranscriptCache;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  onChange: (sessionKey: string) => void;
  /** Tests: kürzeres Zeitlimit. */
  timeoutMs?: number;
}

/** deutscher Schlüssel, übersetzt beim Ablegen des Fehlers */
const SIMPLE_ERROR = "Nyx konnte die Zusammenfassung gerade nicht schreiben. Versuch es gleich noch einmal.";

function honestError(code: string, message: string): string {
  if (code === "budget") return `${message} ${t("Nyx fasst wieder zusammen, sobald Budget frei ist (Einstellungen → Nyx).")}`;
  if (code === "timeout") return t("Nyx hat für die Zusammenfassung zu lange gebraucht und wurde nach dem Zeitlimit gestoppt. Versuch es gleich noch einmal.");
  if (code === "rate_limit" || code === "busy") return t("Nyx ist gerade ausgelastet. Versuch es in einer Minute noch einmal.");
  // Kein Modell eingerichtet/nicht bereit/Anmeldung abgelaufen: der Satz der Laufzeit ist schon übersetzt.
  if ((code === "auth" || code === "not_ready" || code === "disabled") && message) return message;
  return t(SIMPLE_ERROR);
}

/** Führt eine angelegte Zusammenfassung (Zeile `id`, Status `running`) zu Ende. Wirft nie. */
export async function runSummary(deps: SummaryDeps, id: number, sessionKey: string): Promise<void> {
  const { db, runtime, cache, log, onChange } = deps;
  const finish = async (values: Partial<typeof sessionSummaries.$inferInsert>) => {
    await db
      .update(sessionSummaries)
      .set({ ...values, finishedAt: new Date().toISOString() })
      .where(eq(sessionSummaries.id, id));
    onChange(sessionKey);
  };
  try {
    const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionKey)).limit(1);
    if (!s) return await finish({ status: "error", error: t("Diese Session gibt es nicht mehr.") });
    const transcript = await loadMainTranscriptItems(db, cache, sessionKey);
    if (!transcript || transcript.items.length === 0) return await finish({ status: "error", error: t("Von dieser Session liegt noch kein Verlauf vor. Sobald die Brücke ihn geschickt hat, geht die Zusammenfassung.") });
    const who = s.tool === "codex" ? "Codex" : "Claude";
    const messages = transcript.items.filter(isMessage);
    const last = messages.at(-1) ?? null;
    const digest = summaryDigest(transcript.items, who);
    const files = await db
      .select({ path: sessionFiles.path })
      .from(sessionFiles)
      .where(and(eq(sessionFiles.sessionKey, sessionKey), eq(sessionFiles.mode, "write")))
      .limit(FILES_MAX + 1);
    const model = s.lastUsageModel ?? ((s.models ?? []) as string[]).at(-1) ?? null;
    const head = [
      `Session: „${s.title ?? s.sessionId}“ (${who}${model ? `, Modell ${model}` : ""})`,
      `Ordner: ${s.cwd ?? "unbekannt"} · Start: ${s.startedAt ?? "?"} · zuletzt aktiv: ${s.lastActivityAt ?? "?"} · Zustand jetzt: ${s.state ?? s.status}`,
      files.length > 0 ? `Geschriebene Dateien${files.length > FILES_MAX ? ` (die ersten ${FILES_MAX})` : ""}:\n${files.slice(0, FILES_MAX).map((f) => `- ${f.path}`).join("\n")}` : "Geschriebene Dateien: keine erfasst",
      digest.overview,
    ].join("\n");
    await db
      .update(sessionSummaries)
      .set({ itemsRead: digest.itemsRead, itemsTotal: digest.itemsTotal, messagesCovered: messages.length, coveredUntilItem: last?.id ?? null, coveredUntil: last?.ts ?? null })
      .where(eq(sessionSummaries.id, id));
    const prompt = `${head}\n\nVerlauf (älteste zuerst):\n${digest.text}`;

    // Strömen: Text wächst in der Zeile, die Web-App lädt bei jedem Live-Signal nach.
    let streamed = "";
    let lastFlush = Date.now();
    let flushing: Promise<unknown> = Promise.resolve();
    let final: { rawText: string; callId: number } | null = null;
    let failure: { code: string; message: string; callId: number | null } | null = null;
    for await (const ev of runtime.ask({ kind: "auswertung", scope: "none", systemPrompt: summarySystem(), prompt, thinking: false, timeoutMs: deps.timeoutMs ?? SUMMARY_TIMEOUT_MS })) {
      if (ev.type === "delta") {
        streamed += ev.text;
        if (Date.now() - lastFlush >= STREAM_FLUSH_MS) {
          lastFlush = Date.now();
          const text = streamed;
          flushing = flushing.then(() => db.update(sessionSummaries).set({ text }).where(and(eq(sessionSummaries.id, id), eq(sessionSummaries.status, "running")))).then(() => onChange(sessionKey));
        }
      } else if (ev.type === "final") final = { rawText: ev.rawText, callId: ev.callId };
      else if (ev.type === "error") failure = ev;
    }
    await flushing.catch(() => {});
    if (!final) {
      const f = failure ?? { code: "engine", message: "", callId: null };
      log("session-zusammenfassung-fehler", { session: sessionKey, code: f.code, error: f.message });
      return await finish({ status: "error", text: "", error: honestError(f.code, f.message), callId: f.callId });
    }
    const raw = final.rawText.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/, "$1").trim();
    if (raw.length < MIN_CHARS || !/^#{2}\s/m.test(raw)) return await finish({ status: "error", text: "", error: t("Nyx' Antwort war unvollständig. Bitte neu erstellen."), callId: final.callId });
    const checked = checkSummaryFacts(raw, `${prompt}\n${transcript.items.map((i) => i.text ?? i.tool?.target ?? "").join("\n")}`);
    await finish({ status: "done", text: checked.text, dropped: checked.dropped, callId: final.callId, error: null });
  } catch (e) {
    log("session-zusammenfassung-absturz", { session: sessionKey, error: e instanceof Error ? e.message : String(e) });
    await finish({ status: "error", text: "", error: t(SIMPLE_ERROR) }).catch(() => {});
  }
}
