// Motor "claude-cli": offizielles `claude`-CLI im Druck-Modus (`-p`), Modell Haiku, Werkzeuge NUR
// über den MCP-Server "nyxos" (unsere Brücke `mcpProxy.ts` → `/haiku-mcp/*`). Keine eingebauten
// Werkzeuge (`--tools ""`), keine Benutzer-/Projekt-Einstellungen (`--setting-sources ""` → auch keine
// Hooks der Brücke, Haiku-Läufe tauchen also nicht als Session auf), fester, leerer Arbeitsordner.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerSpec } from "../mcp/client.js";
import { ENGINE_REASON, EngineTimeoutError, mcpToolName, MCP_SERVER_NAME, type EngineAvailability, type EngineEvent, type EngineRequest, type EngineUsage, type HaikuEngine } from "./engine.js";
import { t } from "@nyxos/shared";

export interface McpCommand {
  command: string;
  args: string[];
}

/** Wie der MCP-Proxy gestartet wird: im gebauten Server `node dist/haiku-mcp.js`, in der Entwicklung
 * (tsx) die TypeScript-Quelle über das tsx-Binary des Repos. */
export function defaultMcpCommand(): McpCommand {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "haiku-mcp.js");
  if (existsSync(built)) return { command: process.execPath, args: [built] };
  const src = join(here, "mcpProxy.ts");
  // apps/server/src/haiku → Repo-Wurzel
  const tsx = join(here, "..", "..", "..", "..", "node_modules", ".bin", "tsx");
  return { command: tsx, args: [src] };
}

/** Konnektoren als Einträge für `--mcp-config` (Kopfzeilen/Umgebung enthalten die Token – nur im Speicher). */
export function connectorMcpConfig(servers: McpServerSpec[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    if (s.name === MCP_SERVER_NAME) continue;
    if (s.transport === "stdio") out[s.name] = { type: "stdio", command: s.command ?? "", args: s.args ?? [], env: s.env ?? {} };
    else out[s.name] = { type: s.transport, url: s.url ?? "", headers: s.headers ?? {} };
  }
  return out;
}

export interface ClaudeCliOptions {
  bin?: string;
  model?: string;
  /** Basis-URL der NyxOS-API, wie der MCP-Proxy sie erreicht (lokal `http://127.0.0.1:<port>`). */
  apiUrl: string | (() => string);
  mcp?: McpCommand;
  /** Arbeitsordner-Wurzel; je Werkzeug-Umfang ein fester Unterordner (nötig für `--resume`). */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Umgebung für das CLI: nur, was es braucht. Nie die Auftrags-Kennung einer Arbeiter-Session erben. */
function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "XDG_CONFIG_HOME", "NODE_EXTRA_CA_CERTS"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

export function parseUsage(u: unknown, cost: unknown): EngineUsage {
  const o = (u ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(o.input_tokens) + n(o.cache_creation_input_tokens),
    outputTokens: n(o.output_tokens),
    cacheReadTokens: n(o.cache_read_input_tokens),
    costUsd: n(cost),
  };
}

/** Übersetzt eine Zeile aus `--output-format stream-json` in 0–1 Motor-Ereignisse. */
export function translateStreamLine(line: string, state: { model: string | null; sessionId: string | null; contextTokens?: number | null }): EngineEvent[] {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = d.type;
  if (type === "system" && d.subtype === "init") {
    state.sessionId = typeof d.session_id === "string" ? d.session_id : state.sessionId;
    state.model = typeof d.model === "string" ? d.model : state.model;
    return state.sessionId ? [{ type: "session", sessionId: state.sessionId, model: state.model }] : [];
  }
  if (type === "stream_event") {
    const e = d.event as Record<string, unknown> | undefined;
    const delta = e?.delta as Record<string, unknown> | undefined;
    if (e?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") return [{ type: "delta", text: delta.text }];
    return [];
  }
  if (type === "assistant") {
    const message = d.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? []) as Record<string, unknown>[];
    // Kontextgröße der jeweils letzten Runde merken (Eingabe inkl. Cache) — die Summe im Ergebnis zählt
    // bei Werkzeug-Runden jede Runde einzeln und überzeichnet den Kontext.
    if (message?.usage && typeof message.usage === "object") {
      const u = parseUsage(message.usage, 0);
      const ctx = u.inputTokens + u.cacheReadTokens;
      if (ctx > 0) state.contextTokens = ctx;
    }
    const out: EngineEvent[] = [];
    for (const c of content) {
      if (c.type === "tool_use" && typeof c.name === "string") out.push({ type: "tool", name: c.name.replace(`mcp__${MCP_SERVER_NAME}__`, "") });
    }
    return out;
  }
  if (type === "result") {
    const isError = d.is_error === true || (typeof d.subtype === "string" && d.subtype !== "success");
    const models = d.modelUsage && typeof d.modelUsage === "object" ? Object.keys(d.modelUsage as object) : [];
    return [
      {
        type: "result",
        text: typeof d.result === "string" ? d.result : "",
        usage: { ...parseUsage(d.usage, d.total_cost_usd), contextTokens: state.contextTokens ?? null },
        model: models[0] ?? state.model,
        models: [...new Set([...(state.model ? [state.model] : []), ...models])],
        sessionId: typeof d.session_id === "string" ? d.session_id : state.sessionId,
        isError,
        error: isError ? String(d.result ?? d.subtype ?? t("Fehler")) : null,
      },
    ];
  }
  return [];
}

/** Kleinste Token-Grenze, die das Claude-Programm bekommt (s. `envFor`). */

export class ClaudeCliEngine implements HaikuEngine {
  readonly kind = "claude-cli" as const;
  private readonly bin: string;
  private readonly model: string;
  private readonly mcp: McpCommand;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private availability: { at: number; value: EngineAvailability } | null = null;

  constructor(private readonly opts: ClaudeCliOptions) {
    this.bin = opts.bin ?? process.env.CLAUDE_BIN ?? "claude";
    this.model = opts.model ?? process.env.NYXOS_HAIKU_MODEL ?? "haiku";
    this.mcp = opts.mcp ?? defaultMcpCommand();
    this.homeDir = opts.homeDir ?? process.env.NYXOS_HAIKU_HOME ?? join(tmpdir(), "nyxos-haiku");
    this.env = opts.env ?? process.env;
  }

  /** Prüft einmal je 5 Min, ob das CLI da ist (`claude --version`). Anmeldung prüft erst der echte Lauf.
   * Fehlt es, bleibt das Ergebnis nur 30 s gültig (nach einer Installation schnell wieder „bereit“). */
  async available(): Promise<EngineAvailability> {
    if (this.availability && Date.now() - this.availability.at < (this.availability.value.ok ? 300_000 : 30_000)) return this.availability.value;
    const value = await new Promise<EngineAvailability>((resolve) => {
      const child = spawn(this.bin, ["--version"], { env: childEnv(this.env), stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (b: Buffer) => {
        if (out.length < 200) out += b.toString("utf8");
      });
      child.on("error", () => resolve({ ok: false, state: "waiting_token", reason: t(ENGINE_REASON.cliMissingLocal), model: this.model, version: null }));
      child.on("close", (code) => {
        const version = /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
        resolve(code === 0 ? { ok: true, state: "ready", reason: null, model: this.model, version } : { ok: false, state: "error", reason: t(ENGINE_REASON.cliBroken), model: this.model, version });
      });
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    });
    this.availability = { at: Date.now(), value };
    return value;
  }

  /** Inhalt für `--mcp-config` (enthält Konnektor-Token und Lauf-Token – nur als 0600-Datei weitergeben, s. `run`). */
  mcpConfig(req: EngineRequest): { mcpServers: Record<string, unknown> } {
    return {
      mcpServers: {
        // eingeschaltete Konnektoren zuerst, „nyxos“ zuletzt (kann nie überschrieben werden).
        ...connectorMcpConfig(req.mcpServers ?? []),
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: this.mcp.command,
          args: this.mcp.args,
          env: { NYXOS_API_URL: typeof this.opts.apiUrl === "function" ? this.opts.apiUrl() : this.opts.apiUrl, NYXOS_HAIKU_RUN_TOKEN: req.runToken },
        },
      },
    };
  }

  /** (3): `--mcp-config` bekommt einen DATEIPFAD – Token in der Befehlszeile sähe jeder Prozess (ps, /proc). */
  buildArgs(req: EngineRequest, mcpConfigPath: string): string[] {
    const args = [
      "-p",
      "--model",
      req.model ?? this.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--permission-mode",
      "dontAsk",
      "--system-prompt",
      req.systemPrompt,
    ];
    const allowed = [...req.tools.map(mcpToolName), ...(req.mcpServers ?? []).filter((m) => m.name !== MCP_SERVER_NAME).flatMap((m) => (m.allowedTools ? m.allowedTools.map((tool) => `mcp__${m.name}__${tool}`) : [`mcp__${m.name}`]))];
    if (req.effort) args.push("--effort", req.effort);
    if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    return args;
  }

  workDir(scope: string): string {
    const dir = join(this.homeDir, scope);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Umgebung eines Laufs: `thinking: false` schaltet die Denkpause des CLI ab (nur für diesen Lauf). */
  envFor(req: Pick<EngineRequest, "thinking" | "maxTokens">): NodeJS.ProcessEnv {
    const env = childEnv(this.env);
    if (req.thinking === false) env.MAX_THINKING_TOKENS = "0";
    // (Live-Fund „Nyx bricht lange Antworten ab“): KEINE Token-Grenze mehr ans Claude-Programm. Mit
    // `CLAUDE_CODE_MAX_OUTPUT_TOKENS` brach es ab („exceeded the … output token maximum“) oder setzte in einer
    // neuen Nachricht fort – dann enthielt das Ergebnis nur das letzte Teilstück (Antwort begann mitten im Satz).
    // Die Länge steuert der Prompt (Längen-Regler); der API-Motor behält `max_tokens` als Sicherheitsgrenze.
    void req.maxTokens;
    return env;
  }

  async *run(req: EngineRequest): AsyncIterable<EngineEvent> {
    // Eigenes 0700-Verzeichnis je Lauf, Datei 0600; wird am Ende des Laufs gelöscht.
    const cfgDir = mkdtempSync(join(tmpdir(), "nyx-mcp-"));
    const cfgPath = join(cfgDir, "mcp.json");
    writeFileSync(cfgPath, JSON.stringify(this.mcpConfig(req)), { mode: 0o600 });
    const child = spawn(this.bin, this.buildArgs(req, cfgPath), {
      cwd: this.workDir(req.scope),
      env: this.envFor(req),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Frage über stdin, nie als Argument (eine Nachricht, die mit "-" beginnt, wäre sonst eine Option).
    child.stdin.end(req.prompt);

    const queue: EngineEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: Error | null = null;
    let stderr = "";
    let buf = "";
    let gotResult = false;
    const state = { model: null as string | null, sessionId: null as string | null };
    const push = (e: EngineEvent) => {
      if (e.type === "result") gotResult = true;
      queue.push(e);
      wake?.();
    };

    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) for (const e of translateStreamLine(line, state)) push(e);
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < 4000) stderr += b.toString("utf8");
    });
    const kill = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2000).unref();
    };
    const timer = setTimeout(() => {
      failure = new EngineTimeoutError(req.timeoutMs);
      kill();
    }, req.timeoutMs);
    const onAbort = () => {
      failure = failure ?? new Error("abgebrochen");
      kill();
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      failure = failure ?? e;
      finished = true;
      wake?.();
    });
    child.on("close", (code) => {
      if (buf.trim()) for (const e of translateStreamLine(buf.trim(), state)) push(e);
      if (!gotResult && !failure) failure = new Error(stderr ? t("claude endete mit Code {code}: {stderr}", { code, stderr: stderr.trim().slice(0, 300) }) : t("claude endete mit Code {code}", { code }));
      finished = true;
      wake?.();
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as EngineEvent;
          continue;
        }
        if (finished) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      if (failure) throw failure;
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      kill();
      rmSync(cfgDir, { recursive: true, force: true });
    }
  }
}

/** Wo das CLI seine Anmeldung hat (nur zur Anzeige in `HAIKU-BEFUND.md`/Status, nie der Inhalt). */
export function claudeCredentialHint(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN (setup-token)";
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  return existsSync(join(homedir(), ".claude")) ? t("Anmeldung des Benutzers (~/.claude bzw. Schlüsselbund)") : t("keine Anmeldung gefunden");
}
