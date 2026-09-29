// Brücke: `http_proxy_local` nur für 127.0.0.1 und Ports aus der Erlaubnisliste (Ollama/LM Studio + konfiguriert).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowedPorts, httpProxyLocal, LocalProxyError } from "../src/localProxy.js";
import { RpcError, TerminalManager } from "../src/terminal/manager.js";

let server: Server;
let port = 0;
const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "llama3.2" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("http_proxy_local", () => {
  it("Standard-Erlaubnisliste: nur Ollama 11434 und LM Studio 1234", () => {
    expect([...allowedPorts(null)].sort((a, b) => a - b)).toEqual([1234, 11434]);
    expect(allowedPorts([8080, -1, 70000]).has(8080)).toBe(true);
    expect(allowedPorts([8080, -1, 70000]).has(70000)).toBe(false);
  });

  it("freigegebener Port: GET/POST gehen an 127.0.0.1, Cookie/Host werden nicht weitergereicht", async () => {
    const r = await httpProxyLocal({ port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json", cookie: "x=1", authorization: "Bearer lm" }, body: '{"model":"m"}' }, { ports: allowedPorts([port]) });
    expect(r).toMatchObject({ status: 200, contentType: "application/json" });
    expect(JSON.parse(r.body)).toEqual({ data: [{ id: "llama3.2" }] });
    const last = seen.at(-1);
    expect(last).toMatchObject({ method: "POST", url: "/v1/chat/completions", body: '{"model":"m"}' });
    expect(last?.headers.cookie).toBeUndefined();
    expect(last?.headers.authorization).toBe("Bearer lm");
  });

  it("nicht freigegebener Port wird abgelehnt, bevor irgendetwas gesendet wird", async () => {
    const before = seen.length;
    await expect(httpProxyLocal({ port, method: "GET", path: "/" }, { ports: allowedPorts(null) })).rejects.toMatchObject({ code: "port_not_allowed" });
    expect(seen.length).toBe(before);
  });

  it("kein Host im Pfad möglich (nur '/…'), keine anderen Methoden", async () => {
    await expect(httpProxyLocal({ port, method: "GET", path: "http://evil.example/" }, { ports: allowedPorts([port]) })).rejects.toThrow();
    await expect(httpProxyLocal({ port, method: "DELETE", path: "/" }, { ports: allowedPorts([port]) })).rejects.toThrow();
    await expect(httpProxyLocal({ port, method: "GET", path: "//evil.example/x" }, { ports: allowedPorts([port]) })).resolves.toMatchObject({ status: 200 });
    // `//evil.example/x` bleibt ein Pfad auf 127.0.0.1 (URL beginnt immer mit http://127.0.0.1:<port>).
    expect(seen.at(-1)?.url).toBe("//evil.example/x");
  });

  it("dort läuft nichts → Code 'unreachable'", async () => {
    const e = await httpProxyLocal({ port: 1234, method: "GET", path: "/v1/models" }, { ports: allowedPorts(null), fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocalProxyError);
    expect((e as LocalProxyError).code).toBe("unreachable");
  });

  it("über den RPC-Weg der Brücke (TerminalManager.rpc) mit konfiguriertem Port; fremder Port → RpcError", async () => {
    const m = new TerminalManager({ tmux: {} as never, projectRoots: ["/"], path: "/usr/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map(), localModelPorts: [port] });
    await expect(m.rpc("http_proxy_local", { port, method: "GET", path: "/v1/models" })).resolves.toMatchObject({ status: 200 });
    const other = new TerminalManager({ tmux: {} as never, projectRoots: ["/"], path: "/usr/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });
    const err = await other.rpc("http_proxy_local", { port, method: "GET", path: "/v1/models" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe("port_not_allowed");
  });
});
