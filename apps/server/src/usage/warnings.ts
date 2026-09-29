// Warnschwellen der Nutzung → Push (Anlass `usage_warning`, s. packages/shared/src/push.ts).
// Läuft im bestehenden 60-s-Ticker (app.ts `tickStates`) mit. Dedupe über `usage_settings.warn_state`.
//
// Nur noch ECHTE Werte lösen eine Limit-Mitteilung aus (Vorfall 26.09.: „in 25 Min voll, Reset 21:00“ bei
// echten 5 %). Quellen: Claude = OAuth-Nutzung von Anthropic (usage/official.ts, über den Agent-Container),
// Codex = der Füllstand, den Codex selbst in seinen Verlauf schreibt. Die alte Hochrechnung aus Token-Summen
// (usage/forecast.ts, Grundlage „last_limit“) bleibt nur als gekennzeichnete Schätzung in der Nutzungs-Ansicht.
// Regeln je Werkzeug und Fenster (Sitzung = 5 Std, Woche):
//   1. belegt ≥ Schwelle (eigene Warnschwelle, sonst 85 %)                → „Sitzung 88 % belegt, Reset um 20:30“
//   2. Hochrechnung aus ZWEI echten Messpunkten: voll vor dem Reset, in ≤ 60 Min → „… voll um 19:40, Reset um 20:30“
//   Höchstens EINE Mitteilung je Fenster (Dedupe `warn_state.forecastFor[werkzeug:fenster]` = Reset-Zeitpunkt).
// Der Tagesverbrauch (eigene Token-Schwelle) bleibt: höchstens einmal je Tag (Zeitzone des Nutzers).
import { formatTokensCompact, type PushSettings, dateTimeFormat, t } from "@nyxos/shared";
import type { Db } from "../db/client.js";
import { notify } from "../push/dispatcher.js";
import type { NotifyEnv } from "../notifications/pipeline.js";
import { loadNotifyRules } from "../notifications/rules.js";
import type { NtfySender } from "../push/ntfy.js";
import { localClock, forecastWindow, type WindowForecast } from "./forecast.js";
import { getWarningStatus } from "./goals.js";
import { usageReadings, type Reading, type ReadingKey, type UsageReadings } from "./official.js";
import { localDay } from "./periods.js";
import { getLimits } from "./query.js";
import { loadUsageSettings, loadWarnState, saveWarnState } from "./settings.js";
import { reportedFrom } from "./window.js";

export { forecastWindow };

/** Der Wecker meldet sich erst, wenn das Fenster in höchstens so vielen Minuten voll ist (vorher wäre es Rauschen). */
export const FORECAST_LEAD_MIN = 60;
/** Ab diesem Füllstand warnen, wenn keine eigene Warnschwelle gesetzt ist. */
export const DEFAULT_HIGH_PCT = 85;
/** Ohne Reset-Zeit (ältere Codex-Verläufe): höchstens alle 5 Std je Fenster. */
const NO_RESET_QUIET_MS = 5 * 3_600_000;
const TOOL_NAME = { claude: "Claude", codex: "Codex" } as const;
const SOURCE = { claude: "Werte von Anthropic", codex: "Werte von Codex" } as const;
/** dieselben Anthropic-Werte, gelesen von CodexBar auf dem Rechner. */
const SOURCE_CODEXBAR = "Werte von Anthropic über CodexBar";

/** Soll der Limit-Wecker für diese Hochrechnung klingeln? (voll vor dem Reset, bald, noch nicht voll) */
export function forecastDue(f: WindowForecast, now: Date): boolean {
  if (f.hitsLimitAt === null || f.resetsAt === null || f.pct === null || f.pct >= 100) return false;
  const mins = (Date.parse(f.hitsLimitAt) - now.getTime()) / 60_000;
  return mins <= FORECAST_LEAD_MIN && Date.parse(f.hitsLimitAt) < Date.parse(f.resetsAt);
}

/**
 * Codex meldet den Reset je Ereignis neu — Sekunden-Abweichungen dürfen kein „neues Fenster“ sein
 * (sonst zweite Mitteilung). Fenster sind ≥ 5 Std lang, 10 Min Spielraum trennen sie sicher.
 */
const SAME_WINDOW_TOLERANCE_MS = 10 * 60_000;
export function sameWindow(prev: string | undefined, resetsAt: string): boolean {
  if (!prev) return false;
  const d = Math.abs(Date.parse(prev) - Date.parse(resetsAt));
  return Number.isFinite(d) && d < SAME_WINDOW_TOLERANCE_MS;
}

export type RealAlarm = { reason: "high"; pct: number; resetsAt: string | null } | { reason: "forecast"; pct: number; resetsAt: string; hitsAt: string };

/** Rein: Warnt der echte Stand (Schwelle) oder die Hochrechnung aus echtem Tempo? `null` = alles ruhig. */
export function realAlarm(latest: Reading | null, pacePctPerMin: number | null, thresholdPct: number, now: Date): RealAlarm | null {
  if (!latest) return null;
  if (latest.resetsAt !== null && Date.parse(latest.resetsAt) <= now.getTime()) return null; // Fenster schon vorbei
  if (latest.pct >= thresholdPct) return { reason: "high", pct: latest.pct, resetsAt: latest.resetsAt };
  if (pacePctPerMin === null || pacePctPerMin <= 0 || latest.resetsAt === null) return null;
  const hitsAt = Date.parse(latest.at) + ((100 - latest.pct) / pacePctPerMin) * 60_000;
  if (hitsAt >= Date.parse(latest.resetsAt) || hitsAt - now.getTime() > FORECAST_LEAD_MIN * 60_000) return null;
  return { reason: "forecast", pct: latest.pct, resetsAt: latest.resetsAt, hitsAt: new Date(Math.max(hitsAt, now.getTime())).toISOString() };
}

/** `source` ist der deutsche Quellen-Text (Schlüssel), übersetzt wird hier beim Erzeugen. */
function alarmMessage(tool: "claude" | "codex", window: "5h" | "week", a: RealAlarm, source: string = SOURCE[tool]): { title: string; message: string } {
  const name = TOOL_NAME[tool];
  const pct = Math.round(a.pct);
  const what = window === "5h" ? t("Sitzung {pct} % belegt", { pct }) : t("Woche {pct} % belegt", { pct });
  const reset = a.resetsAt ? t("Reset um {time}", { time: localClock(a.resetsAt) }) : t("Reset-Zeit unbekannt");
  const resetWhen = a.resetsAt && window === "week" ? t("Reset {when}", { when: dateTimeFormat({ weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(a.resetsAt)) }) : reset;
  const vars = { tool: name, what, reset: resetWhen, source: t(source) };
  if (a.reason === "high") {
    return {
      title: window === "5h" ? t("Nutzung: {tool}-Sitzung fast voll", vars) : t("Nutzung: {tool}-Woche fast voll", vars),
      message: t("{tool}: {what}, {reset} ({source}).", vars),
    };
  }
  return {
    title: window === "5h" ? t("Nutzung: {tool}-Sitzung bald voll", vars) : t("Nutzung: {tool}-Woche bald voll", vars),
    message: t("{tool}: {what} – bei diesem Tempo voll um {time}, {reset} ({source}).", { ...vars, time: localClock(a.hitsAt) }),
  };
}

/** Echte Messpunkte dieses Takts einsammeln: Claude kommt vom Arbeiter (schon im Speicher), Codex aus dem Verlauf. */
async function collectReadings(db: Db, readings: UsageReadings, now: Date): Promise<ReadingKey[]> {
  const keys: ReadingKey[] = [];
  const official = readings.official(now);
  if (official?.fiveHour) keys.push("claude:5h");
  if (official?.sevenDay) keys.push("claude:week");
  const codex = (await getLimits(db)).find((l) => l.tool === "codex")?.data ?? null;
  const rep = reportedFrom("codex", codex, now);
  const at = now.toISOString();
  if (rep.fiveHourPct !== null) {
    readings.record("codex:5h", { pct: rep.fiveHourPct, resetsAt: rep.resetsAt, at });
    keys.push("codex:5h");
  }
  if (rep.weekPct !== null) {
    readings.record("codex:week", { pct: rep.weekPct, resetsAt: rep.weekResetsAt, at });
    keys.push("codex:week");
  }
  return keys;
}

/** Prüft die Schwellen und schickt je Anlass höchstens eine Mitteilung. Gibt die ausgelösten Anlässe zurück
 * (`"daily"`, `"high:<werkzeug>:<fenster>"`, `"forecast:<werkzeug>:<fenster>"`). */
export async function checkUsageWarnings(db: Db, sender: NtfySender, pushSettings: PushSettings, now = new Date(), readings: UsageReadings = usageReadings, env?: NotifyEnv): Promise<string[]> {
  const settings = await loadUsageSettings(db);
  const state = await loadWarnState(db);
  const next = { dailyDay: state.dailyDay, windowAt: { ...(state.windowAt ?? {}) }, forecastFor: { ...(state.forecastFor ?? {}) } };
  const fired: string[] = [];
  const deps = { db, sender, settings: pushSettings, now, env };

  if (settings.warnDailyTokens !== null) {
    const status = await getWarningStatus(db, { ...settings, warnWindowPct: null }, now);
    const today = localDay(now);
    if (status.daily?.over && state.dailyDay !== today) {
      const res = await notify(
        { kind: "usage_warning", title: t("Nutzung: Tagesgrenze überschritten"), message: t("Heute schon {today} Tokens. Deine Warnschwelle liegt bei {threshold}.", { today: formatTokensCompact(status.daily.today), threshold: formatTokensCompact(status.daily.threshold) }), path: "/usage" },
        deps,
      );
      next.dailyDay = today;
      if (res.sent || res.reason === "quiet_hours") fired.push("daily");
    }
  }

  // Limit notifications only from real values; switched off via the level of the occasion `usage_warning` ("never";
  // the old switches are already included in it).
  if ((await loadNotifyRules(db)).when.usage_warning !== "never") {
    const threshold = settings.warnWindowPct ?? DEFAULT_HIGH_PCT;
    for (const key of await collectReadings(db, readings, now)) {
      const alarm = realAlarm(readings.latest(key), readings.pace(key), threshold, now);
      if (!alarm) continue;
      if (alarm.resetsAt !== null ? sameWindow(next.forecastFor[key], alarm.resetsAt) : next.windowAt[key] && now.getTime() - Date.parse(next.windowAt[key]) < NO_RESET_QUIET_MS) continue;
      const [tool, window] = key.split(":") as ["claude" | "codex", "5h" | "week"];
      const source = tool === "claude" && readings.official(now)?.source === "codexbar" ? SOURCE_CODEXBAR : SOURCE[tool];
      const res = await notify({ kind: "usage_warning", ...alarmMessage(tool, window, alarm, source), path: "/usage" }, deps);
      if (alarm.resetsAt !== null) next.forecastFor[key] = alarm.resetsAt;
      else next.windowAt[key] = now.toISOString();
      if (res.sent || res.reason === "quiet_hours") fired.push(`${alarm.reason}:${key}`);
    }
  }

  const changed =
    next.dailyDay !== state.dailyDay || JSON.stringify(next.windowAt) !== JSON.stringify(state.windowAt ?? {}) || JSON.stringify(next.forecastFor) !== JSON.stringify(state.forecastFor ?? {});
  if (changed) await saveWarnState(db, { dailyDay: next.dailyDay, windowAt: next.windowAt, ...(Object.keys(next.forecastFor).length > 0 ? { forecastFor: next.forecastFor } : {}) });
  return fired;
}
