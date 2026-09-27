// „Limit-Wecker“: Hochrechnung je Werkzeug und Fenster (5 Std, Woche) aus dem Verbrauchs-Tempo der
// letzten 30 Min und dem Reset-Zeitpunkt. Ehrlich, wenn Daten fehlen — dann keine Zahl, nur ein Satz.
//
// Woher die Zahlen kommen (nie geschätzt ohne Grundlage):
// - Codex meldet Füllstand in % und den Reset selbst (`token_count.rate_limits`) → Grundlage „reported“.
// - Claude meldet keinen Füllstand, nur „Limit erreicht bis …“. Das Fassungsvermögen messen wir am Fenster,
//   in dem der Nutzer zuletzt ans Limit kam (Tokens in den 5 Std vor dessen Reset) → Grundlage „last_limit“.
//   Das laufende Fenster beginnt wie bei Claude mit der ersten Nachricht (auf die volle Stunde abgerundet)
//   und endet 5 Std später. Ein Wochen-Limit nennt Claude nicht → keine Hochrechnung.
// Liefert der Nyx-Motor echte Werte von Anthropic (usage/official.ts), gelten NUR diese (Grundlage „reported“,
//   Tempo aus zwei echten Messpunkten). Die Hochrechnung „last_limit“ ist dann weg und sonst als „Schätzung:“
//   gekennzeichnet — Push-Mitteilungen löst sie nie aus (usage/warnings.ts).
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { usageReadings, type OfficialWindow, type UsageReadings } from "./official.js";
import { dateTimeFormat, t } from "@nyxos/shared";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const WINDOW_MS = 5 * HOUR_MS;
/** Tempo = Verbrauch der letzten 30 Min. */
export const PACE_WINDOW_MIN = 30;
const TOTAL = sql.raw("(input_tokens + output_tokens + cache_read_tokens + cache_creation_5m_tokens + cache_creation_1h_tokens)");

export type ForecastWindowKind = "5h" | "week";
export type ForecastBasis = "reported" | "last_limit";

export interface WindowForecast {
  tool: "claude" | "codex";
  window: ForecastWindowKind;
  /** Füllstand in % (`null` = unbekannt). */
  pct: number | null;
  resetsAt: string | null;
  /** Wann das Fenster bei diesem Tempo voll ist — nur, wenn das vor dem Reset passiert. */
  hitsLimitAt: string | null;
  /** Was beim Reset voraussichtlich ungenutzt bleibt (%), `null` = unbekannt. */
  unusedAtReset: number | null;
  /** Tempo in %-Punkten je Minute (letzte 30 Min). */
  pacePctPerMin: number | null;
  basis: ForecastBasis | null;
  /** Eine Zeile für die Oberfläche, deutsch und ohne Technik. */
  line: string;
}

/**
 * Reine Hochrechnung: Bei `pacePctPerMin` %-Punkten je Minute — wann ist das Fenster voll, und was bleibt beim Reset
 * übrig? Ohne Füllstand oder Reset gibt es keine Aussage (beides `null`), nie einen Fehler.
 */
export function forecastWindow(input: { pct: number | null; resetsAt: Date | string | null; pacePctPerMin: number; now: Date }): { hitsLimitAt: Date | null; unusedAtReset: number | null } {
  const { pct, now } = input;
  if (pct === null || input.resetsAt === null || !Number.isFinite(pct)) return { hitsLimitAt: null, unusedAtReset: null };
  const resetsAt = typeof input.resetsAt === "string" ? new Date(input.resetsAt) : input.resetsAt;
  const toResetMin = (resetsAt.getTime() - now.getTime()) / MIN_MS;
  if (!Number.isFinite(toResetMin) || toResetMin <= 0) return { hitsLimitAt: null, unusedAtReset: null };
  if (pct >= 100) return { hitsLimitAt: now, unusedAtReset: 0 };
  const pace = Number.isFinite(input.pacePctPerMin) ? Math.max(0, input.pacePctPerMin) : 0;
  const left = 100 - pct;
  if (pace > 0) {
    const toFullMin = left / pace;
    if (toFullMin < toResetMin) return { hitsLimitAt: new Date(now.getTime() + toFullMin * MIN_MS), unusedAtReset: 0 };
  }
  return { hitsLimitAt: null, unusedAtReset: Math.max(0, left - pace * toResetMin) };
}

export function localClock(d: Date | string): string {
  return dateTimeFormat({ hour: "2-digit", minute: "2-digit" }).format(typeof d === "string" ? new Date(d) : d);
}

function lineFor(f: Omit<WindowForecast, "line">, now: Date): string {
  if (f.pct === null || f.resetsAt === null) return "";
  if (f.pct >= 100) return f.window === "5h" ? t("5-Std-Fenster ist voll · Reset {time}", { time: localClock(f.resetsAt) }) : t("Wochen-Limit ist voll · Reset {time}", { time: localClock(f.resetsAt) });
  if (f.hitsLimitAt) {
    const mins = Math.max(1, Math.round((Date.parse(f.hitsLimitAt) - now.getTime()) / MIN_MS));
    return t("Bei diesem Tempo voll um {time} (in ~{n} Min) · Reset erst {reset}", { time: localClock(f.hitsLimitAt), n: mins, reset: localClock(f.resetsAt) });
  }
  const vars = { time: localClock(f.resetsAt), pct: f.unusedAtReset === null ? null : Math.round(f.unusedAtReset) };
  if (f.pacePctPerMin) return vars.pct === null ? t("Reicht bei diesem Tempo bis zum Reset um {time}", vars) : t("Reicht bei diesem Tempo bis zum Reset um {time} (dann noch ~{pct} % frei)", vars);
  return vars.pct === null ? t("Reicht bis zum Reset um {time}", vars) : t("Reicht bis zum Reset um {time} (dann noch ~{pct} % frei)", vars);
}

function build(base: Omit<WindowForecast, "hitsLimitAt" | "unusedAtReset" | "line">, now: Date, missing: string): WindowForecast {
  const r = forecastWindow({ pct: base.pct, resetsAt: base.resetsAt, pacePctPerMin: base.pacePctPerMin ?? 0, now });
  const f = { ...base, hitsLimitAt: r.hitsLimitAt?.toISOString() ?? null, unusedAtReset: r.unusedAtReset };
  return { ...f, line: lineFor(f, now) || missing };
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Beginn des laufenden Claude-Fensters: erste Nachricht nach dem letzten Fenster, auf die Stunde abgerundet. */
export function currentBlockStart(minutes: { t: number }[], now: Date): Date | null {
  let start: number | null = null;
  for (const m of minutes) {
    if (m.t > now.getTime()) break;
    if (start === null || m.t >= start + WINDOW_MS) start = Math.floor(m.t / HOUR_MS) * HOUR_MS;
  }
  return start !== null && start + WINDOW_MS > now.getTime() ? new Date(start) : null;
}

interface ClaudeLimitData {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** Hochrechnungen für Claude und Codex (je 5 Std und Woche). `limits` = Anbieter-Daten wie in `getLimits`. */
export async function getForecasts(db: Db, limits: { tool: "claude" | "codex"; data: unknown }[], now = new Date(), readings: UsageReadings = usageReadings): Promise<WindowForecast[]> {
  const nowIso = now.toISOString();
  const [paceRes, minutesRes] = await Promise.all([
    db.execute(sql`
      select tool,
             coalesce(sum(${TOTAL}) filter (where ts >= ${nowIso}::timestamptz - interval '5 hours'), 0)::float8 as t5h,
             coalesce(sum(${TOTAL}) filter (where ts >= ${nowIso}::timestamptz - interval '7 days'), 0)::float8 as t7d,
             coalesce(sum(${TOTAL}) filter (where ts >= ${nowIso}::timestamptz - make_interval(mins => ${PACE_WINDOW_MIN})), 0)::float8 as t30
      from usage_events where ts >= ${nowIso}::timestamptz - interval '7 days' and ts <= ${nowIso}::timestamptz group by tool`),
    db.execute(sql`
      select (extract(epoch from date_trunc('minute', ts)) * 1000)::float8 as t, sum(${TOTAL})::float8 as tokens
      from usage_events where tool = 'claude' and ts >= ${nowIso}::timestamptz - interval '24 hours' and ts <= ${nowIso}::timestamptz
      group by 1 order by 1`),
  ]);
  const sums = rowsOf<{ tool: string; t5h: number; t7d: number; t30: number }>(paceRes);
  const sumOf = (tool: string) => sums.find((r) => r.tool === tool);
  const perMin = (tool: string) => Number(sumOf(tool)?.t30 ?? 0) / PACE_WINDOW_MIN;
  const out: WindowForecast[] = [];

  // ── Claude ──
  const official = readings.official(now);
  if (official) {
    // Quelle nennen — direkt von Anthropic (OAuth) oder dieselben Werte über CodexBar auf dem Rechner.
    const from = official.source === "codexbar" ? t("von Anthropic über CodexBar") : t("von Anthropic");
    const real = (kind: ForecastWindowKind, w: OfficialWindow | null): WindowForecast => {
      if (!w || !w.resetsAt || Date.parse(w.resetsAt) <= now.getTime())
        return build({ tool: "claude", window: kind, pct: w?.pct ?? null, resetsAt: null, pacePctPerMin: null, basis: w ? "reported" : null }, now, w ? (kind === "5h" ? t("Sitzung: {pct} % belegt ({from})", { pct: Math.round(w.pct), from }) : t("Woche: {pct} % belegt ({from})", { pct: Math.round(w.pct), from })) : kind === "5h" ? t("Sitzung: Anthropic meldet gerade keinen Wert.") : t("Woche: Anthropic meldet gerade keinen Wert."));
      const pace = readings.pace(kind === "5h" ? "claude:5h" : "claude:week");
      const f = build({ tool: "claude", window: kind, pct: w.pct, resetsAt: w.resetsAt, pacePctPerMin: pace, basis: "reported" }, now, "");
      // Ohne zweiten echten Messpunkt kein Tempo → nur der Stand, keine Aussage „reicht“/„voll um“.
      const shown = { pct: Math.round(w.pct), time: localClock(w.resetsAt) };
      const line = pace === null && w.pct < 100 ? (kind === "5h" ? t("Sitzung {pct} % belegt · Reset {time}", shown) : t("Woche {pct} % belegt · Reset {time}", shown)) : f.line;
      return { ...f, line: `${line} (${from})` };
    };
    out.push(real("5h", official.fiveHour), real("week", official.sevenDay));
  } else {
    out.push(...(await claudeEstimate(db, limits, now, minutesRes, perMin)));
  }

  // ── Codex ──
  const codex = (limits.find((l) => l.tool === "codex")?.data ?? null) as { primary?: CodexWindow | null; secondary?: CodexWindow | null } | null;
  const windows = [codex?.primary, codex?.secondary].filter((w): w is CodexWindow => !!w && typeof w.used_percent === "number");
  const short = windows.find((w) => (w.window_minutes ?? 0) <= 6 * 60) ?? null;
  const long = windows.find((w) => (w.window_minutes ?? 0) > 6 * 60) ?? null;
  const codexFor = (kind: ForecastWindowKind, w: CodexWindow | null, tokens: number): WindowForecast => {
    const pct = w?.used_percent ?? null;
    const resetsAt = typeof w?.resets_at === "number" ? new Date(w.resets_at * 1000) : null;
    if (pct === null || !resetsAt || resetsAt.getTime() <= now.getTime())
      return build({ tool: "codex", window: kind, pct: null, resetsAt: null, pacePctPerMin: null, basis: null }, now, kind === "5h" ? t("5 Std: Codex meldet gerade keinen Füllstand, darum keine Hochrechnung.") : t("Woche: Codex meldet gerade keinen Füllstand, darum keine Hochrechnung."));
    // %-Punkte je Token aus dem gemeldeten Stand; Tokens seit Fensterbeginn (höchstens die Fensterlänge).
    const pace = pct > 0 && tokens > 0 ? (perMin("codex") * pct) / tokens : 0;
    return build({ tool: "codex", window: kind, pct, resetsAt: resetsAt.toISOString(), pacePctPerMin: pace, basis: "reported" }, now, "");
  };
  out.push(codexFor("5h", short, Number(sumOf("codex")?.t5h ?? 0)));
  out.push(codexFor("week", long, Number(sumOf("codex")?.t7d ?? 0)));
  return out;
}

/** Ohne echte Werte: die alte Schätzung (gemessen am letzten erreichten Limit), klar als „Schätzung“ gekennzeichnet. */
async function claudeEstimate(db: Db, limits: { tool: "claude" | "codex"; data: unknown }[], now: Date, minutesRes: unknown, perMin: (tool: string) => number): Promise<WindowForecast[]> {
  const out: WindowForecast[] = [];
  const claude = (limits.find((l) => l.tool === "claude")?.data ?? null) as ClaudeLimitData | null;
  const lastReset = claude && typeof claude.resetsAt === "number" && claude.status === "rejected" ? new Date(claude.resetsAt * 1000) : null;
  const lastIsWindow = lastReset !== null && (claude?.rateLimitType ?? "five_hour") === "five_hour";
  const stillBlocked = lastIsWindow && lastReset !== null && lastReset.getTime() > now.getTime();
  const minutes = rowsOf<{ t: number; tokens: number }>(minutesRes).map((r) => ({ t: Number(r.t), tokens: Number(r.tokens) }));
  const blockStart = currentBlockStart(minutes, now);
  let capacity: number | null = null;
  if (lastIsWindow && lastReset) {
    const capRes = await db.execute(sql`
      select coalesce(sum(${TOTAL}), 0)::float8 as tokens from usage_events
      where tool = 'claude' and ts >= ${new Date(lastReset.getTime() - WINDOW_MS).toISOString()}::timestamptz and ts < ${lastReset.toISOString()}::timestamptz`);
    const cap = Number(rowsOf<{ tokens: number }>(capRes)[0]?.tokens ?? 0);
    capacity = cap > 0 ? cap : null;
  }
  if (stillBlocked && lastReset) {
    out.push(build({ tool: "claude", window: "5h", pct: 100, resetsAt: lastReset.toISOString(), pacePctPerMin: null, basis: "reported" }, now, ""));
  } else if (capacity === null) {
    out.push(build({ tool: "claude", window: "5h", pct: null, resetsAt: blockStart ? new Date(blockStart.getTime() + WINDOW_MS).toISOString() : null, pacePctPerMin: null, basis: null }, now, t("Keine Hochrechnung: Claude nennt keinen Füllstand, und ein erreichtes Limit ist noch nicht bekannt.")));
  } else if (!blockStart) {
    out.push(build({ tool: "claude", window: "5h", pct: null, resetsAt: null, pacePctPerMin: null, basis: "last_limit" }, now, t("Gerade läuft kein Claude-Fenster.")));
  } else {
    const used = minutes.filter((m) => m.t >= blockStart.getTime()).reduce((a, m) => a + m.tokens, 0);
    const resetsAt = new Date(blockStart.getTime() + WINDOW_MS).toISOString();
    // Schon mehr verbraucht als im Limit-Fenster damals, aber Claude sperrt nicht: das Maß stimmt nicht (mehr).
    // Dann lieber keine Zahl als ein falsches „voll“ (Probe 25.09.: Ring 63 %, gemessen aber über 100 %).
    out.push(
      used >= capacity
        ? build({ tool: "claude", window: "5h", pct: null, resetsAt, pacePctPerMin: null, basis: null }, now, t("Keine sichere Hochrechnung: Du liegst schon über dem Fenster, in dem du zuletzt ans Limit kamst."))
        : build({ tool: "claude", window: "5h", pct: (used / capacity) * 100, resetsAt, pacePctPerMin: (perMin("claude") / capacity) * 100, basis: "last_limit" }, now, ""),
    );
  }
  const weekBlocked = lastReset !== null && claude?.rateLimitType === "seven_day" && lastReset.getTime() > now.getTime();
  out.push(
    weekBlocked && lastReset
      ? build({ tool: "claude", window: "week", pct: 100, resetsAt: lastReset.toISOString(), pacePctPerMin: null, basis: "reported" }, now, "")
      : build({ tool: "claude", window: "week", pct: null, resetsAt: null, pacePctPerMin: null, basis: null }, now, t("Woche: Claude nennt keinen Wochen-Füllstand, darum keine Hochrechnung.")),
  );

  return out.map((f) => (f.basis === "last_limit" && f.pct !== null ? { ...f, line: t("Schätzung: {line}", { line: f.line }) } : f));
}
