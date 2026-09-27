// Fetch-Helfer für den Tab "Nutzung" (eigene Datei je Bereich).
import { t, type UsageSettings, type UsageSettingsPatch } from "@nyxos/shared";
import { getJson, patchJson } from "../../lib/http";
import { authFetch } from "../terminal/authClient";

export type Range = "7" | "30" | "all";
export type ToolFilter = "all" | "claude" | "codex";

export interface DailyUsagePoint {
  day: string;
  tool: "claude" | "codex";
  model: string;
  project: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number | null;
}

export interface ModelUsage {
  model: string;
  tool: string;
  totalTokens: number;
  cost: number | null;
}

export interface ExpensiveSession {
  id: string;
  tool: string;
  title: string | null;
  model: string | null;
  totalTokens: number;
  cost: number | null;
}

export interface LimitStatus {
  tool: "claude" | "codex";
  source: string | null;
  data: unknown;
}

export interface Price {
  id: number;
  model: string;
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number;
  cacheCreation5mPerToken: number;
  cacheCreation1hPerToken: number | null;
  contextWindow: number | null;
  validFrom: string;
  source: string;
}

function qs(range: Range, tool?: ToolFilter): string {
  const p = new URLSearchParams({ range });
  if (tool && tool !== "all") p.set("tool", tool);
  return p.toString();
}

export const fetchDailyUsage = (range: Range, tool: ToolFilter): Promise<DailyUsagePoint[]> => getJson<{ days: DailyUsagePoint[] }>(`/api/usage/daily?${qs(range, tool)}`).then((r) => r.days);

export const fetchModelUsage = (range: Range): Promise<ModelUsage[]> => getJson<{ models: ModelUsage[] }>(`/api/usage/models?${qs(range)}`).then((r) => r.models);

export const fetchExpensiveSessions = (limit = 10): Promise<ExpensiveSession[]> => getJson<{ sessions: ExpensiveSession[] }>(`/api/usage/sessions?limit=${limit}`).then((r) => r.sessions);

export const fetchLimits = (): Promise<LimitStatus[]> => getJson<{ limits: LimitStatus[] }>("/api/usage/limits").then((r) => r.limits);

/** Heatmap Tag × Stunde (Zeitzone des Servers), `dow` 1 = Montag … 7 = Sonntag. */
export interface HeatCell {
  dow: number;
  hour: number;
  tokens: number;
}

export const fetchHourly = (range: Range, tool: ToolFilter): Promise<HeatCell[]> => getJson<{ cells: HeatCell[] }>(`/api/usage/hourly?${qs(range, tool)}`).then((r) => r.cells);

/** Fenster-Stand je Werkzeug (s. apps/server/src/usage/window.ts). */
export interface ToolWindow {
  tool: "claude" | "codex";
  tokens5h: number;
  tokens7d: number;
  peak5h: number;
  peak7d: number;
  hourly24: number[];
  reported: {
    fiveHourPct: number | null;
    weekPct: number | null;
    limitReached: boolean;
    limitType: string | null;
    resetsAt: string | null;
    /** Fehlt bei altem Server: Reset der Woche, Herkunft der Prozente, Stand der echten Werte. */
    weekResetsAt?: string | null;
    source?: "anthropic" | "codexbar" | "codex" | "limit_event" | null;
    fetchedAt?: string | null;
  };
  /** Hochrechnung je Fenster (s. apps/server/src/usage/forecast.ts); fehlt bei altem Server. */
  forecast?: WindowForecast[];
  /** Nur bei Claude — gibt es gerade echte Limits, woher, und sonst warum nicht (fehlt bei altem Server). */
  official?: OfficialStatus;
}

/** Stand der echten Claude-Limits (s. apps/server/src/usage/official.ts `UsageReadings.status`). */
export interface OfficialStatus {
  fresh: boolean;
  source: "anthropic" | "codexbar" | null;
  fetchedAt: string | null;
  error: string | null;
  errorText: string | null;
  codexbarAt: string | null;
}

/** „Limit-Wecker“: Hochrechnung aus Tempo (letzte 30 Min) und Reset. */
export interface WindowForecast {
  tool: "claude" | "codex";
  window: "5h" | "week";
  pct: number | null;
  resetsAt: string | null;
  hitsLimitAt: string | null;
  unusedAtReset: number | null;
  pacePctPerMin: number | null;
  basis: "reported" | "last_limit" | null;
  /** Fertiger Satz für die Oberfläche. */
  line: string;
}

export const fetchWindows = (): Promise<ToolWindow[]> =>
  getJson<{ windows: ToolWindow[]; forecast?: WindowForecast[]; official?: OfficialStatus }>("/api/usage/window").then((r) =>
    r.windows.map((w) => ({ ...w, forecast: (r.forecast ?? []).filter((f) => f.tool === w.tool), ...(w.tool === "claude" && r.official ? { official: r.official } : {}) })),
  );

export const fetchPrices = (): Promise<Price[]> => getJson<{ prices: Price[] }>("/api/usage/prices").then((r) => r.prices);

// ── Vergleiche, Modelle im Verlauf, Baustellen, Ziele, Einstellungen ────────────────────
// Typen spiegeln apps/server/src/usage/{compare,goals}.ts; Einstellungen aus @nyxos/shared.

export type UsageTool = "claude" | "codex";

export interface PeriodTotals {
  fromDay: string;
  toDay: string;
  tokens: number;
  byTool: Record<UsageTool, number>;
}

export interface ToolSide {
  tool: UsageTool;
  tokens: number;
  previousTokens: number;
  deltaPct: number | null;
  cost: number;
  costComplete: boolean;
  activeDays: number;
  share: number;
  topModel: string | null;
}

export interface PeriodComparison {
  kind: "week" | "month";
  current: PeriodTotals;
  previous: PeriodTotals;
  previousFull: PeriodTotals;
  deltaPct: number | null;
  series: { currentDays: (string | null)[]; previousDays: (string | null)[]; current: (number | null)[]; previous: (number | null)[] };
  tools: ToolSide[];
  totalDays: number;
}

/** Heute bis jetzt ggü. gestern bis zur gleichen Uhrzeit; `comparable = false` vor 06:00 (dann kein Trend). */
export interface DayComparison {
  today: PeriodTotals;
  previous: PeriodTotals;
  comparable: boolean;
  until: string;
  deltaPct: number | null;
}

export interface UsageComparison {
  now: string;
  /** Fehlt bei älteren Servern — dann zeigt „Heute“ keinen Trend. */
  day?: DayComparison;
  week: PeriodComparison;
  month: PeriodComparison;
}

export interface ModelTrend {
  weeks: string[];
  models: { model: string; tool: string; tokens: number[]; total: number }[];
}

export interface BaustelleUsage {
  slug: string;
  label: string;
  art: string;
  tokens: number;
  claude: number;
  codex: number;
  sessions: number;
}

export interface BaustellenUsage {
  items: BaustelleUsage[];
  ohneBaustelle: number;
  andere: number;
}

export interface GoalStatus {
  kind: "week" | "month";
  fromDay: string;
  lastDay: string;
  target: number;
  soFar: number;
  pct: number;
  pacePerDay: number;
  remainingDays: number;
  projected: number;
  onTrack: boolean;
  neededPerDay: number | null;
  reachDay: string | null;
}

export interface WarningStatus {
  daily: { threshold: number; today: number; over: boolean } | null;
  window: { threshold: number; tools: { tool: UsageTool; pct: number | null; reported: boolean; over: boolean }[] } | null;
}

export interface GoalsResponse {
  scope: UsageSettings["goalScope"];
  week: GoalStatus | null;
  month: GoalStatus | null;
  warnings: WarningStatus;
}

export const fetchComparison = (): Promise<UsageComparison> => getJson<UsageComparison>("/api/usage/compare");
export const fetchModelTrend = (weeks = 12): Promise<ModelTrend> => getJson<ModelTrend>(`/api/usage/model-trend?weeks=${weeks}`);
export const fetchBaustellen = (range: Range): Promise<BaustellenUsage> => getJson<BaustellenUsage>(`/api/usage/baustellen?${qs(range)}`);
export const fetchGoals = (): Promise<GoalsResponse> => getJson<GoalsResponse>("/api/usage/goals");
export const fetchUsageSettings = (): Promise<UsageSettings> => getJson<UsageSettings>("/api/usage/settings");

/** Schreibt über `authFetch` (Anmeldung + CSRF); eine Server-Meldung (400) kommt als Fehlertext zurück. */
export async function saveUsageSettings(patch: UsageSettingsPatch): Promise<UsageSettings> {
  const res = await authFetch("/api/usage/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) {
    let msg = t("Speichern hat nicht geklappt. Bitte noch einmal versuchen.");
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // keine JSON-Antwort — allgemeine Meldung bleibt
    }
    throw new Error(msg);
  }
  return (await res.json()) as UsageSettings;
}

export function updatePrice(id: number, patch: Partial<Pick<Price, "inputPerToken" | "outputPerToken" | "cacheReadPerToken" | "cacheCreation5mPerToken" | "cacheCreation1hPerToken" | "contextWindow">>): Promise<{ price: Price }> {
  return patchJson(`/api/usage/prices/${id}`, patch);
}
