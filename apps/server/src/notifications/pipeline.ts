// ONE pipeline for every notification occasion (previously two separate systems: single push via
// `push/dispatcher.ts` and the digest "when I'm away" via `away/notifier.ts`):
//
//   occasion → when? → duplicate/minimum gap → text (style/template) → Nyx checks/writes → quiet hours/bundling → channels
//
// - When: per occasion "always" · "only when I'm away" · "never"; sub-agents (session with `parent_id`, e.g. the Codex
//   workers "Locke: …") never by default.
// - Duplicate: the same text at the same time (race) or shortly after → once. Minimum gap per session and occasion
//   ("waiting"/"done" count together). Urgent ones have no minimum gap.
// - Text: name of the session (never the raw prompt, see `notificationName`), style + own template.
// - Nyx (optional): one run through the `HaikuRuntime` (counts towards the budget), 8 s limit → otherwise as without Nyx.
// - Channels: user here → computer, browser, phone. Away → computer/browser as usual, the phone gets the digest
//   (away batch); urgent ones immediately everywhere.
// Every decision is logged with a reason in `push_log` (except "only when away" while present – that is the normal
// case and would flood the history). Clock, Nyx runtime and sending come from outside (purely testable).
import {
  dateTimeFormat,
  DEFAULT_PRIORITY_BY_KIND,
  focusBreaksThrough,
  NOTIFY_KINDS,
  NOTIFY_OCCASIONS,
  notifyFamily,
  renderNotification,
  t,
  type FocusMode,
  type NotifyDecision,
  type NotifyNyxTrace,
  type NotifyRenderValues,
  type NotifyRules,
  type PushEventKind,
  type PushNotifyInput,
  type PushPriority,
  type PushSettings,
} from "@nyxos/shared";
import { and, desc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { AwayBatchKind, AwayEvent } from "../away/notifier.js";
import type { Db } from "../db/client.js";
import { pushLog } from "../db/schema.js";
import { deliverDirect, isQuietNow, logDecision, type NotifyResult } from "../push/deliver.js";
import type { NtfySender } from "../push/ntfy.js";
import { askNyxAboutNotification, type NyxNotifyExample, type NyxRunner } from "./nyx.js";
import { loadNotifyRules } from "./rules.js";
import { detailsFrom, loadSessionInfo, type NotifySessionInfo } from "./session-info.js";

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** What the pipeline needs from the running app. Everything optional except presence. */
export interface NotifyEnv {
  /** Is the user away right now (away detection on and no active NyxOS window)? */
  isAway(): boolean;
  /**
   * Focus button. "away": everything to the phone as while away, computer/browser silent. "dnd": computer/browser
   * never, phone only important things (`focusBreaksThrough`), the rest is in the history with a reason. Missing: auto.
   */
  focus?(): FocusMode;
  /** Put into the away digest (phone only). `false` = it was already in there. */
  enqueueAway?(e: AwayEvent): boolean;
  /** Does Telegram send approvals itself as a card with buttons? Then not additionally into the digest. */
  telegramCoversApprovals?(): boolean;
  /** Does Telegram itself ask about waiting sessions while the user is away (paired + "questions" on)? Then not
   * additionally as a line in the digest (otherwise the same waiting session arrived twice). */
  telegramCoversSessionQuestions?(): boolean;
  /** Nyx runtime (`HaikuRuntime`), `null` = Nyx not available right now. */
  runtime?(): NyxRunner | null;
  /** Stack for "Nyx: bundle with the next one" while the user is present. */
  hold?: NotifyHold;
  log?: Log;
  nyxTimeoutMs?: number;
}

export const NO_ENV: NotifyEnv = { isAway: () => false };

export interface PipelineDeps {
  db: Db;
  sender: NtfySender;
  settings: PushSettings;
  now?: Date;
  env?: NotifyEnv;
}

export interface PipelineOptions {
  /** Event of the away watcher: while the user is away ONLY into the digest (no computer/browser). */
  awayEvent?: { key: string };
}

/** Identical texts within this time count as the same message. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;
/** Decisions where the message reached (or will reach) the user. */
const DELIVERED: NotifyDecision[] = ["sent", "bundled", "away_batch", "nyx_bundle"];
/** Simultaneous runs of the same text (race ticker ↔ ingest): only the first one goes on. */
const inflight = new Set<string>();

/** "22:47" in the user's language and time zone. */
export function clockTime(d: Date): string {
  return Number.isNaN(d.getTime()) ? "" : dateTimeFormat({ hour: "2-digit", minute: "2-digit" }).format(d);
}

/** Which batch kind an occasion has in the away digest. */
export function batchKindOf(kind: PushEventKind): AwayBatchKind {
  return kind === "night_run_done" ? "night_done" : kind;
}

/** One line for the digest. */
function batchLine(text: { title: string; body: string }, rules: NotifyRules): string {
  const first = text.body.split("\n")[0] ?? "";
  const line = rules.style === "knapp" || first.length < 4 ? `${text.title}: ${first}` : first;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

const delivered = or(inArray(pushLog.decision, DELIVERED), and(isNull(pushLog.decision), isNull(pushLog.suppressedReason)));

async function lastInFamily(db: Db, kind: PushEventKind, sessionKey: string, since: Date): Promise<{ sentAt: string } | null> {
  const family = notifyFamily(kind);
  const kinds = NOTIFY_KINDS.filter((k) => notifyFamily(k) === family);
  const [row] = await db
    .select({ sentAt: pushLog.sentAt })
    .from(pushLog)
    .where(and(eq(pushLog.sessionKey, sessionKey), inArray(pushLog.kind, kinds), gte(pushLog.sentAt, since.toISOString()), delivered))
    .orderBy(desc(pushLog.sentAt))
    .limit(1);
  return row ?? null;
}

async function isDuplicate(db: Db, kind: PushEventKind, sessionKey: string | null, message: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_MS).toISOString();
  const [row] = await db
    .select({ id: pushLog.id })
    .from(pushLog)
    .where(and(eq(pushLog.kind, kind), sessionKey ? eq(pushLog.sessionKey, sessionKey) : isNull(pushLog.sessionKey), eq(pushLog.message, message), gte(pushLog.sentAt, since), delivered))
    .limit(1);
  return !!row;
}

/** Occasions Nyx' check never filters out (while "important always gets through" is on) – in addition to anything urgent. */
const NYX_PROTECTED_KINDS: ReadonlySet<PushEventKind> = new Set<PushEventKind>(["approval_needed", "session_crashed"]);

/** The user's latest feedback as examples for Nyx' check. */
export async function feedbackExamples(db: Db, limit = 8): Promise<NyxNotifyExample[]> {
  const rows = await db
    .select({ kind: pushLog.kind, title: pushLog.title, message: pushLog.message, feedback: pushLog.feedback })
    .from(pushLog)
    .where(isNotNull(pushLog.feedback))
    .orderBy(desc(pushLog.feedbackAt))
    .limit(limit);
  return rows.map((r) => ({
    art: NOTIFY_OCCASIONS[r.kind as PushEventKind] ? t(NOTIFY_OCCASIONS[r.kind as PushEventKind].label) : r.kind,
    titel: r.title.slice(0, 80),
    text: r.message.replace(/\s+/g, " ").slice(0, 140),
    urteil: r.feedback === "unnoetig" ? ("brauche ich nicht" as const) : ("passt" as const),
  }));
}

interface Prepared {
  rules: NotifyRules;
  info: NotifySessionInfo | null;
  priority: PushPriority;
  values: NotifyRenderValues;
  text: { title: string; body: string };
}

/** Text in the chosen style (unchanged when the caller gives no fact `what` and no own template applies). */
async function prepare(input: PushNotifyInput, db: Db, now: Date, loaded?: NotifyRules): Promise<Prepared> {
  const rules = loaded ?? (await loadNotifyRules(db));
  const info = input.sessionKey ? await loadSessionInfo(db, input.sessionKey).catch(() => null) : null;
  const at = input.at ? new Date(input.at) : now;
  const values: NotifyRenderValues = {
    session: info?.name ?? null,
    baustelle: info?.baustelle ?? null,
    was: input.what ?? input.message,
    wann: clockTime(Number.isNaN(at.getTime()) ? now : at),
    details: input.detail ?? detailsFrom(info),
  };
  const custom = rules.templates[input.kind] ?? null;
  const text = input.what !== undefined || custom ? renderNotification(input.kind, rules.style, values, custom, input.title) : { title: input.title, body: input.message };
  return { rules, info, priority: input.priority ?? DEFAULT_PRIORITY_BY_KIND[input.kind], values, text };
}

/**
 * Occasions that "never report sub-agents" and the minimum gap apply to – the noisy ones. Approvals, crashes and
 * build errors always come (also from a sub-agent, also twice in a short time).
 */
const SESSION_NOISE_KINDS: ReadonlySet<PushEventKind> = new Set(["session_waiting", "session_done", "context_guard_hinweis"]);

/**
 * Occasions that reach the phone IMMEDIATELY while the user is away, as single notifications instead of waiting in
 * the digest (up to 15 min) – otherwise they would reach the user on the go far too late. Approvals only while
 * Telegram does not send them as a card. During quiet hours they go into the digest (it has its own quiet-hours rule).
 */
const IMMEDIATE_WHEN_AWAY: ReadonlySet<PushEventKind> = new Set(["usage_warning", "session_crashed", "approval_needed"]);

/** Focus "away" / "dnd": the phone only. */
const PHONE_ONLY = { mac: false, browser: false } as const;
const focusAwayNote = (): string => t("Ich bin weg: Rechner und Browser still");

export async function runPipeline(input: PushNotifyInput, deps: PipelineDeps, opts: PipelineOptions = {}): Promise<NotifyResult> {
  const { db } = deps;
  const env = deps.env ?? NO_ENV;
  const now = deps.now ?? new Date();
  // "Only when away" while present is the normal case: don't even load session data, log nothing.
  const early = await loadNotifyRules(db);
  const away = env.isAway();
  if (early.when[input.kind] === "away" && !away) return { sent: false, reason: "not_away" };
  const prepared = await prepare(input, db, now, early);
  const { rules, info, priority, values } = prepared;
  let text = prepared.text;
  const kind = input.kind;
  const urgent = priority === "urgent";
  const sessionKey = input.sessionKey ?? null;
  const path = input.path ?? null;
  const base = { kind, sessionKey, priority, path };
  let nyx: NotifyNyxTrace | null = null;
  const skip = async (decision: NotifyDecision, reason: NonNullable<NotifyResult["reason"]>, note?: string | null): Promise<NotifyResult> => {
    const logId = await logDecision(db, { ...base, title: text.title, message: text.body, decision, note: note ?? null, nyx, now });
    return { sent: false, reason, logId };
  };

  // ── 1. When? ──
  const level = rules.when[kind];
  if (level === "never") return skip("kind_off", "kind_disabled");
  const subAgent = input.subAgent ?? (info !== null && (info.parentId !== null || info.agentWorktree));
  if (subAgent && rules.skipSubAgents && SESSION_NOISE_KINDS.has(kind)) {
    const note = info?.parentName ? t("Helfer von „{name}“", { name: info.parentName }) : info?.agentWorktree ? t("Von einem Agenten in seinem Arbeitsordner gestartet") : null;
    return skip("sub_agent", "sub_agent", note);
  }
  // ── 1b. Focus "do not disturb": only important things get through (and then only to the phone, see step 5) ──
  const focus: FocusMode = env.focus?.() ?? "auto";
  if (focus === "dnd" && level === "always" && !focusBreaksThrough(kind, urgent)) return skip("focus", "focus", t("Nicht stören – Rechner, Browser und Handy still"));
  if (level === "away" && !away) return { sent: false, reason: "not_away" };

  // ── 2. Duplicate / minimum gap ──
  const key = `${kind}|${sessionKey ?? "-"}|${text.body}`;
  if (inflight.has(key)) return skip("duplicate", "duplicate", t("Gleichzeitig schon unterwegs"));
  inflight.add(key);
  try {
    if (!urgent && sessionKey && rules.minGapMinutes > 0 && SESSION_NOISE_KINDS.has(kind)) {
      // "Waiting"/"done": only within the same turn (otherwise the gap swallowed a new waiting turn that began shortly
      // after the last message – and `waiting.ts` never asked again for that turn).
      const gapStart = now.getTime() - rules.minGapMinutes * 60_000;
      const turnStart = notifyFamily(kind) === "session_turn" && input.at ? Date.parse(input.at) : Number.NaN;
      const last = await lastInFamily(db, kind, sessionKey, new Date(Number.isNaN(turnStart) ? gapStart : Math.max(gapStart, turnStart)));
      if (last) return await skip("min_gap", "min_gap", t("Zuletzt {time} gemeldet (Abstand {n} Min)", { time: clockTime(new Date(last.sentAt)), n: rules.minGapMinutes }));
    }
    if (await isDuplicate(db, kind, sessionKey, text.body, now)) return await skip("duplicate", "duplicate");

    // ── 3./4. Nyx checks / writes ──
    // Besides urgent ones also approvals and crashes – if Nyx dropped those, a session would hang silently.
    const protectedKind = urgent || NYX_PROTECTED_KINDS.has(kind);
    const review = rules.nyxReview && !(protectedKind && rules.protectUrgent);
    if (rules.nyxReview && protectedKind && rules.protectUrgent) nyx = { review: "uebersprungen", note: urgent ? t("Dringend – kommt immer durch") : t("Wichtig – kommt immer durch") };
    if (review || rules.nyxWrite) {
      const runner = env.runtime?.() ?? null;
      if (!runner) {
        nyx = { ...(nyx ?? {}), ...(review ? { review: "fehler" as const } : {}), ...(rules.nyxWrite ? { wrote: "vorlage" as const } : {}), note: t("Nyx ist gerade nicht erreichbar") };
      } else {
        const out = await askNyxAboutNotification(
          { runner, timeoutMs: env.nyxTimeoutMs, log: env.log },
          {
            kind,
            kindLabel: t(NOTIFY_OCCASIONS[kind].label),
            priority,
            away,
            time: values.wann,
            style: rules.style,
            title: text.title,
            body: text.body,
            was: values.was,
            details: values.details,
            session: info,
            important: rules.important,
            examples: review ? await feedbackExamples(db) : [],
            review,
            write: rules.nyxWrite,
          },
        );
        const trace: NotifyNyxTrace = { ...(nyx ?? {}) };
        if (out.review) {
          if ("decision" in out.review) {
            trace.review = out.review.decision;
            if (out.review.reason) trace.note = out.review.reason;
          } else {
            trace.review = out.review.failed;
            trace.note = out.review.note;
          }
        }
        if (out.text) {
          if ("title" in out.text) {
            text = out.text;
            trace.wrote = "nyx";
          } else {
            trace.wrote = "vorlage";
            trace.note = trace.note ?? t("Eigener Text verworfen ({reason})", { reason: out.text.failed });
          }
        }
        nyx = trace;
        if (out.review && "decision" in out.review) {
          if (out.review.decision === "weglassen") return await skip("nyx_skip", "nyx_skip", out.review.reason || null);
          if (out.review.decision === "buendeln") {
            const line = batchLine(text, rules);
            if (away && env.enqueueAway) {
              env.enqueueAway({ key: opts.awayEvent?.key ?? `n:${kind}:${sessionKey ?? "-"}:${now.getTime()}`, kind: batchKindOf(kind), label: line, path, important: priority === "high", sessionKey });
              return await skip("nyx_bundle", "nyx_bundle", out.review.reason || null);
            }
            if (env.hold) {
              const res = await skip("nyx_bundle", "nyx_bundle", out.review.reason || null);
              env.hold.add({ kind, line, path, at: now.getTime() });
              return res;
            }
            // No stack available (tests): rather send than lose it.
          }
        }
      }
    }

    // ── 5. Quiet hours / bundling / channels ──
    const message = { ...base, title: text.title, message: text.body };
    const direct = { db, sender: deps.sender, settings: deps.settings, now };
    if (focus === "dnd") {
      // Only important things arrive here (see 1b) – and only on the phone. Approvals with a Telegram card not twice.
      if (kind === "approval_needed" && (env.telegramCoversApprovals?.() ?? false)) {
        const logId = await logDecision(db, { ...message, decision: "telegram", note: t("Nicht stören: kommt als Telegram-Karte"), nyx, now });
        return { sent: false, reason: "telegram", logId };
      }
      return await deliverDirect(message, direct, { channels: PHONE_ONLY, nyx, note: t("Nicht stören: nur aufs Handy") });
    }
    const focusAway = focus === "away";
    if (opts.awayEvent) {
      // Away event: user present (level "always") → normal notification; away → only into the digest.
      if (!away) return await deliverDirect(message, direct, { nyx });
      const added = env.enqueueAway?.({ key: opts.awayEvent.key, kind: batchKindOf(kind), label: batchLine(text, rules), path, important: priority === "high" || priority === "urgent", sessionKey }) ?? false;
      return added ? await skip("away_batch", "away_batch") : await skip("duplicate", "duplicate", t("Steht schon in der Sammel-Mitteilung"));
    }
    const byTelegram =
      (kind === "approval_needed" && (env.telegramCoversApprovals?.() ?? false)) ||
      (kind === "session_waiting" && away && (env.telegramCoversSessionQuestions?.() ?? false));
    if (away && !urgent && IMMEDIATE_WHEN_AWAY.has(kind) && !byTelegram && !isQuietNow(deps.settings, now)) {
      // Immediately on all channels – the multi-channel sender lets these kinds through to the phone also while away.
      // During quiet hours further down into the digest as usual (nothing gets lost there).
      return await deliverDirect(message, direct, focusAway ? { channels: PHONE_ONLY, nyx, note: focusAwayNote() } : { nyx });
    }
    if (away && !urgent) {
      // Away: computer + browser as usual (maybe the user sits at the computer, only NyxOS is closed), the phone gets
      // the digest instead of every message on its own. Approvals with a Telegram card / waiting sessions with a
      // Telegram question not additionally.
      let batched = false;
      let inBatch = false;
      if (!byTelegram && env.enqueueAway) {
        batched = env.enqueueAway({ key: `p:${kind}:${sessionKey ?? "-"}:${now.getTime()}`, kind: batchKindOf(kind), label: batchLine(text, rules), path, important: priority === "high", sessionKey });
        // false = the same session is already in there ("waiting" + "done" are one line).
        inBatch = !batched;
      }
      const phone = byTelegram ? (kind === "session_waiting" ? t("Handy: kommt als Telegram-Frage") : t("Handy: kommt als Telegram-Karte")) : batched ? t("Handy: kommt gesammelt") : inBatch ? t("Handy: steht schon in der Sammel-Mitteilung") : null;
      const fallbackDecision: NotifyDecision = byTelegram ? "telegram" : batched || inBatch ? "away_batch" : "send_failed";
      if (isQuietNow(deps.settings, now)) {
        // Quiet hours: computer/browser silent; the digest still sends important ones (own quiet-hours rule).
        const decision: NotifyDecision = byTelegram ? "telegram" : batched || inBatch ? "away_batch" : "quiet_hours";
        const logId = await logDecision(db, { ...message, decision, note: [focusAway ? focusAwayNote() : t("Ruhezeit: Rechner und Browser still"), phone].filter(Boolean).join(" · "), nyx, now });
        return { sent: false, reason: decision === "quiet_hours" ? "quiet_hours" : decision, logId };
      }
      if (focusAway) {
        // "Away" (chosen on purpose): computer and browser silent, the phone gets it in the digest or via Telegram –
        // or directly when there is no digest.
        if (!byTelegram && !batched && !inBatch) return await deliverDirect(message, direct, { channels: PHONE_ONLY, nyx, note: focusAwayNote() });
        const logId = await logDecision(db, { ...message, decision: fallbackDecision, note: [focusAwayNote(), phone].filter(Boolean).join(" · "), nyx, now });
        return { sent: false, reason: fallbackDecision === "telegram" ? "telegram" : "away_batch", logId };
      }
      return await deliverDirect(message, direct, { channels: { ntfy: false }, nyx, note: phone, fallbackDecision });
    }
    return await deliverDirect(message, direct, focusAway ? { channels: PHONE_ONLY, nyx, note: focusAwayNote() } : { nyx });
  } finally {
    inflight.delete(key);
  }
}

// ───────────────────────────── "Nyx: bundle with the next one" ─────────────────────────────

interface HeldItem {
  kind: PushEventKind;
  line: string;
  path: string | null;
  at: number;
}

/**
 * What Nyx wants to "bundle with the next one" while the user is present: collect and send as ONE notification after
 * the digest interval. If the user is away by then, everything moves into the away digest.
 */
export class NotifyHold {
  private items: HeldItem[] = [];

  get size(): number {
    return this.items.length;
  }

  add(item: HeldItem): void {
    this.items.push(item);
  }

  async flush(deps: PipelineDeps & { afterMs: number }): Promise<number> {
    if (this.items.length === 0) return 0;
    const env = deps.env ?? NO_ENV;
    const now = deps.now ?? new Date();
    if (env.isAway() && env.enqueueAway) {
      for (const i of this.items) env.enqueueAway({ key: `h:${i.kind}:${i.at}`, kind: batchKindOf(i.kind), label: i.line, path: i.path, important: false });
      const n = this.items.length;
      this.items = [];
      return n;
    }
    const oldest = Math.min(...this.items.map((i) => i.at));
    if (now.getTime() - oldest < deps.afterMs) return 0;
    const focus: FocusMode = env.focus?.() ?? "auto";
    let items = this.items;
    this.items = [];
    if (focus === "dnd") {
      // "Do not disturb" was switched on after Nyx held these: only what breaks through still goes out (phone only),
      // the rest is logged as silenced – like step 1b of the pipeline.
      const silenced = items.filter((i) => !focusBreaksThrough(i.kind, false));
      for (const i of silenced) {
        await logDecision(deps.db, { kind: i.kind, sessionKey: null, title: t(NOTIFY_OCCASIONS[i.kind].title), message: i.line, priority: "default", path: i.path, decision: "focus", note: t("Nicht stören – Rechner, Browser und Handy still"), now });
      }
      items = items.filter((i) => focusBreaksThrough(i.kind, false));
      if (items.length === 0) return silenced.length;
    }
    const first = items[0] as HeldItem;
    const paths = new Set(items.map((i) => i.path ?? "/overview"));
    const title = items.length === 1 ? t(NOTIFY_OCCASIONS[first.kind].title) : t("NyxOS: {n} Mitteilungen gesammelt", { n: items.length });
    const message = items.map((i) => `• ${i.line}`).join("\n");
    await deliverDirect(
      { kind: first.kind, sessionKey: null, title, message, priority: "default", path: paths.size === 1 ? ([...paths][0] ?? "/overview") : "/overview" },
      { db: deps.db, sender: deps.sender, settings: deps.settings, now },
      { nyx: { review: "buendeln", note: t("Von Nyx gesammelt") }, ...(focus === "auto" ? {} : { channels: PHONE_ONLY }) },
    );
    return items.length;
  }
}
