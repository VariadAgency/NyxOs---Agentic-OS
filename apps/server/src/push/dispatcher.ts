// Push — der Dispatcher entscheidet je Anlass: senden, bündeln oder wegen Ruhezeit
// unterdrücken. Jede Entscheidung landet in `push_log`, auch eine unterdrückte —
// das ist die Grundlage für Dedupe (s. `waiting.ts`) und den Latenz-Nachweis.
import { DEFAULT_PRIORITY_BY_KIND, t, type PushChannelResult, type PushNotifyInput, type PushSettings } from "@nyxos/shared";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushLog } from "../db/schema.js";
import { isWithinWindow } from "../night/window.js";
import type { NtfySender } from "./ntfy.js";

/** true, wenn `now` innerhalb des Ruhezeit-Fensters liegt (kann über Mitternacht gehen, Standard
 * 22:00–08:00) — dieselbe Fenster-Arithmetik wie der Nachtmodus, s. `night/window.ts`. Anders als
 * dort bedeutet `start === end` hier "keine Ruhezeit" (nicht "24 h"), das neutrale Setup für Push. */
export function isQuietNow(settings: Pick<PushSettings, "quietStart" | "quietEnd">, now: Date): boolean {
  if (settings.quietStart === settings.quietEnd) return false;
  return isWithinWindow({ start: settings.quietStart, end: settings.quietEnd }, now);
}

/** Wege fürs Protokoll (nur Weg + Ergebnis, kein Detailtext) — Grundlage für Nyx' `mitteilungen_liste`. */
function logChannels(res: { ok: boolean; channels?: PushChannelResult[] }): { channel: string; ok: boolean; skipped?: boolean }[] {
  // Ein reiner ntfy-Sender (ohne Wege-Liste) ist genau ein Weg: das iPhone über ntfy.
  if (!res.channels) return [{ channel: "ntfy", ok: res.ok }];
  return res.channels.map((c) => ({ channel: c.channel, ok: c.ok, ...(c.skipped ? { skipped: true } : {}) }));
}

export interface NotifyDeps {
  db: Db;
  sender: NtfySender;
  settings: PushSettings;
  now?: Date;
}

export interface NotifyResult {
  sent: boolean;
  reason?: "kind_disabled" | "quiet_hours" | "send_failed";
  /** Ergebnis je Weg (Mac/Browser/iPhone), wenn gesendet wurde. */
  channels?: PushChannelResult[];
}

/**
 * Versendet (oder bündelt/unterdrückt) einen Anlass.
 * - Art in den Einstellungen abgeschaltet → gar nicht geloggt.
 * - Ruhezeit UND Priorität nicht `urgent` → geloggt als unterdrückt, nicht gesendet.
 * - Innerhalb `bundleWindowSeconds` schon eine (wirklich gesendete) Mitteilung derselben Art UND
 *   (falls angegeben) derselben Session → zählt die bestehende Zeile hoch statt eine neue zu senden.
 * - Sonst: normaler Versand, neue Zeile.
 */
export async function notify(input: PushNotifyInput, deps: NotifyDeps): Promise<NotifyResult> {
  const { db, sender, settings } = deps;
  const now = deps.now ?? new Date();
  if (settings.enabledKinds[input.kind] === false) return { sent: false, reason: "kind_disabled" };

  const priority = input.priority ?? DEFAULT_PRIORITY_BY_KIND[input.kind];
  const clickUrl = input.path ? `${settings.publicBaseUrl.replace(/\/$/, "")}${input.path}` : null;
  // Wege + ntfy-Ziel aus den Einstellungen; der Mehr-Wege-Sender verteilt danach auf Mac/Browser/iPhone.
  const routing = { topic: settings.topic, kind: input.kind, path: input.path ?? null, channels: settings.channels, ntfyTarget: settings.ntfyTarget };

  if (isQuietNow(settings, now) && priority !== "urgent") {
    await db.insert(pushLog).values({
      kind: input.kind,
      sessionKey: input.sessionKey ?? null,
      title: input.title,
      message: input.message,
      priority,
      clickUrl,
      bundledCount: 1,
      suppressedReason: "quiet_hours",
      sentAt: now.toISOString(),
    });
    return { sent: false, reason: "quiet_hours" };
  }

  if (settings.bundleWindowSeconds > 0) {
    const since = new Date(now.getTime() - settings.bundleWindowSeconds * 1000).toISOString();
    const conds = [eq(pushLog.kind, input.kind), gte(pushLog.sentAt, since)];
    if (input.sessionKey) conds.push(eq(pushLog.sessionKey, input.sessionKey));
    const [recent] = await db
      .select()
      .from(pushLog)
      .where(and(...conds))
      .orderBy(desc(pushLog.sentAt))
      .limit(1);
    if (recent && recent.suppressedReason === null) {
      const bundledCount = recent.bundledCount + 1;
      const message = t("{n} neue Meldungen (zuletzt: {message})", { n: bundledCount, message: input.message });
      const res = await sender.send({ ...routing, title: input.title, message, priority, clickUrl });
      await db.update(pushLog).set({ bundledCount, message, sentAt: now.toISOString(), channels: logChannels(res) }).where(eq(pushLog.id, recent.id));
      return res.ok ? { sent: true, channels: res.channels } : { sent: false, reason: "send_failed", channels: res.channels };
    }
  }

  const res = await sender.send({ ...routing, title: input.title, message: input.message, priority, clickUrl });
  await db.insert(pushLog).values({
    kind: input.kind,
    sessionKey: input.sessionKey ?? null,
    title: input.title,
    message: input.message,
    priority,
    clickUrl,
    bundledCount: 1,
    suppressedReason: null,
    sentAt: now.toISOString(),
    channels: logChannels(res),
  });
  return res.ok ? { sent: true, channels: res.channels } : { sent: false, reason: "send_failed", channels: res.channels };
}
