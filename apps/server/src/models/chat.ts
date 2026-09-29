// Schlanker Chat-Client für Fremd-Anbieter: OpenAI-kompatibel (Chat Completions – OpenAI,
// OpenRouter, Gemini, Mistral, Groq, xAI, DeepSeek, Ollama, LM Studio, eigene Endpunkte) und Anthropic
// (Messages). Nur `fetch`, kein SDK. Mit Werkzeug-Aufrufen (tool calls) in beide Richtungen.
// Muster: claude-code-router (MIT) – „ein Format innen, je Anbieter übersetzen“; kein Code übernommen.
import { t } from "@nyxos/shared";
import type { ProviderApi, ProviderModel } from "@nyxos/shared";
import { UnsafeUrlError } from "../net/safeFetch.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderEndpoint {
  api: ProviderApi;
  baseUrl: string;
  apiKey: string | null;
  /** Für Tests und den Weg über die Brücke. */
  fetchImpl?: typeof fetch;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  /** "tool" = das Modell will Werkzeuge, sonst fertig. */
  stop: "end" | "tool" | "length";
}

/** Fehler mit einfachen Worten (UI/Chat zeigen `message`). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export function providerHttpMessage(status: number): string {
  if (status === 401 || status === 403) return t("Der Schlüssel wurde abgelehnt – bitte prüfen oder neu eintragen.");
  if (status === 404) return t("Diese Adresse oder dieses Modell gibt es beim Anbieter nicht.");
  if (status === 402 || status === 429) return t("Zu viele Anfragen oder kein Guthaben mehr beim Anbieter.");
  if (status >= 500) return t("Der Anbieter hat gerade Probleme – später nochmal versuchen.");
  return t("Der Anbieter hat die Anfrage abgelehnt ({status}).", { status });
}

function netError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof UnsafeUrlError) return new ProviderError(e.message);
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return new ProviderError(t("Keine Antwort in der Zeit – läuft der Dienst?"));
  return new ProviderError(t("Nicht erreichbar – stimmt die Adresse? Läuft der Dienst?"));
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** Anthropic: API-Schlüssel (`x-api-key`) oder OAuth-Token aus `claude setup-token` (Bearer + Beta-Kopf). */
export function anthropicHeaders(apiKey: string | null): Record<string, string> {
  const h: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (!apiKey) return h;
  if (apiKey.startsWith("sk-ant-oat")) return { ...h, authorization: `Bearer ${apiKey}`, "anthropic-beta": "oauth-2025-04-20" };
  return { ...h, "x-api-key": apiKey };
}

function openaiHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** Anthropic-Basis kann mit oder ohne `/v1` eingetragen sein. */
function anthropicUrl(base: string, path: string): string {
  const b = trimSlash(base);
  return b.endsWith("/v1") ? `${b}${path}` : `${b}/v1${path}`;
}

async function send(ep: ProviderEndpoint, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const fetchImpl = ep.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(timeoutMs);
  const s = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: s });
  } catch (e) {
    throw netError(e);
  }
  if (!res.ok) throw new ProviderError(providerHttpMessage(res.status), res.status);
  try {
    return await res.json();
  } catch {
    throw new ProviderError(t("Der Anbieter hat unverständlich geantwortet."));
  }
}

/** Modell-Liste laden (OpenAI: `GET /models`, Anthropic: `GET /v1/models`, Ollama/LM Studio: dasselbe über /v1). */
/** OpenAI-kompatible Einträge. OpenRouter liefert zusätzlich Kontext + Preise (USD pro Token als Text). */
interface OpenAiModelEntry {
  id?: string;
  name?: string;
  context_length?: number;
  context_window?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
}

/** USD pro Token → USD pro 1 Mio. Token (negativ/unsinnig → null; OpenRouter nennt „-1“ für variable Preise). */
function perMTok(v: string | number | undefined): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 10_000) / 10_000 : null;
}

function toProviderModel(m: OpenAiModelEntry): ProviderModel {
  const context = typeof m.context_length === "number" ? m.context_length : typeof m.context_window === "number" ? m.context_window : null;
  const out: ProviderModel = { id: m.id as string, label: m.name ?? null };
  if (context) out.context = context;
  if (m.pricing) {
    out.priceIn = perMTok(m.pricing.prompt);
    out.priceOut = perMTok(m.pricing.completion);
  }
  return out;
}

export async function listModels(ep: ProviderEndpoint, timeoutMs = 15_000): Promise<ProviderModel[]> {
  if (!ep.baseUrl) throw new ProviderError(t("Keine Adresse eingetragen."));
  if (ep.api === "anthropic") {
    const body = (await send(ep, anthropicUrl(ep.baseUrl, "/models?limit=100"), { headers: anthropicHeaders(ep.apiKey) }, timeoutMs)) as { data?: { id?: string; display_name?: string; max_input_tokens?: number }[] };
    // Anthropic nennt seit 2026 das Kontextfenster (`max_input_tokens`).
    return (body.data ?? []).filter((m) => typeof m.id === "string").map((m) => ({ id: m.id as string, label: m.display_name ?? null, context: typeof m.max_input_tokens === "number" ? m.max_input_tokens : null }));
  }
  const body = (await send(ep, `${trimSlash(ep.baseUrl)}/models`, { headers: openaiHeaders(ep.apiKey) }, timeoutMs)) as { data?: OpenAiModelEntry[]; models?: { name?: string; model?: string }[] };
  const list = (body.data ?? []).filter((m) => typeof m.id === "string").map(toProviderModel);
  if (list.length) return list;
  // Ollama ohne /v1 (`/api/tags`) liefert `models` – falls jemand die Basis ohne /v1 einträgt.
  return (body.models ?? []).map((m) => ({ id: String(m.model ?? m.name ?? ""), label: m.name ?? null })).filter((m) => m.id);
}

// ─── Übersetzung ───

function toOpenAi(req: ChatRequest) {
  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "user") messages.push({ role: "user", content: m.content });
    else if (m.role === "assistant")
      messages.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) } : {}),
      });
    else messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? 2048,
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
  };
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function fromOpenAi(body: unknown, model: string): ChatResult {
  const b = body as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
  const choice = b.choices?.[0];
  if (!choice) throw new ProviderError(t("Der Anbieter hat keine Antwort geliefert."));
  const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? []).map((t, i) => ({ id: t.id ?? `call_${i}`, name: t.function?.name ?? "", arguments: parseArgs(t.function?.arguments) }));
  return {
    text: choice.message?.content ?? "",
    toolCalls,
    usage: { inputTokens: b.usage?.prompt_tokens ?? 0, outputTokens: b.usage?.completion_tokens ?? 0 },
    model: b.model ?? model,
    stop: toolCalls.length ? "tool" : choice.finish_reason === "length" ? "length" : "end",
  };
}

function toAnthropic(req: ChatRequest) {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const m of req.messages) {
    if (m.role === "user") messages.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const content: Record<string, unknown>[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const t of m.toolCalls ?? []) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.arguments ?? {} });
      messages.push({ role: "assistant", content });
    } else {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = messages[messages.length - 1];
      // Mehrere Werkzeug-Ergebnisse gehören in EINE Nutzer-Nachricht.
      if (last?.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
      else messages.push({ role: "user", content: [block] });
    }
  }
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 2048,
    ...(req.system ? { system: req.system } : {}),
    messages,
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
  };
}

function fromAnthropic(body: unknown, model: string): ChatResult {
  const b = body as { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string; model?: string };
  const content = b.content ?? [];
  const toolCalls = content.filter((c) => c.type === "tool_use").map((c) => ({ id: c.id ?? "", name: c.name ?? "", arguments: c.input ?? {} }));
  return {
    text: content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join(""),
    toolCalls,
    usage: { inputTokens: b.usage?.input_tokens ?? 0, outputTokens: b.usage?.output_tokens ?? 0 },
    model: b.model ?? model,
    stop: toolCalls.length ? "tool" : b.stop_reason === "max_tokens" ? "length" : "end",
  };
}

/** Eine Modell-Runde (nicht streamend). Werkzeug-Schleife macht der Aufrufer (s. `providerEngine.ts`). */
export async function chatRound(ep: ProviderEndpoint, req: ChatRequest): Promise<ChatResult> {
  if (!ep.baseUrl) throw new ProviderError(t("Keine Adresse eingetragen."));
  const timeoutMs = req.timeoutMs ?? 120_000;
  if (ep.api === "anthropic") {
    const body = await send(ep, anthropicUrl(ep.baseUrl, "/messages"), { method: "POST", headers: { ...anthropicHeaders(ep.apiKey), "content-type": "application/json" }, body: JSON.stringify(toAnthropic(req)) }, timeoutMs, req.signal);
    return fromAnthropic(body, req.model);
  }
  const body = await send(ep, `${trimSlash(ep.baseUrl)}/chat/completions`, { method: "POST", headers: { ...openaiHeaders(ep.apiKey), "content-type": "application/json" }, body: JSON.stringify(toOpenAi(req)) }, timeoutMs, req.signal);
  return fromOpenAi(body, req.model);
}
