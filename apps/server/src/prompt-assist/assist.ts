// Prompt verbessern: Kontext der Session (Titel, Ordner, Ziel, Auszug des Verlaufs, geänderte Dateien,
// offene Punkte) + des Nutzers Entwurf → Sonnet 5 (Rolle `prompt.improve`, Denkstufe hoch, s. runtime.ts
// `fixedModelFor`) → JSON { prompt, aenderungen, verstaendnis, fragen }. Ohne Werkzeuge, ein Lauf je Klick.
import {
  PROMPT_IMPROVE_EFFORT,
  PROMPT_IMPROVE_MODEL,
  QUESTION_RANGE,
  type PromptAssistQuestion,
  type PromptAssistRequest,
  type PromptAssistResult,
  type PromptUnderstanding,
  t,
} from "@nyxos/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionFiles, sessions } from "../db/schema.js";
import { extractJson } from "../haiku/json.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { digestTranscript } from "../session-audit/audit.js";
import type { DigestService } from "../session-digest.js";
import { loadMainTranscriptItems, type TranscriptCache } from "../transcript.js";

const FILES_MAX = 30;
const GOAL_MAX = 1_200;
/** Sonnet mit hoher Denkstufe braucht länger als Nyx' Standard-Zeitlimit (90 s). */
export const PROMPT_TIMEOUT_MS = 180_000;
const LIST_MAX = 8;

export const PROMPT_SYSTEM = `Du verbesserst Prompts, die der Nutzer an eine laufende Claude-/Codex-Session schicken will. Er tippt schnell oder diktiert – rechne mit Tippfehlern, Versprechern, Wiederholungen und Sprüngen.
Deine Aufgabe: aus seinem Entwurf einen vollwertigen, klar geschriebenen Prompt machen, den die Session sofort richtig versteht.

Regeln:
- Den Sinn vom Nutzer behalten. Nichts dazuerfinden: keine neuen Anforderungen, Dateien oder Ziele, die weder im Entwurf noch im Session-Stand stehen.
- Tipp- und Diktierfehler glätten, Wiederholungen zusammenfassen, Gedankensprünge ordnen.
- Den Session-Stand nutzen: echte Dateinamen, Ordner, Ziele und offene Punkte nennen, wenn sie zum Entwurf passen. Die Session kennt ihren eigenen Verlauf – nichts nacherzählen, was sie schon weiß, nur worauf sich der Entwurf bezieht.
- Klar gegliedert, je nach Umfang: Ziel · Kontext · Schritte/Anforderungen · Abnahme (woran man merkt, dass es fertig ist). Kurze Entwürfe bleiben kurz – keine aufgeblasene Gliederung für einen Satz.
- Sprache wie der Nutzer schreibt, direkt, ohne Floskeln, ohne Höflichkeitsformeln, ohne Meta-Sätze über den Prompt.
- Ergänzungen/Korrekturen und Antworten auf Rückfragen vom Nutzer haben Vorrang vor dem ursprünglichen Entwurf.
- „verstaendnis“: wie sicher du bist, was der Nutzer will – "hoch", "mittel" oder "niedrig".

Antworte NUR mit JSON in genau dieser Form:
{"prompt":"<der fertige Prompt>","aenderungen":["<kurz: was du verbessert hast>"],"verstaendnis":"hoch"|"mittel"|"niedrig","fragen":[{"id":"f1","frage":"<kurze Rückfrage>","optionen":["<Antwort A>","<Antwort B>"],"mehrfach":false}]}
"aenderungen": höchstens 6 kurze Punkte.`;

const QUESTIONS_ON = `Der Nutzer möchte Rückfragen. Stell sie so, dass er mit einem Häkchen antworten kann: je Frage 2–5 konkrete Antwort-Optionen (kurz), "mehrfach": true nur, wenn mehrere Antworten zugleich sinnvoll sind. Er kann zusätzlich Freitext schreiben.
Anzahl je Verständnis: hoch = 1–2 Fragen, mittel = genau 3, niedrig = genau 5. Frag nach dem, was für einen guten Prompt wirklich fehlt oder wo du ihn falsch verstanden haben könntest. Schreib trotzdem schon deinen besten Prompt.`;
const QUESTIONS_OFF = `Keine Rückfragen: "fragen" ist eine leere Liste.`;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)} […]` : t;
}

/** Eingabe fürs Modell: Session-Stand, dann Entwurf, Ergänzungen, Antworten, Modus. */
export function buildPrompt(context: string, req: PromptAssistRequest): string {
  const parts = [`# Session-Stand\n${context}`, `# Entwurf vom Nutzer\n${req.entwurf}`];
  if (req.bisher) parts.push(`# Dein letzter verbesserter Prompt\n${req.bisher}`);
  if (req.zusaetze?.length) parts.push(`# Ergänzungen/Korrekturen vom Nutzer (neueste zuletzt)\n${req.zusaetze.map((z) => `- ${z}`).join("\n")}`);
  if (req.antworten?.length) {
    const lines = req.antworten.map((a) => {
      const pick = a.auswahl?.length ? a.auswahl.join(", ") : "–";
      return `- ${a.frage}\n  Auswahl: ${pick}${a.text ? `\n  Dazu: ${a.text}` : ""}`;
    });
    parts.push(`# Antworten vom Nutzer auf deine Rückfragen\n${lines.join("\n")}`);
  }
  parts.push(`# Auftrag\n${req.modus === "fragen" ? QUESTIONS_ON : QUESTIONS_OFF}`);
  return parts.join("\n\n");
}

/** Session-Stand, begrenzt auf eine sinnvolle Größe (Auszug des Verlaufs wie bei „Session prüfen“). */
export async function sessionContext(deps: { db: Db; cache: TranscriptCache; digests?: DigestService | null }, sessionKey: string): Promise<string | null> {
  const { db, cache } = deps;
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionKey)).limit(1);
  if (!s) return null;
  const who = s.tool === "codex" ? "Codex" : "Claude";
  const model = s.lastUsageModel ?? ((s.models ?? []) as string[]).at(-1) ?? null;
  const lines = [
    `Titel: ${s.title ?? s.sessionId} · ${who}${model ? ` (Modell ${model})` : ""}`,
    `Ordner: ${s.cwd ?? "unbekannt"}${s.gitBranch ? ` · Branch ${s.gitBranch}` : ""} · Zustand: ${s.state ?? s.status}`,
  ];
  const main = deps.digests ? await deps.digests.forSession(sessionKey).then((d) => d.find((x) => x.agentId === null)?.digest ?? null, () => null) : null;
  if (main?.prompt) lines.push(`Ursprünglicher Auftrag: ${clip(main.prompt, GOAL_MAX)}`);
  const open = (main?.todos ?? []).filter((t) => t.status !== "completed");
  if (open.length > 0) lines.push(`Offene Punkte der Aufgabenliste:\n${open.slice(0, 12).map((t) => `- ${t.status === "in_progress" ? "(läuft) " : ""}${clip(t.content, 200)}`).join("\n")}`);
  const commits = (main?.commits ?? []).slice(-3);
  if (commits.length > 0) lines.push(`Letzte Commits: ${commits.map((c) => `„${clip(c.subject, 120)}“`).join(" · ")}`);
  const files = await db
    .select({ path: sessionFiles.path })
    .from(sessionFiles)
    .where(and(eq(sessionFiles.sessionKey, sessionKey), eq(sessionFiles.mode, "write")))
    .limit(FILES_MAX + 1);
  lines.push(files.length > 0 ? `Geänderte Dateien${files.length > FILES_MAX ? ` (die ersten ${FILES_MAX})` : ""}:\n${files.slice(0, FILES_MAX).map((f) => `- ${f.path}`).join("\n")}` : "Geänderte Dateien: keine");
  const transcript = await loadMainTranscriptItems(db, cache, sessionKey).catch(() => null);
  if (transcript && transcript.items.length > 0) lines.push(`Verlauf (Auszug, älteste zuerst):\n${digestTranscript(transcript.items, who).text}`);
  else lines.push("Verlauf: noch keiner da.");
  return lines.join("\n");
}

const UNDERSTANDING: readonly PromptUnderstanding[] = ["hoch", "mittel", "niedrig"];

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, max)
    : [];

/** Fragen säubern (leer/doppelt raus, eindeutige IDs) und auf die Anzahl zum Verständnis beschneiden. */
export function clampQuestions(verstaendnis: PromptUnderstanding, raw: unknown): PromptAssistQuestion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  const out: PromptAssistQuestion[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    const frage = typeof q?.frage === "string" ? q.frage.trim() : "";
    if (!frage || seen.has(frage.toLowerCase())) continue;
    seen.add(frage.toLowerCase());
    let id = typeof q.id === "string" && q.id.trim() ? q.id.trim().slice(0, 40) : `f${out.length + 1}`;
    while (ids.has(id)) id = `${id}-${out.length + 1}`;
    ids.add(id);
    out.push({ id, frage, optionen: [...new Set(strings(q.optionen, 6))], mehrfach: q.mehrfach === true });
  }
  return out.slice(0, QUESTION_RANGE[verstaendnis].max);
}

/** Antwort von Sonnet prüfen. `null` = unbrauchbar (kein Prompt). */
export function parseAssist(raw: string, modus: PromptAssistRequest["modus"]): Pick<PromptAssistResult, "prompt" | "aenderungen" | "verstaendnis" | "fragen"> | null {
  const j = extractJson<Record<string, unknown>>(raw);
  if (!j || typeof j.prompt !== "string" || !j.prompt.trim()) return null;
  const verstaendnis = UNDERSTANDING.includes(j.verstaendnis as PromptUnderstanding) ? (j.verstaendnis as PromptUnderstanding) : "mittel";
  return {
    prompt: j.prompt.trim(),
    aenderungen: strings(j.aenderungen, LIST_MAX),
    verstaendnis,
    fragen: modus === "fragen" ? clampQuestions(verstaendnis, j.fragen) : [],
  };
}

export type AssistOutcome = { ok: true; result: PromptAssistResult } | { ok: false; status: 404 | 409 | 502 | 504; error: string };

const BROKEN = "Sonnet hat keinen brauchbaren Prompt geliefert. Bitte noch einmal auf „Verbessern“ drücken.";

export async function runPromptAssist(
  deps: { db: Db; runtime: HaikuRuntime; cache: TranscriptCache; digests?: DigestService | null; log: (msg: string, extra?: Record<string, unknown>) => void },
  sessionKey: string,
  req: PromptAssistRequest,
  signal?: AbortSignal,
): Promise<AssistOutcome> {
  const context = await sessionContext(deps, sessionKey);
  if (context === null) return { ok: false, status: 404, error: t("Diese Session gibt es nicht mehr.") };
  const started = Date.now();
  const res = await deps.runtime.run({
    kind: "prompt",
    role: "prompt.improve",
    // eigene Spur – Sonnet denkt bis zu 180 s, Nyx' Chat/Stimme/Briefing sollen solange nicht warten.
    lane: "prompt",
    scope: "none",
    thinking: true,
    systemPrompt: PROMPT_SYSTEM,
    prompt: buildPrompt(context, req),
    timeoutMs: PROMPT_TIMEOUT_MS,
    signal,
  });
  if (res.type !== "final") {
    deps.log("prompt-verbessern-fehler", { session: sessionKey, code: res.code });
    if (res.code === "timeout") return { ok: false, status: 504, error: t("Sonnet hat zu lange gebraucht. Bitte noch einmal versuchen – oder den Entwurf kürzen.") };
    if (res.code === "engine") return { ok: false, status: 502, error: res.message === "Nyx konnte nicht antworten." || res.message === t("Nyx konnte nicht antworten.") ? t("Sonnet konnte gerade nicht antworten. Bitte gleich noch einmal versuchen.") : res.message };
    return { ok: false, status: 409, error: res.message };
  }
  const parsed = parseAssist(res.rawText, req.modus);
  if (!parsed) {
    deps.log("prompt-verbessern-unbrauchbar", { session: sessionKey, callId: res.callId });
    return { ok: false, status: 502, error: t(BROKEN) };
  }
  return { ok: true, result: { ...parsed, model: PROMPT_IMPROVE_MODEL, effort: PROMPT_IMPROVE_EFFORT, costUsd: res.usage.costUsd, durationMs: Date.now() - started } };
}
