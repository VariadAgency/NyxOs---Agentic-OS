// Nyx kennt seine Mitteilungen. Alle Mitteilungen, die NyxOS in Nyx' Namen verschickt, landen in `push_log`:
// die Einzel-Pushes über `notify()` (dispatcher.ts) und die Wege daneben — Abwesenheits-Bündel (nur ntfy),
// Fragen und Freigabe-Karten über Telegram. Lesen: `listDeliveries()` (Nyx-Werkzeug `mitteilungen_liste`).
import { NOTIFY_DECISION_LABEL, NOTIFY_OCCASIONS, NotifyDecisionSchema, redactSecrets, t, type NotifyDecision } from "@nyxos/shared";
import { desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushLog } from "../db/schema.js";

export type DeliveryWay = "mac" | "browser" | "ntfy" | "telegram";

export interface DeliveryChannel {
  channel: DeliveryWay | string;
  ok: boolean;
  skipped?: boolean;
}

/** Geheimnisse aus protokollierten Texten entfernen – die Regeln liegen in `@nyxos/shared` (redact.ts), damit auch
 * die Diagnose einer Fehlermeldung (support.ts) genauso maskiert. */
export { redactSecrets } from "@nyxos/shared";

/** Eine Mitteilung außerhalb von `notify()` protokollieren. Fehler still (Protokoll darf nie den Versand stören). */
export async function logDelivery(
  db: Db,
  e: { kind: string; title: string; message: string; channels: DeliveryChannel[]; bundle?: boolean; priority?: string; clickUrl?: string | null; now?: Date },
): Promise<void> {
  try {
    await db.insert(pushLog).values({
      kind: e.kind,
      title: redactSecrets(e.title),
      message: redactSecrets(e.message),
      priority: e.priority ?? "default",
      clickUrl: e.clickUrl ?? null,
      bundledCount: 1,
      suppressedReason: null,
      sentAt: (e.now ?? new Date()).toISOString(),
      channels: e.channels.map((c) => ({ channel: c.channel, ok: c.ok, ...(c.skipped ? { skipped: true } : {}) })),
      bundle: e.bundle ?? false,
    });
  } catch {
    // bewusst still
  }
}

const WAY_LABEL: Record<string, string> = { mac: "Rechner", browser: "Browser", ntfy: "Handy (ntfy)", telegram: "Telegram" };

type LogRow = typeof pushLog.$inferSelect;

/** Decision of a row – also for old rows without `decision` (written before the notification pipeline). */
export function decisionOf(r: Pick<LogRow, "decision" | "suppressedReason" | "channels">): NotifyDecision {
  const parsed = NotifyDecisionSchema.safeParse(r.decision);
  if (parsed.success) return parsed.data;
  if (r.suppressedReason) {
    const legacy = NotifyDecisionSchema.safeParse(r.suppressedReason);
    return legacy.success ? legacy.data : "send_failed";
  }
  if (!r.channels) return "sent";
  return r.channels.some((c) => c.ok && !c.skipped) ? "sent" : "send_failed";
}

/** "Gesendet", "Nyx hat sie weggelassen – …", "Unter-Agent – nicht gemeldet" … in the current language. */
export function decisionReason(r: Pick<LogRow, "decision" | "suppressedReason" | "channels" | "decisionNote">): string {
  const label = t(NOTIFY_DECISION_LABEL[decisionOf(r)]);
  return r.decisionNote ? `${label} – ${r.decisionNote}` : label;
}

const KIND_LABEL: Record<string, string> = {
  ...Object.fromEntries(Object.entries(NOTIFY_OCCASIONS).map(([k, m]) => [k, m.label])),
  away_bundle: "Sammel-Mitteilung (während du weg warst)",
  away_questions: "Fragen an dich (Telegram)",
  away_question_hint: "Hinweis auf offene Fragen",
  approval_telegram: "Freigabe-Karte (Telegram)",
};

/** German label from a map, translated when it is read; unknown keys stay as they are. */
function translatedLabel(labels: Record<string, string>, key: string): string {
  const de = labels[key];
  return de ? t(de) : key;
}

export interface DeliveryItem {
  zeit: string;
  art: string;
  titel: string;
  text: string;
  wege: { weg: string; zugestellt: boolean }[];
  /** Kam sie auf mindestens einem Weg an? */
  zugestellt: boolean;
  sammel: boolean;
  /** What happened to it, with reason ("Gesendet", "Nyx hat sie weggelassen – …", "Unter-Agent …"). */
  grund: string;
  /** Nyx' part (checked/written), otherwise null. */
  nyx: { pruefung?: string; text?: string; notiz?: string } | null;
  /** The user's feedback ("passt" / "brauche ich nicht"), otherwise null. */
  rueckmeldung: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Die letzten `limit` Mitteilungen, neueste zuerst. `stamp` formatiert die Zeit (Zeitzone des Nutzers). */
export async function listDeliveries(db: Db, limit: number, stamp: (iso: string) => string | null): Promise<DeliveryItem[]> {
  const rows = await db.select().from(pushLog).orderBy(desc(pushLog.sentAt), desc(pushLog.id)).limit(limit);
  return rows.map((r) => {
    const ways = (r.channels ?? []).filter((c) => !c.skipped).map((c) => ({ weg: translatedLabel(WAY_LABEL, c.channel), zugestellt: c.ok }));
    // Alte Zeilen ohne Wege: „verschickt“ hieß suppressedReason = null.
    const delivered = r.suppressedReason !== null ? false : r.channels ? ways.some((w) => w.zugestellt) : true;
    const grund = decisionReason(r);
    const nyx = r.nyx
      ? {
          ...(r.nyx.review ? { pruefung: r.nyx.review } : {}),
          ...(r.nyx.wrote ? { text: r.nyx.wrote === "nyx" ? t("von Nyx geschrieben") : t("Vorlage") } : {}),
          ...(r.nyx.note ? { notiz: r.nyx.note } : {}),
        }
      : null;
    return {
      zeit: stamp(r.sentAt) ?? r.sentAt,
      art: translatedLabel(KIND_LABEL, r.kind),
      titel: clip(redactSecrets(r.title), 160),
      text: clip(redactSecrets(r.message), 280),
      wege: ways,
      zugestellt: delivered,
      sammel: r.bundle || r.bundledCount > 1,
      grund,
      nyx,
      rueckmeldung: r.feedback === "unnoetig" ? "brauche ich nicht" : r.feedback === "passt" ? "passt" : null,
    };
  });
}
