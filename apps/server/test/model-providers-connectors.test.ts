// Anbieter, Rollen (resolveModel, skills.create fest), Nyx-Motor mit Fremd-Anbieter (Werkzeuge +
// Konnektor), Konnektoren (HTTP, SSE, stdio, Anmeldung im Browser) – alles gegen Fake-Server, nie Klartext.
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { haikuCalls, modelRoles } from "../src/db/schema.js";
import { ClaudeCliEngine } from "../src/haiku/claudeCli.js";
import type { EngineAvailability, EngineEvent, EngineRequest, HaikuEngine } from "../src/haiku/engine.js";
import { HaikuRuntime } from "../src/haiku/runtime.js";
import { buildDefaultRegistry } from "../src/haiku/tools.js";
import { ModelService, roleForKind } from "../src/models/providers.js";
import type { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup, sharedDb } from "./helpers.js";

/** Fake-Claude-Programm: merkt sich die Läufe, antwortet sofort. */
class FakeEngine implements HaikuEngine {
  readonly kind = "claude-cli" as const;
  requests: EngineRequest[] = [];
  async available(): Promise<EngineAvailability> {
    return { ok: true, reason: null, model: "fake-haiku" };
  }
  async *run(req: EngineRequest): AsyncIterable<EngineEvent> {
    this.requests.push(req);
    yield { type: "result", text: "ok", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 }, model: "fake-haiku", sessionId: null, isError: false, error: null };
  }
}

const KEY = randomBytes(32).toString("base64");
const ENV = { NYXOS_SECRETS_KEY: KEY } as NodeJS.ProcessEnv;
const OPENAI_KEY = "sk-fake-openai-1234567890ABCD";
const ANTHROPIC_KEY = "sk-ant-api-fake-0987654321WXYZ";
const MCP_TOKEN = "mcp-token-secret-QQQQ";

// ─── Fake-Server: OpenAI-kompatibel, Anthropic, MCP (HTTP, SSE, OAuth) ───

type Json = Record<string, unknown>;
const fake = {
  base: "",
  openaiScript: [] as Json[],
  openaiRequests: [] as Json[],
  anthropicScript: [] as Json[],
  anthropicRequests: [] as Json[],
  mcpCalls: [] as { name: string; args: unknown }[],
  sseClients: new Map<string, ServerResponse>(),
  oauth: { challenge: "", clientId: "client-nyx", access: "oauth-access-1" },
  devicePolls: 0,
};
let server: Server;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function mcpAnswer(msg: Json): Json | null {
  if (msg.id === undefined) return null;
  if (msg.method === "initialize") return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } };
  if (msg.method === "tools/list") return { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "bild_machen", description: "Erzeugt ein Bild", inputSchema: { type: "object", properties: { prompt: { type: "string" } } } }] } };
  if (msg.method === "tools/call") {
    const p = msg.params as { name: string; arguments: unknown };
    fake.mcpCalls.push({ name: p.name, args: p.arguments });
    return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "bild:ok" }] } };
  }
  return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unbekannt" } };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", fake.base);
  const auth = req.headers.authorization ?? "";
  const body = req.method === "POST" ? await readBody(req) : "";
  // OpenAI-kompatibel
  if (url.pathname === "/openai/v1/models") return auth === `Bearer ${OPENAI_KEY}` ? json(res, 200, { data: [{ id: "fake-gpt" }, { id: "fake-mini" }] }) : json(res, 401, { error: "bad key" });
  if (url.pathname === "/openai/v1/chat/completions") {
    if (auth !== `Bearer ${OPENAI_KEY}`) return json(res, 401, { error: "bad key" });
    fake.openaiRequests.push(JSON.parse(body) as Json);
    const next = fake.openaiScript.shift() ?? { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] };
    return json(res, 200, { usage: { prompt_tokens: 50, completion_tokens: 5 }, model: "fake-gpt", ...next });
  }
  // Anthropic
  if (url.pathname === "/anthropic/v1/models") return req.headers["x-api-key"] === ANTHROPIC_KEY ? json(res, 200, { data: [{ id: "claude-fake", display_name: "Claude Fake" }] }) : json(res, 401, {});
  if (url.pathname === "/anthropic/v1/messages") {
    if (req.headers["x-api-key"] !== ANTHROPIC_KEY) return json(res, 401, {});
    fake.anthropicRequests.push(JSON.parse(body) as Json);
    const next = fake.anthropicScript.shift() ?? { content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" };
    return json(res, 200, { usage: { input_tokens: 10, output_tokens: 2 }, model: "claude-fake", ...next });
  }
  // MCP Streamable HTTP (tools/list antwortet als SSE, der Rest als JSON)
  if (url.pathname === "/mcp") {
    if (auth !== `Bearer ${MCP_TOKEN}`) return json(res, 401, { error: "no" });
    const msg = JSON.parse(body || "{}") as Json;
    const out = mcpAnswer(msg);
    if (!out) return void res.writeHead(202).end();
    if (msg.method === "tools/list") {
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
      return void res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
    }
    return json(res, 200, out, { "mcp-session-id": "s1" });
  }
  // MCP älterer SSE-Weg
  if (url.pathname === "/sse" && req.method === "GET") {
    const sid = randomBytes(4).toString("hex");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: endpoint\ndata: /sse/messages?sid=${sid}\n\n`);
    fake.sseClients.set(sid, res);
    return;
  }
  // Bösartiger SSE-Server: nennt als Nachrichten-Endpunkt einen FREMDEN Ursprung (localhost statt 127.0.0.1).
  if (url.pathname === "/sse-evil" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: endpoint\ndata: ${fake.base.replace("127.0.0.1", "localhost")}/sse/messages?sid=x\n\n`);
    fake.sseClients.set(`evil-${randomBytes(2).toString("hex")}`, res);
    return;
  }
  if (url.pathname === "/sse/messages") {
    const out = mcpAnswer(JSON.parse(body) as Json);
    const stream = fake.sseClients.get(url.searchParams.get("sid") ?? "");
    res.writeHead(202).end();
    if (out && stream) stream.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
    return;
  }
  // MCP mit Anmeldung im Browser (OAuth)
  if (url.pathname === "/oauth-mcp") {
    if (auth !== `Bearer ${fake.oauth.access}`) return json(res, 401, { error: "login" }, { "www-authenticate": `Bearer resource_metadata="${fake.base}/.well-known/oauth-protected-resource/oauth-mcp"` });
    const out = mcpAnswer(JSON.parse(body || "{}") as Json);
    return out ? json(res, 200, out) : void res.writeHead(202).end();
  }
  if (url.pathname === "/.well-known/oauth-protected-resource/oauth-mcp") return json(res, 200, { resource: `${fake.base}/oauth-mcp`, authorization_servers: [fake.base], scopes_supported: ["mcp"] });
  if (url.pathname === "/.well-known/oauth-authorization-server") return json(res, 200, { issuer: fake.base, authorization_endpoint: `${fake.base}/authorize`, token_endpoint: `${fake.base}/token`, registration_endpoint: `${fake.base}/register` });
  if (url.pathname === "/register") return json(res, 201, { client_id: fake.oauth.clientId });
  // Geräte-Code wie Higgsfield (JSON statt Formular): erst „pending“, dann Token.
  if (url.pathname === "/device/authorize") return json(res, 200, { device_code: "dev-1", verification_uri: `${fake.base}/device?code=ABCD`, expires_in: 900, interval: 3 });
  if (url.pathname === "/device/authorize-js") return json(res, 200, { device_code: "dev-1", verification_uri: "javascript:alert(1)", expires_in: 900, interval: 3 });
  if (url.pathname === "/device/token") {
    const b = JSON.parse(body || "{}") as { device_code?: string };
    if (b.device_code !== "dev-1") return json(res, 400, { error: "invalid" });
    fake.devicePolls++;
    return fake.devicePolls < 2 ? json(res, 400, { error: "authorization_pending" }) : json(res, 200, { access_token: fake.oauth.access, expires_in: 3600 });
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(body);
    const ok = form.get("grant_type") === "authorization_code" && form.get("code") === "code-123" && form.get("client_id") === fake.oauth.clientId && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === fake.oauth.challenge;
    return ok ? json(res, 200, { access_token: fake.oauth.access, refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" }) : json(res, 400, { error: "invalid_grant" });
  }
  json(res, 404, {});
}

// Die Fake-Server laufen auf 127.0.0.1 – das ist sonst (Produktion) als internes Netz gesperrt.
const allowBefore = process.env.NYXOS_ALLOW_PRIVATE_URLS;
beforeAll(async () => {
  process.env.NYXOS_ALLOW_PRIVATE_URLS = "1";
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (allowBefore === undefined) delete process.env.NYXOS_ALLOW_PRIVATE_URLS;
  else process.env.NYXOS_ALLOW_PRIVATE_URLS = allowBefore;
  for (const s of fake.sseClients.values()) s.end();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  fake.openaiScript = [];
  fake.openaiRequests = [];
  fake.anthropicScript = [];
  fake.anthropicRequests = [];
  fake.mcpCalls = [];
});

const JSONH = { "content-type": "application/json" };
const put = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string, body: unknown) => app.request(path, { method: "PUT", headers: JSONH, body: JSON.stringify(body) });
const post = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string, body: unknown) => app.request(path, { method: "POST", headers: JSONH, body: JSON.stringify(body) });

async function customProvider(app: Parameters<typeof post>[0], apiKey = OPENAI_KEY): Promise<string> {
  const res = await post(app, "/api/models/providers", { kind: "custom", label: "Fake-Router", baseUrl: `${fake.base}/openai/v1`, apiKey });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

// ─── Rollen ───

describe("resolveModel + Rollen", () => {
  it("Standard: alle Nyx-Rollen auf Haiku über das Claude-Programm; skills.create fest Opus 5.5", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const body = (await (await app.request("/api/models/roles")).json()) as { roles: { role: string; fixed: boolean; active: { source: string; model: string; label: string } }[] };
    const by = Object.fromEntries(body.roles.map((r) => [r.role, r]));
    expect(by["nyx.chat"]?.active).toMatchObject({ source: "claude-cli", model: "haiku" });
    expect(by["nyx.briefing"]?.active.source).toBe("claude-cli");
    expect(by["nyx.voice"]?.active.source).toBe("claude-cli");
    expect(by["skills.create"]).toMatchObject({ fixed: true, active: { source: "claude-cli", model: "claude-opus-5-5", label: "Claude Opus 5.5 · claude-opus-5-5 (Claude Code)" } });
  });

  it("skills.create ist nicht änderbar – Route 409, Service wirft, selbst eine DB-Zeile ändert nichts; nie Haiku", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const id = await customProvider(app);
    const res = await put(app, "/api/models/roles/skills.create", { providerId: id, model: "fake-gpt" });
    expect(res.status).toBe(409);
    const db = await sharedDb();
    const svc = new ModelService(db, { env: ENV });
    await expect(svc.assignRole("skills.create", null, null)).rejects.toThrow(/Opus 5.5/);
    await db.insert(modelRoles).values({ role: "skills.create", providerId: null, model: "haiku" }).onConflictDoNothing();
    const m = await svc.resolveModel("skills.create");
    expect(m.model).toBe("claude-opus-5-5");
    expect(m.model).not.toMatch(/haiku/i);
    expect(m.fixed).toBe(true);
  });

  it("roleForKind: Ideen-Links von außen nie über einen Fremd-Anbieter, Briefing/Recap → nyx.briefing, Stimme → nyx.voice", () => {
    expect(roleForKind("idealink")).toBeNull();
    expect(roleForKind("briefing")).toBe("nyx.briefing");
    expect(roleForKind("recap")).toBe("nyx.briefing");
    expect(roleForKind("chat")).toBe("nyx.chat");
    expect(roleForKind("chat", "voice")).toBe("nyx.voice");
  });
});

// ─── Anbieter ───

describe("Anbieter", () => {
  it("eigener Endpunkt: speichern, Test lädt Modelle + Probe-Antwort; Schlüssel nie im Klartext", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const id = await customProvider(app);
    const list = await (await app.request("/api/models/providers")).text();
    expect(list).not.toContain(OPENAI_KEY);
    expect(list).not.toContain("openai-1234567890");
    const parsed = JSON.parse(list) as { providers: { id: string; key: { set: boolean; last4: string } }[] };
    expect(parsed.providers.find((p) => p.id === id)?.key).toEqual({ set: true, last4: "ABCD" });
    // Karten für alle Vorlagen (auch nicht angelegte), Ollama/LM Studio über die Brücke.
    const kinds = (JSON.parse(list) as { providers: { kind: string; via: string }[] }).providers.map((p) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["anthropic", "openai", "openrouter", "gemini", "mistral", "groq", "xai", "deepseek", "ollama", "lmstudio", "custom"]));
    const test = (await (await post(app, `/api/models/providers/${id}/test`, { model: "fake-gpt" })).json()) as { ok: boolean; models: number; reply: string };
    expect(test).toMatchObject({ ok: true, models: 2, reply: "OK" });
    const after = (await (await app.request("/api/models/providers")).json()) as { providers: { id: string; models: { id: string }[] }[] };
    expect(after.providers.find((p) => p.id === id)?.models.map((m) => m.id)).toEqual(["fake-gpt", "fake-mini"]);
  });

  it("falscher Schlüssel: Test sagt es in einfachen Worten", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const id = await customProvider(app, "sk-falsch-000000000000");
    const test = (await (await post(app, `/api/models/providers/${id}/test`, {})).json()) as { ok: boolean; message: string };
    expect(test.ok).toBe(false);
    expect(test.message).toMatch(/Schlüssel wurde abgelehnt/);
  });

  it("Anthropic (Messages-API): Modelle + Werkzeug-Runde mit tool_result in EINER Nutzer-Nachricht", async () => {
    const { app, modelsApi } = await setup({ models: { env: ENV } });
    const saved = await put(app, "/api/models/providers/anthropic", { kind: "anthropic", baseUrl: `${fake.base}/anthropic`, apiKey: ANTHROPIC_KEY });
    expect(saved.status).toBe(200);
    const test = (await (await post(app, "/api/models/providers/anthropic/test", {})).json()) as { ok: boolean; models: number };
    expect(test).toMatchObject({ ok: true, models: 1 });
    expect((await put(app, "/api/models/roles/nyx.briefing", { providerId: "anthropic", model: "claude-fake" })).status).toBe(200);
    const svc = modelsApi.models;
    fake.anthropicScript.push({ content: [{ type: "tool_use", id: "tu1", name: "lage", input: {} }], stop_reason: "tool_use" });
    const r1 = await svc.chatComplete({ role: "nyx.briefing", system: "sys", messages: [{ role: "user", content: "Lage?" }], tools: [{ name: "lage", description: "Lage", inputSchema: { type: "object" } }] });
    expect(r1.toolCalls).toEqual([{ id: "tu1", name: "lage", arguments: {} }]);
    await svc.chatComplete({
      role: "nyx.briefing",
      messages: [
        { role: "user", content: "Lage?" },
        { role: "assistant", content: "", toolCalls: r1.toolCalls },
        { role: "tool", toolCallId: "tu1", name: "lage", content: "{}" },
      ],
    });
    const last = fake.anthropicRequests.at(-1) as { messages: { role: string; content: unknown }[]; system?: string };
    expect(last.messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "{}" }] });
  });

  it("Ollama über die Brücke: RPC http_proxy_local mit Port 11434; ohne Brücke ehrliche Meldung", async () => {
    const db = await sharedDb();
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const bridge = {
      online: true,
      supports: (cap: string) => cap === "http_proxy_local",
      rpc: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return { ok: true, result: { status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: "llama3.2" }] }) } };
      },
    } as unknown as BridgeHub;
    const svc = new ModelService(db, { env: ENV, bridgeHub: bridge });
    await svc.saveProvider({ kind: "ollama" });
    const t = await svc.testProvider("ollama");
    expect(t).toMatchObject({ ok: true, models: 1 });
    expect(calls[0]).toMatchObject({ method: "http_proxy_local", params: { port: 11434, method: "GET", path: "/v1/models" } });
    const offline = new ModelService(db, { env: ENV, bridgeHub: { online: false, supports: () => false } as unknown as BridgeHub });
    const t2 = await offline.testProvider("ollama");
    expect(t2.ok).toBe(false);
    expect(t2.message).toMatch(/Rechner ist gerade nicht verbunden/);
  });
});

// ─── Nyx-Motor mit Fremd-Anbieter ───

describe("Nyx mit Fremd-Anbieter", () => {
  it("Rolle nyx.chat → Fake-Anbieter; Nyx-Werkzeug (lage) läuft, Antwort kommt, Protokoll zeigt das Modell", async () => {
    const built = await setup({ models: { env: ENV } });
    const id = await customProvider(built.app);
    expect((await put(built.app, "/api/models/roles/nyx.chat", { providerId: id, model: "fake-gpt" })).status).toBe(200);
    fake.openaiScript.push({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lage", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    fake.openaiScript.push({ choices: [{ message: { content: "Alles ruhig." }, finish_reason: "stop" }] });
    const r = await built.haiku.run({ kind: "chat", scope: "full", systemPrompt: "Du bist Nyx.", prompt: "Wie ist die Lage?" });
    expect(r.type).toBe("final");
    if (r.type === "final") expect(r.text).toBe("Alles ruhig.");
    const first = fake.openaiRequests[0] as { tools: { function: { name: string } }[]; messages: { role: string }[] };
    expect(first.tools.map((t) => t.function.name)).toContain("lage");
    const second = fake.openaiRequests[1] as { messages: { role: string; tool_call_id?: string }[] };
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    const [call] = await built.db.select().from(haikuCalls).where(eq(haikuCalls.status, "ok"));
    expect(call?.model).toBe("fake-gpt");
    expect(call?.toolCalls).toEqual(["lage"]);
  });

  it("eingeschalteter Konnektor wird von Nyx genutzt (Werkzeug fake__bild_machen → MCP tools/call); ausgeschaltet nicht", async () => {
    const built = await setup({ models: { env: ENV } });
    const id = await customProvider(built.app);
    await put(built.app, "/api/models/roles/nyx.chat", { providerId: id, model: "fake-gpt" });
    const created = await post(built.app, "/api/mcp/connectors", { name: "fake", label: "Fake", transport: "http", url: `${fake.base}/mcp`, auth: "bearer", token: MCP_TOKEN, enabled: true });
    expect(created.status).toBe(201);
    const connId = ((await created.json()) as { id: number }).id;
    // Tool-Pinning: nie getestet → Nyx nutzt ihn noch nicht.
    fake.openaiScript.push({ choices: [{ message: { content: "Noch ohne." }, finish_reason: "stop" }] });
    await built.haiku.run({ kind: "chat", scope: "full", systemPrompt: "Du bist Nyx.", prompt: "Mach ein Bild" });
    expect((fake.openaiRequests.at(-1) as { tools: { function: { name: string } }[] }).tools.map((t) => t.function.name)).not.toContain("fake__bild_machen");
    await post(built.app, `/api/mcp/connectors/${connId}/test`, {});
    fake.openaiScript.push({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fake__bild_machen", arguments: '{"prompt":"Club"}' } }] }, finish_reason: "tool_calls" }] });
    fake.openaiScript.push({ choices: [{ message: { content: "Bild ist fertig." }, finish_reason: "stop" }] });
    const r = await built.haiku.run({ kind: "chat", scope: "full", systemPrompt: "Du bist Nyx.", prompt: "Mach ein Bild" });
    expect(r.type).toBe("final");
    // Panel-Kopf zeigt das aktive Modell des Chats.
    expect((await built.haiku.status()).engine).toMatchObject({ kind: "api", state: "ready", model: "fake-gpt" });
    expect(fake.mcpCalls).toEqual([{ name: "bild_machen", args: { prompt: "Club" } }]);
    // Aus → Werkzeug nicht mehr angeboten.
    await built.app.request(`/api/mcp/connectors/${connId}`, { method: "PATCH", headers: JSONH, body: JSON.stringify({ enabled: false }) });
    fake.openaiScript.push({ choices: [{ message: { content: "Ohne Bild." }, finish_reason: "stop" }] });
    await built.haiku.run({ kind: "chat", scope: "full", systemPrompt: "Du bist Nyx.", prompt: "Mach ein Bild" });
    const last = fake.openaiRequests.at(-1) as { tools: { function: { name: string } }[] };
    expect(last.tools.map((t) => t.function.name)).not.toContain("fake__bild_machen");
  });

  it("Claude-Programm: Konnektoren in --mcp-config + erlaubt; nie bei Ideen-Links (scope idealink)", async () => {
    const db = await sharedDb();
    const engine = new FakeEngine();
    const runtime = new HaikuRuntime({ db, tools: buildDefaultRegistry(), cliEngine: engine, apiEngine: null });
    const built = await setup({ models: { env: ENV }, haiku: { runtime } });
    const { id: cid } = (await (await post(built.app, "/api/mcp/connectors", { name: "fake", label: "Fake", transport: "http", url: `${fake.base}/mcp`, auth: "bearer", token: MCP_TOKEN, enabled: true })).json()) as { id: number };
    await post(built.app, `/api/mcp/connectors/${cid}/test`, {});
    await runtime.run({ kind: "chat", scope: "full", systemPrompt: "s", prompt: "p" });
    await runtime.run({ kind: "idealink", scope: "idealink", systemPrompt: "s", prompt: "p" });
    const [full, link] = engine.requests as EngineRequest[];
    expect(full?.mcpServers).toEqual([expect.objectContaining({ name: "fake", headers: { Authorization: `Bearer ${MCP_TOKEN}` } })]);
    expect(link?.mcpServers).toEqual([]);
    const cli = new ClaudeCliEngine({ apiUrl: "http://127.0.0.1:1", bin: "claude", mcp: { command: "node", args: ["x"] } });
    const args = cli.buildArgs(full as EngineRequest, "/pfad/mcp.json");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/pfad/mcp.json");
    const cfg = cli.mcpConfig(full as EngineRequest) as { mcpServers: Record<string, Json> };
    expect(cfg.mcpServers.fake).toEqual({ type: "http", url: `${fake.base}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } });
    expect(cfg.mcpServers.nyxos).toBeDefined();
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__fake__bild_machen");
    // (3): Token nie in der Befehlszeile (ps, /proc) – die Konfig liegt als 0600-Datei vor und ist danach weg.
    const real = new ClaudeCliEngine({ apiUrl: "http://127.0.0.1:1", bin: join(import.meta.dirname, "fixtures", "fake-claude-args.mjs"), mcp: { command: "node", args: ["x"] } });
    let text = "";
    for await (const ev of real.run({ ...(full as EngineRequest), signal: new AbortController().signal, timeoutMs: 15_000 })) if (ev.type === "result") text = ev.text;
    const seen = JSON.parse(text) as { argv: string[]; cfg: { mcpServers: Record<string, Json> } | null; mode: number | null; path: string | null };
    expect(seen.argv.join(" ")).not.toContain(MCP_TOKEN);
    expect(seen.cfg?.mcpServers.fake).toMatchObject({ headers: { Authorization: `Bearer ${MCP_TOKEN}` } });
    expect(seen.mode).toBe(0o600);
    expect(existsSync(seen.path as string)).toBe(false);
  });
});

// ─── Konnektoren ───

describe("Konnektoren (MCP)", () => {
  it("HTTP: Test listet Werkzeuge; falscher Token → einfache Meldung; Liste nie mit Token", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const res = await post(app, "/api/mcp/connectors", { name: "fake", label: "Fake", transport: "http", url: `${fake.base}/mcp`, auth: "bearer", token: MCP_TOKEN });
    const { id } = (await res.json()) as { id: number };
    const t = (await (await post(app, `/api/mcp/connectors/${id}/test`, {})).json()) as { ok: boolean; tools: { name: string }[] };
    expect(t.ok).toBe(true);
    expect(t.tools.map((x) => x.name)).toEqual(["bild_machen"]);
    const list = await (await app.request("/api/mcp/connectors")).text();
    expect(list).not.toContain(MCP_TOKEN);
    // Tool-Pinning: erster erfolgreicher Test gibt die gezeigten Werkzeuge frei.
    expect(JSON.parse(list).connectors[0].allowedTools).toEqual(["bild_machen"]);
    expect(JSON.parse(list).templates.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(["higgsfield", "github", "notion", "playwright", "brave-search", "fal", "elevenlabs"]));
    await app.request(`/api/mcp/connectors/${id}`, { method: "PATCH", headers: JSONH, body: JSON.stringify({ token: "falsch-00000000000" }) });
    const bad = (await (await post(app, `/api/mcp/connectors/${id}/test`, {})).json()) as { ok: boolean; message: string };
    expect(bad).toMatchObject({ ok: false, message: expect.stringMatching(/Zugang abgelehnt/) });
  });

  it("älterer SSE-Weg funktioniert", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const { id } = (await (await post(app, "/api/mcp/connectors", { name: "alt", label: "Alt", transport: "sse", url: `${fake.base}/sse`, auth: "none" })).json()) as { id: number };
    const t = (await (await post(app, `/api/mcp/connectors/${id}/test`, {})).json()) as { ok: boolean; tools: { name: string }[] };
    expect(t).toMatchObject({ ok: true, tools: [{ name: "bild_machen" }] });
  });

  it("Befehl (stdio) mit Token als Umgebungsvariable", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const script = join(import.meta.dirname, "fixtures", "fake-mcp-stdio.mjs");
    const { id } = (await (await post(app, "/api/mcp/connectors", { name: "lokal", label: "Lokal", transport: "stdio", command: process.execPath, args: [script], auth: "env", authName: "FAKE_TOKEN", token: "geheim" })).json()) as { id: number };
    const t = (await (await post(app, `/api/mcp/connectors/${id}/test`, {})).json()) as { ok: boolean; tools: { name: string }[]; message: string };
    expect(t).toMatchObject({ ok: true, tools: [{ name: "echo" }] });
  });

  it("Name „nyxos“ ist reserviert; Adresse Pflicht", async () => {
    const { app } = await setup({ models: { env: ENV } });
    expect((await post(app, "/api/mcp/connectors", { name: "nyxos", label: "x", transport: "http", url: `${fake.base}/mcp`, auth: "none" })).status).toBe(400);
    expect((await post(app, "/api/mcp/connectors", { name: "ohne", label: "x", transport: "http", auth: "none" })).status).toBe(400);
  });

  it("Anmelden im Browser (OAuth + PKCE): Start liefert Adresse, Rückkehr speichert Token verschlüsselt, Test klappt", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const { id } = (await (await post(app, "/api/mcp/connectors", { name: "higgs", label: "Higgsfield", template: "higgsfield", transport: "http", url: `${fake.base}/oauth-mcp`, auth: "oauth" })).json()) as { id: number };
    const before = (await (await post(app, `/api/mcp/connectors/${id}/test`, {})).json()) as { ok: boolean; message: string };
    expect(before).toMatchObject({ ok: false, message: expect.stringMatching(/angemeldet/) });
    const start = await post(app, `/api/mcp/connectors/${id}/oauth/start`, { origin: "http://127.0.0.1:47890" });
    expect(start.status).toBe(200);
    const authUrl = new URL(((await start.json()) as { url: string }).url);
    expect(authUrl.origin + authUrl.pathname).toBe(`${fake.base}/authorize`);
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47890/api/mcp/oauth/callback");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    fake.oauth.challenge = authUrl.searchParams.get("code_challenge") ?? "";
    const cb = await app.request(`/api/mcp/oauth/callback?state=${encodeURIComponent(authUrl.searchParams.get("state") ?? "")}&code=code-123`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("Verbunden");
    const list = await (await app.request("/api/mcp/connectors")).text();
    expect(list).not.toContain(fake.oauth.access);
    expect((JSON.parse(list) as { connectors: { token: { set: boolean; expiresAt: string | null } }[] }).connectors[0]?.token).toMatchObject({ set: true, expiresAt: expect.any(String) });
    const after = (await (await post(app, `/api/mcp/connectors/${id}/test`, {})).json()) as { ok: boolean };
    expect(after.ok).toBe(true);
    // Unbekannter/erneut benutzter Zustand wird abgelehnt.
    const again = await app.request(`/api/mcp/oauth/callback?state=${encodeURIComponent(authUrl.searchParams.get("state") ?? "")}&code=code-123`);
    expect(again.status).toBe(400);
  });
});

describe("Tool-Pinning", () => {
  it("neue Werkzeuge bleiben aus: ein späterer Test ändert die Freigabe nicht; Alex kann Werkzeuge einzeln abschalten", async () => {
    const { app, modelsApi } = await setup({ models: { env: ENV } });
    const { id } = (await (await post(app, "/api/mcp/connectors", { name: "fake", label: "Fake", transport: "http", url: `${fake.base}/mcp`, auth: "bearer", token: MCP_TOKEN, enabled: true })).json()) as { id: number };
    await app.request(`/api/mcp/connectors/${id}`, { method: "PATCH", headers: JSONH, body: JSON.stringify({ allowedTools: ["altes_werkzeug"] }) });
    await post(app, `/api/mcp/connectors/${id}/test`, {});
    const [spec] = await modelsApi.connectors.enabledSpecs();
    expect(spec?.allowedTools).toEqual(["altes_werkzeug"]);
  });
});

describe("Geräte-Anmeldung (Higgsfield-Weg) + Werkzeug-Probe", () => {
  it("Link kommt, NyxOS fragt selbst nach, speichert das Token verschlüsselt und testet danach von selbst", async () => {
    const { app } = await setup({ models: { env: ENV, devicePollMs: 20 } });
    fake.devicePolls = 0;
    const { id } = (await (
      await post(app, "/api/mcp/connectors", { name: "higgsfield", label: "Higgsfield", template: "higgsfield", transport: "http", url: `${fake.base}/oauth-mcp`, auth: "device", authConfig: { deviceAuthorizeUrl: `${fake.base}/device/authorize`, deviceTokenUrl: `${fake.base}/device/token` }, enabled: true })
    ).json()) as { id: number };
    const start = (await (await post(app, `/api/mcp/connectors/${id}/device/start`, {})).json()) as { state: string; verificationUri: string };
    expect(start).toMatchObject({ state: "pending", verificationUri: `${fake.base}/device?code=ABCD` });
    const pending = await (await app.request("/api/mcp/connectors")).text();
    expect(pending).not.toContain("dev-1");
    let view: { token: { set: boolean }; login: unknown; lastTest: { ok: boolean; tools: { name: string }[] } | null; allowedTools: string[] | null } | undefined;
    for (let i = 0; i < 100; i++) {
      view = ((await (await app.request("/api/mcp/connectors")).json()) as { connectors: NonNullable<typeof view>[] }).connectors[0];
      if (view?.lastTest) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(view).toMatchObject({ token: { set: true }, login: null, lastTest: { ok: true, tools: [{ name: "bild_machen" }] }, allowedTools: ["bild_machen"] });
    expect(JSON.stringify(view)).not.toContain(fake.oauth.access);
  });

  it("Anbieter-Test mit Modell prüft, ob das Modell Werkzeuge nutzt", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const id = await customProvider(app);
    fake.openaiScript.push({ choices: [{ message: { content: null, tool_calls: [{ id: "t", type: "function", function: { name: "uhrzeit", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    const t = (await (await post(app, `/api/models/providers/${id}/test`, { model: "fake-gpt" })).json()) as { ok: boolean; tools: boolean; message: string };
    expect(t).toMatchObject({ ok: true, tools: true, message: expect.stringMatching(/kann Werkzeuge/) });
    const plain = (await (await post(app, `/api/models/providers/${id}/test`, { model: "fake-mini" })).json()) as { tools: boolean; message: string };
    expect(plain).toMatchObject({ tools: false, message: expect.stringMatching(/keine Werkzeuge/) });
  });
});

// ─── Sicherheit ───

describe("Sicherheit", () => {
  it("skills.create läuft nie über den Haiku-Motor – der Lauf wird abgelehnt, kein Modell gerufen", async () => {
    const db = await sharedDb();
    const engine = new FakeEngine();
    const runtime = new HaikuRuntime({ db, tools: buildDefaultRegistry(), cliEngine: engine, apiEngine: null });
    await setup({ models: { env: ENV }, haiku: { runtime } });
    const r = await runtime.run({ kind: "chat", role: "skills.create", scope: "full", systemPrompt: "s", prompt: "Bau einen Skill" });
    expect(r).toMatchObject({ type: "error", message: expect.stringMatching(/Opus 5.5/) });
    expect(engine.requests).toHaveLength(0);
  });

  it("Ideen-Links nie über einen Fremd-Anbieter – auch nicht mit ausdrücklich übergebener Rolle", async () => {
    const db = await sharedDb();
    const engine = new FakeEngine();
    const runtime = new HaikuRuntime({ db, tools: buildDefaultRegistry(), cliEngine: engine, apiEngine: null });
    const built = await setup({ models: { env: ENV }, haiku: { runtime } });
    const id = await customProvider(built.app);
    await put(built.app, "/api/models/roles/nyx.chat", { providerId: id, model: "fake-gpt" });
    await runtime.run({ kind: "idealink", role: "nyx.chat", scope: "idealink", systemPrompt: "s", prompt: "p" });
    expect(fake.openaiRequests).toHaveLength(0);
    expect(engine.requests).toHaveLength(1);
  });

  it("interne Adressen (Docker-Dienste, Metadaten) werden weder gespeichert noch aufgerufen", async () => {
    const { app } = await setup({ models: { env: ENV } });
    process.env.NYXOS_ALLOW_PRIVATE_URLS = "0";
    try {
      const p = await post(app, "/api/models/providers", { kind: "custom", label: "Böse", baseUrl: "http://shop-postgres:5432/v1", apiKey: OPENAI_KEY });
      expect(p.status).toBe(400);
      expect(((await p.json()) as { error: string }).error).toMatch(/interne Netz/);
      const c = await post(app, "/api/mcp/connectors", { name: "meta", label: "Meta", transport: "http", url: "http://169.254.169.254/mcp", auth: "none" });
      expect(c.status).toBe(400);
      // Vorher (mit Freigabe) gespeichert, jetzt in Produktion gesperrt: der Test ruft die Adresse nicht auf.
      process.env.NYXOS_ALLOW_PRIVATE_URLS = "1";
      const { id } = (await (await post(app, "/api/mcp/connectors", { name: "lokal", label: "Lokal", transport: "http", url: `${fake.base}/mcp`, auth: "bearer", token: MCP_TOKEN })).json()) as { id: number };
      process.env.NYXOS_ALLOW_PRIVATE_URLS = "0";
      const t = (await (await post(app, `/api/mcp/connectors/${id}/test`, {})).json()) as { ok: boolean; message: string };
      expect(t).toMatchObject({ ok: false, message: expect.stringMatching(/interne Netz/) });
    } finally {
      process.env.NYXOS_ALLOW_PRIVATE_URLS = "1";
    }
  });

  it("SSE: Nachrichten-Endpunkt auf fremdem Ursprung wird abgelehnt (kein Token an fremde Server)", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const { id } = (await (await post(app, "/api/mcp/connectors", { name: "evil", label: "Evil", transport: "sse", url: `${fake.base}/sse-evil`, auth: "bearer", token: MCP_TOKEN })).json()) as { id: number };
    const t = (await (await post(app, `/api/mcp/connectors/${id}/test`, {})).json()) as { ok: boolean; message: string };
    expect(t).toMatchObject({ ok: false, message: expect.stringMatching(/andere Adresse/) });
  });

  it("Konnektor zeigt auf eine neue Adresse → Freigaben und Token weg (neu testen, neu eintragen)", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const { id } = (await (await post(app, "/api/mcp/connectors", { name: "fake", label: "Fake", transport: "http", url: `${fake.base}/mcp`, auth: "bearer", token: MCP_TOKEN })).json()) as { id: number };
    await post(app, `/api/mcp/connectors/${id}/test`, {});
    await app.request(`/api/mcp/connectors/${id}`, { method: "PATCH", headers: JSONH, body: JSON.stringify({ label: "Neu benannt" }) });
    let c = ((await (await app.request("/api/mcp/connectors")).json()) as { connectors: { allowedTools: string[] | null; token: { set: boolean } }[] }).connectors[0];
    expect(c).toMatchObject({ allowedTools: ["bild_machen"], token: { set: true } });
    await app.request(`/api/mcp/connectors/${id}`, { method: "PATCH", headers: JSONH, body: JSON.stringify({ url: `${fake.base}/mcp?anders=1` }) });
    c = ((await (await app.request("/api/mcp/connectors")).json()) as { connectors: { allowedTools: string[] | null; token: { set: boolean } }[] }).connectors[0];
    expect(c).toMatchObject({ allowedTools: null, token: { set: false } });
  });

  it("Vorlage mit neuer Adresse ohne neuen Schlüssel → alter Schlüssel wird nicht dorthin geschickt", async () => {
    const { app } = await setup({ models: { env: ENV } });
    expect((await put(app, "/api/models/providers/openai", { kind: "openai", baseUrl: `${fake.base}/openai/v1`, apiKey: OPENAI_KEY })).status).toBe(200);
    await put(app, "/api/models/providers/openai", { kind: "openai", baseUrl: `${fake.base}/openai/v1`, label: "OpenAI" });
    const same = (await (await app.request("/api/models/providers")).json()) as { providers: { id: string; key: { set: boolean } }[] };
    expect(same.providers.find((p) => p.id === "openai")?.key.set).toBe(true);
    await put(app, "/api/models/providers/openai", { kind: "openai", baseUrl: `${fake.base}/anderswo/v1` });
    const list = (await (await app.request("/api/models/providers")).json()) as { providers: { id: string; key: { set: boolean } }[] };
    expect(list.providers.find((p) => p.id === "openai")?.key.set).toBe(false);
  });

  it("Geräte-Anmeldung: Link, der kein https ist, wird nicht weitergegeben", async () => {
    const { app } = await setup({ models: { env: ENV, devicePollMs: 20 } });
    const { id } = (await (
      await post(app, "/api/mcp/connectors", { name: "higgs2", label: "H", transport: "http", url: `${fake.base}/oauth-mcp`, auth: "device", authConfig: { deviceAuthorizeUrl: `${fake.base}/device/authorize-js`, deviceTokenUrl: `${fake.base}/device/token` } })
    ).json()) as { id: number };
    const res = await post(app, `/api/mcp/connectors/${id}/device/start`, {});
    expect(await res.text()).not.toContain("javascript:");
  });
});
