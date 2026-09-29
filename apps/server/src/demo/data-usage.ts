// Demo mode: 30 days of token usage for Claude and Codex. Single messages (`usage_events`) come from
// the demo sessions plus everyday background work; the daily table is aggregated from them, exactly
// like the real ingest does, so every chart and total agrees.
import { computeCost, findPrice } from "@nyxos/shared";
import { localDay } from "../usage/periods.js";
import type { BuiltSession } from "./build-sessions.js";
import { hex, rng } from "./text.js";

/** Project bucket for work inside the tracked project folder (sessions are linked only there). */
export const TRACKED_PROJECT = "projekte";
export const OTHER_PROJECT = "andere";

export interface DemoUsageEvent {
  id: string;
  ts: string;
  tool: "claude" | "codex";
  model: string;
  project: string;
  sessionKey: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  reasoningTokens: number;
  cost: number | null;
}

export interface DemoUsageDaily {
  day: string;
  tool: string;
  model: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number | null;
}

function priced(e: Omit<DemoUsageEvent, "cost">): DemoUsageEvent {
  const cost = computeCost(findPrice(e.model), {
    input: e.inputTokens,
    output: e.outputTokens,
    cacheRead: e.cacheReadTokens,
    cacheCreation5m: e.cacheCreation5mTokens,
    cacheCreation1h: e.cacheCreation1hTokens,
  });
  return { ...e, cost };
}

const CLAUDE_MODELS = [
  { model: "claude-opus-5-5", share: 0.62 },
  { model: "claude-sonnet-5", share: 0.3 },
  { model: "claude-haiku-4-5", share: 0.08 },
];
const CODEX_MODELS = [
  { model: "gpt-6-astra", share: 0.55 },
  { model: "gpt-5.6-terra", share: 0.45 },
];

function pickModel(models: { model: string; share: number }[], r: number): string {
  let acc = 0;
  for (const m of models) {
    acc += m.share;
    if (r <= acc) return m.model;
  }
  return models[0]?.model ?? "claude-sonnet-5";
}

export function buildUsage(now: number, sessions: BuiltSession[]): { events: DemoUsageEvent[]; daily: DemoUsageDaily[] } {
  const rand = rng(4711);
  const events: DemoUsageEvent[] = [];

  // 1) The demo sessions: their token totals spread over their answers.
  for (const s of sessions) {
    const answers = s.events.filter((e) => e.kind === "assistant" || e.kind === "tool_call").filter((e, i, arr) => i % Math.max(1, Math.floor(arr.length / 10)) === 0);
    if (answers.length === 0) continue;
    const t = s.summary.tokens;
    const n = answers.length;
    const model = s.summary.models[0] ?? s.spec.model;
    answers.forEach((a, i) => {
      events.push(
        priced({
          id: `demo:${s.key}:${i}`,
          ts: a.ts,
          tool: s.spec.tool,
          model,
          project: TRACKED_PROJECT,
          sessionKey: s.key,
          inputTokens: Math.round(t.input / n),
          outputTokens: Math.round(t.output / n),
          cacheReadTokens: Math.round(t.cacheRead / n),
          cacheCreation5mTokens: s.spec.tool === "claude" ? Math.round((t.cacheCreation / n) * 0.3) : Math.round(t.cacheCreation / n),
          cacheCreation1hTokens: s.spec.tool === "claude" ? Math.round((t.cacheCreation / n) * 0.7) : 0,
          reasoningTokens: Math.round(t.reasoning / n),
        }),
      );
    });
  }

  // 2) Everyday work in other folders over 30 days: busier on weekdays, between 8 and 22 o'clock.
  for (let d = 29; d >= 0; d--) {
    const dayStart = new Date(now - d * 86_400_000);
    dayStart.setUTCHours(0, 0, 0, 0);
    const weekend = dayStart.getUTCDay() === 0 || dayStart.getUTCDay() === 6;
    const trend = 0.75 + (0.5 * (29 - d)) / 29; // usage grows a little over the month
    for (const tool of ["claude", "codex"] as const) {
      const base = tool === "claude" ? 14 : 6;
      const count = Math.max(1, Math.round((weekend ? base * 0.35 : base) * trend * (0.7 + rand() * 0.6)));
      for (let i = 0; i < count; i++) {
        const hour = 6 + Math.floor(rand() * 14) + (rand() < 0.2 ? 3 : 0);
        const ts = dayStart.getTime() + hour * 3_600_000 + Math.floor(rand() * 3_600_000);
        if (ts > now - 60_000) continue;
        const model = pickModel(tool === "claude" ? CLAUDE_MODELS : CODEX_MODELS, rand());
        const scale = tool === "claude" ? 1 : 0.55;
        const cacheRead = Math.round((400_000 + rand() * 3_600_000) * scale);
        events.push(
          priced({
            id: `demo:bg:${hex(`${d}:${tool}:${i}`, 12)}`,
            ts: new Date(ts).toISOString(),
            tool,
            model,
            project: OTHER_PROJECT,
            sessionKey: null,
            inputTokens: Math.round((6_000 + rand() * 60_000) * scale),
            outputTokens: Math.round((4_000 + rand() * 38_000) * scale),
            cacheReadTokens: cacheRead,
            cacheCreation5mTokens: Math.round(cacheRead * 0.02),
            cacheCreation1hTokens: tool === "claude" ? Math.round(cacheRead * 0.05) : 0,
            reasoningTokens: tool === "codex" ? Math.round(12_000 * rand()) : 0,
          }),
        );
      }
    }
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : 1));

  // 3) Daily table = sum of the events per Berlin day, tool, model and project.
  const byKey = new Map<string, DemoUsageDaily>();
  for (const e of events) {
    const day = localDay(new Date(e.ts));
    const key = `${day}|${e.tool}|${e.model}|${e.project}`;
    const row = byKey.get(key) ?? { day, tool: e.tool, model: e.model, project: e.project, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 };
    row.inputTokens += e.inputTokens;
    row.outputTokens += e.outputTokens;
    row.cacheReadTokens += e.cacheReadTokens;
    row.cacheCreation5mTokens += e.cacheCreation5mTokens;
    row.cacheCreation1hTokens += e.cacheCreation1hTokens;
    row.reasoningTokens += e.reasoningTokens;
    row.totalTokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreation5mTokens + e.cacheCreation1hTokens;
    row.cost = row.cost === null || e.cost === null ? null : row.cost + e.cost;
    byKey.set(key, row);
  }
  return { events, daily: [...byKey.values()] };
}
