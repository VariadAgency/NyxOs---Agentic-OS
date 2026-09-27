// Demo mode: writes Claude Code and Codex transcripts (JSONL) in exactly the format the real tools
// write them. The seeder runs them through the same parsers the bridge uses, so sessions, events,
// files, token counts and the chat view come out of one source, like for a real session.
import type { Lang } from "@nyxos/shared";
import { hex, pick, rng, uuid, type L } from "./text.js";

/** One action of the assistant inside a turn. Paths are relative to the session's working folder. */
export type Step =
  | { t: "read"; path: string }
  | { t: "grep"; pattern: string }
  | { t: "edit"; path: string; old: string; new: string }
  | { t: "write"; path: string; content: string }
  | { t: "bash"; cmd: string; fail?: boolean }
  | { t: "skill"; name: string }
  | { t: "say"; text: L }
  | { t: "agent"; type: string; desc: L; prompt: L; result: L; steps: Step[] };

/** One question of the user and the work it caused. Without `reply` the turn is still open. */
export interface Turn {
  user: L;
  steps: Step[];
  reply?: L;
}

export interface TranscriptSpec {
  tool: "claude" | "codex";
  sessionId: string;
  cwd: string;
  branch: string;
  model: string;
  /** Model of Claude sub-agents. */
  subModel?: string;
  /** Claude: title Claude Code generated (`ai-title`). */
  title?: L;
  /** Codex sub-agent: parent session and nickname. */
  parentSessionId?: string;
  nickname?: string;
  start: number;
  end: number;
  /** Share of the context window the last answer used (drives the context ring). */
  contextFrac: number;
  /** Codex: used share of the 5 h / weekly limit at the end of the session. */
  limits?: { primary: number; secondary: number };
  /** Codex: session ids of the sub-agent sessions this one spawns, by agent type. */
  childIds?: Record<string, string>;
  turns: Turn[];
}

export interface TranscriptFile {
  /** Path relative to the tool's root folder, as the bridge uploads it. */
  path: string;
  text: string;
  /** Claude sub-agent file: its agent id and meta data. */
  agentId?: string;
  meta?: { agentType: string; description: string; toolUseId: string };
}

export interface HookSpec {
  ts: string;
  event: string;
  extra: Record<string, string>;
}

export interface BuiltTranscript {
  files: TranscriptFile[];
  hooks: HookSpec[];
  firstTs: string;
  lastTs: string;
}

const CLAUDE_VERSION = "2.3.14";
const CODEX_VERSION = "0.161.2";
export const CONTEXT_WINDOW: Record<string, number> = {
  "claude-opus-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "gpt-6-astra": 922_000,
  "gpt-5.6-terra": 922_000,
};

/** Claude Code stores transcripts under `~/.claude/projects/<cwd with / and . replaced by ->/`. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Sequential clock: spreads a known number of lines evenly (with a little jitter) between start and end. */
class Clock {
  private i = 0;
  private readonly rand: () => number;
  constructor(
    private readonly start: number,
    private readonly end: number,
    private readonly slots: number,
    seed: string,
  ) {
    this.rand = rng(parseInt(hex(seed, 8), 16));
  }
  next(): string {
    const step = (this.end - this.start) / Math.max(1, this.slots - 1);
    const jitter = this.i === 0 || this.i >= this.slots - 1 ? 0 : (this.rand() - 0.5) * step * 0.6;
    const t = Math.min(this.end, this.start + step * this.i + jitter);
    this.i++;
    return new Date(Math.round(t)).toISOString();
  }
}

function claudeSlots(steps: Step[]): number {
  let n = 0;
  for (const s of steps) {
    if (s.t === "say") n += 1;
    else if (s.t === "agent") n += 2 + 1 + claudeSlots(s.steps) + 1;
    else n += 2;
  }
  return n;
}

function codexSlots(steps: Step[]): number {
  let n = 0;
  for (const s of steps) n += s.t === "agent" ? 2 : 1;
  return n;
}

const abs = (cwd: string, path: string) => (path.startsWith("/") ? path : `${cwd}/${path}`);

function bashOutput(cmd: string, fail: boolean | undefined, lang: Lang): string {
  if (fail) return lang === "de" ? "Fehler: Test fehlgeschlagen (1 von 42)" : "Error: test failed (1 of 42)";
  if (/test|vitest|jest/.test(cmd)) return "✓ 42 passed (3.1s)";
  if (/lint|tsc|typecheck/.test(cmd)) return "0 errors";
  if (/git status/.test(cmd)) return "On branch main\nnothing to commit, working tree clean";
  return "ok";
}

// ─────────────────────────────── Claude ───────────────────────────────

export function buildClaudeTranscript(spec: TranscriptSpec, lang: Lang): BuiltTranscript {
  const total = spec.turns.reduce((n, t) => n + 1 + claudeSlots(t.steps) + (t.reply ? 1 : 0), 0) + 1;
  const clock = new Clock(spec.start, spec.end, total, spec.sessionId);
  const dir = claudeProjectDir(spec.cwd);
  const lines: string[] = [];
  const subFiles: TranscriptFile[] = [];
  const hooks: HookSpec[] = [];
  let n = 0;
  let prev: string | null = null;
  const window = CONTEXT_WINDOW[spec.model] ?? 1_000_000;
  const totalAssistant = Math.max(1, spec.turns.reduce((k, t) => k + claudeSlots(t.steps) / 2 + (t.reply ? 1 : 0), 0));
  let assistantIdx = 0;
  const rand = rng(parseInt(hex(`${spec.sessionId}:tok`, 8), 16));

  const base = (ts: string, extra: Record<string, unknown> = {}) => {
    const id = uuid(`${spec.sessionId}:${n++}`);
    const row = {
      parentUuid: prev,
      isSidechain: false,
      ...extra,
      uuid: id,
      timestamp: ts,
      userType: "external",
      entrypoint: "cli",
      cwd: spec.cwd,
      sessionId: spec.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: spec.branch,
    };
    prev = id;
    return row;
  };

  const usage = () => {
    assistantIdx++;
    const frac = Math.min(1, assistantIdx / totalAssistant);
    const context = Math.round(18_000 + (spec.contextFrac * window - 18_000) * frac);
    const creation = Math.round(400 + rand() * 4_000);
    return {
      input_tokens: Math.round(3 + rand() * 40),
      cache_creation_input_tokens: creation,
      cache_read_input_tokens: Math.max(0, context - creation),
      output_tokens: Math.round(120 + rand() * 1_400),
    };
  };

  const assistant = (ts: string, content: unknown[], model = spec.model) =>
    base(ts, {
      message: { model, id: `msg_${hex(`${spec.sessionId}:m${n}`, 24)}`, type: "message", role: "assistant", content, stop_reason: null, usage: usage() },
      requestId: `req_${hex(`${spec.sessionId}:r${n}`, 24)}`,
      type: "assistant",
    });

  const userText = (ts: string, text: string) => base(ts, { promptId: `p-${n}`, type: "user", message: { role: "user", content: text }, permissionMode: "default" });

  const toolResult = (ts: string, toolUseId: string, text: string, isError: boolean, toolUseResult: unknown) =>
    base(ts, { type: "user", message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: text, is_error: isError }] }, toolUseResult });

  const toolInput = (s: Step): { name: string; input: Record<string, unknown>; result: string; isError: boolean; tur: unknown } | null => {
    switch (s.t) {
      case "read":
        return { name: "Read", input: { file_path: abs(spec.cwd, s.path) }, result: "…", isError: false, tur: { type: "text", file: { filePath: abs(spec.cwd, s.path), numLines: 120 } } };
      case "grep":
        return { name: "Grep", input: { pattern: s.pattern, output_mode: "files_with_matches" }, result: "3 files", isError: false, tur: { mode: "files_with_matches", numFiles: 3 } };
      case "edit":
        return {
          name: "Edit",
          input: { file_path: abs(spec.cwd, s.path), old_string: s.old, new_string: s.new },
          result: "The file has been updated.",
          isError: false,
          tur: { filePath: abs(spec.cwd, s.path), oldString: s.old, newString: s.new },
        };
      case "write":
        return { name: "Write", input: { file_path: abs(spec.cwd, s.path), content: s.content }, result: "File created", isError: false, tur: { type: "create", filePath: abs(spec.cwd, s.path) } };
      case "bash":
        return { name: "Bash", input: { command: s.cmd, description: s.cmd.split(" ").slice(0, 3).join(" ") }, result: bashOutput(s.cmd, s.fail, lang), isError: s.fail === true, tur: { stdout: bashOutput(s.cmd, s.fail, lang), stderr: "" } };
      case "skill":
        return { name: "Skill", input: { skill: s.name }, result: `Launching skill: ${s.name}`, isError: false, tur: { success: true, commandName: s.name } };
      default:
        return null;
    }
  };

  const emitSteps = (steps: Step[]) => {
    for (const s of steps) {
      if (s.t === "say") {
        lines.push(JSON.stringify(assistant(clock.next(), [{ type: "text", text: pick(s.text, lang) }])));
        continue;
      }
      if (s.t === "agent") {
        const toolUseId = `toolu_${hex(`${spec.sessionId}:a${n}`, 24)}`;
        const agentId = `a${hex(`${spec.sessionId}:agent${n}`, 16)}`;
        lines.push(
          JSON.stringify(
            assistant(clock.next(), [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description: pick(s.desc, lang), subagent_type: s.type, prompt: pick(s.prompt, lang) } }]),
          ),
        );
        const mainPrev = prev;
        subFiles.push(buildClaudeSubagent(spec, lang, agentId, s, clock, toolUseId));
        prev = mainPrev;
        lines.push(JSON.stringify(toolResult(clock.next(), toolUseId, pick(s.result, lang), false, { status: "completed", agentId })));
        continue;
      }
      const call = toolInput(s);
      if (!call) continue;
      const toolUseId = `toolu_${hex(`${spec.sessionId}:t${n}`, 24)}`;
      lines.push(JSON.stringify(assistant(clock.next(), [{ type: "tool_use", id: toolUseId, name: call.name, input: call.input }])));
      lines.push(JSON.stringify(toolResult(clock.next(), toolUseId, call.result, call.isError, call.tur)));
    }
  };

  let firstTs = "";
  spec.turns.forEach((turn, i) => {
    const ts = clock.next();
    if (i === 0) {
      firstTs = ts;
      hooks.push({ ts: new Date(Date.parse(ts) - 4_000).toISOString(), event: "SessionStart", extra: { source: "startup" } });
    }
    hooks.push({ ts, event: "UserPromptSubmit", extra: {} });
    lines.push(JSON.stringify(userText(ts, pick(turn.user, lang))));
    emitSteps(turn.steps);
    if (turn.reply) {
      const rts = clock.next();
      lines.push(JSON.stringify(assistant(rts, [{ type: "text", text: pick(turn.reply, lang) }])));
      hooks.push({ ts: new Date(Date.parse(rts) + 500).toISOString(), event: "Stop", extra: {} });
    }
  });
  const lastTs = JSON.parse(lines[lines.length - 1] ?? "{}").timestamp as string;
  if (spec.title) lines.push(JSON.stringify({ type: "ai-title", aiTitle: pick(spec.title, lang), sessionId: spec.sessionId }));

  return {
    files: [{ path: `${dir}/${spec.sessionId}.jsonl`, text: `${lines.join("\n")}\n` }, ...subFiles],
    hooks,
    firstTs,
    lastTs,
  };
}

function buildClaudeSubagent(spec: TranscriptSpec, lang: Lang, agentId: string, step: Extract<Step, { t: "agent" }>, clock: Clock, toolUseId: string): TranscriptFile {
  const lines: string[] = [];
  let n = 0;
  let prev: string | null = null;
  const model = spec.subModel ?? "claude-sonnet-5";
  const base = (ts: string, extra: Record<string, unknown>) => {
    const id = uuid(`${spec.sessionId}:${agentId}:${n++}`);
    const row = { parentUuid: prev, isSidechain: true, agentId, ...extra, uuid: id, timestamp: ts, userType: "external", entrypoint: "cli", cwd: spec.cwd, sessionId: spec.sessionId, version: CLAUDE_VERSION, gitBranch: spec.branch };
    prev = id;
    return row;
  };
  const usage = (k: number) => ({ input_tokens: 12, cache_creation_input_tokens: 2_400, cache_read_input_tokens: 14_000 + k * 3_500, output_tokens: 380 });
  const assistant = (ts: string, content: unknown[]) =>
    base(ts, { message: { model, id: `msg_${hex(`${agentId}:m${n}`, 24)}`, type: "message", role: "assistant", content, stop_reason: null, usage: usage(n) }, type: "assistant" });

  lines.push(JSON.stringify(base(clock.next(), { type: "user", message: { role: "user", content: pick(step.prompt, lang) } })));
  for (const s of step.steps) {
    if (s.t === "say") {
      lines.push(JSON.stringify(assistant(clock.next(), [{ type: "text", text: pick(s.text, lang) }])));
      continue;
    }
    const id = `toolu_${hex(`${agentId}:t${n}`, 24)}`;
    const name = s.t === "read" ? "Read" : s.t === "grep" ? "Grep" : s.t === "bash" ? "Bash" : s.t === "edit" ? "Edit" : "Write";
    const input =
      s.t === "read"
        ? { file_path: abs(spec.cwd, s.path) }
        : s.t === "grep"
          ? { pattern: s.pattern }
          : s.t === "bash"
            ? { command: s.cmd }
            : s.t === "edit"
              ? { file_path: abs(spec.cwd, s.path), old_string: s.old, new_string: s.new }
              : s.t === "write"
                ? { file_path: abs(spec.cwd, s.path), content: s.content }
                : {};
    lines.push(JSON.stringify(assistant(clock.next(), [{ type: "tool_use", id, name, input }])));
    lines.push(JSON.stringify(base(clock.next(), { type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: "ok" }] } })));
  }
  lines.push(JSON.stringify(assistant(clock.next(), [{ type: "text", text: pick(step.result, lang) }])));
  return {
    path: `${claudeProjectDir(spec.cwd)}/${spec.sessionId}/subagents/agent-${agentId}.jsonl`,
    text: `${lines.join("\n")}\n`,
    agentId,
    meta: { agentType: step.type, description: pick(step.desc, lang), toolUseId },
  };
}

// ─────────────────────────────── Codex ───────────────────────────────

export function codexRolloutPath(sessionId: string, start: number): string {
  const d = new Date(start).toISOString();
  const [date, time] = [d.slice(0, 10), d.slice(11, 19).replace(/:/g, "-")];
  return `${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}/rollout-${date}T${time}-${sessionId}.jsonl`;
}

export function buildCodexTranscript(spec: TranscriptSpec, lang: Lang): BuiltTranscript {
  const total = spec.turns.reduce((n, t) => n + 3 + codexSlots(t.steps) + (t.reply ? 2 : 0), 0) + 2;
  const clock = new Clock(spec.start, spec.end, total, spec.sessionId);
  const lines: string[] = [];
  const id = spec.sessionId;
  const window = CONTEXT_WINDOW[spec.model] ?? 922_000;
  const rand = rng(parseInt(hex(`${id}:tok`, 8), 16));
  let item = 0;
  const cumulative = { input: 0, cached: 0, output: 0, reasoning: 0 };
  const limits = spec.limits ?? { primary: 22, secondary: 41 };

  const push = (ts: string, type: string, payload: Record<string, unknown>) => lines.push(JSON.stringify({ timestamp: ts, type, payload }));
  const done = (ts: string, turnId: string, it: Record<string, unknown>) =>
    push(ts, "event_msg", { type: "item_completed", thread_id: id, turn_id: turnId, item: { ...it, id: `${String(it.type).toLowerCase()}-${item++}` } });

  const startTs = clock.next();
  push(startTs, "session_meta", {
    session_id: id,
    id,
    timestamp: startTs,
    cwd: spec.cwd,
    originator: "codex-tui",
    cli_version: CODEX_VERSION,
    source: spec.parentSessionId ? { subagent: { thread_spawn: { parent_thread_id: spec.parentSessionId, depth: 1, agent_path: `/root/${spec.nickname ?? "explorer"}`, agent_nickname: spec.nickname ?? null } } } : "cli",
    ...(spec.parentSessionId ? { parent_thread_id: spec.parentSessionId, agent_nickname: spec.nickname ?? null } : {}),
    model_provider: "openai",
    git: { branch: spec.branch, commit_hash: hex(`${id}:head`, 40) },
  });

  spec.turns.forEach((turn, ti) => {
    const turnId = `t-${ti + 1}`;
    const ts0 = clock.next();
    push(ts0, "turn_context", { turn_id: turnId, cwd: spec.cwd, model: spec.model, effort: "high" });
    push(ts0, "event_msg", { type: "task_started", turn_id: turnId, model_context_window: window });
    done(clock.next(), turnId, { type: "UserMessage", content: [{ type: "text", text: pick(turn.user, lang) }] });
    for (const s of turn.steps) {
      const ts = clock.next();
      switch (s.t) {
        case "say":
          done(ts, turnId, { type: "AgentMessage", content: [{ type: "Text", text: pick(s.text, lang) }], phase: "commentary" });
          break;
        case "read": {
          const cmd = `sed -n '1,200p' ${s.path}`;
          done(ts, turnId, {
            type: "CommandExecution",
            process_id: "1",
            command: ["/bin/zsh", "-lc", cmd],
            cwd: `file://${spec.cwd}`,
            parsed_cmd: [{ type: "read", cmd, name: s.path.split("/").pop(), path: s.path }],
            status: "completed",
            exit_code: 0,
          });
          break;
        }
        case "grep":
        case "bash":
        case "skill": {
          const cmd = s.t === "grep" ? `rg -n "${s.pattern}"` : s.t === "bash" ? s.cmd : `cat ~/.codex/skills/${s.name}/SKILL.md`;
          done(ts, turnId, { type: "CommandExecution", process_id: "1", command: ["/bin/zsh", "-lc", cmd], cwd: `file://${spec.cwd}`, parsed_cmd: [], status: "completed", exit_code: s.t === "bash" && s.fail ? 1 : 0 });
          break;
        }
        case "edit":
          done(ts, turnId, {
            type: "FileChange",
            changes: { [abs(spec.cwd, s.path)]: { type: "update", unified_diff: `@@ -1,1 +1,1 @@\n-${s.old.split("\n").join("\n-")}\n+${s.new.split("\n").join("\n+")}\n`, move_path: null } },
            status: "completed",
          });
          break;
        case "write":
          done(ts, turnId, { type: "FileChange", changes: { [abs(spec.cwd, s.path)]: { type: "add", content: s.content } }, status: "completed" });
          break;
        case "agent": {
          const childId = spec.childIds?.[s.type] ?? uuid(`${id}:child:${item}`);
          done(ts, turnId, { type: "CollabAgentToolCall", tool: "spawn_agent", receiver_thread_ids: [childId], status: "completed" });
          // No `SubAgentActivity` line: the agents tab would list it a second time as a Claude run.
          clock.next();
          break;
        }
      }
    }
    // Token count after every turn: cumulative totals plus the size of the last request.
    const context = Math.round(window * spec.contextFrac * ((ti + 1) / spec.turns.length));
    const lastIn = Math.max(12_000, context);
    const lastCached = Math.round(lastIn * 0.86);
    const lastOut = Math.round(600 + rand() * 2_400);
    cumulative.input += lastIn * (2 + turn.steps.length);
    cumulative.cached += lastCached * (2 + turn.steps.length);
    cumulative.output += lastOut * 2;
    cumulative.reasoning += Math.round(lastOut * 0.6);
    const frac = (ti + 1) / spec.turns.length;
    const tcTs = clock.next();
    push(tcTs, "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: cumulative.input,
          cached_input_tokens: cumulative.cached,
          cache_write_input_tokens: 0,
          output_tokens: cumulative.output,
          reasoning_output_tokens: cumulative.reasoning,
          total_tokens: cumulative.input + cumulative.output,
        },
        last_token_usage: { input_tokens: lastIn, cached_input_tokens: lastCached, cache_write_input_tokens: 0, output_tokens: lastOut, reasoning_output_tokens: 0, total_tokens: lastIn + lastOut },
        model_context_window: window,
      },
      rate_limits: {
        limit_id: "premium",
        primary: { used_percent: Math.round(limits.primary * frac * 10) / 10, window_minutes: 300, resets_at: Math.round(spec.end / 1000) + 2 * 3600 },
        secondary: { used_percent: Math.round((limits.secondary - 6 + 6 * frac) * 10) / 10, window_minutes: 10_080, resets_at: Math.round(spec.end / 1000) + 3 * 86_400 },
        plan_type: "pro",
      },
    });
    if (turn.reply) {
      done(clock.next(), turnId, { type: "AgentMessage", content: [{ type: "Text", text: pick(turn.reply, lang) }], phase: "final_answer" });
      push(clock.next(), "event_msg", { type: "task_complete", turn_id: turnId, duration_ms: 60_000 });
    }
  });

  const lastTs = JSON.parse(lines[lines.length - 1] ?? "{}").timestamp as string;
  return { files: [{ path: codexRolloutPath(id, spec.start), text: `${lines.join("\n")}\n` }], hooks: [], firstTs: startTs, lastTs };
}

export function buildTranscript(spec: TranscriptSpec, lang: Lang): BuiltTranscript {
  return spec.tool === "claude" ? buildClaudeTranscript(spec, lang) : buildCodexTranscript(spec, lang);
}
