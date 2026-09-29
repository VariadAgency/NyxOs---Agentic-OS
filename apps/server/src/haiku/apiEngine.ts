// Reserve-Motor: ein Anthropic-kompatibles Modell per API-Schlüssel (z. B. MiniMax, das die
// Messages-API nachbildet). Muster: claude-code-router (MIT) – "Routing/Fallback über eine Schnittstelle";
// kein Code übernommen. Ohne Schlüssel ist der Motor AUS (available().ok = false), nichts wird vorgetäuscht.
// Werkzeuge laufen hier ohne MCP direkt über `req.callTool` – derselbe scope-geprüfte Weg wie `/haiku-mcp`.
import { pruneOldToolResults } from "../nyx/compaction.js";
import { EngineTimeoutError, type EngineAvailability, type EngineEvent, type EngineRequest, type EngineUsage, type HaikuEngine } from "./engine.js";
import { t } from "@nyxos/shared";

export interface ApiEngineOptions {
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  /** Kosten je 1 Mio. Token (Eingabe/Ausgabe) für die Budget-Rechnung; ohne Angabe 0 (unbekannt). */
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  fetchImpl?: typeof fetch;
  maxToolRounds?: number;
}

/** ab so vielen Zeichen Verlauf (≈ 20 Tsd. Tokens) werden alte Werkzeug-Ausgaben geleert. */
export const API_CONTEXT_CHARS = 80_000;

export function apiEngineFromEnv(env: NodeJS.ProcessEnv = process.env): ApiEngine {
  return new ApiEngine({
    apiKey: env.NYXOS_HAIKU_API_KEY?.trim() || null,
    baseUrl: env.NYXOS_HAIKU_API_BASE_URL?.trim() || null,
    model: env.NYXOS_HAIKU_API_MODEL?.trim() || null,
    priceInPerMTok: Number(env.NYXOS_HAIKU_API_PRICE_IN ?? 0) || 0,
    priceOutPerMTok: Number(env.NYXOS_HAIKU_API_PRICE_OUT ?? 0) || 0,
  });
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export class ApiEngine implements HaikuEngine {
  readonly kind = "api" as const;
  constructor(private readonly opts: ApiEngineOptions) {}

  get configured(): boolean {
    return !!(this.opts.apiKey && this.opts.baseUrl && this.opts.model);
  }

  get publicInfo(): { configured: boolean; baseUrl: string | null; model: string | null } {
    return { configured: this.configured, baseUrl: this.opts.baseUrl, model: this.opts.model };
  }

  async available(): Promise<EngineAvailability> {
    if (!this.configured) return { ok: false, reason: t("Kein API-Schlüssel hinterlegt (NYXOS_HAIKU_API_KEY/_BASE_URL/_MODEL)"), model: this.opts.model };
    return { ok: true, reason: null, model: this.opts.model };
  }

  async *run(req: EngineRequest): AsyncIterable<EngineEvent> {
    if (!this.configured) throw new Error(t("Reserve-Motor nicht eingerichtet"));
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = `${(this.opts.baseUrl ?? "").replace(/\/+$/, "")}/v1/messages`;
    const usage: EngineUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: req.prompt }];
    const tools = req.toolDefs.map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema }));
    const deadline = Date.now() + req.timeoutMs;
    let finalText = "";
    const rounds = this.opts.maxToolRounds ?? 6;
    for (let round = 0; round <= rounds; round++) {
      // Verdichtung Phase 1 (Hermes): wächst der Verlauf über das Budget, alte Werkzeug-Ausgaben leeren.
      pruneOldToolResults(messages, { maxChars: API_CONTEXT_CHARS, keepLast: 1 });
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new EngineTimeoutError(req.timeoutMs);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), remaining);
      const onAbort = () => ctrl.abort();
      req.signal.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey ?? "", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: this.opts.model, max_tokens: req.maxTokens ?? 2048, system: req.systemPrompt, messages, ...(tools.length ? { tools } : {}) }),
        });
      } catch (e) {
        if (Date.now() >= deadline) throw new EngineTimeoutError(req.timeoutMs);
        throw e;
      } finally {
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
      }
      if (!res.ok) throw new Error(`Reserve-Motor antwortete ${res.status}`);
      const body = (await res.json()) as { content?: ContentBlock[]; usage?: Record<string, number>; model?: string; stop_reason?: string };
      usage.inputTokens += body.usage?.input_tokens ?? 0;
      usage.outputTokens += body.usage?.output_tokens ?? 0;
      usage.cacheReadTokens += body.usage?.cache_read_input_tokens ?? 0;
      const content = body.content ?? [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      if (text) {
        finalText += text;
        yield { type: "delta", text };
      }
      const toolUses = content.filter((c) => c.type === "tool_use");
      if (toolUses.length === 0 || body.stop_reason !== "tool_use") break;
      messages.push({ role: "assistant", content });
      const results: unknown[] = [];
      for (const tu of toolUses) {
        yield { type: "tool", name: tu.name ?? "?" };
        let out: unknown;
        let isError = false;
        try {
          out = await req.callTool(tu.name ?? "", tu.input ?? {});
        } catch (e) {
          out = { fehler: e instanceof Error ? e.message : String(e) };
          isError = true;
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 20_000), is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }
    usage.costUsd = (usage.inputTokens * (this.opts.priceInPerMTok ?? 0) + usage.outputTokens * (this.opts.priceOutPerMTok ?? 0)) / 1_000_000;
    yield { type: "result", text: finalText, usage, model: this.opts.model, sessionId: null, isError: false, error: null };
  }
}
