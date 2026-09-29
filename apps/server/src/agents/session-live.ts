// Agents in the session chat — live view of the sub-agents of ONE session.
//
// Sources (no agents table of its own, like `runs.ts`):
// - Claude: events with `data.agentId` in `session_events` of the parent session (the bridge reads
//   `<claudeDir>/projects/<project>/<session>/subagents/agent-<id>.jsonl` — same path on macOS and Linux — with the
//   parser instance of the parent). Answers of a sub-agent carry `usage`/`msgId`/`model` → live tokens. The hook
//   `SubagentStop` reports `subagentId` → "done".
// - Codex: teammates are their own `sessions` rows with `parent_id` ("Locke: …").
// - Archive digest (per sub-agent file): only STORED versions (`peekSession`), never wait for a computation — it
//   adds task/result/tokens of older runs.
//
// Run = round of the session: starts with a message to the session (prompt of the main session). An agent belongs
// to the run of the last message before its start.
import {
  AGENT_STEPS_MAX,
  firstLineOf,
  mergeAgentTokens,
  splitCodexTitle,
  type AgentRunInfo,
  type AgentStep,
  type AgentTokens,
  type AgentVerdict,
  type LiveAgent,
  type LiveAgentAction,
  type LiveAgentStatus,
  type SessionAgentLiveDetail,
  type SessionAgentsLiveResponse,
  type Tool,
  locale,
  quote,
  t,
  tc,
  timeZone,
} from "@nyxos/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { entries, sessionAgentMarks, sessions } from "../db/schema.js";
import { createEntry, applyMaturity } from "../entries/store.js";
import { entryHref } from "../haiku/entriesBridge.js";
import type { ArchiveDigest, DigestService, StoredDigest } from "../session-digest.js";
import { computeCostForModel, loadLatestPrices } from "../usage/pricing.js";
import { AGENT_TOOL_WAIT_MS, detectVerdict, isClaudeAgentRunning } from "./runs.js";

type SessionRow = typeof sessions.$inferSelect;

const HANDBACK_TOOL = "SubagentHandback";
const TASK_LINE_MAX = 160;
const ACTION_LABEL_MAX = 160;
const STEP_LABEL_MAX = 280;
const TASK_TITLE_MAX = 200;
const TASK_DESCRIPTION_MAX = 10_000;
/** This many raw events are read by the detail view (at most `AGENT_STEPS_MAX` steps come out of them). */
const STEP_EVENTS_MAX = 160;
const TASK_SOURCE_TYPE = "session_agent";

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Codex child session "running": round open — like `runs.ts`, but "idle" only while it has not been silent for
 * longer than the tool wait time (a never closed child session would otherwise tick as "running" forever).
 */
export function codexChildRunning(state: string | null, lastActivityAt: string | null, now: number): boolean {
  if (state === "running") return true;
  if (state !== "idle") return false;
  const last = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
  return !Number.isNaN(last) && now - last < AGENT_TOOL_WAIT_MS;
}

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function tokensOf(r: { i: unknown; o: unknown; cr: unknown; cc: unknown }): AgentTokens {
  const t = { input: num(r.i), output: num(r.o), cacheRead: num(r.cr), cacheCreation: num(r.cc), total: 0 };
  t.total = t.input + t.output + t.cacheRead + t.cacheCreation;
  return t;
}

function tokensFromSession(raw: Record<string, number> | null | undefined): AgentTokens | null {
  if (!raw || typeof raw !== "object") return null;
  const t = { input: num(raw.input), output: num(raw.output), cacheRead: num(raw.cacheRead), cacheCreation: num(raw.cacheCreation), total: num(raw.total) };
  if (t.total === 0) t.total = t.input + t.output + t.cacheRead + t.cacheCreation;
  return t.total > 0 ? t : null;
}

function actionOf(r: { kind: string; name: string | null; target: string | null; text: string | null; ts: string | Date }): LiveAgentAction | null {
  const ts = iso(r.ts);
  if (!ts) return null;
  if (r.kind === "tool_call") return { kind: "tool", tool: r.name ?? t("Werkzeug"), label: clip(r.target ?? "", ACTION_LABEL_MAX), ts };
  const text = firstLineOf(r.text, ACTION_LABEL_MAX);
  return text ? { kind: "text", tool: null, label: text, ts } : null;
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

interface PromptRow {
  id: string;
  ts: string;
  text: string | null;
}

/** Messages to the session (main transcript, no sub-agent tasks, no hooks), oldest first. */
async function mainPrompts(db: Db, sessionKey: string): Promise<PromptRow[]> {
  const rows = rowsOf<{ id: string; ts: string | Date; text: string | null }>(
    await db.execute(sql`
      select id, ts, left(coalesce(nullif(data->>'text', ''), case when data ? 'command' then '/' || (data->>'command') || ' ' || coalesce(data->>'args', '') end), 400) as text
      from session_events
      where session_key = ${sessionKey} and kind = 'prompt' and source = 'file' and not (data ? 'agentId')
      order by ts asc, id asc
    `),
  );
  return rows.flatMap((r) => {
    const ts = iso(r.ts);
    return ts ? [{ id: r.id, ts, text: r.text }] : [];
  });
}

/** The id of the run a start belongs to (last message before it), `"before"` without an earlier message. */
export const RUN_BEFORE_FIRST = "before";

export function runIdFor(prompts: PromptRow[], startedAt: string | null): string {
  if (!startedAt) return prompts.at(-1)?.id ?? RUN_BEFORE_FIRST;
  const t = Date.parse(startedAt);
  let found: string = RUN_BEFORE_FIRST;
  for (const p of prompts) {
    if (Date.parse(p.ts) <= t) found = p.id;
    else break;
  }
  return found;
}

function buildRuns(prompts: PromptRow[], agents: LiveAgent[]): { runs: AgentRunInfo[]; currentRunId: string | null } {
  const currentRunId = prompts.at(-1)?.id ?? (agents.length > 0 ? RUN_BEFORE_FIRST : null);
  const used = new Set(agents.map((a) => a.runId));
  if (currentRunId) used.add(currentRunId);
  const runs: AgentRunInfo[] = [];
  if (used.has(RUN_BEFORE_FIRST)) {
    const first = agents.filter((a) => a.runId === RUN_BEFORE_FIRST).map((a) => a.startedAt ?? "").filter(Boolean).sort()[0] ?? null;
    runs.push({ id: RUN_BEFORE_FIRST, startedAt: first, prompt: null, current: currentRunId === RUN_BEFORE_FIRST });
  }
  for (const p of prompts) if (used.has(p.id)) runs.push({ id: p.id, startedAt: p.ts, prompt: firstLineOf(p.text, TASK_LINE_MAX), current: p.id === currentRunId });
  return { runs: runs.reverse(), currentRunId };
}

// ---------------------------------------------------------------------------------------------
// Claude sub-agents
// ---------------------------------------------------------------------------------------------

interface ClaudeAgg {
  agent_id: string;
  started_at: string | Date;
  ended_at: string | Date;
  tool_calls: string | number;
  last_kind: string | null;
  last_tool: string | null;
  handed_back: boolean | string;
  model: string | null;
}

function subagentMetas(session: SessionRow): Map<string, { name: string | null; type: string | null }> {
  const raw = Array.isArray(session.subagents) ? session.subagents : [];
  const out = new Map<string, { name: string | null; type: string | null }>();
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (typeof o.id === "string") out.set(o.id, { name: typeof o.name === "string" ? o.name : null, type: typeof o.type === "string" ? o.type : null });
  }
  return out;
}

const sumTools = (tools: Record<string, number> | undefined) => Object.values(tools ?? {}).reduce((a, b) => a + b, 0);

async function claudeAgents(db: Db, session: SessionRow, digests: StoredDigest[], now: number, onlyId: string | null): Promise<Omit<LiveAgent, "runId" | "hidden" | "costUsd">[]> {
  const key = session.id;
  // All queries use the partial index `session_events_agent_idx` (condition `data ? 'agentId'`).
  const only = onlyId === null ? sql`` : sql` and data->>'agentId' = ${onlyId}`;
  const agg = rowsOf<ClaudeAgg>(
    await db.execute(sql`
      select data->>'agentId' as agent_id, min(ts) as started_at, max(ts) as ended_at,
        count(*) filter (where kind = 'tool_call') as tool_calls,
        (array_agg(kind order by ts desc, id desc))[1] as last_kind,
        (array_agg(data->>'name' order by ts desc, id desc))[1] as last_tool,
        coalesce(bool_or(kind = 'tool_call' and data->>'name' = ${HANDBACK_TOOL}), false) as handed_back,
        (array_agg(data->>'model' order by ts desc, id desc) filter (where data ? 'model'))[1] as model
      from session_events
      where session_key = ${key} and data ? 'agentId'${only}
      group by data->>'agentId'
    `),
  );
  // Live tokens: per (agent, answer) the largest value, then summed per agent.
  const usageRows = rowsOf<{ agent_id: string; i: unknown; o: unknown; cr: unknown; cc: unknown }>(
    await db.execute(sql`
      select agent_id, sum(i) as i, sum(o) as o, sum(cr) as cr, sum(cc) as cc from (
        select data->>'agentId' as agent_id, coalesce(data->>'msgId', id) as mid,
          max((data->'usage'->>'input')::bigint) as i, max((data->'usage'->>'output')::bigint) as o,
          max((data->'usage'->>'cacheRead')::bigint) as cr, max((data->'usage'->>'cacheCreation')::bigint) as cc
        from session_events
        where session_key = ${key} and data ? 'agentId'${only} and data ? 'usage'
        group by 1, 2
      ) t group by agent_id
    `),
  );
  const firstPrompt = rowsOf<{ agent_id: string; text: string | null }>(
    await db.execute(sql`
      select distinct on (data->>'agentId') data->>'agentId' as agent_id, left(data->>'text', 400) as text
      from session_events
      where session_key = ${key} and data ? 'agentId'${only} and kind = 'prompt'
      order by data->>'agentId', ts asc, id asc
    `),
  );
  const lastAction = rowsOf<{ agent_id: string; kind: string; name: string | null; target: string | null; text: string | null; ts: string | Date }>(
    await db.execute(sql`
      select distinct on (data->>'agentId') data->>'agentId' as agent_id, kind, data->>'name' as name, data->>'target' as target, left(data->>'text', 400) as text, ts
      from session_events
      where session_key = ${key} and data ? 'agentId'${only}
        and ((kind = 'tool_call' and coalesce(data->>'name', '') <> ${HANDBACK_TOOL}) or (kind = 'assistant' and coalesce(data->>'text', '') <> ''))
      order by data->>'agentId', ts desc, id desc
    `),
  );
  // Verdict (PASS/BLOCK): the last answers per agent are enough ("the last hit wins").
  const lastTexts = rowsOf<{ agent_id: string; text: string }>(
    await db.execute(sql`
      select agent_id, text from (
        select data->>'agentId' as agent_id, coalesce(data->>'text', '') as text, ts, id,
          row_number() over (partition by data->>'agentId' order by ts desc, id desc) as rn
        from session_events
        where session_key = ${key} and data ? 'agentId'${only} and kind = 'assistant'
      ) t where rn <= 3 order by ts asc, id asc
    `),
  );
  // `SubagentStop` hooks only from the start of the earliest unfinished agent on (time range via the index
  // `(session_key, ts)`) — when all are finished, the query is not needed at all.
  const openStarts = agg
    .filter((a) => !(a.handed_back === true || String(a.handed_back) === "true") && a.last_kind !== "assistant")
    .map((a) => iso(a.started_at))
    .filter((x): x is string => x !== null)
    .sort();
  const stopped = new Set(
    openStarts[0]
      ? rowsOf<{ id: string }>(
          await db.execute(sql`
            select distinct data->>'subagentId' as id from session_events
            where session_key = ${key} and ts >= ${openStarts[0]} and kind = 'hook' and data->>'event' = 'SubagentStop' and data ? 'subagentId'
          `),
        ).map((r) => r.id)
      : [],
  );

  const usageBy = new Map(usageRows.map((r) => [r.agent_id, tokensOf(r)]));
  const promptBy = new Map(firstPrompt.map((r) => [r.agent_id, r.text]));
  const actionBy = new Map(lastAction.map((r) => [r.agent_id, actionOf(r)]));
  const textsBy = new Map<string, string[]>();
  for (const r of lastTexts) textsBy.set(r.agent_id, [...(textsBy.get(r.agent_id) ?? []), r.text]);
  const digestBy = new Map(digests.filter((d) => d.agentId !== null && (onlyId === null || d.agentId === onlyId)).map((d) => [d.agentId as string, d.digest]));
  const metas = subagentMetas(session);
  const parentAlive = session.status === "running" && session.closedAt === null;

  const ids = new Set([...agg.map((a) => a.agent_id), ...digestBy.keys()]);
  const aggBy = new Map(agg.map((a) => [a.agent_id, a]));
  return [...ids].map((id) => {
    const a = aggBy.get(id);
    const d: ArchiveDigest | undefined = digestBy.get(id);
    const meta = metas.get(id);
    const startedAt = iso(a?.started_at) ?? d?.startedAt ?? null;
    const lastActivityAt = iso(a?.ended_at) ?? d?.endedAt ?? null;
    const handedBack = a ? a.handed_back === true || String(a.handed_back) === "true" : false;
    const running = a
      ? isClaudeAgentRunning({ parentAlive, handedBack: handedBack || stopped.has(id), lastKind: a.last_kind, lastToolName: a.last_tool, lastTs: lastActivityAt }, now)
      : false;
    const verdict: AgentVerdict | null = detectVerdict(textsBy.get(id) ?? []) ?? d?.verdict ?? null;
    const finished = handedBack || stopped.has(id) || a?.last_kind === "assistant" || verdict !== null || (!a && Boolean(d?.result));
    const status: LiveAgentStatus = running ? "running" : finished ? "done" : "stopped";
    return {
      id,
      tool: "claude" as Tool,
      name: meta?.name ?? null,
      type: meta?.type ?? null,
      task: firstLineOf(promptBy.get(id) ?? d?.prompt ?? null, TASK_LINE_MAX) ?? meta?.name ?? null,
      status,
      startedAt,
      lastActivityAt,
      endedAt: running ? null : lastActivityAt,
      toolCalls: Math.max(num(a?.tool_calls), sumTools(d?.tools)),
      tokens: mergeAgentTokens(usageBy.get(id) ?? null, d?.tokens ?? null),
      model: a?.model ?? d?.models.at(-1) ?? null,
      lastAction: actionBy.get(id) ?? null,
      verdict,
      sessionKey: null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Codex teammates (child sessions)
// ---------------------------------------------------------------------------------------------

async function codexAgents(db: Db, session: SessionRow, now: number, onlyId: string | null): Promise<Omit<LiveAgent, "runId" | "hidden" | "costUsd">[]> {
  const children = await db
    .select()
    .from(sessions)
    .where(onlyId === null ? eq(sessions.parentId, session.id) : and(eq(sessions.parentId, session.id), eq(sessions.id, onlyId)));
  if (children.length === 0) return [];
  const keys = children.map((c) => c.id);
  const lastAction = rowsOf<{ session_key: string; kind: string; name: string | null; target: string | null; text: string | null; ts: string | Date }>(
    await db.execute(sql`
      select distinct on (session_key) session_key, kind, data->>'name' as name, data->>'target' as target, left(data->>'text', 400) as text, ts
      from session_events
      where session_key in (${sql.join(
        keys.map((k) => sql`${k}`),
        sql`, `,
      )}) and (kind = 'tool_call' or (kind = 'assistant' and coalesce(data->>'text', '') <> ''))
      order by session_key, ts desc, id desc
    `),
  );
  const actionBy = new Map(lastAction.map((r) => [r.session_key, actionOf(r)]));
  return children.map((c) => {
    const lastActivityAt = iso(c.lastActivityAt);
    const running = codexChildRunning(c.state, lastActivityAt, now);
    const { name, task } = splitCodexTitle(c.title);
    const crashed = c.state === "crashed";
    return {
      id: c.id,
      tool: "codex" as Tool,
      name,
      type: null,
      task: firstLineOf(task, TASK_LINE_MAX),
      status: running ? "running" : crashed ? "stopped" : "done",
      startedAt: iso(c.startedAt),
      lastActivityAt,
      endedAt: running ? null : (iso(c.endedAt) ?? lastActivityAt),
      toolCalls: sumTools(c.toolCalls as Record<string, number>),
      tokens: tokensFromSession(c.tokens as Record<string, number>),
      model: (c.models as string[]).at(-1) ?? null,
      lastAction: actionBy.get(c.id) ?? null,
      verdict: null,
      sessionKey: c.id,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------------------------

async function hiddenIds(db: Db, sessionKey: string): Promise<Set<string>> {
  const rows = await db.select({ agentId: sessionAgentMarks.agentId }).from(sessionAgentMarks).where(eq(sessionAgentMarks.sessionKey, sessionKey));
  return new Set(rows.map((r) => r.agentId));
}

interface Loaded {
  response: SessionAgentsLiveResponse;
  digests: StoredDigest[];
  archivePaths: string[];
}

const EMPTY = (now: number): SessionAgentsLiveResponse => ({ agents: [], runs: [], currentRunId: null, childKeys: [], now: new Date(now).toISOString() });

/** Early exit: most sessions have no agents at all — then no further query. */
async function hasAnyAgents(db: Db, session: SessionRow): Promise<boolean> {
  if (session.tool === "codex") {
    const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.parentId, session.id)).limit(1);
    return row !== undefined;
  }
  const events = rowsOf<{ one: number }>(await db.execute(sql`select 1 as one from session_events where session_key = ${session.id} and data ? 'agentId' limit 1`));
  if (events.length > 0) return true;
  const files = rowsOf<{ one: number }>(await db.execute(sql`select 1 as one from archive where session_key = ${session.id} and position('/subagents/agent-' in path) > 0 limit 1`));
  return files.length > 0;
}

/** `onlyId`: load only this one agent (detail, manage) — the runs are still needed (assignment). */
async function load(db: Db, digestService: DigestService, session: SessionRow, now: number, onlyId: string | null = null): Promise<Loaded> {
  if (!(await hasAnyAgents(db, session))) return { response: EMPTY(now), digests: [], archivePaths: [] };
  const [{ stored, archivePaths }, hidden, prices] = await Promise.all([
    session.tool === "claude" ? digestService.peekSession(session.id) : Promise.resolve({ stored: [] as StoredDigest[], archivePaths: [] as string[] }),
    hiddenIds(db, session.id),
    loadLatestPrices(db),
  ]);
  const base = session.tool === "codex" ? await codexAgents(db, session, now, onlyId) : await claudeAgents(db, session, stored, now, onlyId);
  if (base.length === 0) return { response: EMPTY(now), digests: stored, archivePaths };
  const prompts = await mainPrompts(db, session.id);
  const agents: LiveAgent[] = base
    .map((a) => ({
      ...a,
      runId: runIdFor(prompts, a.startedAt),
      hidden: hidden.has(a.id),
      costUsd: a.tokens ? computeCostForModel(prices, a.model, { input: a.tokens.input, output: a.tokens.output, cacheRead: a.tokens.cacheRead, cacheCreation5m: a.tokens.cacheCreation, cacheCreation1h: 0 }) : null,
    }))
    .sort((x, y) => (y.startedAt ?? "").localeCompare(x.startedAt ?? ""));
  const { runs, currentRunId } = buildRuns(prompts, agents);
  const childKeys = agents.flatMap((a) => (a.sessionKey ? [a.sessionKey] : []));
  return { response: { agents, runs, currentRunId, childKeys, now: new Date(now).toISOString() }, digests: stored, archivePaths };
}

export async function loadSessionAgentsLive(db: Db, digests: DigestService, session: SessionRow, now = Date.now()): Promise<SessionAgentsLiveResponse> {
  return (await load(db, digests, session, now)).response;
}

interface StepEventRow {
  id: string;
  ts: string | Date;
  kind: string;
  data: Record<string, unknown>;
}

/** Raw events → steps (oldest first). Tool status from the result or Codex' exit code. */
export function buildSteps(rows: StepEventRow[], running: boolean): AgentStep[] {
  const steps: AgentStep[] = [];
  const byToolUse = new Map<string, AgentStep>();
  for (const r of rows) {
    const ts = iso(r.ts);
    if (!ts) continue;
    const d = r.data;
    const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
    if (r.kind === "tool_result") {
      const step = byToolUse.get(str("toolUseId") ?? "");
      if (step) step.status = d.isError === true ? "error" : "ok";
      continue;
    }
    if (r.kind === "tool_call") {
      const name = str("name") ?? t("Werkzeug");
      if (name === HANDBACK_TOOL) {
        const report = str("text");
        steps.push({ id: r.id, ts, kind: "text", tool: null, label: report ? clip(report.trim(), STEP_LABEL_MAX) : t("Bericht abgegeben"), status: null, current: false });
        continue;
      }
      const exit = typeof d.exitCode === "number" ? (d.exitCode === 0 ? "ok" : "error") : null;
      const step: AgentStep = { id: r.id, ts, kind: "tool", tool: name, label: clip(str("target") ?? "", STEP_LABEL_MAX), status: exit ?? "open", current: false };
      steps.push(step);
      const tu = str("toolUseId");
      if (tu) byToolUse.set(tu, step);
      continue;
    }
    const text = str("text");
    if (!text) continue;
    steps.push({ id: r.id, ts, kind: r.kind === "prompt" ? "prompt" : "text", tool: null, label: clip(text.trim(), STEP_LABEL_MAX), status: null, current: false });
  }
  const out = steps.slice(-AGENT_STEPS_MAX);
  if (running) {
    // Current: the newest still open tool, else the last step.
    const open = [...out].reverse().find((s) => s.kind === "tool" && s.status === "open");
    const cur = open ?? out.at(-1);
    if (cur) cur.current = true;
  } else {
    // An agent that no longer runs waits for nothing — open tools without a result stay without a check mark.
    for (const s of out) if (s.status === "open") s.status = null;
  }
  return out;
}

async function stepRows(db: Db, session: SessionRow, agent: LiveAgent): Promise<StepEventRow[]> {
  const rows =
    agent.tool === "codex" && agent.sessionKey
      ? rowsOf<StepEventRow>(
          await db.execute(sql`
            select id, ts, kind, data from session_events
            where session_key = ${agent.sessionKey} and kind in ('tool_call', 'assistant', 'prompt')
            order by ts desc, id desc limit ${STEP_EVENTS_MAX}
          `),
        )
      : rowsOf<StepEventRow>(
          await db.execute(sql`
            select id, ts, kind, data from session_events
            where session_key = ${session.id} and data ? 'agentId' and data->>'agentId' = ${agent.id} and kind in ('tool_call', 'tool_result', 'assistant', 'prompt')
            order by ts desc, id desc limit ${STEP_EVENTS_MAX}
          `),
        );
  return rows.reverse().map((r) => ({ ...r, data: (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown> }));
}

/** Task (first message) and result: the final report (`SubagentHandback`) before the last answer. */
async function firstAndLastText(db: Db, session: SessionRow, agent: LiveAgent): Promise<{ prompt: string | null; result: string | null; report: string | null }> {
  const [key, filter] = agent.tool === "codex" && agent.sessionKey ? [agent.sessionKey, sql`true`] : [session.id, sql`data ? 'agentId' and data->>'agentId' = ${agent.id}`];
  const [p] = rowsOf<{ text: string | null }>(
    await db.execute(sql`select data->>'text' as text from session_events where session_key = ${key} and kind = 'prompt' and ${filter} order by ts asc, id asc limit 1`),
  );
  const [r] = rowsOf<{ text: string | null }>(
    await db.execute(sql`select data->>'text' as text from session_events where session_key = ${key} and kind = 'assistant' and coalesce(data->>'text', '') <> '' and ${filter} order by ts desc, id desc limit 1`),
  );
  const [h] = rowsOf<{ text: string | null }>(
    await db.execute(
      sql`select data->>'text' as text from session_events where session_key = ${key} and kind = 'tool_call' and data->>'name' = ${HANDBACK_TOOL} and coalesce(data->>'text', '') <> '' and ${filter} order by ts desc, id desc limit 1`,
    ),
  );
  return { prompt: p?.text ?? null, result: r?.text ?? null, report: h?.text ?? null };
}

async function existingTask(db: Db, sessionKey: string, agentId: string): Promise<{ id: number; title: string; kind: string } | null> {
  const [row] = await db
    .select({ id: entries.id, title: entries.title, kind: entries.kind })
    .from(entries)
    .where(and(eq(entries.sourceType, TASK_SOURCE_TYPE), eq(entries.sourceId, `${sessionKey}|${agentId}`)))
    .orderBy(desc(entries.id))
    .limit(1);
  return row ?? null;
}

export async function loadSessionAgentLiveDetail(db: Db, digests: DigestService, session: SessionRow, agentId: string, now = Date.now()): Promise<SessionAgentLiveDetail | null> {
  const loaded = await load(db, digests, session, now, agentId);
  const agent = loaded.response.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const [rows, texts, task] = await Promise.all([stepRows(db, session, agent), firstAndLastText(db, session, agent), existingTask(db, session.id, agent.id)]);
  // Full task/result from the archive digest (unclipped), else from the events.
  const stored = loaded.digests.find((d) => d.agentId === agent.id) ?? null;
  const full = stored ? await digests.fullDigest(stored.archiveId) : null;
  const running = agent.status === "running";
  const hasTranscript =
    agent.tool === "codex" && agent.sessionKey
      ? (await digests.peekSession(agent.sessionKey)).archivePaths.length > 0
      : loaded.archivePaths.some((p) => p.endsWith(`/subagents/agent-${agent.id}.jsonl`));
  // Result: the final report from the events is current (maybe clipped); the archive digest only when it contains
  // the same report in full (it can be older) or when there is no report.
  const report = texts.report;
  const fullResult = full?.result ?? null;
  const result = report ? (fullResult?.startsWith(report.slice(0, 200)) ? fullResult : report) : (fullResult ?? texts.result);
  return {
    agent,
    steps: buildSteps(rows, running),
    prompt: full?.prompt ?? texts.prompt,
    result: running ? null : result,
    hasTranscript,
    archived: agent.runId !== loaded.response.currentRunId,
    task: task ? { id: task.id, href: entryHref(task.kind, task.id) } : null,
  };
}

export async function setAgentHidden(db: Db, digests: DigestService, session: SessionRow, agentId: string, hidden: boolean): Promise<boolean> {
  const exists = (await load(db, digests, session, Date.now(), agentId)).response.agents.some((a) => a.id === agentId);
  if (!exists) return false;
  if (hidden) await db.insert(sessionAgentMarks).values({ sessionKey: session.id, agentId }).onConflictDoNothing();
  else await db.delete(sessionAgentMarks).where(and(eq(sessionAgentMarks.sessionKey, session.id), eq(sessionAgentMarks.agentId, agentId)));
  return true;
}

export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 4; i++) {
    if (typeof cur === "object" && (cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export type AgentTaskResult = { kind: "not_found" } | { kind: "ok"; created: boolean; entry: { id: number; title: string; href: string } };

/** "Add to tasks": a task with the agent's task + result; already added → the same one. */
export async function agentToTask(db: Db, digests: DigestService, session: SessionRow, agentId: string): Promise<AgentTaskResult> {
  const existing = await existingTask(db, session.id, agentId);
  if (existing) return { kind: "ok", created: false, entry: { id: existing.id, title: existing.title, href: entryHref(existing.kind, existing.id) } };
  const detail = await loadSessionAgentLiveDetail(db, digests, session, agentId);
  if (!detail) return { kind: "not_found" };
  const a = detail.agent;
  const who = a.name ?? a.type ?? t("Sub-Agent");
  const title = clip(t("Agent {who}: {task}", { who: quote(who), task: a.task ?? t("Ergebnis prüfen") }).replace(/\s+/g, " "), TASK_TITLE_MAX);
  const day = a.startedAt ? new Date(a.startedAt).toLocaleDateString(locale(), { timeZone: timeZone() }) : null;
  const vars = { session: quote(session.title ?? session.id), day, who: quote(who), type: a.type && a.type !== who ? ` (${a.type})` : "" };
  const head = day ? t("Aus der Session {session} vom {day} – Agent {who}{type}.", vars) : t("Aus der Session {session} – Agent {who}{type}.", vars);
  const parts = [head];
  if (detail.prompt) parts.push(`## ${tc("agent", "Auftrag")}\n\n${clip(detail.prompt, 3_000)}`);
  if (detail.result) parts.push(`## ${t("Ergebnis")}\n\n${detail.result}`);
  const description = clip(parts.join("\n\n"), TASK_DESCRIPTION_MAX);
  let created: { id: number };
  try {
    created = await createEntry(db, { kind: "aufgabe", title, description, source: "api", sourceType: TASK_SOURCE_TYPE, sourceId: `${session.id}|${agentId}`, sessionKey: session.id });
  } catch (e) {
    // Two simultaneous clicks (double click, two windows): the unique index on (source_type, source_id) allows only
    // one task — the other request then shows the same one.
    const again = isUniqueViolation(e) ? await existingTask(db, session.id, agentId) : null;
    if (!again) throw e;
    return { kind: "ok", created: false, entry: { id: again.id, title: again.title, href: entryHref(again.kind, again.id) } };
  }
  await applyMaturity(db, created.id);
  return { kind: "ok", created: true, entry: { id: created.id, title, href: entryHref("aufgabe", created.id) } };
}
