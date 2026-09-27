// Abwesenheit: Nyx merkt, wenn der Nutzer nicht mehr in NyxOS arbeitet, und meldet sich dann von selbst.
// Ereignisse (Session fertig, Auftrag erledigt, neuer Bug, Build rot, Nachtlauf fertig) → gebündelt NUR über ntfy.
// Fragen/Bedarf (Inbox-Frage, Session wartet auf Eingabe) → Telegram mit Antwort-Knöpfen.
import { z } from "zod";

/** Das Web meldet sich alle 30 s, solange ein Fenster sichtbar ist und der Nutzer aktiv war. */
export const PRESENCE_HEARTBEAT_MS = 30_000;
/** „Aktiv“ = Maus/Tastatur/Touch in den letzten 2 Minuten. */
export const PRESENCE_ACTIVE_WINDOW_MS = 120_000;

export const AwayEventKindSchema = z.enum(["session_done", "auftrag_done", "bug_new", "build_red", "night_done"]);
export type AwayEventKind = z.infer<typeof AwayEventKindSchema>;
export const AWAY_EVENT_KINDS = AwayEventKindSchema.options;

const HHMM = z.string().regex(/^\d{2}:\d{2}$/);

export const AwaySettingsSchema = z.object({
  /** Ganz an/aus. Aus = keine Abwesenheits-Meldungen; alte Einzel-Mitteilungen gehen dann wie früher auch aufs iPhone. */
  enabled: z.boolean(),
  /** „Weg“, wenn so lange kein Herzschlag aus einem aktiven NyxOS-Fenster kam. */
  awayAfterMinutes: z.number().int().min(1).max(240),
  /** Höchstens alle N Minuten EINE Sammel-Mitteilung (ntfy). */
  bundleMinutes: z.number().int().min(1).max(240),
  /** Wichtiges (Build rot, Bug P0/P1) darf früher raus – aber mit diesem Mindestabstand. */
  urgentGapMinutes: z.number().int().min(1).max(120),
  /** Telegram-Fragen: höchstens eine Nachricht je N Minuten (mehrere Fragen darin). */
  questionGapMinutes: z.number().int().min(0).max(120),
  /** Ruhezeit: nur Wichtiges; der Rest wartet bis zum Ende der Ruhezeit. */
  quietEnabled: z.boolean(),
  quietStart: HHMM,
  quietEnd: HHMM,
  events: z.object({
    session_done: z.boolean(),
    auftrag_done: z.boolean(),
    bug_new: z.boolean(),
    build_red: z.boolean(),
    night_done: z.boolean(),
    /** Fragen/Bedarf → Telegram. */
    questions: z.boolean(),
  }),
});
export type AwaySettings = z.infer<typeof AwaySettingsSchema>;

export const DEFAULT_AWAY_SETTINGS: AwaySettings = {
  enabled: true,
  awayAfterMinutes: 5,
  bundleMinutes: 15,
  urgentGapMinutes: 5,
  questionGapMinutes: 3,
  quietEnabled: true,
  quietStart: "23:00",
  quietEnd: "07:00",
  events: { session_done: true, auftrag_done: true, bug_new: true, build_red: true, night_done: true, questions: true },
};

export const AwaySettingsPatchSchema = AwaySettingsSchema.omit({ events: true })
  .partial()
  .extend({ events: AwaySettingsSchema.shape.events.partial().optional() });
export type AwaySettingsPatch = z.infer<typeof AwaySettingsPatchSchema>;

/** `GET /api/away/status` */
export interface AwayStatus {
  away: boolean;
  lastSeenAt: string | null;
  pendingEvents: number;
  settings: AwaySettings;
}
