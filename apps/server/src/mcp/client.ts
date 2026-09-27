// Kleiner MCP-Client (JSON-RPC 2.0, handgeschrieben wie `haiku/mcpProxy.ts` – kein SDK nötig).
// Wege: „http“ (Streamable HTTP: POST, Antwort als JSON oder SSE), „sse“ (älterer Weg: GET-Strom +
// POST an den gemeldeten Endpunkt) und „stdio“ (Befehl als Kindprozess, eine JSON-Zeile je Nachricht).
// Genutzt für den Test-Knopf (Werkzeuge auflisten) und für Nyx mit Fremd-Anbietern (Werkzeuge aufrufen).
import { t } from "@nyxos/shared";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { safeFetch, UnsafeUrlError } from "../net/safeFetch.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "nyxos", version: "0.1.0" };

export interface McpServerSpec {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string | null;
  command?: string | null;
  args?: string[];
  /** Fertige Kopfzeilen inkl. Token (nur im Speicher, nie loggen). */
  headers?: Record<string, string>;
  /** Zusätzliche Umgebung für stdio (inkl. Token). */
  env?: Record<string, string>;
  /** Tool-Pinning: nur diese Werkzeuge darf Nyx nutzen (fehlt = alle, nur beim Test). */
  allowedTools?: string[];
}

export interface McpTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Transport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

/** Einfache Worte für HTTP-Fehler (UI zeigt sie). */
export function mcpHttpMessage(status: number): string {
  if (status === 401 || status === 403) return t("Zugang abgelehnt – Token fehlt, ist abgelaufen oder falsch.");
  if (status === 404) return t("Unter dieser Adresse antwortet kein Konnektor.");
  if (status === 429) return t("Zu viele Anfragen – kurz warten und nochmal testen.");
  if (status >= 500) return t("Der Dienst hat gerade Probleme – später nochmal testen.");
  return t("Der Dienst hat die Anfrage abgelehnt ({status}).", { status });
}

/** Zerlegt einen SSE-Strom in Ereignisse ({event, data}). */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // (5): Strom abbrechen statt nur die Sperre freigeben – sonst bleibt die Verbindung je Anfrage offen.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function netMessage(e: unknown): string {
  if (e instanceof McpError || e instanceof UnsafeUrlError) return e.message;
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return t("Keine Antwort in der Zeit – ist der Dienst erreichbar?");
  return t("Nicht erreichbar – stimmt die Adresse? Läuft der Dienst?");
}

// ─── Streamable HTTP ───

class HttpTransport implements Transport {
  private sessionId: string | null = null;
  private protocol: string | null = null;
  private nextId = 1;
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private reqHeaders(): Record<string, string> {
    return {
      ...this.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocol ? { "mcp-protocol-version": this.protocol } : {}),
    };
  }

  setProtocol(v: string): void {
    this.protocol = v;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, { method: "POST", headers: this.reqHeaders(), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal });
    } catch (e) {
      throw new McpError(netMessage(e));
    }
    if (!res.ok) throw new McpError(mcpHttpMessage(res.status), res.status);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && res.body) {
      for await (const ev of readSse(res.body, signal)) {
        let msg: RpcMessage;
        try {
          msg = JSON.parse(ev.data) as RpcMessage;
        } catch {
          continue;
        }
        if (msg.id === id) return unwrap(msg);
      }
      throw new McpError(t("Der Konnektor hat die Antwort abgebrochen."));
    }
    const msg = (await res.json().catch(() => null)) as RpcMessage | RpcMessage[] | null;
    const one = Array.isArray(msg) ? msg.find((m) => m.id === id) : msg;
    if (!one) throw new McpError(t("Der Konnektor hat unverständlich geantwortet."));
    return unwrap(one);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    try {
      await this.fetchImpl(this.url, { method: "POST", headers: this.reqHeaders(), body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(10_000) });
    } catch {
      // Benachrichtigungen sind ohne Antwort – ein Aussetzer hier ist kein Fehler.
    }
  }

  close(): void {
    if (!this.sessionId) return;
    void this.fetchImpl(this.url, { method: "DELETE", headers: this.reqHeaders(), signal: AbortSignal.timeout(5_000) }).catch(() => {});
  }
}

// ─── älterer SSE-Weg ───

class SseTransport implements Transport {
  private endpoint: string | null = null;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly ctrl = new AbortController();
  private nextId = 1;
  private ready!: Promise<void>;
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async open(timeoutMs: number): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, { headers: { ...this.headers, accept: "text/event-stream" }, signal: this.ctrl.signal });
    } catch (e) {
      throw new McpError(netMessage(e));
    }
    if (!res.ok || !res.body) throw new McpError(mcpHttpMessage(res.status), res.status);
    const body = res.body;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new McpError(t("Der Konnektor hat keinen Endpunkt gemeldet."))), timeoutMs);
      void (async () => {
        try {
          for await (const ev of readSse(body, this.ctrl.signal)) {
            if (ev.event === "endpoint") {
              const ep = new URL(ev.data.trim(), this.url);
              clearTimeout(timer);
              //: Nachrichten (mit Token) nur an denselben Server, der den Strom liefert.
              if (ep.origin !== new URL(this.url).origin) {
                reject(new McpError(t("Der Konnektor will seine Nachrichten an eine andere Adresse schicken – aus Sicherheitsgründen abgelehnt.")));
                return;
              }
              this.endpoint = ep.toString();
              resolve();
              continue;
            }
            let msg: RpcMessage;
            try {
              msg = JSON.parse(ev.data) as RpcMessage;
            } catch {
              continue;
            }
            if (typeof msg.id === "number") {
              const p = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              try {
                p?.resolve(unwrap(msg));
              } catch (err) {
                p?.reject(err as Error);
              }
            }
          }
        } catch {
          // Strom zu (close) – offene Anfragen unten abbrechen.
        }
        clearTimeout(timer);
        // Strom zu, bevor ein Endpunkt kam → `open` nicht ewig warten lassen (wirkungslos, falls schon aufgelöst).
        reject(new McpError("Der Konnektor hat keinen Endpunkt gemeldet."));
        for (const p of this.pending.values()) p.reject(new McpError("Verbindung zum Konnektor getrennt."));
        this.pending.clear();
      })();
    });
    await this.ready;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.endpoint) throw new McpError("Der Konnektor hat keinen Endpunkt gemeldet.");
    const id = this.nextId++;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new McpError(t("Keine Antwort in der Zeit – ist der Dienst erreichbar?")));
      }, timeoutMs).unref?.();
    });
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, { method: "POST", headers: { ...this.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      this.pending.delete(id);
      throw new McpError(netMessage(e));
    }
    if (!res.ok) {
      this.pending.delete(id);
      throw new McpError(mcpHttpMessage(res.status), res.status);
    }
    return answer;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.endpoint) return;
    await this.fetchImpl(this.endpoint, { method: "POST", headers: { ...this.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }

  close(): void {
    this.ctrl.abort();
  }
}

// ─── stdio ───

class StdioTransport implements Transport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private stderr = "";
  private exited = false;

  constructor(command: string, args: string[], env: Record<string, string>) {
    const base: NodeJS.ProcessEnv = {};
    // Nur, was ein Befehl braucht – nie DB-Passwort o. Ä. der API vererben.
    for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "NODE_EXTRA_CA_CERTS", "npm_config_cache"]) if (process.env[k] !== undefined) base[k] = process.env[k];
    this.child = spawn(command, args, { env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    // (6): EPIPE nach dem Ende des Befehls darf API/Worker nicht abstürzen lassen.
    this.child.stdin.on("error", () => this.fail(new McpError(t("Der Befehl läuft nicht mehr."))));
    this.child.on("error", (e) => this.fail(new McpError(/ENOENT/.test(String(e)) ? t("Der Befehl ist hier nicht installiert.") : t("Der Befehl ließ sich nicht starten."))));
    this.child.on("exit", () => this.fail(new McpError(this.stderr.trim() ? t("Der Befehl hat sich beendet: {detail}", { detail: this.stderr.trim().split("\n").pop()?.slice(0, 160) }) : t("Der Befehl hat sich beendet."))));
    this.child.stderr.on("data", (b: Buffer) => {
      if (this.stderr.length < 4000) this.stderr += b.toString("utf8");
    });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (typeof msg.id !== "number" || msg.method) return;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      try {
        p?.resolve(unwrap(msg));
      } catch (err) {
        p?.reject(err as Error);
      }
    });
  }

  private fail(e: Error): void {
    this.exited = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited) return Promise.reject(new McpError(t("Der Befehl läuft nicht mehr.")));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new McpError(t("Keine Antwort in der Zeit – startet der Befehl zu langsam?")));
      }, timeoutMs).unref?.();
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }

  close(): void {
    this.exited = true;
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }, 2000).unref();
  }
}

function unwrap(msg: RpcMessage): unknown {
  if (msg.error) throw new McpError(t("Der Konnektor meldet: {message}", { message: String(msg.error.message).slice(0, 200) }));
  return msg.result;
}

export interface McpConnectOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class McpClient {
  private constructor(
    readonly spec: McpServerSpec,
    private readonly transport: Transport,
    private readonly timeoutMs: number,
  ) {}

  static async connect(spec: McpServerSpec, opts: McpConnectOptions = {}): Promise<McpClient> {
    //: jede Adresse (auch Weiterleitungen) gegen das interne Netz prüfen.
    const fetchImpl = safeFetch(opts.fetchImpl ?? fetch);
    const timeoutMs = opts.timeoutMs ?? 20_000;
    let transport: Transport;
    if (spec.transport === "stdio") {
      if (!spec.command) throw new McpError("Kein Befehl eingetragen.");
      transport = new StdioTransport(spec.command, spec.args ?? [], spec.env ?? {});
    } else {
      if (!spec.url) throw new McpError(t("Keine Adresse eingetragen."));
      if (spec.transport === "sse") {
        const sse = new SseTransport(spec.url, spec.headers ?? {}, fetchImpl);
        try {
          await sse.open(timeoutMs);
        } catch (e) {
          sse.close();
          throw e;
        }
        transport = sse;
      } else transport = new HttpTransport(spec.url, spec.headers ?? {}, fetchImpl);
    }
    try {
      const init = (await transport.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, timeoutMs)) as { protocolVersion?: string } | null;
      if (transport instanceof HttpTransport) transport.setProtocol(typeof init?.protocolVersion === "string" ? init.protocolVersion : MCP_PROTOCOL_VERSION);
      await transport.notify("notifications/initialized");
    } catch (e) {
      transport.close();
      throw e;
    }
    return new McpClient(spec, transport, timeoutMs);
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.transport.request("tools/list", cursor ? { cursor } : {}, this.timeoutMs)) as { tools?: unknown[]; nextCursor?: string } | null;
      for (const tool of r?.tools ?? []) {
        const o = tool as Record<string, unknown>;
        if (typeof o.name !== "string") continue;
        tools.push({ name: o.name, description: typeof o.description === "string" ? o.description : null, inputSchema: (o.inputSchema as Record<string, unknown>) ?? { type: "object" } });
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** Ruft ein Werkzeug auf und liefert den Text-Inhalt (Bilder als Hinweis) – für das Modell. */
  async callTool(name: string, args: unknown, timeoutMs = 120_000): Promise<{ text: string; isError: boolean }> {
    const r = (await this.transport.request("tools/call", { name, arguments: args ?? {} }, timeoutMs)) as { content?: Record<string, unknown>[]; isError?: boolean; structuredContent?: unknown } | null;
    const parts: string[] = [];
    for (const c of r?.content ?? []) {
      if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      else if (c.type === "image") parts.push("[Bild]");
      else if (c.type === "resource_link" && typeof c.uri === "string") parts.push(String(c.uri));
      else if (c.type === "resource") parts.push(JSON.stringify(c.resource).slice(0, 4000));
    }
    if (parts.length === 0 && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join("\n"), isError: r?.isError === true };
  }

  close(): void {
    this.transport.close();
  }
}

/** Test-Knopf: verbinden, Werkzeuge auflisten, trennen. */
export async function listMcpTools(spec: McpServerSpec, opts: McpConnectOptions = {}): Promise<McpTool[]> {
  const client = await McpClient.connect(spec, opts);
  try {
    return await client.listTools();
  } finally {
    client.close();
  }
}
