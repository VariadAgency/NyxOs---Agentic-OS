// Notifications: ONE pipeline for every occasion (single push to computer/browser/phone and the collected
// notifications while the user is away). Four questions, one setting each:
//   When?        per occasion Always · Only when I'm away · Never; sub-agents off; minimum gap per session
//   How written? style Short · With context · Detailed; own template per occasion with placeholders
//   Nyx checks?  send · skip · bundle (+ reason); "What matters to me"; important ones (urgent, approvals, crashes) always get through
//   Nyx writes?  text from the session context; numbers/names only from the data, otherwise the template text
// Everything server AND web need lives here: occasions, defaults, names, templates and filling in the placeholders
// (the live preview computes with it in the browser exactly like the server).
// Texts are German source texts; labels in the maps are translated where they are shown (`t(meta.label)`),
// default templates are translated before the placeholders are filled (`t(template)` keeps `{…}` untouched).
import { z } from "zod";
import { t } from "./i18n/index.js";
import { auftragLabel, folderName, type SessionLabelInput } from "./session-label.js";
import { AwaySettingsPatchSchema, type AwaySettings } from "./away.js";
import { PushSettingsPatchSchema, type PushEventKind, type PushSettings } from "./push.js";

// ───────────────────────────── Occasions ─────────────────────────────

/** When a notification goes out: always, only while the user is not in NyxOS, or never. */
export const NotifyWhenSchema = z.enum(["always", "away", "never"]);
export type NotifyWhen = z.infer<typeof NotifyWhenSchema>;

export const NotifyStyleSchema = z.enum(["knapp", "zusammenhang", "ausfuehrlich"]);
export type NotifyStyle = z.infer<typeof NotifyStyleSchema>;
export const NOTIFY_STYLE_LABEL: Record<NotifyStyle, { title: string; text: string }> = {
  knapp: { title: "Knapp", text: "Nur was passiert ist und welche Session." },
  zusammenhang: { title: "Mit Zusammenhang", text: "Ein Satz, was passiert ist." },
  ausfuehrlich: { title: "Ausführlich", text: "Dazu, was die Session zuletzt gemacht hat." },
};

export interface NotifyOccasionMeta {
  /** Name in the list "Wann?" (German source text, translate with `t()`). */
  label: string;
  /** One sentence what the occasion is. */
  text: string;
  /** Default level = the behaviour before the pipeline existed (the user adjusts it). */
  defaultWhen: NotifyWhen;
  /** Title of the notification (default template). */
  title: string;
  /** Example for the preview (`{was}` and `{details}`). */
  sample: { was: string; details: string };
  /** Does the occasion belong to a session? (Templates with {session}/{baustelle} only make sense then.) */
  session: boolean;
}

/**
 * The occasions in settings order. The default level is the earlier behaviour: single push "always", the events
 * that used to be reported only in the away digest (session done, task done, new bug) "only when away".
 */
export const NOTIFY_OCCASIONS: Record<PushEventKind, NotifyOccasionMeta> = {
  session_waiting: {
    label: "Session wartet",
    text: "Eine Session ist fertig und wartet seit ein paar Minuten auf deine Antwort.",
    defaultWhen: "always",
    title: "Wartet auf dich",
    sample: { was: "wartet auf dich", details: "Zuletzt: Tests laufen grün, Bericht ist geschrieben." },
    session: true,
  },
  session_done: {
    label: "Session fertig",
    text: "Eine Session hat eine Runde beendet.",
    defaultWhen: "away",
    title: "Session fertig",
    sample: { was: "ist fertig", details: "Zuletzt: Einstellungsseite gebaut, Build grün." },
    session: true,
  },
  session_crashed: {
    label: "Session abgestürzt",
    text: "Eine Session ist unerwartet beendet worden.",
    defaultWhen: "always",
    title: "Session abgestürzt",
    sample: { was: "ist abgestürzt", details: "Das Terminal-Fenster lebt nicht mehr." },
    session: true,
  },
  approval_needed: {
    label: "Frage oder Freigabe nötig",
    text: "Eine Session oder Nyx braucht deine Entscheidung, bevor es weitergeht.",
    defaultWhen: "always",
    title: "Freigabe nötig",
    sample: { was: "git push auf main", details: "Regel: Push nur nach Freigabe." },
    session: true,
  },
  build_red: {
    label: "Build rot",
    text: "Eine Prüfung (Build oder Tests) ist fehlgeschlagen.",
    defaultWhen: "always",
    title: "Build rot",
    sample: { was: "Build rot: web-app – Typfehler in einer Datei", details: "Erster Fehler seit dem letzten grünen Lauf." },
    session: false,
  },
  deploy_failed: {
    label: "Deploy fehlgeschlagen",
    text: "Das Ausrollen auf den Server hat nicht geklappt. Dringend.",
    defaultWhen: "always",
    title: "Deploy fehlgeschlagen",
    sample: { was: "Deploy auf den Server fehlgeschlagen", details: "Der alte Stand läuft weiter." },
    session: false,
  },
  context_guard_hinweis: {
    label: "Kontext-Wächter",
    text: "Das Gedächtnis einer Session ist fast voll – Komprimieren wäre gut.",
    defaultWhen: "always",
    title: "Kontext fast voll",
    sample: { was: "Kontext 65 % – Komprimieren empfohlen", details: "Zuletzt: großes Refactoring über viele Dateien." },
    session: true,
  },
  usage_warning: {
    label: "Nutzungswarnung",
    text: "Die Nutzung von Claude oder Codex liegt über deiner Warnschwelle.",
    defaultWhen: "always",
    title: "Nutzung hoch",
    sample: { was: "Claude: 5-Std-Fenster bei 85 %", details: "Das Fenster setzt sich um 18:00 zurück." },
    session: false,
  },
  night_run_done: {
    label: "Nachtlauf fertig",
    text: "Ein geplanter Lauf in der Nacht ist abgeschlossen.",
    // Used to be only in the away digest (there was no single push for it).
    defaultWhen: "away",
    title: "Nachtlauf fertig",
    sample: { was: "Nachtlauf fertig: Audit (grün)", details: "3 Aufträge erledigt." },
    session: false,
  },
  bug_new: {
    label: "Neuer Bug",
    text: "Ein neuer Bug oder Audit-Fund wurde angelegt.",
    defaultWhen: "away",
    title: "Neuer Bug",
    sample: { was: "Bug (P1): Absturz beim Speichern", details: "Aus dem Audit von heute." },
    session: false,
  },
  auftrag_done: {
    label: "Auftrag erledigt",
    text: "Ein Auftrag ist auf „erledigt“ gewechselt.",
    defaultWhen: "away",
    title: "Auftrag erledigt",
    sample: { was: "Erledigt: Anmeldung umbauen", details: "Geprüft und abgeschlossen." },
    session: false,
  },
};

export const NOTIFY_WHEN_LABEL: Record<NotifyWhen, string> = { always: "Immer", away: "Wenn weg", never: "Nie" };

/**
 * Claude Code creates `…/.claude/worktrees/agent-<id>` for agents with their own workspace. A session in such a
 * folder was started by an agent (trial runs, tests) – not by the user, even without `parent_id`.
 */
export const AGENT_WORKTREE_LIKE = "%/.claude/worktrees/agent-%";
const AGENT_WORKTREE_RE = /\/\.claude\/worktrees\/agent-[^/]+(?:\/|$)/;
export function isAgentWorktree(cwd: string | null | undefined): boolean {
  return !!cwd && AGENT_WORKTREE_RE.test(cwd);
}

/** "Waiting" and "done" are the same message for the SAME session (minimum gap + away digest count them together). */
export function notifyFamily(kind: string): string {
  return kind === "session_waiting" || kind === "session_done" ? "session_turn" : kind;
}

// ───────────────────────────── Settings ─────────────────────────────

export const NotifyTemplateSchema = z.object({
  title: z.string().max(120),
  body: z.string().max(600),
});
export type NotifyTemplate = z.infer<typeof NotifyTemplateSchema>;

const KindKeys = z.enum([
  "session_waiting",
  "session_done",
  "session_crashed",
  "approval_needed",
  "build_red",
  "deploy_failed",
  "context_guard_hinweis",
  "usage_warning",
  "night_run_done",
  "bug_new",
  "auftrag_done",
]);

export const NotifyRulesSchema = z.object({
  when: z.record(KindKeys, NotifyWhenSchema),
  /** Never report sub-agents/teammates of a session (e.g. "Locke: …"). */
  skipSubAgents: z.boolean(),
  /** Minimum gap per session and occasion (minutes, 0 = off). Urgent ones don't count. */
  minGapMinutes: z.number().int().min(0).max(240),
  style: NotifyStyleSchema,
  /** Own templates per occasion (missing = default template of the style). */
  templates: z.partialRecord(KindKeys, NotifyTemplateSchema.nullable()),
  /** Nyx sees every notification before it is sent and decides send/skip/bundle. */
  nyxReview: z.boolean(),
  /** Nyx writes the text from the session context. */
  nyxWrite: z.boolean(),
  /** "What matters to me" – free text for Nyx' check. */
  important: z.string().max(1000),
  /** Nyx cannot filter out urgent ones (deploy failed). */
  protectUrgent: z.boolean(),
  /** When the level of an occasion was last changed (rule suggestions only count feedback after that). */
  whenChangedAt: z.partialRecord(KindKeys, z.string()),
  /** Declined rule suggestions (time) – offered again only after new feedback. */
  dismissedAt: z.partialRecord(KindKeys, z.string()),
});
export type NotifyRules = z.infer<typeof NotifyRulesSchema>;

export const NOTIFY_KINDS = KindKeys.options as readonly PushEventKind[];

export const DEFAULT_NOTIFY_RULES: NotifyRules = {
  when: Object.fromEntries(NOTIFY_KINDS.map((k) => [k, NOTIFY_OCCASIONS[k].defaultWhen])) as NotifyRules["when"],
  skipSubAgents: true,
  minGapMinutes: 10,
  style: "zusammenhang",
  templates: {},
  nyxReview: false,
  nyxWrite: false,
  important: "",
  protectUrgent: true,
  whenChangedAt: {},
  dismissedAt: {},
};

/** Earlier switches → levels: a kind that was switched off stays "never". */
export interface LegacyNotifyChoices {
  /** `push_settings.enabled_kinds` */
  enabledKinds?: Record<string, boolean> | null;
  /** `away_settings.events` */
  awayEvents?: Record<string, boolean> | null;
}
const AWAY_EVENT_OF: Partial<Record<PushEventKind, string>> = {
  session_done: "session_done",
  auftrag_done: "auftrag_done",
  bug_new: "bug_new",
  night_run_done: "night_done",
  approval_needed: "questions",
};

/** Lay stored rules over the defaults; every key checked on its own (broken values → default). */
export function normalizeNotifyRules(raw: unknown, legacy: LegacyNotifyChoices = {}): NotifyRules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <K extends keyof NotifyRules>(key: K): NotifyRules[K] => {
    const parsed = NotifyRulesSchema.shape[key].safeParse(r[key]);
    return parsed.success ? (parsed.data as NotifyRules[K]) : DEFAULT_NOTIFY_RULES[key];
  };
  const whenRaw = (r.when && typeof r.when === "object" ? r.when : {}) as Record<string, unknown>;
  const when = {} as NotifyRules["when"];
  for (const k of NOTIFY_KINDS) {
    const stored = NotifyWhenSchema.safeParse(whenRaw[k]);
    if (stored.success) when[k] = stored.data;
    else {
      const awayKey = AWAY_EVENT_OF[k];
      const off = legacy.enabledKinds?.[k] === false || (awayKey !== undefined && legacy.awayEvents?.[awayKey] === false && NOTIFY_OCCASIONS[k].defaultWhen === "away");
      when[k] = off ? "never" : NOTIFY_OCCASIONS[k].defaultWhen;
    }
  }
  const templatesRaw = (r.templates && typeof r.templates === "object" ? r.templates : {}) as Record<string, unknown>;
  const templates: NotifyRules["templates"] = {};
  for (const k of NOTIFY_KINDS) {
    const tpl = NotifyTemplateSchema.safeParse(templatesRaw[k]);
    if (tpl.success && (tpl.data.title.trim() || tpl.data.body.trim())) templates[k] = tpl.data;
  }
  const stamps = (key: "whenChangedAt" | "dismissedAt") => {
    const src = (r[key] && typeof r[key] === "object" ? r[key] : {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of NOTIFY_KINDS) if (typeof src[k] === "string" && !Number.isNaN(Date.parse(src[k] as string))) out[k] = src[k] as string;
    return out as NotifyRules["whenChangedAt"];
  };
  return {
    when,
    skipSubAgents: pick("skipSubAgents"),
    minGapMinutes: pick("minGapMinutes"),
    style: pick("style"),
    templates,
    nyxReview: pick("nyxReview"),
    nyxWrite: pick("nyxWrite"),
    important: pick("important"),
    protectUrgent: pick("protectUrgent"),
    whenChangedAt: stamps("whenChangedAt"),
    dismissedAt: stamps("dismissedAt"),
  };
}

export const NotifyRulesPatchSchema = z
  .object({
    when: z.partialRecord(KindKeys, NotifyWhenSchema).optional(),
    skipSubAgents: z.boolean().optional(),
    minGapMinutes: NotifyRulesSchema.shape.minGapMinutes.optional(),
    style: NotifyStyleSchema.optional(),
    /** `null` = remove the own template (back to the default). */
    templates: z.partialRecord(KindKeys, NotifyTemplateSchema.nullable()).optional(),
    nyxReview: z.boolean().optional(),
    nyxWrite: z.boolean().optional(),
    important: NotifyRulesSchema.shape.important.optional(),
    protectUrgent: z.boolean().optional(),
    /** Rule suggestion declined ("Nein danke"). */
    dismissSuggestion: KindKeys.optional(),
  })
  .strict();
export type NotifyRulesPatch = z.infer<typeof NotifyRulesPatchSchema>;

// ───────────────────────────── Names ─────────────────────────────

export interface NotifyNameInput extends SessionLabelInput {
  /** First user message (from the events) in case the title is still missing. */
  firstPrompt?: string | null;
}

/** Maximum length of the short topic taken from a message. */
const TOPIC_MAX = 42;
const UUID_LIKE = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,3}(-[0-9a-f]{12})?$/i;
/** Codex sub-agents are called "Locke: <task>" – the nickname in front is not a topic. */
const NICKNAME_PREFIX = /^[A-ZÄÖÜ][a-zäöüß]{2,15}:\s+/;

function cutAtWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  const head = space > cut.length / 2 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:.–—-]+$/u, "")} …`;
}

/**
 * Short topic from a message: first sentence, without slash command ("/goal …"), without sub-agent nickname,
 * without paths, cut at a word end. `null` when nothing useful is left.
 */
export function topicFromPrompt(text: string | null | undefined): string | null {
  if (!text) return null;
  const goal = auftragLabel(text);
  if (goal) return goal;
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  let topic = firstLine
    .replace(/^\/[a-z][\w-]*\s*/i, "")
    .replace(NICKNAME_PREFIX, "")
    .replace(/(?:^|\s)(?:~|\.{0,2})\/[\w./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentenceEnd = topic.search(/[.!?](\s|$)/);
  if (sentenceEnd > 12) topic = topic.slice(0, sentenceEnd);
  topic = topic.replace(/[\s,;:.–—-]+$/u, "").trim();
  if (topic.length < 3) return null;
  return cutAtWord(topic.charAt(0).toUpperCase() + topic.slice(1), TOPIC_MAX);
}

/**
 * The name of a session IN A NOTIFICATION. Unlike `sessionLabel` (lists) never the raw prompt:
 *   1. real title (from Nyx, the index, set by hand) or task ("P3 · Terminal")
 *   2. the workstream ("Website") – short and clear enough on the lock screen
 *   3. short summary of the first message (first sentence, without "/goal", cut)
 *   4. folder, otherwise the tool – never "Session vom 28.09., 22:33" alone
 */
export function notificationName(s: NotifyNameInput): string {
  const title = s.title?.trim() ?? "";
  const junk = title.length < 3 || UUID_LIKE.test(title) || /^(claude|codex):[0-9a-f-]{8,}$/i.test(title);
  if (title && !junk) {
    const goal = auftragLabel(title);
    if (goal) return goal;
    if (s.titleSource !== "prompt") return cutAtWord(title.replace(/\s+/g, " "), 64);
  }
  const baustelle = s.baustelleLabel?.trim();
  if (baustelle) return baustelle;
  const topic = topicFromPrompt(title && s.titleSource === "prompt" ? title : null) ?? topicFromPrompt(s.firstPrompt);
  if (topic) return topic;
  const folder = folderName(s.cwd);
  if (folder) return folder;
  return s.tool === "codex" ? t("Codex-Session") : s.tool === "claude" ? t("Claude-Session") : t("Eine Session");
}

// ───────────────────────────── Templates ─────────────────────────────

/** Placeholders allowed in own templates (with an explanation for the interface; German, translate with `t()`). */
export const NOTIFY_PLACEHOLDERS: { key: string; text: string }[] = [
  { key: "{session}", text: "Name der Session" },
  { key: "{baustelle}", text: "Baustelle bzw. Projekt" },
  { key: "{was}", text: "was passiert ist" },
  { key: "{wann}", text: "Uhrzeit" },
  { key: "{details}", text: "was die Session zuletzt gemacht hat" },
];

type StyleBodies = Record<NotifyStyle, string>;
const SESSION_BODIES = (verb: string): StyleBodies => ({
  knapp: "{session}",
  zusammenhang: `„{session}“ ${verb}.`,
  ausfuehrlich: `„{session}“ ({baustelle}) ${verb}.\n{details}`,
});
/** Occasions without a session bring a finished sentence (build error, usage …) – it stands on its own. */
const FACT_BODIES: StyleBodies = { knapp: "{was}", zusammenhang: "{was}", ausfuehrlich: "{was}\n{details}" };

/** Default text per occasion and style (German source; `renderNotification` translates it). `{was}` is the fact the occasion brings. */
export const DEFAULT_NOTIFY_BODIES: Record<PushEventKind, StyleBodies> = {
  session_waiting: SESSION_BODIES("wartet seit {wann} auf dich"),
  session_done: SESSION_BODIES("ist fertig ({wann})"),
  session_crashed: SESSION_BODIES("ist abgestürzt ({wann})"),
  approval_needed: { knapp: "{was}", zusammenhang: "„{session}“ braucht deine Freigabe: {was}", ausfuehrlich: "„{session}“ ({baustelle}) braucht deine Freigabe: {was}\n{details}" },
  build_red: FACT_BODIES,
  deploy_failed: FACT_BODIES,
  context_guard_hinweis: { knapp: "{session}: {was}", zusammenhang: "„{session}“: {was}.", ausfuehrlich: "„{session}“ ({baustelle}): {was}.\n{details}" },
  usage_warning: FACT_BODIES,
  night_run_done: FACT_BODIES,
  bug_new: FACT_BODIES,
  auftrag_done: FACT_BODIES,
};

export interface NotifyRenderValues {
  session: string | null;
  baustelle: string | null;
  was: string;
  /** "22:47" (the user's time zone). */
  wann: string;
  details: string | null;
}

/** Empty placeholders leave no remains ("()", empty quotes, double spaces, empty lines). */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/\(\s*\)/g, "")
        .replace(/„\s*“/g, "")
        .replace(/“\s*”/g, "")
        .replace(/^\s*[:·–-]\s*/, "")
        .replace(/\s+([.,:;!?)])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0 && !/^[.,:;!?]+$/.test(line))
    .join("\n")
    .trim();
}

export function fillTemplate(template: string, v: NotifyRenderValues): string {
  const map: Record<string, string> = {
    session: v.session ?? "",
    baustelle: v.baustelle ?? "",
    was: v.was,
    wann: v.wann,
    details: v.details ?? "",
  };
  return tidy(template.replace(/\{(session|baustelle|was|wann|details)\}/g, (_m, key: string) => map[key] ?? ""));
}

/**
 * Title + text of a notification from style and (own) template. Without a session `{session}` drops out and `{was}`
 * carries the message (templates with a session would otherwise be empty: then the fact counts).
 * Default templates and titles are translated into the current language; own templates stay as the user wrote them.
 */
export function renderNotification(
  kind: PushEventKind,
  style: NotifyStyle,
  v: NotifyRenderValues,
  custom?: NotifyTemplate | null,
  fallbackTitle?: string | null,
): { title: string; body: string } {
  const meta = NOTIFY_OCCASIONS[kind];
  const defaultTitle = t(meta.title);
  const titleTpl = custom?.title?.trim() || fallbackTitle?.trim() || defaultTitle;
  const bodyTpl = custom?.body?.trim() || t(DEFAULT_NOTIFY_BODIES[kind][style]);
  const title = fillTemplate(titleTpl, v) || defaultTitle;
  let body = fillTemplate(bodyTpl, v);
  // Session template without a session (e.g. an approval from a script): the fact alone.
  if (!body || (meta.session && !v.session && !custom?.body?.trim())) body = fillTemplate(style === "ausfuehrlich" ? "{was}\n{details}" : "{was}", v);
  return { title: title.slice(0, 200), body: (body || v.was).slice(0, 1000) };
}

// ───────────────────────────── History ─────────────────────────────

/** What happened to a notification (column `push_log.decision`). */
export const NotifyDecisionSchema = z.enum([
  "sent",
  "send_failed",
  "quiet_hours",
  "bundled",
  "away_batch",
  "nyx_skip",
  "nyx_bundle",
  "duplicate",
  "min_gap",
  "sub_agent",
  "kind_off",
  "telegram",
  "focus",
]);
export type NotifyDecision = z.infer<typeof NotifyDecisionSchema>;

export const NOTIFY_DECISION_LABEL: Record<NotifyDecision, string> = {
  sent: "Gesendet",
  send_failed: "Kein Weg hat geklappt",
  quiet_hours: "Ruhezeit",
  bundled: "Mit der vorigen zusammengefasst",
  away_batch: "Kommt gesammelt aufs Handy (du warst weg)",
  nyx_skip: "Nyx hat sie weggelassen",
  nyx_bundle: "Nyx bündelt sie mit der nächsten",
  duplicate: "Doppelt – schon gemeldet",
  min_gap: "Mindestabstand – eben erst gemeldet",
  sub_agent: "Unter-Agent – nicht gemeldet",
  kind_off: "Anlass ist aus",
  telegram: "Kommt über Telegram",
  focus: "Fokus – still gestellt",
};

export const NotifyFeedbackSchema = z.enum(["passt", "unnoetig"]);
export type NotifyFeedback = z.infer<typeof NotifyFeedbackSchema>;

export interface NotifyNyxTrace {
  /** Check: decision, or why it went on without Nyx (time limit, error, budget). */
  review?: "senden" | "weglassen" | "buendeln" | "zeitlimit" | "fehler" | "uebersprungen";
  /** Text: written by Nyx or the template (with reason). */
  wrote?: "nyx" | "vorlage";
  /** Short reason (Nyx' sentence or why the template stayed). */
  note?: string;
}

export interface NotifyHistoryItem {
  id: number;
  at: string;
  kind: string;
  kindLabel: string;
  title: string;
  message: string;
  decision: NotifyDecision | null;
  /** In the current language, for the interface ("Nyx hat sie weggelassen – …"). */
  reason: string;
  delivered: boolean;
  bundle: boolean;
  channels: { channel: string; ok: boolean; skipped?: boolean }[];
  nyx: NotifyNyxTrace | null;
  feedback: NotifyFeedback | null;
}

export interface NotifySuggestion {
  kind: PushEventKind;
  /** "Kontext-Wächter nur, wenn ich weg bin?" (current language). */
  text: string;
  when: NotifyWhen;
  /** How often "Brauche ich nicht" since the last change. */
  count: number;
}

export interface NotifyHistoryResponse {
  items: NotifyHistoryItem[];
  suggestions: NotifySuggestion[];
}

export interface NotifyFeedbackResponse {
  ok: true;
  suggestion: NotifySuggestion | null;
}

/** After this many "Brauche ich nicht" for the same kind NyxOS suggests a rule. */
export const NOTIFY_SUGGEST_AFTER = 2;

export function suggestionText(kind: PushEventKind, when: NotifyWhen): string {
  const label = t(NOTIFY_OCCASIONS[kind].label);
  return when === "away" ? t("„{label}“ nur, wenn ich weg bin?", { label }) : t("„{label}“ gar nicht mehr melden?", { label });
}

// ───────────────────────────── Settings (API) ─────────────────────────────

export const NotifyPreviewRequestSchema = z.object({
  kind: KindKeys,
  style: NotifyStyleSchema.optional(),
  template: NotifyTemplateSchema.nullable().optional(),
  /** With Nyx (check/write, depending on the settings) – costs a short Nyx run. */
  withNyx: z.boolean().optional(),
});
export type NotifyPreviewRequest = z.infer<typeof NotifyPreviewRequestSchema>;

export interface NotifyPreviewResponse {
  title: string;
  body: string;
  /** „22:47“ */
  time: string;
  nyx: (NotifyNyxTrace & { decision?: "senden" | "weglassen" | "buendeln" }) | null;
}

/** Example session for the preview (the last active real session, otherwise a placeholder). */
export interface NotifySample {
  session: string;
  baustelle: string | null;
}

/** `GET/PATCH /api/notifications/settings` – everything for the page "Mitteilungen" in one answer. */
export interface NotifySettingsResponse {
  rules: NotifyRules;
  /** Channels, quiet hours, bundling, waiting time, ntfy target, click address (without the secret topic). */
  push: Omit<PushSettings, "topic">;
  /** Away: detection, digest interval, own quiet hours (kept equal to the push quiet hours). */
  away: AwaySettings;
  presence: { away: boolean; lastSeenAt: string | null };
  sample: NotifySample;
  /** Can Nyx check/write right now (a model is set up)? Otherwise notifications go out as without Nyx. */
  nyxReady: boolean;
}

export const NotifySettingsPatchSchema = z
  .object({
    rules: NotifyRulesPatchSchema.optional(),
    push: PushSettingsPatchSchema.optional(),
    away: AwaySettingsPatchSchema.optional(),
  })
  .strict();
export type NotifySettingsPatch = z.infer<typeof NotifySettingsPatchSchema>;
