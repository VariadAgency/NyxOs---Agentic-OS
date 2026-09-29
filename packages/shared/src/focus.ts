// Focus button (like the Focus modes on macOS/iOS): a small button at the bottom of the sidebar sets how NyxOS reaches
// the user right now – independent of whether a NyxOS window is open:
//   auto  – as before: "away" is detected from presence (heartbeat).
//   away  – counts as away immediately: phone (ntfy, Telegram) as while away, computer/browser silent.
//   dnd   – computer/browser never; phone only important things (deploy failed, approvals, crashes, urgent).
// Duration like on the phone: 1 hour · until this evening / tomorrow morning · until I turn it off. Then back to auto.
// Deliberately only three modes (a fourth "concentrated" would be too close to "do not disturb").
// All times ("this evening", "tomorrow morning", "until 19:00") use the user's time zone (`timeZone()`), never a fixed one.
import { z } from "zod";
import { dateTimeFormat } from "./format.js";
import { t, timeZone } from "./i18n/index.js";
import type { PushEventKind } from "./push.js";

export const FocusModeSchema = z.enum(["auto", "away", "dnd"]);
export type FocusMode = z.infer<typeof FocusModeSchema>;
export const FOCUS_MODES = FocusModeSchema.options;

/** Duration choice in the menu. `evening` after 18:00 = until tomorrow morning. `manual` = until I turn it off. */
export const FocusDurationSchema = z.enum(["1h", "evening", "morning", "manual"]);
export type FocusDuration = z.infer<typeof FocusDurationSchema>;

/** Who set the focus: the user (menu/settings), Nyx (`app_api`) or the expiry tick. */
export const FocusSetBySchema = z.enum(["user", "nyx", "expiry"]);
export type FocusSetBy = z.infer<typeof FocusSetBySchema>;

export const FocusStateSchema = z.object({
  mode: FocusModeSchema,
  /** End (ISO); `null` = until I turn it off (for auto: no end). */
  until: z.string().nullable(),
  /** Since when this mode applies (ISO). */
  since: z.string().nullable(),
  setBy: FocusSetBySchema.nullable(),
});
export type FocusState = z.infer<typeof FocusStateSchema>;

export const DEFAULT_FOCUS_STATE: FocusState = { mode: "auto", until: null, since: null, setBy: null };

/**
 * `PUT /api/focus`. Either `duration` (menu) or `until` (e.g. Nyx: "until 18:00"); neither = until I turn it off.
 * The web app also sends `until`, computed in the viewer's time zone, so "this evening" is the user's evening even when
 * the server runs in another zone; `until` wins over `duration`.
 */
export const FocusPutSchema = z
  .object({
    mode: FocusModeSchema,
    duration: FocusDurationSchema.optional(),
    until: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type FocusPut = z.infer<typeof FocusPutSchema>;

export interface FocusResponse {
  state: FocusState;
  /** Server time (ISO). */
  now: string;
}

/** Live message to all open windows. */
export interface FocusLiveMessage {
  type: "focus";
  state: FocusState;
}

export interface FocusModeMeta {
  label: string;
  /** Short name for the button (auto shows only the icon). */
  short: string;
  icon: string;
  /** Colour token from `lib/tones.ts` (without `--a-`). */
  tone: "mut" | "wait" | "indigo";
  /** One sentence: what the mode does. */
  sentence: string;
}

/**
 * Label, icon and sentence of a mode in the current language. `local`: local mode – there the phone only gets
 * something when Telegram or ntfy is set up, so the "away" sentence doesn't promise it.
 */
export function focusModeMeta(mode: FocusMode, opts: { local?: boolean } = {}): FocusModeMeta {
  if (mode === "away") {
    return {
      label: t("Ich bin weg"),
      short: t("Weg"),
      icon: "↗",
      tone: "wait",
      sentence: opts.local
        ? t("Rechner und Browser bleiben still – auch wenn NyxOS offen ist. Aufs Handy kommt es, wenn Telegram oder ntfy eingerichtet ist.")
        : t("Alles kommt aufs Handy (Push und Telegram-Fragen), Rechner und Browser bleiben still – auch wenn NyxOS offen ist."),
    };
  }
  if (mode === "dnd") {
    return {
      label: t("Nicht stören"),
      short: t("Nicht stören"),
      icon: "☾",
      tone: "indigo",
      sentence: t("Keine Mitteilungen auf Rechner und Browser. Aufs Handy nur Wichtiges: Freigaben, Abstürze, fehlgeschlagener Deploy."),
    };
  }
  return {
    label: t("Automatisch"),
    short: "",
    icon: "◐",
    tone: "mut",
    sentence: t("Wie bisher: NyxOS merkt selbst, ob du da bist, und schickt dann auf den Rechner oder aufs Handy."),
  };
}

/** What still reaches the phone under "do not disturb" (in addition to everything with priority "urgent"). */
export const FOCUS_DND_BREAKTHROUGH: readonly PushEventKind[] = ["approval_needed", "session_crashed", "deploy_failed"];

export function focusBreaksThrough(kind: PushEventKind, urgent: boolean): boolean {
  return urgent || FOCUS_DND_BREAKTHROUGH.includes(kind);
}

// ───────────────────────────── Time (user's time zone) ─────────────────────────────

/** "Until this evening" ends at this hour; from one hour before, the choice is "until tomorrow morning". */
export const FOCUS_EVENING_HOUR = 19;
export const FOCUS_MORNING_HOUR = 8;

interface WallParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

function wallParts(d: Date, zone: string): WallParts {
  const fmt = dateTimeFormat({ timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }, "en-GB");
  const p: Record<string, number> = {};
  for (const x of fmt.formatToParts(d)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year ?? 0, m: p.month ?? 1, d: p.day ?? 1, h: p.hour ?? 0, min: p.minute ?? 0, s: p.second ?? 0 };
}

/** Offset zone ↔ UTC in ms at a point in time. */
function zoneOffset(d: Date, zone: string): number {
  const p = wallParts(d, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(d.getTime() / 1000) * 1000;
}

/** Wall time `hour:00` on the day of `now` plus `dayOffset` days in `zone` → UTC point in time. */
function wallAt(now: Date, hour: number, dayOffset: number, zone: string): Date {
  const p = wallParts(now, zone);
  const wall = Date.UTC(p.y, p.m - 1, p.d + dayOffset, hour, 0, 0);
  let ts = wall - zoneOffset(now, zone);
  ts = wall - zoneOffset(new Date(ts), zone); // daylight saving change in between
  return new Date(ts);
}

/** Is the second duration choice currently "until this evening" (otherwise "until tomorrow morning")? */
export function focusEveningAvailable(now: Date, zone: string = timeZone()): boolean {
  const h = wallParts(now, zone).h;
  return h >= 5 && h < FOCUS_EVENING_HOUR - 1;
}

/** End for a duration choice (ISO) or `null` (until I turn it off), in the user's time zone. */
export function focusUntilFor(duration: FocusDuration, now: Date, zone: string = timeZone()): string | null {
  if (duration === "manual") return null;
  if (duration === "1h") return new Date(now.getTime() + 60 * 60_000).toISOString();
  if (duration === "evening" && focusEveningAvailable(now, zone)) return wallAt(now, FOCUS_EVENING_HOUR, 0, zone).toISOString();
  // Until tomorrow morning: before 05:00 = today 08:00, otherwise tomorrow 08:00.
  const early = wallParts(now, zone).h < 5;
  return wallAt(now, FOCUS_MORNING_HOUR, early ? 0 : 1, zone).toISOString();
}

/** Expired → auto. */
export function effectiveFocus(state: FocusState, now: Date): FocusState {
  if (state.mode === "auto" || state.until === null) return state;
  const end = Date.parse(state.until);
  return Number.isNaN(end) || end <= now.getTime() ? DEFAULT_FOCUS_STATE : state;
}

/** "bis 19:00" · "bis morgen 08:00" · "bis du es ausschaltest" (empty for auto), in the user's time zone. */
export function focusUntilLabel(state: FocusState, now: Date, zone: string = timeZone()): string {
  if (state.mode === "auto") return "";
  if (state.until === null) return t("bis du es ausschaltest");
  const end = new Date(state.until);
  if (Number.isNaN(end.getTime())) return "";
  const a = wallParts(now, zone);
  const b = wallParts(end, zone);
  const days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
  const time = dateTimeFormat({ hour: "2-digit", minute: "2-digit", timeZone: zone }).format(end);
  if (days <= 0) return t("bis {time}", { time });
  if (days === 1) return t("bis morgen {time}", { time });
  return t("bis {day} {time}", { day: dateTimeFormat({ weekday: "short", timeZone: zone }).format(end), time });
}
