// EINE Nyx-Runde für alle Kanäle (Web-Chat, Stimme im Tab/Begleiter, Telegram). Vorher steckte die Runde
// nur im Chat-Weg (`routes/haiku.ts`), Telegram hatte einen eigenen, alten Haiku-Weg ohne Gedächtnis, Plan,
// Sprechfassung und Verdichtung. Jetzt: gleicher System-Prompt (Kanal-Regeln), gleiches eingefrorenes Gedächtnis,
// gleiche Liste offener Aufgaben, gleiche Modell-Rolle und Profil-Hinweise, gleiche Live-Zustände.
import type { HaikuContext, HaikuSource, HaikuStreamEvent, HaikuUsage, NyxAnswerLength, NyxChannel } from "@nyxos/shared";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { haikuMessages, haikuThreads } from "../db/schema.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { localDay } from "../haiku/settings.js";
import { localStamp } from "../haiku/tools.js";
import { SUMMARY_PREFIX } from "./compaction.js";
import { correctApprovalPromise, correctFalseSendClaim, fixKnownTypos, SendClaimStream } from "./honesty.js";
import type { NyxCore } from "./index.js";
import { nyxCallOptions, roleForChannel } from "./model.js";
import { loadNyxProfile } from "./personaDefault.js";
import { AnswerGate, fillerFor } from "./answerGate.js";
import { withChannelNote } from "./prompt.js";
import { toSpeakText } from "./speak.js";
import { getTodos, openTodosBlock } from "./todo.js";
import { t, timeZone } from "@nyxos/shared";

/** Prüfstand: Wie viel vom bisherigen Faden mitgeht. Statt `--resume` (Kontext wuchs je Runde, alte
 * Werkzeug-Ergebnisse blieben als veraltete Zahlen im Gedächtnis) bekommt Haiku einen kurzen Verlauf: die
 * erste Frage, die letzten Runden mit Antwort und dazwischen nur die Fragen. */
export const THREAD_KEEP_FULL = 3;
const THREAD_ANSWER_CHARS = 500;
const THREAD_QUESTION_CHARS = 200;
const THREAD_MIDDLE_MAX = 8;
/** So viele jüngste Nachrichten reichen für {@link threadHistory} (je Runde 2, plus Puffer für Fehl-Runden). */
const THREAD_HISTORY_ROWS = 4 * (THREAD_KEEP_FULL + THREAD_MIDDLE_MAX + 1);

export function threadHistory(messages: { role: string; text: string }[]): string {
  const pairs: { q: string; a: string | null }[] = [];
  for (const m of messages) {
    if (m.role === "user") pairs.push({ q: m.text, a: null });
    else if (m.role === "assistant" && pairs.length > 0) (pairs[pairs.length - 1] as { a: string | null }).a = m.text;
  }
  if (pairs.length === 0) return "";
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ").trim();
  const full = pairs.slice(-THREAD_KEEP_FULL);
  const earlier = pairs.slice(0, -THREAD_KEEP_FULL);
  const lines: string[] = [];
  if (earlier.length > 0) {
    lines.push(`Erste Frage: ${cut(earlier[0]?.q ?? "", THREAD_QUESTION_CHARS)}`);
    const middle = earlier.slice(1);
    const skipped = Math.max(0, middle.length - THREAD_MIDDLE_MAX);
    if (skipped > 0) lines.push(`(${skipped} ältere Fragen ausgelassen)`);
    for (const p of middle.slice(-THREAD_MIDDLE_MAX)) lines.push(`Frage: ${cut(p.q, THREAD_QUESTION_CHARS)}`);
  }
  for (const p of full) {
    lines.push(`Frage: ${cut(p.q, THREAD_QUESTION_CHARS)}`);
    if (p.a) lines.push(`Deine Antwort: ${cut(p.a, THREAD_ANSWER_CHARS)}`);
  }
  return `Bisheriges Gespräch (gekürzt; Zahlen darin können veraltet sein):\n${lines.join("\n")}`;
}

export function contextLine(ctx: HaikuContext): string {
  const parts = [`Pfad ${ctx.path}`];
  if (ctx.tab) parts.push(`Tab „${ctx.tab}“`);
  const f = Object.entries(ctx.filters ?? {});
  if (f.length) parts.push(`Filter ${f.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (ctx.openSessionId) parts.push(`geöffnete Session ${ctx.openSessionId}${ctx.title ? ` („${ctx.title}“)` : ""}`);
  if (ctx.openEntryId) parts.push(`geöffneter Eintrag ${ctx.openEntryId}`);
  return parts.join(" · ");
}

export type HaikuThreadRow = typeof haikuThreads.$inferSelect;

export interface NyxTurnDeps {
  db: Db;
  runtime: HaikuRuntime;
  nyx: NyxCore;
  /** Liste/Status im Web neu laden (`{type:"haiku", what}`). */
  notify: (what: "threads" | "status") => void;
}

export interface NyxTurnInput {
  /** Bestehender Faden (vom Aufrufer geprüft) – ohne: neuer Faden. */
  thread?: HaikuThreadRow;
  /** des Nutzers Nachricht, so wie sie gespeichert wird. */
  message: string;
  context: HaikuContext;
  channel: NyxChannel;
  /** Neuer Faden: Wegwerf-Faden, Thema und Titel (Standard: Tab bzw. Anfang der Nachricht). */
  temporary?: boolean;
  topic?: string;
  title?: string;
  /** Statt „Der Nutzer sieht gerade: …“ (z. B. Telegram: er schreibt vom Handy). */
  whereLine?: string;
  /** Hängt nur im Prompt an die Nachricht (z. B. Anhänge aus Telegram). */
  promptSuffix?: string;
  /**
   * der Nutzer sitzt NICHT vor NyxOS (Telegram, auch Sprachnachrichten dort). die Browser-Steuerung (`ui_*`) bleibt –
   * Nyx nutzt sie nur, wenn der Nutzer ausdrücklich etwas im offenen NyxOS-Fenster klicken/zeigen lässt (Lage-Zeile).
   */
  remote?: boolean;
  /** Längen-Wahl an der Eingabe (Auto · Kurz · Normal · Ausführlich) – überschreibt für diese Runde den Regler. */
  length?: NyxAnswerLength;
  signal?: AbortSignal;
}

/**
 * Eine Nyx-Runde als Ereignis-Strom (`thread`, `status`, `delta`, `done`/`error`). Speichert Frage und Antwort
 * (mit Sprechfassung `speak`), meldet `nyx.state` (thinking → tool → idle) und stößt danach Lernprüfung/Verdichtung an.
 * Befehl „verdichten“ bzw. „/compact [Thema]“ in einem bestehenden Faden verdichtet statt zu antworten.
 */
export async function* runNyxTurn(deps: NyxTurnDeps, input: NyxTurnInput): AsyncGenerator<HaikuStreamEvent> {
  const { db, runtime, nyx } = deps;
  const { message, context, channel } = input;
  let thread = input.thread;
  // Verlauf VOR der neuen Frage, gekürzt (statt `--resume`, s. threadHistory).
  // HB: die JÜNGSTEN Nachrichten (absteigend holen, dann umdrehen) plus die erste Frage.
  const earlier: { id: number; role: string; text: string }[] = [];
  if (thread) {
    // nach einer Verdichtung nur noch Nachrichten NACH der Zusammenfassung (sie steht davor).
    const after = thread.summaryUptoId ? gt(haikuMessages.id, thread.summaryUptoId) : undefined;
    const cols = { id: haikuMessages.id, role: haikuMessages.role, text: haikuMessages.text };
    // Karten aus dem Menü „⋯“ (role = note) sind keine Gesprächsrunden und bleiben draußen.
    const turn = and(eq(haikuMessages.threadId, thread.id), inArray(haikuMessages.role, ["user", "assistant"]), after);
    const recent = (await db.select(cols).from(haikuMessages).where(turn).orderBy(desc(haikuMessages.id)).limit(THREAD_HISTORY_ROWS)).reverse();
    const [firstQ] = thread.summary ? [] : await db.select(cols).from(haikuMessages).where(and(eq(haikuMessages.threadId, thread.id), eq(haikuMessages.role, "user"))).orderBy(haikuMessages.id).limit(1);
    if (firstQ && recent[0]?.id !== firstQ.id) earlier.push(firstQ);
    earlier.push(...recent);
  }
  const history = [thread?.summary ? `${SUMMARY_PREFIX}\n\n${thread.summary}` : "", threadHistory(earlier)].filter(Boolean).join("\n\n");
  const compactCmd = thread ? /^\/?(verdichten|compact)\b\s*(.*)$/is.exec(message.trim()) : null;
  // erst prüfen, ob Nyx überhaupt antworten kann – sonst entstünden Fäden ohne Antwort.
  const denied = await runtime.preflight("chat", roleForChannel(channel));
  if (denied) {
    yield { type: "error", code: denied.code, message: denied.message };
    return;
  }
  if (!thread) {
    // Gedächtnis-Abbild beim Anlegen einfrieren (Prompt je Faden stabil, Hermes).
    [thread] = await db
      .insert(haikuThreads)
      .values({ scope: "full", topic: input.topic ?? context.tab ?? "allgemein", day: localDay(new Date()), title: (input.title ?? message).slice(0, 80), temporary: input.temporary === true, memorySnapshot: await nyx.freezeMemory() })
      .returning();
  } else if (thread.memorySnapshot === null) {
    // Alte Fäden (vor N1): beim ersten Nyx-Lauf einmal einfrieren.
    [thread] = await db.update(haikuThreads).set({ memorySnapshot: await nyx.freezeMemory() }).where(eq(haikuThreads.id, thread.id)).returning();
  }
  const th = thread as HaikuThreadRow;
  const [userMsg] = await db.insert(haikuMessages).values({ threadId: th.id, role: "user", text: message, context, channel }).returning({ id: haikuMessages.id });
  const done = async (text: string, extra: { sources?: HaikuSource[]; estimate?: boolean; usage?: HaikuUsage; callId?: number | null; thoughts?: string[] } = {}): Promise<HaikuStreamEvent> => {
    const speak = toSpeakText(text);
    const [msg] = await db
      .insert(haikuMessages)
      .values({ threadId: th.id, role: "assistant", text, sources: extra.sources ?? [], estimate: extra.estimate ?? false, callId: extra.callId ?? null, channel, speak })
      .returning({ id: haikuMessages.id });
    return {
      type: "done",
      messageId: (msg as { id: number }).id,
      text,
      speak,
      sources: extra.sources ?? [],
      estimate: extra.estimate ?? false,
      usage: extra.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
      callId: extra.callId ?? undefined,
      ...(extra.thoughts?.length ? { thoughts: extra.thoughts } : {}),
    };
  };
  yield { type: "thread", threadId: th.id };
  if (compactCmd) {
    yield { type: "status", status: "thinking" };
    const r = await nyx.compact(th.id, compactCmd[2]?.trim() || null);
    yield await done(compactAnswer(r));
    await db.update(haikuThreads).set({ updatedAt: new Date().toISOString() }).where(eq(haikuThreads.id, th.id));
    deps.notify("threads");
    return;
  }
  const todos = openTodosBlock(await getTodos(db, th.id));
  const call = nyxCallOptions(roleForChannel(channel), await loadNyxProfile(db), channel, input.length);
  // Auch von unterwegs (Telegram) darf Nyx den NyxOS-Cursor benutzen – Der Nutzer will „Tab wechseln, Session anklicken,
  // reinschreiben“ per Telegram. Die Lage-Zeile sagt Nyx, dass er es nur auf ausdrücklichen Wunsch tut.
  const systemPrompt = await nyx.systemPrompt({ channel, memoryBlock: th.memorySnapshot, ...(input.length ? { length: input.length } : {}) });
  const where = input.whereLine ?? `Der Nutzer sieht gerade: ${contextLine(context)}`;
  const question = `${message}${input.promptSuffix ? `\n\n${input.promptSuffix}` : ""}`;
  nyx.state({ state: "thinking", threadId: th.id, channel });
  // Nyx-Prüfung G16 (+ Kritik): Versand-Behauptungen nur korrigieren, wenn in dieser Runde wirklich nichts nach außen
  // gehen kann. Über Telegram gefragt (auch Sprachnachricht, Kanal „voice“ + remote) geht die Antwort dorthin; eine
  // geplante Aufgabe (`schedule`, z. B. `run` sofort) kann bei verbundenem Telegram zustellen.
  const remoteTurn = input.remote === true || channel === "telegram";
  const telegramReady = remoteTurn ? true : await nyx.notifier.channelReady("telegram");
  const usedTools: string[] = [];
  const mayClaimSend = (tools: readonly string[]) => !remoteTurn && !(telegramReady && tools.includes("schedule"));
  // Live-Strom: satzweise erst prüfen, dann weitergeben – sonst wäre die erfundene Meldung schon gezeigt bzw. vorgelesen
  // (die Stimme spricht die Deltas). Nur wenn es drauf ankommt (Stimme immer, sonst wenn die Bitte vom Senden
  // handelt), damit normale Web-Antworten weiter Wort für Wort erscheinen.
  const sendGuard =
    !remoteTurn && (channel === "voice" || /telegram|e-?mail|\bmail|schick|send|weiterleit|forward/i.test(message)) ? new SendClaimStream(() => mayClaimSend(usedTools)) : null;
  // Text vor einem Werkzeug ist Denken (`thought`, nie gesprochen); beim ersten Werkzeug EINE Zwischenmeldung.
  const gate = new AnswerGate({ filler: fillerFor(message) });
  let idleSent = false;
  const emit = function* (events: ReturnType<AnswerGate["push"]>): Generator<HaikuStreamEvent> {
    for (const g of events) {
      if (g.type === "delta") {
        const out = sendGuard ? sendGuard.push(g.text) : g.text;
        if (out) yield { type: "delta", text: out };
      } else {
        // Zurückgenommener Entwurf: was der Satz-Prüfer noch hielt, gehört zum Gedanken – verwerfen.
        if (g.type === "thought" && g.retract) sendGuard?.end();
        yield g;
      }
    }
  };
  try {
    for await (const ev of runtime.ask({
      kind: "chat",
      scope: "full",
      systemPrompt,
      prompt: `Jetzt: ${localStamp(new Date().toISOString())} (${timeZone()}). ${where}\n\n${history ? `${history}\n\n` : ""}${todos ? `${todos}\n\n` : ""}${history || todos ? "Neue Frage:\n" : ""}${withChannelNote(channel, question, message, input.length)}`,
      resumeSessionId: null,
      threadId: th.id,
      messageId: (userMsg as { id: number }).id,
      // Rolle → N5 `resolveModel(role)` im Motor-Wähler; Hinweise des Kanals wirken im Motor.
      role: call.role,
      thinking: call.thinking,
      maxTokens: call.maxTokens,
      // lange Antworten (bis 8000 Tokens bei ~60 Tokens/s) sollen nicht am festen 90-s-Limit scheitern.
      ...(call.maxTokens ? { timeoutMs: Math.max(90_000, call.maxTokens * 25 + 30_000) } : {}),
      // app_api: nur diese Runde (vom Nutzer selbst) darf über app_api schreiben – der Server setzt den Kanal.
      channel,
      question: message,
      signal: input.signal,
    })) {
      if (ev.type === "status") {
        if (ev.status === "tool") nyx.state({ state: "tool", ...(ev.tool ? { tool: ev.tool.slice(0, 80) } : {}), threadId: th.id, channel });
        if (ev.status === "tool" && ev.tool) usedTools.push(ev.tool);
        if (ev.status === "tool") yield* emit(gate.tool());
        yield { type: "status", status: ev.status, tool: ev.tool, position: ev.position };
      } else if (ev.type === "delta") {
        yield* emit(gate.push(ev.text));
      } else if (ev.type === "error") {
        yield* emit(gate.end());
        const rest = sendGuard?.end();
        if (rest) yield { type: "delta", text: rest };
        // Was schon geschrieben war, bleibt im Faden (als abgebrochen markiert) – sonst weiß Nyx beim nächsten
        // „Mach weiter“ nicht mehr, was er gesagt hat.
        // nur der Abschnitt nach dem letzten Werkzeug (nie ein Gedanke), mit denselben Korrekturen wie eine
        // fertige Antwort. Hat der Nutzer selbst abgebrochen (Stopp/ins Wort gefallen), speichert der Client, was er
        // gehört hat (`/threads/:id/interrupted`) – hier nichts, sonst stünde die Antwort doppelt im Faden.
        let partial = input.signal?.aborted ? "" : fixKnownTypos(gate.partial());
        if (partial && mayClaimSend(usedTools)) partial = correctFalseSendClaim(partial, channel);
        if (partial) await db.insert(haikuMessages).values({ threadId: th.id, role: "assistant", text: partial, channel, interrupted: true, speak: toSpeakText(partial) });
        yield { type: "error", code: ev.code, message: ev.message };
      } else {
        yield* emit(gate.end());
        const rest = sendGuard?.end();
        if (rest) yield { type: "delta", text: rest };
        //: Tippfehler bei Fachwörtern + kein Versprechen „läuft nach Freigabe von selbst“.
        const tools = ev.toolCalls ?? [];
        // nur die Antwort nach dem letzten Werkzeug – Gedanken gehen getrennt mit (`thoughts`).
        // die gestreamte Antwort (nach dem letzten Werkzeug) ist maßgeblich – das Claude-Programm liefert als
        // Ergebnis nur seine LETZTE Nachricht; bei einer Fortsetzung fehlte sonst der Anfang. Ohne Strom (Reserve-API)
        // bleibt der Endtext.
        const streamedAnswer = gate.partial();
        let text = fixKnownTypos(streamedAnswer.length >= gate.answer(ev.text).length ? streamedAnswer : gate.answer(ev.text));
        if (tools.includes("freigabe_anfragen")) text = correctApprovalPromise(text);
        // keine erfundene Telegram-/Mail-Nachricht, außer in dieser Runde konnte wirklich etwas raus.
        if (mayClaimSend(tools)) text = correctFalseSendClaim(text, channel);
        // Die Antwort steht – sofort „idle“ melden, nicht erst nach dem Aufräumen (sonst hing im Tab noch
        // „tool“ und Nyx wurde nach dem ersten Grün noch einmal orange). Ohne Antwort (Fehler) meldet es `finally`.
        nyx.state({ state: "idle", threadId: th.id, channel });
        idleSent = true;
        yield await done(text, { sources: ev.sources, estimate: ev.estimate, usage: ev.usage, callId: ev.callId, thoughts: gate.thoughts });
        await db
          .update(haikuThreads)
          // Wer in einem archivierten Faden weiterschreibt, holt ihn zurück in die Liste.
          .set({ claudeSessionId: ev.claudeSessionId ?? th.claudeSessionId, updatedAt: new Date().toISOString(), archivedAt: null })
          .where(eq(haikuThreads.id, th.id));
        await nyx.afterTurn(th.id, tools);
      }
    }
  } finally {
    if (!idleSent) nyx.state({ state: "idle", threadId: th.id, channel });
    deps.notify("status");
  }
}

/** Antwort auf „verdichten“ in einfachen Worten. */
export function compactAnswer(r: { mode: "modell" | "notfall" | "nichts"; compactedMessages: number }): string {
  return r.mode === "nichts"
    ? t("Da gibt es noch nichts zu verdichten – der Chat ist kurz genug.")
    : r.mode === "notfall"
      ? t("Verdichtet: {n} ältere Nachrichten sind jetzt eine Zusammenfassung (ohne Modell erstellt, weil es gerade nicht antwortet). Die letzten Nachrichten bleiben wörtlich.", { n: r.compactedMessages })
      : t("Verdichtet: {n} ältere Nachrichten sind jetzt eine Zusammenfassung. Die letzten Nachrichten bleiben wörtlich.", { n: r.compactedMessages });
}
