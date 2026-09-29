// Echte Claude-Limits über CodexBar. Die Mac-App CodexBar (MIT, steipete) schreibt die echten Werte von
// Anthropic laufend nach `~/Library/Application Support/com.steipete.codexbar/history/claude.json`. Die Brücke
// liest NUR diese Datei (keine Cookies, keine Keychain, keine anderen CodexBar-Dateien) und schickt über den
// Brücken-Kanal (`WS /bridge`) nur Zahlen: Prozent, Reset, Messzeitpunkt — im selben Format wie der OAuth-Weg
// (`utilization` 0–100, `resets_at` ISO, `fetchedAt` = `capturedAt`). Der Server prüft die Plausibilität selbst
// (apps/server/src/usage/official.ts `parseCodexBarReport`).
import { z } from "zod";

/** So viele jüngste Messpunkte des Sitzungs-Fensters gehen für die Hochrechnung mit. */
export const USAGE_READINGS_MAX_POINTS = 12;

const IsoSchema = z.string().max(40);

/** Ein Fenster, wie Anthropic es meldet (Stand zum Zeitpunkt `fetchedAt`). */
export const UsageReadingWindowSchema = z.object({
  utilization: z.number(),
  resets_at: IsoSchema.nullable(),
  fetchedAt: IsoSchema,
});
export type UsageReadingWindow = z.infer<typeof UsageReadingWindowSchema>;

/** Brücke → Server: jüngster Stand je Fenster + die letzten Messpunkte der Sitzung. */
export const UsageReadingsMsgSchema = z.object({
  op: z.literal("usage_readings"),
  source: z.literal("codexbar"),
  tool: z.literal("claude"),
  /** „session“ (5 Std). */
  fiveHour: UsageReadingWindowSchema.nullable(),
  /** „weekly“ (alle Modelle). */
  sevenDay: UsageReadingWindowSchema.nullable(),
  /** „opus“ / „sonnet“ (Modell-Woche), wenn CodexBar sie führt. */
  sevenDayOpus: UsageReadingWindowSchema.nullable(),
  sevenDaySonnet: UsageReadingWindowSchema.nullable(),
  /** Älteste zuerst. */
  sessionHistory: z.array(UsageReadingWindowSchema).max(USAGE_READINGS_MAX_POINTS),
});
export type UsageReadingsMsg = z.infer<typeof UsageReadingsMsgSchema>;
