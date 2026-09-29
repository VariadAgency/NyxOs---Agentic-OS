// Einstellungen der Nutzung (Standard-Zeitraum, Ziele, Warnschwellen). Vertrag zwischen
// Server (`apps/server/src/usage/settings.ts`, Tabelle `usage_settings`) und Web
// (`apps/web/src/features/usage/UsageSettingsSheet.tsx`).
import { z } from "zod";

export const UsageRangeSchema = z.enum(["7", "30", "all"]);
export type UsageRange = z.infer<typeof UsageRangeSchema>;

/** Auf welche Nutzung sich Ziele beziehen: alles zusammen oder nur ein Werkzeug. */
export const UsageGoalScopeSchema = z.enum(["all", "claude", "codex"]);
export type UsageGoalScope = z.infer<typeof UsageGoalScopeSchema>;

/** 10 Billionen Tokens — weit über jedem realen Monat, fängt nur Tippfehler ab (z. B. eine Null zu viel × 1000). */
export const USAGE_TOKEN_MAX = 10_000_000_000_000;

const tokenAmount = z.number().int().positive().max(USAGE_TOKEN_MAX);

export const UsageSettingsSchema = z.object({
  /** Zeitraum, mit dem der Tab „Nutzung“ öffnet (ohne `?range=` in der Adresse). */
  defaultRange: UsageRangeSchema,
  goalScope: UsageGoalScopeSchema,
  /** Ziel je Kalendermonat (Zeitzone des Nutzers), `null` = kein Ziel. */
  goalMonthTokens: tokenAmount.nullable(),
  /** Ziel je Kalenderwoche (Montag–Sonntag, Zeitzone des Nutzers), `null` = kein Ziel. */
  goalWeekTokens: tokenAmount.nullable(),
  /** Warnen, sobald das 5-Std-Fenster diesen Anteil erreicht (derselbe Wert wie der Ring). */
  warnWindowPct: z.number().int().min(1).max(100).nullable(),
  /** Warnen, sobald der heutige Verbrauch (Tag in der Zeitzone des Nutzers, alle Werkzeuge) diesen Wert übersteigt. */
  warnDailyTokens: tokenAmount.nullable(),
});
export type UsageSettings = z.infer<typeof UsageSettingsSchema>;

/** PATCH: jedes Feld einzeln, unbekannte Felder sind ein Fehler (kein stilles Verschlucken). */
export const UsageSettingsPatchSchema = UsageSettingsSchema.partial().strict();
export type UsageSettingsPatch = z.infer<typeof UsageSettingsPatchSchema>;

export const DEFAULT_USAGE_SETTINGS: UsageSettings = {
  defaultRange: "30",
  goalScope: "all",
  goalMonthTokens: null,
  goalWeekTokens: null,
  warnWindowPct: null,
  warnDailyTokens: null,
};
