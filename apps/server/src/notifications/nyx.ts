// Nyx checks and/or writes a notification before it goes out.
//
// - Check: send · skip · bundle, with a short reason. Basis: the notification, whether the user is away right now,
//   the free text "Was mir wichtig ist" and the latest feedback ("Passt" / "Brauche ich nicht") as examples.
// - Write: title + text in the chosen style from the session context (name, workstream, last question/answer).
//   Guard rail as for the spoken briefing (`haiku/speech.ts`): every number and every quoted name must appear in the
//   data, otherwise the template text stays.
// - ONE run for both (saves time and budget), hard limit 8 s: after that it goes on as without Nyx.
// The runtime (`HaikuRuntime`, the user's own model/provider via the role `nyx.chat`) comes from outside – so every
// call counts towards Nyx' budget and the file is testable without a model. The prompt is German like all Nyx
// system prompts; the runtime adds the answer language ("Answer in English." in English mode).
import { t, type NotifyStyle, type PushEventKind, type PushPriority } from "@nyxos/shared";
import { extractJson } from "../haiku/json.js";
import { numbersIn } from "../haiku/report.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import type { NotifySessionInfo } from "./session-info.js";

/** What the pipeline needs from the runtime (`HaikuRuntime` fulfils it). */
export type NyxRunner = Pick<HaikuRuntime, "run">;

/** If Nyx doesn't answer this fast, the notification goes out as without Nyx. */
export const NYX_NOTIFY_TIMEOUT_MS = 8000;

export type NyxReviewDecision = "senden" | "weglassen" | "buendeln";

export interface NyxNotifyExample {
  art: string;
  titel: string;
  text: string;
  urteil: "passt" | "brauche ich nicht";
}

export interface NyxNotifyInput {
  kind: PushEventKind;
  kindLabel: string;
  priority: PushPriority;
  away: boolean;
  /** "22:47" */
  time: string;
  style: NotifyStyle;
  /** Text from the template (what would go out without Nyx). */
  title: string;
  body: string;
  was: string;
  details: string | null;
  session: NotifySessionInfo | null;
  important: string;
  examples: NyxNotifyExample[];
  review: boolean;
  write: boolean;
}

export interface NyxNotifyOutcome {
  review: { decision: NyxReviewDecision; reason: string } | { failed: "zeitlimit" | "fehler"; note: string } | null;
  text: { title: string; body: string } | { failed: string } | null;
  ms: number;
}

const BODY_MAX: Record<NotifyStyle, number> = { knapp: 120, zusammenhang: 260, ausfuehrlich: 500 };
const TITLE_MAX = 80;
const REASON_MAX = 120;

const SYSTEM = `Du bist Nyx, der Assistent in NyxOS (Kommandozentrale für die KI-Sessions des Nutzers). NyxOS schickt dem Nutzer Mitteilungen aufs Handy und an seinen Rechner.
Du bekommst EINE Mitteilung, bevor sie rausgeht. Antworte NUR mit einem JSON-Objekt, ohne Text davor oder danach. Die Schlüssel des JSON bleiben genau wie angegeben.
Regeln:
- Verwende nur die gegebenen Daten. Erfinde keine Zahlen, Namen, Dateien oder Ergebnisse.
- Einfach, kurz, ohne Fachchinesisch. Nyx ist geschlechtsneutral; sprich den Nutzer mit „du“ an.
- Kein Markdown, keine Emojis.`;

function styleWords(style: NotifyStyle): string {
  if (style === "knapp") return "knapp: nur was passiert ist und welche Session, höchstens ein paar Wörter";
  if (style === "ausfuehrlich") return "ausführlich: ein Satz, was passiert ist, dazu ein zweiter, was die Session zuletzt gemacht hat";
  return "mit Zusammenhang: genau ein Satz, was passiert ist";
}

export function buildNyxNotifyPrompt(input: NyxNotifyInput): string {
  const s = input.session;
  const data = {
    art: input.kindLabel,
    dringend: input.priority === "urgent",
    nutzer_ist: input.away ? "weg (nicht in NyxOS)" : "gerade in NyxOS",
    uhrzeit: input.time,
    was: input.was,
    zusatz: input.details,
    session: s ? { name: s.name, baustelle: s.baustelle, unter_agent_von: s.parentName, zuletzt_gefragt: s.lastPrompt, zuletzt_geantwortet: s.lastAnswer } : null,
    vorlage: { titel: input.title, text: input.body },
  };
  const tasks: string[] = [];
  const shape: Record<string, string> = {};
  if (input.review) {
    tasks.push(
      `Entscheide, ob diese Mitteilung den Nutzer JETZT erreichen soll: "senden", "weglassen" (unwichtig für ihn) oder "buendeln" (nicht dringend, kann mit der nächsten Sammel-Mitteilung kommen). Im Zweifel "senden".`,
    );
    shape.entscheidung = "senden | weglassen | buendeln";
    shape.grund = `kurzer Satz (höchstens ${REASON_MAX} Zeichen), warum`;
  }
  if (input.write) {
    tasks.push(`Schreibe Titel und Text der Mitteilung neu, Stil ${styleWords(input.style)}. Nenne die Session beim Namen aus den Daten, nie einen rohen Prompt.`);
    shape.titel = `höchstens ${TITLE_MAX} Zeichen`;
    shape.text = `höchstens ${BODY_MAX[input.style]} Zeichen`;
  }
  const important = input.important.trim() ? `\nWas dem Nutzer wichtig ist (seine Worte): ${input.important.trim()}` : "";
  const examples = input.review && input.examples.length > 0 ? `\nSeine letzten Rückmeldungen zu Mitteilungen:\n${input.examples.map((e) => `- ${e.art}: „${e.titel} – ${e.text}“ → ${e.urteil}`).join("\n")}` : "";
  return `${tasks.join("\n")}${important}${examples}\nAntwortformat: ${JSON.stringify(shape)}\nDaten:\n${JSON.stringify(data, null, 1)}`;
}

/** All texts Nyx may take numbers and names from. */
function factText(input: NyxNotifyInput): string {
  const s = input.session;
  return [input.kindLabel, input.time, input.was, input.details ?? "", input.title, input.body, s?.name ?? "", s?.baustelle ?? "", s?.parentName ?? "", s?.lastPrompt ?? "", s?.lastAnswer ?? ""].join("\n");
}

const QUOTED = /[„"“»]([^„"“”»«]{2,80})[“”"«]/g;
/** Links (`https://…`, `www.…`) and anything that looks like `name.ending` (domain, file). */
const ADDRESS = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/\S*)?/gi;

/** Check Nyx' text: length, no invented numbers, quoted names only from the data. `null` = fine. */
export function checkNyxText(title: string, body: string, input: NyxNotifyInput): string | null {
  if (!title.trim() || !body.trim()) return t("leer");
  if (title.length > TITLE_MAX || body.length > BODY_MAX[input.style]) return t("zu lang");
  const facts = factText(input);
  const allowed = numbersIn(facts);
  for (const n of numbersIn(`${title} ${body}`)) if (!allowed.has(n)) return t("Zahl {n} steht nicht in den Daten", { n });
  const lower = facts.toLowerCase();
  for (const m of `${title} ${body}`.matchAll(QUOTED)) {
    const name = (m[1] ?? "").trim().toLowerCase();
    if (name && !lower.includes(name)) return t("Name „{name}“ steht nicht in den Daten", { name: m[1] ?? "" });
  }
  // Session texts are foreign input – an injected sentence must not make Nyx put a link (a sign-in page or the like)
  // on the user's lock screen. Addresses and file names only if they appear verbatim in the data.
  for (const m of `${title} ${body}`.matchAll(ADDRESS)) {
    const addr = m[0].replace(/[.,;:!?)»“”"']+$/u, "").toLowerCase();
    if (addr && !lower.includes(addr)) return t("Adresse „{addr}“ steht nicht in den Daten", { addr });
  }
  return null;
}

const DECISIONS: NyxReviewDecision[] = ["senden", "weglassen", "buendeln"];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Read Nyx' answer (pure, without runtime – for tests). */
export function parseNyxNotify(raw: string, input: NyxNotifyInput): Omit<NyxNotifyOutcome, "ms"> {
  const j = extractJson<Record<string, unknown>>(raw);
  let review: NyxNotifyOutcome["review"] = null;
  let text: NyxNotifyOutcome["text"] = null;
  if (input.review) {
    const d = typeof j?.entscheidung === "string" ? (j.entscheidung.trim().toLowerCase() as NyxReviewDecision) : null;
    review = d && DECISIONS.includes(d) ? { decision: d, reason: clip(typeof j?.grund === "string" ? j.grund.trim() : "", REASON_MAX) } : { failed: "fehler", note: t("Nyx hat keine gültige Entscheidung geliefert") };
  }
  if (input.write) {
    const title = typeof j?.titel === "string" ? j.titel.replace(/\s+/g, " ").trim() : "";
    const body = typeof j?.text === "string" ? j.text.trim() : "";
    const problem = checkNyxText(title, body, input);
    text = problem ? { failed: problem } : { title, body };
  }
  return { review, text };
}

export interface AskNyxDeps {
  runner: NyxRunner;
  timeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Clock (tests). */
  clock?: () => number;
}

/** One Nyx run for checking and/or writing. Never throws: time limit/errors are in the result. */
export async function askNyxAboutNotification(deps: AskNyxDeps, input: NyxNotifyInput): Promise<NyxNotifyOutcome> {
  const clock = deps.clock ?? Date.now;
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? NYX_NOTIFY_TIMEOUT_MS;
  const t0 = clock();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const failAll = (kind: "zeitlimit" | "fehler", note: string): NyxNotifyOutcome => ({
    review: input.review ? { failed: kind, note } : null,
    text: input.write ? { failed: note } : null,
    ms: clock() - t0,
  });
  try {
    const run = deps.runner
      .run({ kind: "mitteilung", lane: "mitteilung", scope: "none", thinking: false, systemPrompt: SYSTEM, prompt: buildNyxNotifyPrompt(input), timeoutMs, signal: ctrl.signal, maxTokens: 400 })
      .catch((e: unknown) => ({ type: "error" as const, code: "engine" as const, message: e instanceof Error ? e.message : String(e), callId: null }));
    const res = await Promise.race([run, timeout]);
    if (res === "timeout") {
      ctrl.abort();
      log("mitteilung-nyx-zeitlimit", { art: input.kind, ms: timeoutMs });
      return failAll("zeitlimit", t("Nyx hat nicht in {n} s geantwortet", { n: Math.round(timeoutMs / 1000) }));
    }
    if (res.type !== "final") {
      const note =
        res.code === "timeout"
          ? t("Nyx hat nicht in {n} s geantwortet", { n: Math.round(timeoutMs / 1000) })
          : res.code === "budget"
            ? t("Nyx-Budget für heute erreicht")
            : t("Nyx war gerade nicht erreichbar");
      log(res.code === "timeout" ? "mitteilung-nyx-zeitlimit" : "mitteilung-nyx-fehler", { art: input.kind, code: res.code });
      return failAll(res.code === "timeout" ? "zeitlimit" : "fehler", note);
    }
    const parsed = parseNyxNotify(res.rawText, input);
    const ms = clock() - t0;
    if (parsed.review) log("mitteilung-nyx-pruefung", { art: input.kind, ms, ...("decision" in parsed.review ? { entscheidung: parsed.review.decision } : { fehler: parsed.review.note }) });
    if (parsed.text) log("mitteilung-nyx-text", { art: input.kind, ms, ok: "title" in parsed.text, ...("failed" in parsed.text ? { grund: parsed.text.failed } : {}) });
    return { ...parsed, ms };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
