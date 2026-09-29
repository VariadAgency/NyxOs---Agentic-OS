// Motor für Rollen mit Fremd-Anbieter (OpenAI-kompatibel oder Anthropic-API). Dieselbe Schnittstelle
// wie der Claude-Programm-Motor (`HaikuEngine`), dieselben Werkzeuge: Nyx-Werkzeuge laufen direkt über
// `req.callTool` (scope-geprüft wie `/haiku-mcp`), eingeschaltete Konnektoren (Adresse, nicht Befehl) über den
// kleinen MCP-Client. Werkzeug-Namen der Konnektoren: `<konnektor>__<werkzeug>` (Anbieter erlauben nur [A-Za-z0-9_-]).
import { t } from "@nyxos/shared";
import type { ResolvedModel } from "@nyxos/shared";
import { EngineTimeoutError, type EngineAvailability, type EngineEvent, type EngineRequest, type HaikuEngine } from "../haiku/engine.js";
import { McpClient, type McpServerSpec } from "../mcp/client.js";
import { ProviderError, chatRound, type ChatMessage, type ChatTool, type ProviderEndpoint } from "./chat.js";

export const MAX_TOOL_ROUNDS = 8;

/** Konnektor antwortet nicht → 30 s auslassen, bei jedem weiteren Fehler doppelt so lange, höchstens 10 Min. */
export class ConnectorBackoff {
  private readonly state = new Map<string, { until: number; delay: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  ready(name: string): boolean {
    return (this.state.get(name)?.until ?? 0) <= this.now();
  }
  fail(name: string): void {
    const delay = Math.min((this.state.get(name)?.delay ?? 15_000) * 2, 600_000);
    this.state.set(name, { until: this.now() + delay, delay });
  }
  ok(name: string): void {
    this.state.delete(name);
  }
}
const backoff = new ConnectorBackoff();

export function connectorToolName(connector: string, tool: string): string {
  return `${connector}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export interface ProviderEngineOptions {
  resolved: Extract<ResolvedModel, { source: "provider" }>;
  endpoint: () => Promise<ProviderEndpoint>;
  /** Tests: eigener MCP-Verbindungsaufbau. */
  connect?: (spec: McpServerSpec) => Promise<McpClient>;
}

export class ProviderEngine implements HaikuEngine {
  readonly kind = "api" as const;
  constructor(private readonly o: ProviderEngineOptions) {}

  async available(): Promise<EngineAvailability> {
    try {
      await this.o.endpoint();
      return { ok: true, state: "ready", reason: null, model: this.o.resolved.model };
    } catch (e) {
      return { ok: false, state: "error", reason: e instanceof ProviderError ? e.message : t("Der gewählte Anbieter ist gerade nicht nutzbar."), model: this.o.resolved.model };
    }
  }

  async *run(req: EngineRequest): AsyncIterable<EngineEvent> {
    const ep = await this.o.endpoint();
    const deadline = Date.now() + req.timeoutMs;
    const tools: ChatTool[] = req.toolDefs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const route = new Map<string, { client: McpClient; tool: string }>();
    const clients: McpClient[] = [];
    // Nur Konnektoren mit Adresse: Befehle (stdio) laufen nie im API-Container.
    for (const spec of (req.mcpServers ?? []).filter((s) => s.transport !== "stdio" && backoff.ready(s.name))) {
      try {
        const client = await (this.o.connect ?? ((s) => McpClient.connect(s, { timeoutMs: 15_000 })))(spec);
        clients.push(client);
        backoff.ok(spec.name);
        for (const t of await client.listTools()) {
          if (spec.allowedTools && !spec.allowedTools.includes(t.name)) continue;
          const name = connectorToolName(spec.name, t.name);
          if (route.has(name) || tools.some((x) => x.name === name)) continue;
          route.set(name, { client, tool: t.name });
          tools.push({ name, description: `[${spec.name}] ${t.description ?? t.name}`.slice(0, 1000), inputSchema: t.inputSchema });
        }
      } catch {
        // Ein Konnektor, der nicht antwortet, hält Nyx nicht auf – und wird eine Weile ausgelassen (30 s → 10 Min).
        backoff.fail(spec.name);
      }
    }
    const messages: ChatMessage[] = [{ role: "user", content: req.prompt }];
    let input = 0;
    let output = 0;
    let finalText = "";
    let model = this.o.resolved.model;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new EngineTimeoutError(req.timeoutMs);
        let r;
        try {
          r = await chatRound(ep, { model: this.o.resolved.model, system: req.systemPrompt, messages, tools: tools.length ? tools : undefined, timeoutMs: remaining, signal: req.signal });
        } catch (e) {
          if (Date.now() >= deadline) throw new EngineTimeoutError(req.timeoutMs);
          throw e;
        }
        input += r.usage.inputTokens;
        output += r.usage.outputTokens;
        model = r.model;
        if (r.text) {
          finalText += r.text;
          yield { type: "delta", text: r.text };
        }
        if (r.stop !== "tool" || r.toolCalls.length === 0 || round === MAX_TOOL_ROUNDS) break;
        messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
        for (const call of r.toolCalls) {
          const via = route.get(call.name);
          yield { type: "tool", name: via ? `${call.name}` : call.name };
          let content: string;
          let isError = false;
          try {
            if (via) {
              // (9): Werkzeug-Aufrufe halten die Frist des Laufs ein (höchstens 120 s).
              const out = await via.client.callTool(via.tool, call.arguments, Math.max(1_000, Math.min(120_000, deadline - Date.now())));
              content = out.text;
              isError = out.isError;
            } else content = JSON.stringify(await req.callTool(call.name, call.arguments ?? {}));
          } catch (e) {
            content = JSON.stringify({ fehler: e instanceof Error ? e.message : String(e) });
            isError = true;
          }
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: content.slice(0, 20_000), isError });
        }
      }
    } finally {
      for (const c of clients) c.close();
    }
    // Kosten der Fremd-Anbieter sind hier unbekannt (0) – die Token-Zahlen stimmen.
    yield { type: "result", text: finalText, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, costUsd: 0 }, model, sessionId: null, isError: false, error: null };
  }
}
