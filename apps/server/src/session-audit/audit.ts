// „Session zusammenfassen & prüfen“. Haiku liest einen Auszug des Verlaufs (Anfang + Ende,
// sichtbar markiert, wenn etwas ausgelassen ist) plus die geänderten Dateien und schreibt eine
// Prüfung als JSON. Läuft über denselben Haiku-Weg wie die Auftrags-Auswertung (`runtime.run`,
// Art „auswertung“, ohne Werkzeuge) — kein eigener Motor, kein eigenes Budget.
import { AuditQualitySchema, t, type SessionAudit, type SessionAuditResult, type TranscriptItem } from "@nyxos/shared";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionAudits, sessionFiles, sessions } from "../db/schema.js";
import { extractJson } from "../haiku/json.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import type { TranscriptCache } from "../transcript.js";
import { loadMainTranscriptItems } from "../transcript.js";

/** Obergrenzen für den Auszug (Haiku soll schnell und günstig bleiben). */
const MESSAGE_MAX = 1500;
const HEAD_CHARS = 8_000;
const TOTAL_CHARS = 40_000;
const FILES_MAX = 40;
/** Eine hängengebliebene Prüfung (Server-Neustart mitten im Lauf) sperrt nicht für immer. */
const RUNNING_STALE_MS = 15 * 60_000;

export const AUDIT_SYSTEM = `Du bist Nyx und prüfst eine Claude-/Codex-Session für den Nutzer. Schreib einfach und kurz, ohne Fachchinesisch.
Antworte NUR mit JSON in genau dieser Form:
{"zusammenfassung":"<2-3 Sätze: worum ging es, wie weit ist es>","gemacht":["<was wurde gemacht>"],"erledigt":["<was ist fertig und belegt>"],"offen":["<was ist noch offen oder unklar>"],"qualitaet":{"note":"gut"|"mittel"|"schwach","text":"<1-2 Sätze: wie sauber wurde gearbeitet (Tests, Prüfungen, Nachfragen)>"},"risiken":["<was kann schiefgehen, was sollte der Nutzer prüfen>"]}
Regeln: Nur, was im Verlauf steht – nichts erfinden. „erledigt“ nur, wenn die Session es selbst sagt oder ein Test/Build es zeigt. Höchstens 6 Punkte je Liste. Leere Liste, wenn es nichts gibt.`;

const time = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 16);
};

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  return clean.length > max ? `${clean.slice(0, max)} […gekürzt, ${clean.length} Zeichen]` : clean;
}

function line(item: TranscriptItem, who: string): string | null {
  if (item.role === "user") return item.text ? `[Nutzer ${time(item.ts)}] ${clip(item.text, MESSAGE_MAX)}` : null;
  if (item.role === "assistant") return item.text ? `[${who} ${time(item.ts)}] ${clip(item.text, MESSAGE_MAX)}` : null;
  if (item.role === "tool" && item.tool) return `[Werkzeug] ${item.tool.name}${item.tool.target ? ` · ${clip(item.tool.target, 160)}` : ""}${item.tool.status === "error" ? " ✗" : ""}`;
  if (item.role === "subagent" && item.subagent) return `[Sub-Agent] ${item.subagent.title ?? item.subagent.id}`;
  if (item.role === "system" && !item.internal && item.text) return `[Hinweis] ${item.text}`;
  return null;
}

/** Auszug: Anfang (Auftrag) + möglichst viel vom Ende; ausgelassene Mitte steht sichtbar drin. */
export function digestTranscript(items: TranscriptItem[], who: string): { text: string; itemsRead: number; itemsTotal: number } {
  const lines = items.map((i) => line(i, who)).filter((l): l is string => l !== null);
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= TOTAL_CHARS) return { text: lines.join("\n"), itemsRead: lines.length, itemsTotal: lines.length };
  const head: string[] = [];
  let headLen = 0;
  for (const l of lines) {
    if (headLen + l.length > HEAD_CHARS) break;
    head.push(l);
    headLen += l.length + 1;
  }
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const l = lines[i] as string;
    if (tailLen + l.length > TOTAL_CHARS - headLen) break;
    tail.unshift(l);
    tailLen += l.length + 1;
  }
  const skipped = lines.length - head.length - tail.length;
  return { text: [...head, `[… ${skipped} Einträge in der Mitte ausgelassen …]`, ...tail].join("\n"), itemsRead: head.length + tail.length, itemsTotal: lines.length };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 8)
    : [];

/** Antwort von Haiku prüfen und in Form bringen. `null` = unbrauchbar. */
export function parseAudit(raw: string): SessionAuditResult | null {
  const j = extractJson<Record<string, unknown>>(raw);
  if (!j || typeof j.zusammenfassung !== "string" || !j.zusammenfassung.trim()) return null;
  const q = (j.qualitaet ?? {}) as Record<string, unknown>;
  const note = AuditQualitySchema.safeParse(q.note);
  return {
    zusammenfassung: j.zusammenfassung.trim(),
    gemacht: strings(j.gemacht),
    erledigt: strings(j.erledigt),
    offen: strings(j.offen),
    qualitaet: { note: note.success ? note.data : "mittel", text: typeof q.text === "string" ? q.text.trim() : "" },
    risiken: strings(j.risiken),
  };
}

export function toAudit(r: typeof sessionAudits.$inferSelect): SessionAudit {
  return {
    id: r.id,
    sessionKey: r.sessionKey,
    status: r.status as SessionAudit["status"],
    result: (r.result as SessionAuditResult | null) ?? null,
    error: r.error,
    itemsRead: r.itemsRead,
    itemsTotal: r.itemsTotal,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  };
}

/** D-a 11: Prüfungen, die ein Server-Neustart mitten im Lauf hinterlassen hat, ehrlich abschließen. */
export async function closeStaleAudits(db: Db, sessionKey: string, now = Date.now()): Promise<void> {
  const before = new Date(now - RUNNING_STALE_MS).toISOString();
  await db
    .update(sessionAudits)
    .set({ status: "error", error: t("Die Prüfung ist nicht fertig geworden (der Server wurde neu gestartet). Starte sie bitte noch einmal."), finishedAt: new Date(now).toISOString() })
    .where(and(eq(sessionAudits.sessionKey, sessionKey), eq(sessionAudits.status, "running"), lt(sessionAudits.createdAt, before)));
}

export async function runningAudit(db: Db, sessionKey: string, now = Date.now()) {
  const since = new Date(now - RUNNING_STALE_MS).toISOString();
  const [row] = await db
    .select()
    .from(sessionAudits)
    .where(and(eq(sessionAudits.sessionKey, sessionKey), eq(sessionAudits.status, "running"), gte(sessionAudits.createdAt, since)))
    .orderBy(desc(sessionAudits.id))
    .limit(1);
  return row ?? null;
}

export interface AuditDeps {
  db: Db;
  runtime: HaikuRuntime;
  cache: TranscriptCache;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  onChange: (sessionKey: string) => void;
}

/** deutscher Schlüssel, übersetzt beim Ablegen des Fehlers */
const SIMPLE_ERROR = "Nyx konnte die Prüfung gerade nicht schreiben. Versuch es gleich noch einmal.";

/** Führt eine angelegte Prüfung (Zeile `auditId`, Status `running`) zu Ende. Wirft nie. */
export async function runAudit(deps: AuditDeps, auditId: number, sessionKey: string): Promise<void> {
  const { db, runtime, cache, log, onChange } = deps;
  const finish = async (values: Partial<typeof sessionAudits.$inferInsert>) => {
    await db
      .update(sessionAudits)
      .set({ ...values, finishedAt: new Date().toISOString() })
      .where(eq(sessionAudits.id, auditId));
    onChange(sessionKey);
  };
  try {
    const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionKey)).limit(1);
    if (!s) return await finish({ status: "error", error: t("Diese Session gibt es nicht mehr.") });
    const transcript = await loadMainTranscriptItems(db, cache, sessionKey);
    if (!transcript || transcript.items.length === 0) return await finish({ status: "error", error: t("Von dieser Session liegt noch kein Verlauf vor. Sobald die Brücke ihn geschickt hat, geht die Prüfung.") });
    const who = s.tool === "codex" ? "Codex" : "Claude";
    const digest = digestTranscript(transcript.items, who);
    const files = await db.select({ path: sessionFiles.path }).from(sessionFiles).where(and(eq(sessionFiles.sessionKey, sessionKey), eq(sessionFiles.mode, "write"))).limit(FILES_MAX + 1);
    const model = s.lastUsageModel ?? ((s.models ?? []) as string[]).at(-1) ?? null;
    const head = [
      `Session: „${s.title ?? s.sessionId}“ (${who}${model ? `, Modell ${model}` : ""})`,
      `Ordner: ${s.cwd ?? "unbekannt"} · Start: ${s.startedAt ?? "?"} · zuletzt aktiv: ${s.lastActivityAt ?? "?"} · Zustand: ${s.state ?? s.status}`,
      files.length > 0 ? `Geänderte Dateien${files.length > FILES_MAX ? ` (die ersten ${FILES_MAX})` : ""}:\n${files.slice(0, FILES_MAX).map((f) => `- ${f.path}`).join("\n")}` : "Geänderte Dateien: keine",
    ].join("\n");
    await db.update(sessionAudits).set({ itemsRead: digest.itemsRead, itemsTotal: digest.itemsTotal }).where(eq(sessionAudits.id, auditId));
    const res = await runtime.run({ kind: "auswertung", scope: "none", systemPrompt: AUDIT_SYSTEM, prompt: `${head}\n\nVerlauf (älteste zuerst):\n${digest.text}` });
    if (res.type !== "final") {
      log("session-pruefung-fehler", { session: sessionKey, code: res.code, error: res.message });
      return await finish({ status: "error", error: res.code === "budget" ? res.message : t(SIMPLE_ERROR), callId: res.callId });
    }
    const result = parseAudit(res.rawText);
    if (!result) return await finish({ status: "error", error: t("Nyx' Antwort war unvollständig. Starte die Prüfung bitte noch einmal."), callId: res.callId });
    await finish({ status: "done", result, callId: res.callId });
  } catch (e) {
    log("session-pruefung-absturz", { session: sessionKey, error: e instanceof Error ? e.message : String(e) });
    await finish({ status: "error", error: t(SIMPLE_ERROR) }).catch(() => {});
  }
}
