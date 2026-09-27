// Einstellungen der Nutzung — eine Zeile (`usage_settings.id = 1`), beim ersten Lesen mit den
// Standardwerten angelegt (wie `push/settings.ts`). Prüfung der Werte über `UsageSettingsPatchSchema`.
import { DEFAULT_USAGE_SETTINGS, UsageGoalScopeSchema, UsageRangeSchema, type UsageSettings, type UsageSettingsPatch } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { usageSettings } from "../db/schema.js";

type Row = typeof usageSettings.$inferSelect;

function toDTO(row: Row): UsageSettings {
  const range = UsageRangeSchema.safeParse(row.defaultRange);
  const scope = UsageGoalScopeSchema.safeParse(row.goalScope);
  return {
    defaultRange: range.success ? range.data : DEFAULT_USAGE_SETTINGS.defaultRange,
    goalScope: scope.success ? scope.data : DEFAULT_USAGE_SETTINGS.goalScope,
    goalMonthTokens: row.goalMonthTokens,
    goalWeekTokens: row.goalWeekTokens,
    warnWindowPct: row.warnWindowPct,
    warnDailyTokens: row.warnDailyTokens,
  };
}

async function loadRow(db: Db): Promise<Row> {
  const [row] = await db.select().from(usageSettings).where(eq(usageSettings.id, 1)).limit(1);
  if (row) return row;
  await db.insert(usageSettings).values({ id: 1 }).onConflictDoNothing();
  const [again] = await db.select().from(usageSettings).where(eq(usageSettings.id, 1)).limit(1);
  if (!again) throw new Error("usage_settings konnte nicht angelegt werden");
  return again;
}

export async function loadUsageSettings(db: Db): Promise<UsageSettings> {
  return toDTO(await loadRow(db));
}

/** Nur für den Warn-Ticker: wann zuletzt gewarnt wurde. */
export async function loadWarnState(db: Db): Promise<Row["warnState"]> {
  return (await loadRow(db)).warnState;
}

export async function saveWarnState(db: Db, state: Row["warnState"]): Promise<void> {
  await db.update(usageSettings).set({ warnState: state }).where(eq(usageSettings.id, 1));
}

export async function patchUsageSettings(db: Db, patch: UsageSettingsPatch): Promise<UsageSettings> {
  const current = await loadRow(db); // stellt sicher, dass die Zeile existiert
  const set: Partial<typeof usageSettings.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (patch.defaultRange !== undefined) set.defaultRange = patch.defaultRange;
  if (patch.goalScope !== undefined) set.goalScope = patch.goalScope;
  if (patch.goalMonthTokens !== undefined) set.goalMonthTokens = patch.goalMonthTokens;
  if (patch.goalWeekTokens !== undefined) set.goalWeekTokens = patch.goalWeekTokens;
  if (patch.warnWindowPct !== undefined) set.warnWindowPct = patch.warnWindowPct;
  if (patch.warnDailyTokens !== undefined) set.warnDailyTokens = patch.warnDailyTokens;
  // Eine geänderte Schwelle darf sofort wieder warnen (sonst schweigt sie bis morgen bzw. 5 Std).
  // nur bei einem WIRKLICH anderen Wert — das Blatt „Nutzung einstellen“ schickt beim
  // Speichern immer alle Felder mit; sonst warnte jedes Speichern (z. B. nur Standard-Zeitraum) sofort neu.
  const changed = (next: number | null | undefined, prev: number | null) => next !== undefined && next !== prev;
  // der Limit-Wecker hängt nicht an den Schwellen — seine Merker bleiben.
  if (changed(patch.warnDailyTokens, current.warnDailyTokens) || changed(patch.warnWindowPct, current.warnWindowPct)) set.warnState = Object.keys(current.warnState.forecastFor ?? {}).length > 0 ? { forecastFor: current.warnState.forecastFor } : {};
  const [row] = await db.update(usageSettings).set(set).where(eq(usageSettings.id, 1)).returning();
  if (!row) throw new Error("usage_settings-Zeile fehlt");
  return toDTO(row);
}
