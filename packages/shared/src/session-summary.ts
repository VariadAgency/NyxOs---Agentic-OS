// „Nyx fasst zusammen“ – Nyx liest den Verlauf einer Session und schreibt eine ausführliche, gegliederte
// Zusammenfassung (Markdown): Ziel · Erledigt · Läuft gerade · Offen/Fragen · Nächster Schritt. Gespeichert je
// Session mit Zeitpunkt und Stand (bis zu welcher Nachricht), damit NyxOS „3 neue Nachrichten seit der
// Zusammenfassung“ sagen kann. Tabelle `session_summaries`.
import { z } from "zod";
import type { HaikuEngineState } from "./haiku.js";

export const NyxSessionSummaryStatusSchema = z.enum(["running", "done", "error"]);
export type NyxSessionSummaryStatus = z.infer<typeof NyxSessionSummaryStatusSchema>;

export const NyxSessionSummarySchema = z.object({
  id: z.number().int(),
  sessionKey: z.string(),
  status: NyxSessionSummaryStatusSchema,
  /** Markdown. Während `running` der bisher gestreamte Text (noch ungeprüft), danach die geprüfte Fassung. */
  text: z.string(),
  /** Bei `error`: was schiefging, in einfachen Worten. */
  error: z.string().nullable(),
  /** Stand: Anzahl der Nachrichten (Nutzer + Claude/Codex), die die Zusammenfassung abdeckt. */
  messagesCovered: z.number().int().nonnegative(),
  /** Zeitpunkt der letzten abgedeckten Nachricht. */
  coveredUntil: z.string().nullable(),
  /** Wie viele Verlaufs-Einträge Nyx gelesen hat (von wie vielen) – weniger, wenn die Mitte gekürzt wurde. */
  itemsRead: z.number().int().nullable(),
  itemsTotal: z.number().int().nullable(),
  /** Zeilen, die NyxOS weggelassen hat, weil ein Pfad/eine Zahl/ein Commit nicht im Verlauf vorkam. */
  dropped: z.number().int().nonnegative(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type NyxSessionSummary = z.infer<typeof NyxSessionSummarySchema>;

export interface NyxSessionSummaryView {
  /** Kann Nyx gerade zusammenfassen? Sonst Zustand + Grund. */
  engine: { ready: boolean; state: HaikuEngineState; reason: string | null };
  /** Die letzte Zusammenfassung (auch eine laufende oder fehlgeschlagene) – `null`, wenn es noch keine gibt. */
  summary: NyxSessionSummary | null;
  /** Neue Nachrichten seit dem Stand der letzten fertigen Zusammenfassung (0 ohne Zusammenfassung). */
  newMessages: number;
}
