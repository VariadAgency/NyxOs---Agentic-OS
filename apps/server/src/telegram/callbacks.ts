// Knopf-Daten (`callback_data`) für Telegram. Telegram erlaubt höchstens 64 Byte je Knopf
// (OpenClaw `approval-callback-data.ts`, MIT: `TELEGRAM_CALLBACK_DATA_MAX_BYTES`, versioniertes Präfix).
// Schema: `n1:<art>:<wert>…`. Lange Werte (Ordner-Pfade, Session-Schlüssel, Volltexte) liegen im
// {@link CallbackRegistry} und der Knopf trägt nur eine kurze ID — nach einem Neustart ist ein alter Knopf
// „abgelaufen“ (ehrliche Meldung statt falscher Aktion). Die IDs tragen dafür ein zufälliges Präfix je
// Prozess; ein reiner Zähler finge nach dem Neustart wieder bei 1 an, und ein alter „Start“-Knopf träfe einen
// anderen Ordner.
import { randomBytes } from "node:crypto";
import { TELEGRAM_CALLBACK_MAX_BYTES } from "@nyxos/shared";

export const CALLBACK_PREFIX = "n1";

export class CallbackTooLongError extends Error {}

/** Baut `n1:<teil>:<teil>…` und wirft, wenn Telegram es ablehnen würde (> 64 Byte). */
export function cb(...parts: (string | number)[]): string {
  const data = [CALLBACK_PREFIX, ...parts.map(String)].join(":");
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_MAX_BYTES) throw new CallbackTooLongError(`Knopf-Daten zu lang (${Buffer.byteLength(data, "utf8")} Byte)`);
  return data;
}

/** `n1:a:b` → `["a", "b"]`; fremde/alte Formate → `null`. */
export function parseCb(data: string | undefined): string[] | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts[0] !== CALLBACK_PREFIX || parts.length < 2) return null;
  return parts.slice(1);
}

/** Kurze IDs für lange Werte (höchstens `max` Einträge, älteste fallen raus). */
export class CallbackRegistry<T = unknown> {
  private readonly items = new Map<string, T>();
  private counter = 0;
  /** 6 Zeichen base64url (ohne „:“), je Prozess neu. */
  private readonly prefix = randomBytes(4).toString("base64url").slice(0, 6);
  constructor(private readonly max = 500) {}

  put(value: T): string {
    const id = `${this.prefix}${(++this.counter).toString(36)}`;
    this.items.set(id, value);
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    return id;
  }

  get(id: string | undefined): T | undefined {
    return id === undefined ? undefined : this.items.get(id);
  }
}
