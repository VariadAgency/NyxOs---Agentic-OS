// Agents in the session chat: types of the live view of the sub-agents (Claude) or teammates (Codex child sessions,
// titles like "Locke: …") of ONE session, plus pure helpers shared by server and web.
//
// Sources (see `apps/server/src/agents/session-live.ts`): events of the session (live, every few seconds from the
// bridge) + archive digest (delayed by up to ~2 min). Tokens: the larger of the two sums.
import { z } from "zod";
import type { AgentVerdict } from "./agents.js";
import type { Tool } from "./events.js";
import { t } from "./i18n/index.js";
import type { AgentTokens } from "./session-panels.js";

/** Running · done (report / final answer) · stopped (session ended or silent for long, without a result). */
export type LiveAgentStatus = "running" | "done" | "stopped";

/** What the agent did last — one line. */
export interface LiveAgentAction {
  kind: "tool" | "text";
  /** Tool name (`Read`, `Bash` …) or `null` for text. */
  tool: string | null;
  /** Target (file, command) or start of the text. */
  label: string;
  ts: string;
}

export interface LiveAgent {
  /** Claude: `agentId` from the sub-agent transcript. Codex: key of the child session (`codex:<id>`). */
  id: string;
  tool: Tool;
  /** Short name: Claude = description of the call, Codex = nickname ("Locke"). */
  name: string | null;
  /** Agent type (`general-purpose`, `Explore`, custom agent) — Codex: `null`. */
  type: string | null;
  /** Task in one line (start of the prompt). */
  task: string | null;
  status: LiveAgentStatus;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** Only when no longer running: last activity. */
  endedAt: string | null;
  toolCalls: number;
  tokens: AgentTokens | null;
  model: string | null;
  /** Cost in US dollars (only when a price is stored for the model, else `null` — never estimated). */
  costUsd: number | null;
  lastAction: LiveAgentAction | null;
  verdict: AgentVerdict | null;
  /** Run (round) of the session in which the agent started — see `AgentRunInfo`. */
  runId: string;
  /** Hidden by the user in the archive. */
  hidden: boolean;
  /** Codex: own child session (to open it). Claude: `null`. */
  sessionKey: string | null;
}

/** A run = one round of the session: starts with a message to the session (prompt). */
export interface AgentRunInfo {
  id: string;
  startedAt: string | null;
  /** Start of the message that started the run (`null` = agents before the first known message). */
  prompt: string | null;
  /** The newest run of the session. */
  current: boolean;
}

/** `GET /api/sessions/:id/agents-live` */
export interface SessionAgentsLiveResponse {
  agents: LiveAgent[];
  /** Only runs with agents + the current one; newest first. */
  runs: AgentRunInfo[];
  currentRunId: string | null;
  /** Child sessions (Codex) whose live signals concern this view. */
  childKeys: string[];
  now: string;
}

/** One step of "what it is doing right now". */
export interface AgentStep {
  id: string;
  ts: string;
  kind: "tool" | "text" | "prompt";
  tool: string | null;
  label: string;
  /** Tool only: open (no result yet) · ok · error. */
  status: "open" | "ok" | "error" | null;
  /** The step the agent is working on right now. */
  current: boolean;
}

/** `GET /api/sessions/:id/agents-live/:agentId` */
export interface SessionAgentLiveDetail {
  agent: LiveAgent;
  /** Latest steps, oldest first. */
  steps: AgentStep[];
  prompt: string | null;
  result: string | null;
  /** Is a transcript in the archive (for the chat)? */
  hasTranscript: boolean;
  /** Belongs to an earlier run (only then "hide in archive"). */
  archived: boolean;
  /** Already taken over into tasks (entry id + link). */
  task: { id: number; href: string } | null;
}

export const AgentHideSchema = z.object({ hidden: z.boolean() });
export type AgentHideInput = z.infer<typeof AgentHideSchema>;

/** From this many active agents on, the view suggests the full screen. */
export const AGENTS_FULLSCREEN_SUGGEST_AT = 6;
/** This many steps are shown in the detail view. */
export const AGENT_STEPS_MAX = 40;

/** Live sum (events) and archive digest are both lower bounds — the larger one wins. */
export function mergeAgentTokens(a: AgentTokens | null, b: AgentTokens | null): AgentTokens | null {
  if (!a) return b;
  if (!b) return a;
  return b.total > a.total ? b : a;
}

/** Elapsed time: running until now, else until the last activity. `null` without a start time. Never negative. */
export function agentElapsedMs(a: Pick<LiveAgent, "status" | "startedAt" | "endedAt" | "lastActivityAt">, now: number): number | null {
  const start = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const endIso = a.status === "running" ? null : (a.endedAt ?? a.lastActivityAt);
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "0:07", "4:07", "1:04:09" — below one day with seconds (visibly ticking), above "1 T 2 h" / "1 d 2 h". */
export function formatAgentElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return h % 24 === 0 ? t("{d} T", { d }) : t("{d} T {h} h", { d, h: h % 24 });
  }
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Codex child sessions are titled "Locke: <task>" (nickname of the session, see `parse/codex.ts`). */
export function splitCodexTitle(title: string | null): { name: string | null; task: string | null } {
  if (!title) return { name: null, task: null };
  const m = /^([A-ZÄÖÜ][\p{L}-]{1,23}): (.+)$/su.exec(title);
  return m?.[1] && m[2] ? { name: m[1], task: m[2] } : { name: null, task: title };
}

/** First non-empty line, clipped to `max` characters. */
export function firstLineOf(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
