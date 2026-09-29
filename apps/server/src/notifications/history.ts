// Notification history with reason, feedback "Passt" / "Brauche ich nicht" and rule suggestions.
// "Brauche ich nicht" becomes an example for Nyx' check (`feedbackExamples`) and – from twice for the same kind since
// the last change – a suggestion "Kontext-Wächter nur, wenn ich weg bin?" (or "gar nicht mehr?").
import {
  NOTIFY_KINDS,
  NOTIFY_OCCASIONS,
  NOTIFY_SUGGEST_AFTER,
  suggestionText,
  t,
  type NotifyFeedback,
  type NotifyHistoryItem,
  type NotifyNyxTrace,
  type NotifyRules,
  type NotifySuggestion,
  type NotifyWhen,
  type PushEventKind,
} from "@nyxos/shared";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushLog } from "../db/schema.js";
import { decisionOf, decisionReason, redactSecrets } from "../push/log.js";

/** Kinds outside the occasions (digests, Telegram cards). German source texts, translated in `kindLabel`. */
const EXTRA_KIND_LABEL: Record<string, string> = {
  away_bundle: "Sammel-Mitteilung (du warst weg)",
  away_questions: "Fragen an dich (Telegram)",
  away_question_hint: "Hinweis auf offene Fragen",
  approval_telegram: "Freigabe-Karte (Telegram)",
};

export function kindLabel(kind: string): string {
  const de = NOTIFY_OCCASIONS[kind as PushEventKind]?.label ?? EXTRA_KIND_LABEL[kind];
  return de ? t(de) : kind;
}

type Row = typeof pushLog.$inferSelect;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function toHistoryItem(r: Row): NotifyHistoryItem {
  const decision = decisionOf(r);
  const ways = (r.channels ?? []).filter((c) => !c.skipped);
  const delivered = decision === "sent" || decision === "bundled" ? (r.channels ? ways.some((w) => w.ok) : true) : false;
  const nyx = (r.nyx ?? null) as NotifyNyxTrace | null;
  return {
    id: r.id,
    at: r.sentAt,
    kind: r.kind,
    kindLabel: kindLabel(r.kind),
    title: clip(redactSecrets(r.title), 160),
    message: clip(redactSecrets(r.message), 600),
    decision,
    reason: decisionReason(r),
    delivered,
    bundle: r.bundle || r.bundledCount > 1,
    channels: r.channels ?? [],
    nyx,
    feedback: r.feedback === "passt" || r.feedback === "unnoetig" ? r.feedback : null,
  };
}

export async function listHistory(db: Db, limit = 50): Promise<NotifyHistoryItem[]> {
  const rows = await db.select().from(pushLog).orderBy(desc(pushLog.sentAt), desc(pushLog.id)).limit(limit);
  return rows.map(toHistoryItem);
}

/** The next, stricter level (always → only when away → never). */
function stricter(when: NotifyWhen): NotifyWhen | null {
  return when === "always" ? "away" : when === "away" ? "never" : null;
}

/** Rule suggestions from the feedback (only "Brauche ich nicht" since the last change or decline). */
export async function computeSuggestions(db: Db, rules: NotifyRules, now = new Date()): Promise<NotifySuggestion[]> {
  const since = new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString();
  const rows = await db
    .select({ kind: pushLog.kind, at: pushLog.feedbackAt })
    .from(pushLog)
    .where(and(eq(pushLog.feedback, "unnoetig"), gte(pushLog.feedbackAt, since)));
  const out: NotifySuggestion[] = [];
  for (const kind of NOTIFY_KINDS) {
    const next = stricter(rules.when[kind]);
    if (!next) continue;
    const floor = Math.max(Date.parse(rules.whenChangedAt[kind] ?? "") || 0, Date.parse(rules.dismissedAt[kind] ?? "") || 0);
    const count = rows.filter((r) => r.kind === kind && r.at && Date.parse(r.at) > floor).length;
    if (count >= NOTIFY_SUGGEST_AFTER) out.push({ kind, when: next, count, text: suggestionText(kind, next) });
  }
  return out;
}

/** Store feedback; `null` = no such entry. Returns a rule suggestion for this kind if one is due now. */
export async function recordFeedback(db: Db, id: number, value: NotifyFeedback, rules: NotifyRules, now = new Date()): Promise<{ suggestion: NotifySuggestion | null } | null> {
  const [row] = await db.update(pushLog).set({ feedback: value, feedbackAt: now.toISOString() }).where(eq(pushLog.id, id)).returning({ kind: pushLog.kind });
  if (!row) return null;
  if (value !== "unnoetig") return { suggestion: null };
  const all = await computeSuggestions(db, rules, now);
  return { suggestion: all.find((s) => s.kind === row.kind) ?? null };
}
