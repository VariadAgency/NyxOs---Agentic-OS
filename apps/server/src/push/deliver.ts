// Push — the last step of the notification pipeline: quiet hours, bundling of similar occasions, sending over the
// channels (computer/browser/phone) and the log `push_log` with the decision. This used to be the whole dispatcher;
// the questions "when? how written? Nyx?" are now asked before it by `notifications/pipeline.ts`.
import { t, type NotifyDecision, type NotifyNyxTrace, type PushChannel, type PushChannelResult, type PushEventKind, type PushPriority, type PushSettings } from "@nyxos/shared";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushLog } from "../db/schema.js";
import { isWithinWindow } from "../night/window.js";
import { redactSecrets } from "./log.js";
import type { NtfySender } from "./ntfy.js";

/** true when `now` lies within the quiet-hours window (may cross midnight, default 22:00–08:00) — the same window
 * arithmetic as night mode, see `night/window.ts`. Unlike there, `start === end` means "no quiet hours" here (not
 * "24 h"), the neutral setup for push. */
export function isQuietNow(settings: Pick<PushSettings, "quietStart" | "quietEnd">, now: Date): boolean {
  if (settings.quietStart === settings.quietEnd) return false;
  return isWithinWindow({ start: settings.quietStart, end: settings.quietEnd }, now);
}

/** Channels for the log (only channel + result, no detail text) — basis for Nyx' `mitteilungen_liste`. */
export function logChannels(res: { ok: boolean; channels?: PushChannelResult[] }): { channel: string; ok: boolean; skipped?: boolean }[] {
  // A plain ntfy sender (without a channel list) is exactly one channel: the phone via ntfy.
  if (!res.channels) return [{ channel: "ntfy", ok: res.ok }];
  return res.channels.map((c) => ({ channel: c.channel, ok: c.ok, ...(c.skipped ? { skipped: true } : {}) }));
}

export interface NotifyResult {
  sent: boolean;
  reason?: "kind_disabled" | "quiet_hours" | "send_failed" | "sub_agent" | "not_away" | "nyx_skip" | "nyx_bundle" | "duplicate" | "min_gap" | "away_batch" | "telegram" | "focus";
  /** Result per channel (computer/browser/phone) when something was sent. */
  channels?: PushChannelResult[];
  /** Row in the log (for feedback). */
  logId?: number;
}

export interface DirectMessage {
  kind: PushEventKind;
  sessionKey: string | null;
  title: string;
  message: string;
  priority: PushPriority;
  path: string | null;
}

export interface DirectOptions {
  /** Override channels (e.g. phone off because it comes in the digest). */
  channels?: Partial<Record<PushChannel, boolean>>;
  nyx?: NotifyNyxTrace | null;
  note?: string | null;
  /** If nothing arrived, this goes into the log instead of "Kein Weg hat geklappt" (e.g. "kommt gesammelt"). */
  fallbackDecision?: NotifyDecision;
}

/** One row with a decision in the log (also for notifications that did NOT go out). */
export async function logDecision(
  db: Db,
  m: DirectMessage & { clickUrl?: string | null; decision: NotifyDecision; note?: string | null; nyx?: NotifyNyxTrace | null; now: Date; channels?: { channel: string; ok: boolean; skipped?: boolean }[] | null; bundle?: boolean },
): Promise<number | undefined> {
  const sent = m.decision === "sent" || m.decision === "bundled";
  const [row] = await db
    .insert(pushLog)
    .values({
      kind: m.kind,
      sessionKey: m.sessionKey,
      title: redactSecrets(m.title),
      message: redactSecrets(m.message),
      priority: m.priority,
      clickUrl: m.clickUrl ?? null,
      bundledCount: 1,
      // Older readers (bundling, "already reported?") only know this column: null means "sent".
      suppressedReason: sent ? null : m.decision === "quiet_hours" ? "quiet_hours" : m.decision,
      sentAt: m.now.toISOString(),
      channels: m.channels ?? null,
      bundle: m.bundle ?? false,
      decision: m.decision,
      decisionNote: m.note ? m.note.slice(0, 300) : null,
      nyx: m.nyx ?? null,
    })
    .returning({ id: pushLog.id });
  return row?.id;
}

/**
 * Sends (or bundles/suppresses) a finished notification.
 * - Quiet hours AND priority not `urgent` → logged as quiet hours, not sent.
 * - Within `bundleWindowSeconds` there already is a (really sent) notification of the same kind AND (if given) the
 *   same session → counts up the existing row instead of sending a new one.
 * - Otherwise: normal sending, new row.
 */
export async function deliverDirect(raw: DirectMessage, deps: { db: Db; sender: NtfySender; settings: PushSettings; now: Date }, opts: DirectOptions = {}): Promise<NotifyResult> {
  const { db, sender, settings, now } = deps;
  // Texts can carry session content ("Zuletzt: …", Nyx' text) – never secrets onto the phone/ntfy.sh.
  const m = { ...raw, title: redactSecrets(raw.title), message: redactSecrets(raw.message) };
  const clickUrl = m.path ? `${settings.publicBaseUrl.replace(/\/$/, "")}${m.path}` : null;
  // Channels + ntfy target from the settings; the multi-channel sender distributes to computer/browser/phone.
  const channels = { ...settings.channels, ...(opts.channels ?? {}) };
  const routing = { topic: settings.topic, kind: m.kind, path: m.path, channels, ntfyTarget: settings.ntfyTarget };
  const extra = { nyx: opts.nyx ?? null, note: opts.note ?? null };

  if (isQuietNow(settings, now) && m.priority !== "urgent") {
    const logId = await logDecision(db, { ...m, clickUrl, decision: "quiet_hours", now, ...extra });
    return { sent: false, reason: "quiet_hours", logId };
  }

  if (settings.bundleWindowSeconds > 0) {
    const since = new Date(now.getTime() - settings.bundleWindowSeconds * 1000).toISOString();
    const conds = [eq(pushLog.kind, m.kind), gte(pushLog.sentAt, since), or(eq(pushLog.decision, "sent"), eq(pushLog.decision, "bundled"), isNull(pushLog.decision))];
    if (m.sessionKey) conds.push(eq(pushLog.sessionKey, m.sessionKey));
    const [recent] = await db
      .select()
      .from(pushLog)
      .where(and(...conds))
      .orderBy(desc(pushLog.sentAt))
      .limit(1);
    if (recent && recent.suppressedReason === null) {
      const bundledCount = recent.bundledCount + 1;
      const message = t("{n} neue Meldungen (zuletzt: {message})", { n: bundledCount, message: m.message });
      const res = await sender.send({ ...routing, title: m.title, message, priority: m.priority, clickUrl });
      await db
        .update(pushLog)
        .set({ bundledCount, message: redactSecrets(message), sentAt: now.toISOString(), channels: logChannels(res), decision: res.ok ? "bundled" : "send_failed" })
        .where(eq(pushLog.id, recent.id));
      return res.ok ? { sent: true, channels: res.channels, logId: recent.id } : { sent: false, reason: "send_failed", channels: res.channels, logId: recent.id };
    }
  }

  const res = await sender.send({ ...routing, title: m.title, message: m.message, priority: m.priority, clickUrl });
  const decision: NotifyDecision = res.ok ? "sent" : (opts.fallbackDecision ?? "send_failed");
  const logId = await logDecision(db, { ...m, clickUrl, decision, now, channels: logChannels(res), ...extra });
  if (res.ok) return { sent: true, channels: res.channels, logId };
  const reason = decision === "away_batch" || decision === "telegram" ? decision : "send_failed";
  return { sent: false, reason, channels: res.channels, logId };
}
