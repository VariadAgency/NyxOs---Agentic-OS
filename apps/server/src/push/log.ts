// Nyx kennt seine Mitteilungen. Alle Mitteilungen, die NyxOS in Nyx' Namen verschickt, landen in `push_log`:
// die Einzel-Pushes über `notify()` (dispatcher.ts) und die Wege daneben — Abwesenheits-Bündel (nur ntfy),
// Fragen und Freigabe-Karten über Telegram. Lesen: `listDeliveries()` (Nyx-Werkzeug `mitteilungen_liste`).
import { t } from "@nyxos/shared";
import { desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushLog } from "../db/schema.js";

export type DeliveryWay = "mac" | "browser" | "ntfy" | "telegram";

export interface DeliveryChannel {
  channel: DeliveryWay | string;
  ok: boolean;
  skipped?: boolean;
}

/**
 * Geheimnisse aus protokollierten Texten entfernen (z. B. der Befehl einer Freigabe-Karte:
 * `curl -H "Authorization: Bearer …"`, `export GITHUB_TOKEN=…`). Gilt beim Speichern und beim Ausgeben an Nyx.
 */
const MASK = "•••";
const SECRET_RULES: [RegExp, string][] = [
  [/\b(sk-ant-|sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abprs]-|glpat-|AKIA)[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\b([A-Za-z0-9_]*(?:token|secret|passwor[dt]|passwd|pwd|api[_-]?key|authorization|credentials?)[A-Za-z0-9_]*)(\s*[:=]\s*)("?)[^\s"']+/gi, `$1$2$3${MASK}`],
];
export function redactSecrets(text: string): string {
  return SECRET_RULES.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

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

const WAY_LABEL: Record<string, string> = { mac: "Mac", browser: "Browser", ntfy: "iPhone (ntfy)", telegram: "Telegram" };
const KIND_LABEL: Record<string, string> = {
  session_waiting: "Session wartet",
  session_crashed: "Session abgestürzt",
  build_red: "Build rot",
  night_run_done: "Nachtlauf fertig",
  deploy_failed: "Deploy fehlgeschlagen",
  approval_needed: "Freigabe nötig",
  context_guard_hinweis: "Kontext-Hinweis",
  usage_warning: "Nutzungswarnung",
  away_bundle: "Sammel-Mitteilung (während du weg warst)",
  away_questions: "Fragen an dich (Telegram)",
  away_question_hint: "Hinweis auf offene Fragen",
  approval_telegram: "Freigabe-Karte (Telegram)",
};
const REASON_LABEL: Record<string, string> = { quiet_hours: "Ruhezeit", send_failed: "Versand fehlgeschlagen" };

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
  /** Warum nicht (Ruhezeit, Fehler), sonst null. */
  grund: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Die letzten `limit` Mitteilungen, neueste zuerst. `stamp` formatiert die Zeit (Zeitzone des Nutzers). */
export async function listDeliveries(db: Db, limit: number, stamp: (iso: string) => string | null): Promise<DeliveryItem[]> {
  const rows = await db.select().from(pushLog).orderBy(desc(pushLog.sentAt), desc(pushLog.id)).limit(limit);
  return rows.map((r) => {
    const ways = (r.channels ?? []).filter((c) => !c.skipped).map((c) => ({ weg: translatedLabel(WAY_LABEL, c.channel), zugestellt: c.ok }));
    // Alte Zeilen ohne Wege: „verschickt“ hieß suppressedReason = null.
    const delivered = r.suppressedReason !== null ? false : r.channels ? ways.some((w) => w.zugestellt) : true;
    const grund = r.suppressedReason ? translatedLabel(REASON_LABEL, r.suppressedReason) : !delivered ? t("Kein Weg hat geklappt") : null;
    return {
      zeit: stamp(r.sentAt) ?? r.sentAt,
      art: translatedLabel(KIND_LABEL, r.kind),
      titel: clip(redactSecrets(r.title), 160),
      text: clip(redactSecrets(r.message), 280),
      wege: ways,
      zugestellt: delivered,
      sammel: r.bundle || r.bundledCount > 1,
      grund,
    };
  });
}
