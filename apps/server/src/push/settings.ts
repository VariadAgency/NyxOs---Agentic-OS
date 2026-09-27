// Push — Einstellungen liegen in einer Ein-Zeilen-Tabelle (`push_settings`, `id = 1`), die
// der Server beim ersten Zugriff selbst mit einem zufälligen, geheimen Thema anlegt (
// "Themen-Name zufällig und geheim"). Keine Migration muss Startwerte kennen.
import { randomBytes } from "node:crypto";
import { DEFAULT_PUSH_CHANNELS, PUSH_CHANNELS, PushEventKindSchema, type PushSettings, type PushSettingsPatch } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pushSettings } from "../db/schema.js";

const ALL_KINDS = PushEventKindSchema.options;

type Row = typeof pushSettings.$inferSelect;

function toDTO(row: Row): PushSettings {
  const enabledKinds: Record<string, boolean> = {};
  for (const k of ALL_KINDS) enabledKinds[k] = row.enabledKinds[k] !== false; // Standard: an
  // fehlender Schlüssel = Standard (Mac + Browser + iPhone an).
  const channels: Record<string, boolean> = {};
  for (const c of PUSH_CHANNELS) channels[c] = typeof row.channels?.[c] === "boolean" ? row.channels[c] : DEFAULT_PUSH_CHANNELS[c];
  return {
    topic: row.topic,
    quietStart: row.quietStart,
    quietEnd: row.quietEnd,
    bundleWindowSeconds: row.bundleWindowSeconds,
    waitingAfterSeconds: row.waitingAfterSeconds,
    publicBaseUrl: row.publicBaseUrl,
    enabledKinds: enabledKinds as PushSettings["enabledKinds"],
    channels: channels as PushSettings["channels"],
    ntfyTarget: row.ntfyTarget === "ntfy_sh" ? "ntfy_sh" : "own",
  };
}

/** `nyxos-<24 Hex-Zeichen>` — lang und zufällig genug, um nicht erraten zu werden (ntfy-Themen
 * sind sonst öffentlich lesbar, wer den Namen kennt). */
export function randomTopic(): string {
  return `nyxos-${randomBytes(12).toString("hex")}`;
}

/** Legt die Einstellungs-Zeile beim ersten Aufruf an (Standardwerte aus dem Schema), liest sie sonst nur. */
export async function loadOrInitSettings(db: Db): Promise<PushSettings> {
  const [row] = await db.select().from(pushSettings).where(eq(pushSettings.id, 1)).limit(1);
  if (row) return toDTO(row);
  const inserted = await db.insert(pushSettings).values({ id: 1, topic: randomTopic() }).onConflictDoNothing().returning();
  if (inserted[0]) return toDTO(inserted[0]);
  // Wettlauf: eine parallele Anfrage hat die Zeile inzwischen angelegt.
  const [again] = await db.select().from(pushSettings).where(eq(pushSettings.id, 1)).limit(1);
  if (!again) throw new Error("push_settings konnte nicht angelegt werden");
  return toDTO(again);
}

export async function patchSettings(db: Db, patch: PushSettingsPatch): Promise<PushSettings> {
  const current = await loadOrInitSettings(db); // stellt sicher, dass die Zeile existiert
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.quietStart !== undefined) set.quietStart = patch.quietStart;
  if (patch.quietEnd !== undefined) set.quietEnd = patch.quietEnd;
  if (patch.bundleWindowSeconds !== undefined) set.bundleWindowSeconds = patch.bundleWindowSeconds;
  if (patch.waitingAfterSeconds !== undefined) set.waitingAfterSeconds = patch.waitingAfterSeconds;
  if (patch.publicBaseUrl !== undefined) set.publicBaseUrl = patch.publicBaseUrl;
  // Merge statt Ersetzen: ein Umschalter im Panel kennt nur seine eigene Art (s. `PartialEnabledKindsSchema`).
  if (patch.enabledKinds !== undefined) set.enabledKinds = { ...current.enabledKinds, ...patch.enabledKinds };
  if (patch.channels !== undefined) set.channels = { ...current.channels, ...patch.channels };
  if (patch.ntfyTarget !== undefined) set.ntfyTarget = patch.ntfyTarget;
  const [row] = await db.update(pushSettings).set(set).where(eq(pushSettings.id, 1)).returning();
  if (!row) throw new Error("push_settings-Zeile fehlt");
  return toDTO(row);
}
