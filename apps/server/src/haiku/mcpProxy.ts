// MCP-Server "nyxos" für Haiku (stdio, JSON-RPC 2.0, handgeschrieben wie P4 – kein SDK nötig).
// Er kennt KEINE Werkzeuge selbst: Liste und Aufrufe gehen mit dem Einmal-Token des Laufs an den Server
// (`/haiku-mcp/tools`, `/haiku-mcp/call`). Welche Werkzeuge es gibt, entscheidet allein der Server anhand
// des Umfangs, an den das Token gebunden ist (Ideen-Link = nur ideen_suchen + idee_anlegen).
import { createInterface } from "node:readline";

const API = (process.env.NYXOS_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.NYXOS_HAIKU_RUN_TOKEN ?? "";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function api(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `HTTP ${res.status}`);
  return json;
}

export async function handle(req: RpcRequest): Promise<unknown | undefined> {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "nyxos-haiku", version: "0.1.0" },
      };
    case "ping":
      return {};
    case "tools/list": {
      const r = (await api("/haiku-mcp/tools")) as { tools: unknown[] };
      return { tools: r.tools };
    }
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      try {
        const r = (await api("/haiku-mcp/call", { name, arguments: req.params?.arguments ?? {} })) as { result: unknown };
        return { content: [{ type: "text", text: JSON.stringify(r.result) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
    default:
      if (req.method.startsWith("notifications/")) return undefined;
      throw Object.assign(new Error(`Unbekannte Methode ${req.method}`), { code: -32601 });
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    handle(req).then(
      (result) => {
        if (req.id !== undefined && req.id !== null && result !== undefined) send({ jsonrpc: "2.0", id: req.id, result });
      },
      (e: Error & { code?: number }) => {
        if (req.id !== undefined && req.id !== null) send({ jsonrpc: "2.0", id: req.id, error: { code: e.code ?? -32000, message: e.message } });
      },
    );
  });
  rl.on("close", () => process.exit(0));
}

if (process.argv[1] && /mcpProxy\.(ts|js)$|haiku-mcp\.js$/.test(process.argv[1])) main();
