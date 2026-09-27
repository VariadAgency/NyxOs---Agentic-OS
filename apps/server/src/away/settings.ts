// Abwesenheit: Einstellungen „Wenn ich weg bin“ (Tabelle `away_settings`, eine Zeile). Fehlende oder
// kaputte Werte → Standard; so braucht die Migration keine Startwerte.
import { AwaySettingsSchema, DEFAULT_AWAY_SETTINGS, type AwaySettings, type AwaySettingsPatch } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { awaySettings } from "../db/schema.js";

/** Gespeicherte Werte über den Standard legen; jeder Schlüssel wird einzeln geprüft. */
export function normalizeAwaySettings(raw: unknown): AwaySettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...DEFAULT_AWAY_SETTINGS };
  for (const key of Object.keys(DEFAULT_AWAY_SETTINGS) as (keyof AwaySettings)[]) {
    if (key === "events") continue;
    const field = AwaySettingsSchema.shape[key].safeParse(r[key]);
    if (field.success) merged[key] = field.data;
  }
  const ev = (r.events && typeof r.events === "object" ? r.events : {}) as Record<string, unknown>;
  const events: Record<string, boolean> = { ...DEFAULT_AWAY_SETTINGS.events };
  for (const k of Object.keys(events)) if (typeof ev[k] === "boolean") events[k] = ev[k] as boolean;
  merged.events = events;
  return merged as AwaySettings;
}

export async function loadAwaySettings(db: Db): Promise<AwaySettings> {
  const [row] = await db.select({ settings: awaySettings.settings }).from(awaySettings).where(eq(awaySettings.id, 1)).limit(1);
  return normalizeAwaySettings(row?.settings);
}

export async function patchAwaySettings(db: Db, patch: AwaySettingsPatch): Promise<AwaySettings> {
  const current = await loadAwaySettings(db);
  const next = normalizeAwaySettings({ ...current, ...patch, events: { ...current.events, ...(patch.events ?? {}) } });
  await db
    .insert(awaySettings)
    .values({ id: 1, settings: next })
    .onConflictDoUpdate({ target: awaySettings.id, set: { settings: next, updatedAt: sql`now()` } });
  return next;
}
