// Parser für Codex-Rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
// Maßgeblich sind die `item_completed`-Events; die `response_item`-Zeilen
// wiederholen dieselben Inhalte und werden deshalb nicht als Events gezählt.
// Kein `node:path`: @nyxos/shared läuft auch im Browser (Vite-Dev lädt den ganzen Barrel ungebündelt, und dort
// gibt es `node:path` nicht – die Seite blieb weiß). Codex-Pfade sind POSIX (Mac/Linux), daher reichen reine Helfer.
import type { EventKind, LastUsage, SessionEvent, SessionSummary, SubagentInfo, TokenTotals } from "../events.js";
import {
  Counter,
  EVENT_TEXT_MAX,
  clipText,
  OrderedSet,
  TimeRange,
  count,
  isObj,
  isoTs,
  parseJsonLine,
  str,
  toTitle,
  truncate,
  type Json,
  type ParserOptions,
} from "./common.js";

/** Wie `path.posix.basename`: letzter Abschnitt, abschließende Schrägstriche zählen nicht. */
export function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Wie `path.posix.join` (mit Normalisieren von `.`/`..`) für einen Basisordner und einen relativen Pfad. */
export function posixJoin(base: string, rel: string): string {
  const joined = [base, rel].filter((p) => p.length > 0).join("/");
  if (joined.length === 0) return ".";
  const absolute = joined.startsWith("/");
  const trailing = joined.endsWith("/");
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const body = out.join("/");
  const result = absolute ? `/${body}` : body || ".";
  return trailing && body ? `${result}/` : result;
}

const ROLLOUT_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function codexSessionIdFromPath(path: string): string | null {
  return ROLLOUT_RE.exec(posixBasename(path))?.[1]?.toLowerCase() ?? null;
}

/** `session_index.jsonl`: je Session gilt der Name mit dem jüngsten `updated_at`. */
export function parseCodexIndex(text: string): Map<string, string> {
  const best = new Map<string, { name: string; at: string }>();
  for (const line of text.split("\n")) {
    const o = parseJsonLine(line);
    if (!o) continue;
    const id = str(o.id);
    const name = str(o.thread_name);
    if (!id || !name) continue;
    const at = isoTs(o.updated_at) ?? "";
    const prev = best.get(id);
    if (!prev || at >= prev.at) best.set(id, { name, at });
  }
  return new Map([...best].map(([id, v]) => [id, v.name]));
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObj)
    .map((c) => str(c.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function fileUrlToPath(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return s.startsWith("file://") ? decodeURIComponent(s.slice("file://".length)) : s;
}

export class CodexSessionParser {
  private readonly range = new TimeRange();
  private readonly models = new OrderedSet();
  private readonly filesWritten = new OrderedSet();
  private readonly filesRead = new OrderedSet();
  private readonly toolCalls = new Counter();
  private readonly subagentMap = new Map<string, SubagentInfo>();
  private readonly emitted = new Set<string>();
  private tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 };
  private limits: unknown = null;
  /** Tokens der letzten Antwort (`last_token_usage`, von Codex selbst schon "nur diese
   * Antwort" geliefert — anders als `tokens` oben, das die kumulative Session-Summe ist) plus das
   * von Codex selbst gemeldete Kontextfenster dieser Session. */
  private lastUsage: LastUsage | null = null;
  private currentModel: string | null = null;
  private modelContextWindow: number | null = null;
  private metaStart: string | null = null;
  private parentSessionId: string | null = null;
  private nickname: string | null = null;
  private cwd: string | null = null;
  private gitBranch: string | null = null;
  private cliVersion: string | null = null;
  private firstPrompt: string | null = null;
  private fallbackPrompt: string | null = null;
  private indexTitle: string | null = null;
  private eventCount = 0;
  private parseErrors = 0;

  /** Kürzungsgrenze für Event-Texte; `null` = voller Text (Chat aus dem Archiv). */
  private readonly textMax: number | null;

  constructor(
    readonly sessionId: string,
    opts: ParserOptions = {},
  ) {
    this.textMax = opts.textMax === undefined ? EVENT_TEXT_MAX : opts.textMax;
  }

  setIndexTitle(name: string | null): void {
    this.indexTitle = name;
  }

  push(line: string): SessionEvent[] {
    const o = parseJsonLine(line);
    if (o === undefined) return [];
    if (o === null) {
      this.parseErrors++;
      return [];
    }
    const ts = isoTs(o.timestamp);
    if (!ts) {
      this.parseErrors++;
      return [];
    }
    const p = isObj(o.payload) ? o.payload : {};
    // Sub-Agent-Dateien beginnen mit der Kopfzeile der Eltern-Session: nicht unsere.
    if (o.type === "session_meta" && str(p.id) !== this.sessionId) return [];
    if (typeof p.thread_id === "string" && p.thread_id !== this.sessionId) return [];

    this.range.see(ts);
    const out: SessionEvent[] = [];
    const emit = (idSuffix: string, kind: EventKind, data: Json) => {
      const id = `codex:${this.sessionId}:${idSuffix}`;
      if (this.emitted.has(id)) return;
      this.emitted.add(id);
      this.eventCount++;
      out.push({ id, tool: "codex", sessionId: this.sessionId, ts, kind, source: "file", data });
    };

    switch (o.type) {
      case "session_meta":
        this.onMeta(p);
        emit("session_meta", "session_meta", { cwd: this.cwd, parentSessionId: this.parentSessionId });
        break;
      case "turn_context":
        this.models.add(str(p.model));
        this.currentModel = str(p.model) ?? this.currentModel;
        this.cwd ??= str(p.cwd);
        break;
      case "response_item":
        if (p.type === "message" && p.role === "user" && !this.fallbackPrompt) {
          const t = textOf(p.content).trim();
          if (t && !t.startsWith("<") && !t.startsWith("# AGENTS.md")) this.fallbackPrompt = t;
        }
        break;
      case "event_msg":
        this.onEventMsg(p, emit);
        break;
    }
    return out;
  }

  private onMeta(p: Json): void {
    this.metaStart = isoTs(p.timestamp) ?? this.metaStart;
    this.cwd = str(p.cwd) ?? this.cwd;
    this.cliVersion = str(p.cli_version) ?? this.cliVersion;
    const git = isObj(p.git) ? p.git : {};
    this.gitBranch = str(git.branch) ?? this.gitBranch;
    const source = isObj(p.source) ? p.source : {};
    const sub = isObj(source.subagent) ? source.subagent : {};
    const spawn = isObj(sub.thread_spawn) ? sub.thread_spawn : {};
    this.parentSessionId = str(p.parent_thread_id) ?? str(spawn.parent_thread_id) ?? this.parentSessionId;
    this.nickname = str(p.agent_nickname) ?? str(spawn.agent_nickname) ?? this.nickname;
  }

  private onEventMsg(p: Json, emit: (id: string, k: EventKind, d: Json) => void): void {
    const turnId = str(p.turn_id) ?? "?";
    switch (p.type) {
      case "task_started":
        emit(`turn:${turnId}:start`, "turn_start", { turnId });
        return;
      case "task_complete":
        emit(`turn:${turnId}:end`, "turn_end", { turnId, durationMs: count(p.duration_ms) });
        return;
      case "turn_aborted":
        emit(`turn:${turnId}:aborted`, "turn_aborted", { turnId, reason: str(p.reason) });
        return;
      case "token_count":
        this.onTokenCount(p);
        return;
      case "item_completed":
        if (isObj(p.item)) this.onItem(p.item, emit);
        return;
    }
  }

  private onTokenCount(p: Json): void {
    const info = isObj(p.info) ? p.info : null;
    const u = info && isObj(info.total_token_usage) ? info.total_token_usage : null;
    if (isObj(p.rate_limits)) this.limits = p.rate_limits;
    const windowRaw = info?.model_context_window;
    if (typeof windowRaw === "number" && Number.isSafeInteger(windowRaw) && windowRaw > 0) this.modelContextWindow = windowRaw;
    const last = info && isObj(info.last_token_usage) ? info.last_token_usage : null;
    if (last) {
      const li = count(last.input_tokens);
      const lc = Math.min(count(last.cached_input_tokens), li);
      const lw = Math.min(count(last.cache_write_input_tokens), li - lc);
      this.lastUsage = { input: li - lc - lw, output: count(last.output_tokens), cacheRead: lc, cacheCreation: lw };
    }
    if (!u) return;
    const valid = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    if (!valid(u.input_tokens) || !valid(u.output_tokens) || !valid(u.total_tokens)) return;
    // Codex zählt gelesenen und geschriebenen Cache im Input mit (wie die Vorlage, siehe NOTICE).
    const input = count(u.input_tokens);
    const cached = Math.min(count(u.cached_input_tokens), input);
    const written = Math.min(count(u.cache_write_input_tokens), input - cached);
    this.tokens = {
      input: input - cached - written,
      cacheRead: cached,
      cacheCreation: written,
      output: count(u.output_tokens),
      reasoning: count(u.reasoning_output_tokens),
      total: count(u.total_tokens),
    };
  }

  private addSubagent(id: string | null, name: string | null): void {
    if (!id) return;
    const prev = this.subagentMap.get(id);
    this.subagentMap.set(id, { id, name: name ?? prev?.name ?? null, type: null });
  }

  private onItem(item: Json, emit: (id: string, k: EventKind, d: Json) => void): void {
    const id = str(item.id);
    if (!id) return;
    switch (item.type) {
      case "UserMessage": {
        const text = textOf(item.content);
        if (!this.firstPrompt && text.trim()) this.firstPrompt = text;
        emit(id, "prompt", clipText(text, this.textMax));
        return;
      }
      case "AgentMessage":
        emit(id, "assistant", clipText(textOf(item.content), this.textMax));
        return;
      case "Reasoning":
        emit(id, "thinking", {});
        return;
      case "ContextCompaction":
        emit(id, "compaction", {});
        return;
      case "CommandExecution": {
        this.toolCalls.inc("exec_command");
        const cwd = fileUrlToPath(item.cwd) ?? this.cwd;
        if (Array.isArray(item.parsed_cmd)) {
          for (const c of item.parsed_cmd.filter(isObj)) {
            const path = str(c.path);
            if (c.type !== "read" || !path) continue;
            this.filesRead.add(path.startsWith("/") || !cwd ? path : posixJoin(cwd, path));
          }
        }
        const cmd = Array.isArray(item.command) ? item.command.filter((x) => typeof x === "string").at(-1) : null;
        emit(id, "tool_call", { name: "exec_command", target: cmd ? truncate(cmd, 300) : null, exitCode: item.exit_code ?? null });
        return;
      }
      case "FileChange": {
        this.toolCalls.inc("apply_patch");
        const files: string[] = [];
        if (isObj(item.changes)) {
          for (const [path, change] of Object.entries(item.changes)) {
            files.push(path);
            this.filesWritten.add(path);
            if (isObj(change)) this.filesWritten.add(str(change.move_path));
          }
        }
        emit(id, "tool_call", { name: "apply_patch", files: files.slice(0, 50) });
        return;
      }
      case "McpToolCall": {
        const name = `mcp:${str(item.server) ?? "?"}/${str(item.tool) ?? "?"}`;
        this.toolCalls.inc(name);
        emit(id, "tool_call", { name });
        return;
      }
      case "Extension": {
        const name = str(item.kind) ?? "extension";
        this.toolCalls.inc(name);
        emit(id, "tool_call", { name, target: str(item.query) });
        return;
      }
      case "CollabAgentToolCall": {
        const name = str(item.tool) ?? "collab";
        this.toolCalls.inc(name);
        if (name === "spawn_agent" && Array.isArray(item.receiver_thread_ids)) {
          for (const r of item.receiver_thread_ids) this.addSubagent(str(r), null);
        }
        emit(id, "tool_call", { name });
        return;
      }
      case "SubAgentActivity": {
        const agentPath = str(item.agent_path);
        const agentId = str(item.agent_thread_id);
        this.addSubagent(agentId, agentPath ? posixBasename(agentPath) : null);
        emit(id, "subagent", { agentId, activity: str(item.kind), agentPath });
        return;
      }
      default:
        emit(id, "system", { itemType: str(item.type) });
    }
  }

  summary(): SessionSummary {
    let title: string | null = null;
    let titleSource: SessionSummary["titleSource"] = null;
    const prompt = this.firstPrompt ?? this.fallbackPrompt;
    if (this.indexTitle) [title, titleSource] = [toTitle(this.indexTitle), "index"];
    else if (prompt) [title, titleSource] = [toTitle(this.nickname ? `${this.nickname}: ${prompt}` : prompt), "prompt"];

    return {
      tool: "codex",
      sessionId: this.sessionId,
      parentSessionId: this.parentSessionId,
      cwd: this.cwd,
      title,
      titleSource,
      startedAt: this.metaStart ?? this.range.first,
      lastActivityAt: this.range.last,
      models: this.models.toArray(),
      tokens: { ...this.tokens },
      toolCalls: this.toolCalls.toObject(),
      filesWritten: this.filesWritten.toArray(),
      filesRead: this.filesRead.toArray(),
      subagents: [...this.subagentMap.values()],
      gitBranch: this.gitBranch,
      cliVersion: this.cliVersion,
      eventCount: this.eventCount,
      parseErrors: this.parseErrors,
      limits: this.limits,
      lastUsage: this.lastUsage,
      lastUsageModel: this.currentModel,
      modelContextWindow: this.modelContextWindow,
    };
  }
}
