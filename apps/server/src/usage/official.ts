// Echte Claude-Limits statt Schätzung. Quelle: der OAuth-Nutzungs-Endpunkt von Anthropic
// (`GET https://api.anthropic.com/api/oauth/usage`, derselbe, den Menüleisten-Apps wie CodexBar lesen).
// Kostenlos (keine Modell-Tokens), nur lesend.
//
// Wer fragt: NICHT die API. Das Claude-Token (`claude setup-token`) liegt nur im Agent-Container
// (infra/docker-compose.yml leert es für die API bewusst). Der Arbeiter dort (haiku-worker.ts) fragt
// höchstens alle 5 Min, mit Zeitlimit, und schickt über die bestehende Arbeiter-Leitung NUR die Zahlen
// (Prozent + Reset) — nie das Token, nie die rohe Antwort. Fehler: still, im Log nur die Art (z. B. „403“).
//
// Hier: Parser, Abruf (mit injizierbarem fetch für Tests), Abruf-Takt für den Arbeiter und der kleine
// Speicher im API-Prozess (letzter Stand + Verlauf echter Messpunkte für die Hochrechnung).
import { UsageReadingsMsgSchema, t } from "@nyxos/shared";
import { z } from "zod";

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** Höchstens so oft fragen. */
export const USAGE_POLL_MS = 5 * 60_000;
/** Nach „Token abgelehnt/keine Berechtigung“ viel seltener fragen (ändert sich erst mit neuem Token). */
export const USAGE_POLL_DENIED_MS = 60 * 60_000;
export const USAGE_FETCH_TIMEOUT_MS = 10_000;
/** Älter als das gilt ein Stand nicht mehr als „aktuell“ (3 verpasste Abrufe). */
export const OFFICIAL_FRESH_MS = 16 * 60_000;
/** CodexBar (Brücke): aktualisiert etwa jede Minute; älter als das gilt nicht mehr als „aktuell“. */
export const CODEXBAR_FRESH_MS = 20 * 60_000;

/** Woher echte Claude-Werte stammen: OAuth-Endpunkt (Agent-Container) oder CodexBar auf dem Rechner (Brücke). */
export type OfficialSource = "anthropic" | "codexbar";

export interface OfficialWindow {
  /** Belegt in Prozent (0–100), so wie Anthropic es meldet. */
  pct: number;
  resetsAt: string | null;
}

export interface OfficialUsage {
  /** 5-Stunden-Fenster („Sitzung“). */
  fiveHour: OfficialWindow | null;
  /** Wochenlimit (alle Modelle). */
  sevenDay: OfficialWindow | null;
  /** Modell-eigene Wochenwerte, wenn Anthropic sie meldet. */
  sevenDayOpus: OfficialWindow | null;
  sevenDaySonnet: OfficialWindow | null;
  fetchedAt: string;
  /** Quelle; fehlt = OAuth („anthropic“). */
  source?: OfficialSource;
}

export type OfficialError = "no_token" | "unauthorized" | "forbidden" | "rate_limited" | "http" | "timeout" | "network" | "parse";

export type OfficialFetchResult = { ok: true; usage: OfficialUsage } | { ok: false; error: OfficialError; status?: number };

/** Ein deutscher Satz je Fehlerart (für Anzeige und Log, ohne Geheimnis). */
export const OFFICIAL_ERROR_TEXT: Record<OfficialError, string> = {
  no_token: "Im Nyx-Motor ist kein Claude-Token gesetzt.",
  unauthorized: "Anthropic hat das Token abgelehnt (abgelaufen oder ungültig).",
  forbidden: "Das Token darf die Nutzung nicht lesen (fehlende Berechtigung).",
  rate_limited: "Anthropic bremst die Abfrage gerade (zu oft gefragt).",
  http: "Anthropic hat mit einem Fehler geantwortet.",
  timeout: "Anthropic hat nicht rechtzeitig geantwortet.",
  network: "Anthropic war nicht erreichbar.",
  parse: "Die Antwort von Anthropic war nicht lesbar.",
};

function windowOf(raw: unknown): OfficialWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { utilization?: unknown; resets_at?: unknown };
  const u = typeof r.utilization === "number" ? r.utilization : typeof r.utilization === "string" ? Number(r.utilization) : NaN;
  if (!Number.isFinite(u)) return null;
  const resets = typeof r.resets_at === "string" && Number.isFinite(Date.parse(r.resets_at)) ? new Date(r.resets_at).toISOString() : null;
  return { pct: Math.min(100, Math.max(0, u)), resetsAt: resets };
}

/** Liest die Antwort des Endpunkts. `null`, wenn gar kein Fenster darin steht. */
export function parseOauthUsage(body: unknown, fetchedAt: Date): OfficialUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const usage: OfficialUsage = {
    fiveHour: windowOf(b.five_hour),
    sevenDay: windowOf(b.seven_day),
    sevenDayOpus: windowOf(b.seven_day_opus),
    sevenDaySonnet: windowOf(b.seven_day_sonnet),
    fetchedAt: fetchedAt.toISOString(),
  };
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Ein Abruf. Das Token geht nur in den Authorization-Kopf — nie in Rückgabe, Fehlertext oder Log. */
export async function fetchOauthUsage(opts: { token: string | undefined | null; fetchImpl?: FetchLike; timeoutMs?: number; now?: () => Date }): Promise<OfficialFetchResult> {
  const token = opts.token?.trim();
  if (!token) return { ok: false, error: "no_token" };
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? USAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await f(OAUTH_USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA_HEADER, Accept: "application/json", "User-Agent": "NyxOS-NyxOS/1" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const error: OfficialError = res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden" : res.status === 429 ? "rate_limited" : "http";
      return { ok: false, error, status: res.status };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: "parse" };
    }
    const usage = parseOauthUsage(body, (opts.now ?? (() => new Date()))());
    return usage ? { ok: true, usage } : { ok: false, error: "parse" };
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** Was der Arbeiter über die Leitung schickt (nur Zahlen bzw. die Fehlerart). */
export interface UsageReport {
  type: "usage";
  usage: OfficialUsage | null;
  error: OfficialError | null;
  status?: number;
}

/** Uhr-Spielraum für `fetchedAt` aus dem Arbeiter; Reset höchstens so weit hinter dem Messzeitpunkt (Woche + Luft). */
const REPORT_CLOCK_SKEW_MS = 2 * 60_000;
const REPORT_MAX_RESET_AHEAD_MS = 8 * 24 * 3_600_000;
const isoDate = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)));
const WindowSchema = z.object({ pct: z.number().finite().min(0).max(100), resetsAt: isoDate.nullable() }).nullable();
const OFFICIAL_ERRORS = Object.keys(OFFICIAL_ERROR_TEXT) as [OfficialError, ...OfficialError[]];
const UsageReportSchema = z.object({
  type: z.literal("usage"),
  usage: z.object({ fiveHour: WindowSchema, sevenDay: WindowSchema, sevenDayOpus: WindowSchema.optional(), sevenDaySonnet: WindowSchema.optional(), fetchedAt: isoDate }).nullable(),
  error: z.enum(OFFICIAL_ERRORS).nullable(),
  status: z.number().int().optional(),
});

/**
 * Bericht von der Arbeiter-Leitung prüfen, bevor er in den Speicher kommt (Prozent 0–100, gültige Zeiten,
 * Messzeitpunkt nicht in der Zukunft, Reset plausibel nah). `null` = verwerfen.
 */
export function parseUsageReport(raw: unknown, now = new Date()): Pick<UsageReport, "usage" | "error"> | null {
  const r = UsageReportSchema.safeParse(raw);
  if (!r.success) return null;
  const { usage, error } = r.data;
  if (!usage) return error ? { usage: null, error } : null;
  const at = Date.parse(usage.fetchedAt);
  if (at > now.getTime() + REPORT_CLOCK_SKEW_MS) return null;
  const ws = [usage.fiveHour, usage.sevenDay, usage.sevenDayOpus ?? null, usage.sevenDaySonnet ?? null];
  if (ws.some((w) => w?.resetsAt && Date.parse(w.resetsAt) - at > REPORT_MAX_RESET_AHEAD_MS)) return null;
  if (!usage.fiveHour && !usage.sevenDay) return null;
  const norm = (w: OfficialWindow | null | undefined): OfficialWindow | null => (w ? { pct: w.pct, resetsAt: w.resetsAt ? new Date(w.resetsAt).toISOString() : null } : null);
  return {
    usage: { fiveHour: norm(usage.fiveHour), sevenDay: norm(usage.sevenDay), sevenDayOpus: norm(usage.sevenDayOpus), sevenDaySonnet: norm(usage.sevenDaySonnet), fetchedAt: new Date(at).toISOString() },
    error: null,
  };
}

/**
 * Bericht der Brücke aus CodexBar (`usage_readings`, s. packages/shared/src/usage-readings.ts) prüfen —
 * dieselben Regeln wie `parseUsageReport`: Prozent 0–100, gültige Zeiten, Messzeitpunkt höchstens 2 Min in der
 * Zukunft, Reset höchstens 8 Tage nach der Messung. Ein unplausibles Sitzungs-/Wochenfenster verwirft den ganzen
 * Bericht; Modell-Wochen und Verlaufspunkte fallen einzeln weg (auch, wenn sie > 20 Min neben dem Stand liegen —
 * CodexBar führt z. B. „opus“ seit Juli nicht mehr fort). Alter wird NICHT verworfen: „aktuell“ entscheidet `official()`.
 */
export function parseCodexBarReport(raw: unknown, now = new Date()): { usage: OfficialUsage; history: Reading[] } | null {
  const r = UsageReadingsMsgSchema.safeParse(raw);
  if (!r.success) return null;
  const m = r.data;
  type W = { utilization: number; resets_at: string | null; fetchedAt: string };
  const check = (w: W): (Reading & { atMs: number }) | null => {
    const at = Date.parse(w.fetchedAt);
    if (!Number.isFinite(at) || at > now.getTime() + REPORT_CLOCK_SKEW_MS) return null;
    if (!Number.isFinite(w.utilization) || w.utilization < 0 || w.utilization > 100) return null;
    let resetsAt: string | null = null;
    if (w.resets_at !== null) {
      const reset = Date.parse(w.resets_at);
      if (!Number.isFinite(reset) || reset - at > REPORT_MAX_RESET_AHEAD_MS) return null;
      resetsAt = new Date(reset).toISOString();
    }
    return { pct: w.utilization, resetsAt, at: new Date(at).toISOString(), atMs: at };
  };
  const five = m.fiveHour ? check(m.fiveHour) : null;
  const week = m.sevenDay ? check(m.sevenDay) : null;
  if ((m.fiveHour && !five) || (m.sevenDay && !week)) return null;
  const main = five ?? week;
  if (!main) return null;
  const near = (w: W | null): OfficialWindow | null => {
    const c = w ? check(w) : null;
    return c && Math.abs(c.atMs - main.atMs) <= CODEXBAR_FRESH_MS ? { pct: c.pct, resetsAt: c.resetsAt } : null;
  };
  const history = m.sessionHistory
    .map(check)
    .filter((h): h is Reading & { atMs: number } => h !== null && h.atMs <= main.atMs)
    .sort((a, b) => a.atMs - b.atMs)
    .map(({ pct, resetsAt, at }) => ({ pct, resetsAt, at }));
  return {
    usage: {
      fiveHour: five ? { pct: five.pct, resetsAt: five.resetsAt } : null,
      sevenDay: near(m.sevenDay),
      sevenDayOpus: near(m.sevenDayOpus),
      sevenDaySonnet: near(m.sevenDaySonnet),
      fetchedAt: main.at,
      source: "codexbar",
    },
    history,
  };
}

/**
 * Abruf-Takt im Arbeiter: sofort einmal, dann alle 5 Min (nach 401/403 stündlich). `send` bekommt jedes Ergebnis.
 * Liefert eine Stopp-Funktion. Timer blockieren das Beenden des Prozesses nicht.
 */
export function startUsagePoller(o: {
  token: () => string | undefined | null;
  send: (r: UsageReport) => void;
  fetchImpl?: FetchLike;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  intervalMs?: number;
  deniedIntervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): () => void {
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  let stopped = false;
  let timer: unknown = null;
  const tick = async () => {
    if (stopped) return;
    const r = await fetchOauthUsage({ token: o.token(), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    if (stopped) return;
    if (r.ok) o.send({ type: "usage", usage: r.usage, error: null });
    else {
      o.log?.("nutzung-anthropic-fehler", { art: r.error, ...(r.status ? { status: r.status } : {}) });
      o.send({ type: "usage", usage: null, error: r.error, ...(r.status ? { status: r.status } : {}) });
    }
    const denied = !r.ok && (r.error === "unauthorized" || r.error === "forbidden" || r.error === "no_token");
    timer = setTimer(() => void tick(), denied ? (o.deniedIntervalMs ?? USAGE_POLL_DENIED_MS) : (o.intervalMs ?? USAGE_POLL_MS));
  };
  void tick();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
  };
}

// ───────────────────────────── Speicher im API-Prozess ─────────────────────────────

export type ReadingKey = `${"claude" | "codex"}:${"5h" | "week"}`;

export interface Reading {
  pct: number;
  resetsAt: string | null;
  /** Zeitpunkt der Messung. */
  at: string;
}

/** Punkte, die für ein Tempo mindestens auseinanderliegen müssen, und wie weit zurück wir schauen. */
export const PACE_MIN_SPAN_MS = 5 * 60_000;
export const PACE_LOOKBACK_MS = 60 * 60_000;
const HISTORY_MAX = 24;
const SAME_WINDOW_MS = 10 * 60_000;

function sameReset(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(Date.parse(a) - Date.parse(b)) < SAME_WINDOW_MS;
}

/**
 * Tempo in %-Punkten je Minute aus ZWEI echten Messpunkten desselben Fensters (mindestens 5 Min auseinander,
 * höchstens 60 Min zurück). `null` = zu wenig echte Punkte → keine Hochrechnung.
 */
export function paceFromReadings(readings: Reading[]): number | null {
  const last = readings[readings.length - 1];
  if (!last) return null;
  const lastAt = Date.parse(last.at);
  const first = readings.find((r) => sameReset(r.resetsAt, last.resetsAt) && lastAt - Date.parse(r.at) >= PACE_MIN_SPAN_MS && lastAt - Date.parse(r.at) <= PACE_LOOKBACK_MS);
  if (!first) return null;
  const mins = (lastAt - Date.parse(first.at)) / 60_000;
  return Math.max(0, (last.pct - first.pct) / mins);
}

export class UsageReadings {
  private officialUsage: OfficialUsage | null = null;
  private lastError: { error: OfficialError; at: string } | null = null;
  /** Stand des letzten CodexBar-Berichts (auch wenn er zu alt ist — für den Grund in der Anzeige). */
  private codexbarAt: string | null = null;
  private readonly history = new Map<ReadingKey, Reading[]>();

  /** Ein Bericht des Arbeiters (Erfolg oder Fehlerart). */
  recordReport(r: Pick<UsageReport, "usage" | "error">, now = new Date()): void {
    if (r.usage) {
      this.setOfficial({ ...r.usage, source: "anthropic" });
      this.lastError = null;
      if (r.usage.fiveHour) this.record("claude:5h", { ...r.usage.fiveHour, at: r.usage.fetchedAt });
      if (r.usage.sevenDay) this.record("claude:week", { ...r.usage.sevenDay, at: r.usage.fetchedAt });
    } else if (r.error) {
      this.lastError = { error: r.error, at: now.toISOString() };
    }
  }

  /** geprüfter Bericht aus CodexBar (über die Brücke), s. `parseCodexBarReport`. */
  recordCodexBar(r: { usage: OfficialUsage; history: Reading[] }): void {
    this.codexbarAt = r.usage.fetchedAt;
    this.setOfficial({ ...r.usage, source: "codexbar" });
    for (const h of r.history) this.record("claude:5h", h);
    if (r.usage.fiveHour) this.record("claude:5h", { ...r.usage.fiveHour, at: r.usage.fetchedAt });
    if (r.usage.sevenDay) this.record("claude:week", { ...r.usage.sevenDay, at: r.usage.fetchedAt });
  }

  /** Der jüngere Stand gewinnt — egal aus welcher Quelle. */
  private setOfficial(u: OfficialUsage): void {
    const cur = this.officialUsage;
    if (cur && Date.parse(cur.fetchedAt) > Date.parse(u.fetchedAt)) return;
    this.officialUsage = u;
  }

  /** Letzter echter Stand (OAuth oder CodexBar), wenn er frisch genug ist. */
  official(now = new Date()): OfficialUsage | null {
    const u = this.officialUsage;
    const maxAge = u?.source === "codexbar" ? CODEXBAR_FRESH_MS : OFFICIAL_FRESH_MS;
    if (!u || now.getTime() - Date.parse(u.fetchedAt) > maxAge) return null;
    return u;
  }

  /**
   * Für Anzeige/API: gibt es gerade echte Werte, woher, und falls nicht, warum (Fehler des OAuth-Wegs; Stand des
   * letzten CodexBar-Berichts, falls je einer kam).
   */
  status(now = new Date()): { fresh: boolean; source: OfficialSource | null; fetchedAt: string | null; error: OfficialError | null; errorText: string | null; codexbarAt: string | null } {
    const cur = this.official(now);
    const fresh = cur !== null;
    const error = fresh ? null : (this.lastError?.error ?? null);
    return {
      fresh,
      source: cur ? (cur.source ?? "anthropic") : null,
      fetchedAt: this.officialUsage?.fetchedAt ?? null,
      error,
      errorText: error ? t(OFFICIAL_ERROR_TEXT[error]) : null,
      codexbarAt: this.codexbarAt,
    };
  }

  /** Einen echten Messpunkt merken (gleicher Wert innerhalb 5 Min wird nicht doppelt gespeichert). */
  record(key: ReadingKey, r: Reading): void {
    const list = this.history.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && Date.parse(r.at) <= Date.parse(last.at)) return;
    if (last && last.pct === r.pct && sameReset(last.resetsAt, r.resetsAt) && Date.parse(r.at) - Date.parse(last.at) < PACE_MIN_SPAN_MS) return;
    list.push(r);
    const cutoff = Date.parse(r.at) - 2 * PACE_LOOKBACK_MS;
    while (list.length > HISTORY_MAX || (list[0] && Date.parse(list[0].at) < cutoff)) list.shift();
    this.history.set(key, list);
  }

  readings(key: ReadingKey): Reading[] {
    return [...(this.history.get(key) ?? [])];
  }

  latest(key: ReadingKey): Reading | null {
    const list = this.history.get(key);
    return list?.[list.length - 1] ?? null;
  }

  pace(key: ReadingKey): number | null {
    return paceFromReadings(this.history.get(key) ?? []);
  }
}

/** Der eine Speicher im API-Prozess (der Arbeiter füttert ihn über remoteEngine.ts). */
export const usageReadings = new UsageReadings();
