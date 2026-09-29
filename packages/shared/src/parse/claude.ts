// Parser für Claude-Code-Verläufe (~/.claude/projects/<projekt>/<session>.jsonl).
// Aufbau der Zeilen und die Idee, Tokens pro Nachrichten-ID zu zählen, folgen dem
// Parser aus „Claude Code Agent Monitor" (MIT, siehe NOTICE).
import type { EventKind, LastUsage, SessionEvent, SessionSummary, SubagentInfo, TokenTotals } from "../events.js";
import {
  Counter,
  EVENT_TEXT_MAX,
  clipText,
  OrderedSet,
  TimeRange,
  count,
  emptyTokens,
  isObj,
  isoTs,
  parseJsonLine,
  str,
  toTitle,
  truncate,
  type Json,
  type ParserOptions,
} from "./common.js";
import { skillKeyFrom } from "../skills.js";

/** Claude Code (≥ 2.1) legt lange Einfügungen so im Verlauf ab: `<pasted_content id="x">…</pasted_content id="x">`. */
const PASTED_RE = /<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">/g;

/** Befehls-Argumente wie Text behandeln – gekürzt nur mit Marke. */
function clipArgs(args: string, max: number | null): { args: string; argsTruncated?: true; argsLength?: number } {
  const c = clipText(args, max);
  return c.textTruncated ? { args: c.text, argsTruncated: true, argsLength: c.textLength } : { args: c.text };
}

export interface ClaudeLineOrigin {
  /** Gesetzt, wenn die Zeile aus `<session>/subagents/agent-<id>.jsonl` stammt. */
  agentId?: string;
}

export interface ClaudeSubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const COMMAND_RE = /<command-name>([^<]*)<\/command-name>/;
const ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
/** eine rohe, getippte Befehlszeile („/compact“, „/model opus“) – nur ein Wort nach dem Schrägstrich. */
const TYPED_COMMAND_RE = /^\/([a-z][a-z-]*)(?:\s[^\n]*)?$/;

/**
 * Eingebaute, rein LOKALE Claude-Code-Befehle (`/clear`, `/model`, …) —
 * die CLI führt sie selbst aus, OHNE das Modell aufzurufen, es folgt also nie eine Assistenten-
 * Antwort. Sie kommen in derselben `<command-name>`-Zeilenform wie ein echter, projekt-eigener
 * Slash-Befehl an (z. B. `/goal` aus `.claude/commands/` — DER expandiert zu einem echten Prompt und
 * löst sehr wohl eine Antwort aus, s. Fixture `sess-cmd.jsonl`). Ohne diese Unterscheidung zählt ein
 * lokaler Befehl als `kind: "prompt"` — genau das, was `store.ts` (`CONTENT_EVENT_KINDS`) als
 * „Runde ist offen, wartet auf Antwort" liest. Da nie eine Antwort folgt, bliebe die Runde für immer
 * offen (Session wirkt endlos „läuft"/"wartet"). Diese Liste ist der feste, eingebaute Befehlssatz
 * der CLI selbst (nicht projektspezifisch) — neue eingebaute Befehle hier ergänzen.
 */
const LOCAL_COMMAND_NAMES = new Set([
  "add-dir",
  "agents",
  "bug",
  "clear",
  "compact",
  "config",
  "context",
  "cost",
  "doctor",
  "exit",
  "export",
  "help",
  "init",
  "login",
  "logout",
  "mcp",
  "memory",
  "migrate-installer",
  "model",
  "output-style",
  "permissions",
  "pr-comments",
  "release-notes",
  "resume",
  "rewind",
  "status",
  "statusline",
  "terminal-setup",
  "theme",
  "todos",
  "usage",
  "vim",
]);

function isLocalCommand(name: string): boolean {
  return LOCAL_COMMAND_NAMES.has(name.replace(/^\//, "").trim().toLowerCase());
}

export function parseClaudeSubagentMeta(text: string): ClaudeSubagentMeta {
  const o = parseJsonLine(text);
  if (!o) return {};
  const meta: ClaudeSubagentMeta = {};
  const agentType = str(o.agentType);
  const description = str(o.description);
  const toolUseId = str(o.toolUseId);
  if (agentType) meta.agentType = agentType;
  if (description) meta.description = description;
  if (toolUseId) meta.toolUseId = toolUseId;
  return meta;
}

/** Ziel eines Werkzeug-Aufrufs, kurz genug für die Liste. */
function toolTarget(input: Json): string | null {
  for (const key of ["file_path", "notebook_path", "command", "pattern", "url", "query", "description"]) {
    const v = str(input[key]);
    if (v) return truncate(v, 300);
  }
  return null;
}

function usageOf(u: unknown): TokenTotals | null {
  if (!isObj(u)) return null;
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  const cacheRead = count(u.cache_read_input_tokens);
  const cacheCreation = count(u.cache_creation_input_tokens);
  const details = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  const reasoning = count(details.thinking_tokens);
  return { input, output, cacheRead, cacheCreation, reasoning, total: input + output + cacheRead + cacheCreation };
}

export class ClaudeSessionParser {
  private readonly range = new TimeRange();
  private readonly models = new OrderedSet();
  private readonly filesWritten = new OrderedSet();
  private readonly filesRead = new OrderedSet();
  private readonly toolCalls = new Counter();
  /** Nutzung pro Nachrichten-ID: eine Antwort steht oft in mehreren Zeilen mit identischer usage. */
  private readonly usageByMessage = new Map<string, TokenTotals>();
  /** Tokens + Modell der zuletzt GESEHENEN Antwort (nicht Summe) — Grundlage für `contextPct`. */
  private lastUsage: LastUsage | null = null;
  private lastUsageModel: string | null = null;
  private readonly agentCalls = new Map<string, { name: string | null; type: string | null }>();
  private readonly agentIdByToolUse = new Map<string, string>();
  private readonly subagentMeta = new Map<string, ClaudeSubagentMeta>();
  private readonly emitted = new Set<string>();
  private cwd: string | null = null;
  private gitBranch: string | null = null;
  private cliVersion: string | null = null;
  private customTitle: string | null = null;
  private aiTitle: string | null = null;
  private summaryTitle: string | null = null;
  private firstPrompt: { title: string; source: "command" | "prompt" } | null = null;
  private eventCount = 0;
  private parseErrors = 0;
  /** Zeilen mit eigener bzw. fremder `sessionId` (fremd = übernommener Verlauf einer anderen Session, s. `push`). */
  private ownLines = 0;
  private foreignLines = 0;
  private foreignSessionId: string | null = null;
  /** Nutzungslimit (Schritt 0: einzige beobachtete maschinenlesbare Quelle für Claude-Limits —
   * `quotaLimits` steht auf der Zeile, die den 429 "session limit" meldet, mit `resetsAt`/
   * `rateLimitType`). Nur der zuletzt gesehene Stand zählt (wie Codex' `rate_limits`, dieselbe
   * Spalte `sessions.limits` — s. `applySummary`). Kein Dauer-Prozentwert, nur "zuletzt erreicht". */
  private lastQuotaLimit: unknown = null;

  /** Kürzungsgrenze für Event-Texte; `null` = voller Text (Chat aus dem Archiv). */
  private readonly textMax: number | null;

  constructor(
    readonly sessionId: string,
    opts: ParserOptions = {},
  ) {
    this.textMax = opts.textMax === undefined ? EVENT_TEXT_MAX : opts.textMax;
  }

  /** Nur Zeilen einer ANDEREN Session gesehen (keine eigene)? Dann deren `sessionId` und Anzahl, sonst `null`. */
  onlyForeignLines(): { sessionId: string; lines: number } | null {
    return this.ownLines === 0 && this.foreignSessionId !== null ? { sessionId: this.foreignSessionId, lines: this.foreignLines } : null;
  }

  addSubagentMeta(agentId: string, meta: ClaudeSubagentMeta): void {
    this.subagentMeta.set(agentId, meta);
    if (meta.toolUseId) this.agentIdByToolUse.set(meta.toolUseId, agentId);
  }

  push(line: string, origin: ClaudeLineOrigin = {}): SessionEvent[] {
    const o = parseJsonLine(line);
    if (o === undefined) return [];
    if (o === null) {
      this.parseErrors++;
      return [];
    }
    // Zeilen einer anderen Session (übernommener Verlauf beim Fortsetzen/Abzweigen) gehören der Ursprungs-Session
    // und kämen sonst doppelt an. Gezählt, damit eine Datei ohne eigene Zeilen nie STILL leer bleibt.
    if (typeof o.sessionId === "string" && o.sessionId !== this.sessionId) {
      this.foreignLines++;
      this.foreignSessionId ??= o.sessionId;
      return [];
    }
    if (o.sessionId === this.sessionId) this.ownLines++;

    const main = origin.agentId === undefined;
    switch (o.type) {
      case "ai-title":
        if (main) this.aiTitle = str(o.aiTitle) ?? this.aiTitle;
        return [];
      case "custom-title":
        if (main) this.customTitle = str(o.customTitle) ?? this.customTitle;
        return [];
      case "summary":
        if (main) this.summaryTitle = str(o.summary) ?? this.summaryTitle;
        return [];
    }

    if (isObj(o.quotaLimits)) this.lastQuotaLimit = o.quotaLimits;

    const uuid = str(o.uuid);
    if (!uuid) return [];
    const ts = isoTs(o.timestamp);
    if (!ts) {
      this.parseErrors++;
      return [];
    }
    this.range.see(ts);
    if (main) {
      this.cwd ??= str(o.cwd);
      this.gitBranch ??= str(o.gitBranch);
      this.cliVersion = str(o.version) ?? this.cliVersion;
    }

    const out: SessionEvent[] = [];
    const emit = (idSuffix: string, kind: EventKind, data: Json) => {
      const id = `claude:${this.sessionId}:${idSuffix}`;
      if (this.emitted.has(id)) return;
      this.emitted.add(id);
      this.eventCount++;
      if (origin.agentId) data.agentId = origin.agentId;
      out.push({ id, tool: "claude", sessionId: this.sessionId, ts, kind, source: "file", data });
    };

    switch (o.type) {
      case "user":
        this.onUser(o, main, uuid, emit);
        break;
      case "assistant":
        this.onAssistant(o, main, uuid, emit);
        break;
      case "system":
        if (o.subtype === "compact_boundary") {
          // `trigger` = "manual" (der Nutzer hat komprimiert, danach wartet Claude wieder) oder "auto"
          // (mitten in einer Runde, Claude arbeitet weiter) – s. `deriveTurnSignal` im Server.
          const meta = isObj(o.compactMetadata) ? o.compactMetadata : {};
          const trigger = str(meta.trigger);
          emit(uuid, "compaction", { subtype: "compact_boundary", ...(trigger ? { trigger } : {}) });
        } else emit(uuid, "system", { subtype: str(o.subtype) });
        break;
      case "attachment": {
        const att = isObj(o.attachment) ? o.attachment : {};
        emit(uuid, "attachment", { attachmentType: str(att.type) });
        break;
      }
      default:
        emit(uuid, "system", { recordType: str(o.type) });
    }
    return out;
  }

  private onUser(o: Json, main: boolean, uuid: string, emit: (id: string, k: EventKind, d: Json) => void): void {
    const msg = isObj(o.message) ? o.message : {};
    const content = msg.content;
    if (o.isMeta === true) {
      emit(uuid, "system", { meta: true });
      return;
    }
    if (o.isCompactSummary === true) {
      // die Zusammenfassung, mit der Claude nach „/compact“ weitermacht – kein Text vom Nutzer,
      // nie Chat-Blase und nie Session-Titel (im Chat steht dafür die ruhige Zeile „Kontext komprimiert“).
      emit(uuid, "system", { compactSummary: true });
      return;
    }
    if (typeof content === "string" && content.includes("<pasted_content id=")) {
      // lange Einfügungen (Claude Code packt sie in <pasted_content>) sind des Nutzers Text,
      // kein „Formatierter Hinweis“ — sonst verschwand die ganze Nachricht als interne Zeile.
      this.onPromptText(content.replace(PASTED_RE, "$1").trim(), main, uuid, emit);
      return;
    }
    if (typeof content === "string") {
      const typed = TYPED_COMMAND_RE.exec(content.trim());
      if (typed && isLocalCommand(typed[1] ?? "")) {
        // Claude Code schreibt einen getippten lokalen Befehl („/compact“) zusätzlich als rohe
        // Nutzerzeile vor die <command-name>-Zeilen. Wie Befund H5: kein prompt, kein Titel, keine Chat-Blase.
        emit(uuid, "system", { command: typed[1] ?? "", localCommand: true, typed: true });
        return;
      }
      const cmd = COMMAND_RE.exec(content);
      if (cmd) {
        const name = (cmd[1] ?? "").trim();
        const args = (ARGS_RE.exec(content)?.[1] ?? "").trim();
        if (isLocalCommand(name)) {
          // lokaler Befehl (kein Modell-Aufruf, nie eine Antwort) — kein "prompt", wird
          // nie Session-Titel, zählt in `store.ts` (CONTENT_EVENT_KINDS) nicht als Runden-Inhalt.
          emit(uuid, "system", { command: name, ...clipArgs(args, this.textMax), localCommand: true });
          return;
        }
        emit(uuid, "prompt", { command: name, ...clipArgs(args, this.textMax) });
        if (main && !this.firstPrompt) {
          const title = toTitle(args ? `${name} ${args}` : name);
          if (title) this.firstPrompt = { title, source: "command" };
        }
        return;
      }
      if (content.trimStart().startsWith("<")) {
        emit(uuid, "system", { tagged: true });
        return;
      }
      this.onPromptText(content, main, uuid, emit);
      return;
    }
    if (!Array.isArray(content)) {
      emit(uuid, "prompt", {});
      return;
    }
    const blocks = content.filter(isObj);
    const result = blocks.find((b) => b.type === "tool_result");
    if (result) {
      const toolUseId = str(result.tool_use_id);
      const tur = isObj(o.toolUseResult) ? o.toolUseResult : {};
      const agentId = str(tur.agentId);
      if (toolUseId && agentId) this.agentIdByToolUse.set(toolUseId, agentId);
      emit(uuid, "tool_result", { toolUseId, isError: result.is_error === true });
      return;
    }
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => str(b.text) ?? "")
      .join("\n");
    this.onPromptText(text, main, uuid, emit);
  }

  private onPromptText(text: string, main: boolean, uuid: string, emit: (id: string, k: EventKind, d: Json) => void): void {
    emit(uuid, "prompt", clipText(text, this.textMax));
    if (main && !this.firstPrompt) {
      const title = toTitle(text);
      if (title) this.firstPrompt = { title, source: "prompt" };
    }
  }

  private onAssistant(o: Json, main: boolean, uuid: string, emit: (id: string, k: EventKind, d: Json) => void): void {
    const msg = isObj(o.message) ? o.message : {};
    const model = str(msg.model);
    if (model && model !== "<synthetic>") this.models.add(model);
    const usage = usageOf(msg.usage);
    if (usage) {
      this.usageByMessage.set(str(msg.id) ?? `uuid:${uuid}`, usage);
      // UX-A Punkt 6 (Kontext-Ring springt): NUR die Haupt-Session-Zeilen (`origin.agentId ===
      // undefined`, s. `push()`) bestimmen `lastUsage`/`lastUsageModel` — ein Sub-Agent führt seine
      // EIGENE, unabhängige Unterhaltung mit eigenem, meist viel kleinerem Kontextfenster-Füllstand.
      // Vorher lieferte JEDE Assistant-Zeile (auch aus `subagents/agent-<id>.jsonl`) hier den
      // "letzten" Wert — je nachdem, in welcher Reihenfolge Haupt- und Sub-Agent-Zeilen eintrafen,
      // sprang der Ring dadurch zwischen Haupt- und Sub-Agent-Füllstand (z. B. 42 → 19 → 54 → 15 %).
      if (main) {
        this.lastUsage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheCreation: usage.cacheCreation };
        this.lastUsageModel = model && model !== "<synthetic>" ? model : this.lastUsageModel;
      }
    }

    // Live tokens of a sub-agent: usage, message id and model on the FIRST event of this line (the server sums per
    // agent, per `msgId` only the largest value). Not for main-session lines: their tokens come via the summary.
    const extra: Json =
      !main && usage
        ? {
            usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheCreation: usage.cacheCreation },
            msgId: str(msg.id) ?? null,
            ...(model && model !== "<synthetic>" ? { model } : {}),
          }
        : {};

    const content = msg.content;
    if (typeof content === "string") {
      emit(uuid, "assistant", { ...clipText(content, this.textMax), ...extra });
      return;
    }
    if (!Array.isArray(content) || content.length === 0) {
      emit(uuid, "assistant", { ...extra });
      return;
    }
    content.forEach((raw, i) => {
      const id = i === 0 ? uuid : `${uuid}#${i}`;
      const b = isObj(raw) ? raw : {};
      const first = i === 0 ? extra : {};
      if (b.type === "tool_use") emit(id, "tool_call", { ...this.onToolUse(b), ...first });
      else if (b.type === "thinking" || b.type === "redacted_thinking") emit(id, "thinking", { ...first });
      else emit(id, "assistant", { ...clipText(str(b.text) ?? "", this.textMax), ...first });
    });
  }

  private onToolUse(b: Json): Json {
    const name = str(b.name) ?? "unbekannt";
    const toolUseId = str(b.id);
    const input = isObj(b.input) ? b.input : {};
    this.toolCalls.inc(name);
    const path = str(input.file_path) ?? str(input.notebook_path);
    if (WRITE_TOOLS.has(name)) this.filesWritten.add(path);
    if (READ_TOOLS.has(name)) this.filesRead.add(path);
    if (AGENT_TOOLS.has(name) && toolUseId) {
      this.agentCalls.set(toolUseId, { name: str(input.description), type: str(input.subagent_type) });
    }
    // Skill-Aufrufe (Parameter `skill`, kein `file_path`/`command`/…) — Grundlage der Sortier-Regel
    // "genutzter Skill". Ohne diesen Sonderfall bleibt `target` null (siehe SORTIER-BEFUND.md).
    // auch die ältere Form `command` und „/name“ ergeben den Namen (sonst zählt die Nutzung nie).
    const target = name === "Skill" ? (skillKeyFrom(input.skill) ?? skillKeyFrom(input.command)) : toolTarget(input);
    // The final report of a background agent is ONLY here (`SubagentHandback({ message })`) — pass it on as text so
    // the "result" in the chat is right live (otherwise only via the archive digest, delayed).
    if (name === "SubagentHandback") {
      const message = str(input.message);
      if (message) return { name, toolUseId, target: null, ...clipText(message, this.textMax) };
    }
    return { name, toolUseId, target };
  }

  private subagents(): SubagentInfo[] {
    const out: SubagentInfo[] = [];
    const seen = new Set<string>();
    for (const [toolUseId, call] of this.agentCalls) {
      const id = this.agentIdByToolUse.get(toolUseId) ?? toolUseId;
      const meta = this.subagentMeta.get(id);
      out.push({ id, name: call.name ?? meta?.description ?? null, type: call.type ?? meta?.agentType ?? null });
      seen.add(id);
    }
    for (const [agentId, meta] of this.subagentMeta) {
      if (seen.has(agentId)) continue;
      out.push({ id: agentId, name: meta.description ?? null, type: meta.agentType ?? null });
    }
    return out;
  }

  summary(): SessionSummary {
    const tokens = emptyTokens();
    for (const u of this.usageByMessage.values()) {
      tokens.input += u.input;
      tokens.output += u.output;
      tokens.cacheRead += u.cacheRead;
      tokens.cacheCreation += u.cacheCreation;
      tokens.reasoning += u.reasoning;
      tokens.total += u.total;
    }
    let title: string | null = null;
    let titleSource: SessionSummary["titleSource"] = null;
    if (this.customTitle) [title, titleSource] = [toTitle(this.customTitle), "custom"];
    else if (this.aiTitle) [title, titleSource] = [toTitle(this.aiTitle), "ai"];
    else if (this.summaryTitle) [title, titleSource] = [toTitle(this.summaryTitle), "summary"];
    else if (this.firstPrompt) [title, titleSource] = [this.firstPrompt.title, this.firstPrompt.source];

    return {
      tool: "claude",
      sessionId: this.sessionId,
      parentSessionId: null,
      cwd: this.cwd,
      title,
      titleSource,
      startedAt: this.range.first,
      lastActivityAt: this.range.last,
      models: this.models.toArray(),
      tokens,
      toolCalls: this.toolCalls.toObject(),
      filesWritten: this.filesWritten.toArray(),
      filesRead: this.filesRead.toArray(),
      subagents: this.subagents(),
      gitBranch: this.gitBranch,
      cliVersion: this.cliVersion,
      eventCount: this.eventCount,
      parseErrors: this.parseErrors,
      limits: this.lastQuotaLimit,
      lastUsage: this.lastUsage,
      lastUsageModel: this.lastUsageModel,
      modelContextWindow: null, // Claude meldet kein Kontextfenster im Verlauf (anders als Codex).
    };
  }
}
