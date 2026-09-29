// Befehls-Konnektoren (stdio) laufen im Agent-Container – der Test-Knopf geht über den Arbeiter
// (echter WebSocket), nie im API-Prozess. Ohne verbundenen Arbeiter: ehrliche Meldung.
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliEngine } from "../src/haiku/claudeCli.js";
import { RemoteEngine } from "../src/haiku/remoteEngine.js";
import { HaikuRuntime } from "../src/haiku/runtime.js";
import { buildDefaultRegistry } from "../src/haiku/tools.js";
import { runWorker } from "../src/haiku-worker.js";
import { setup, sharedDb } from "./helpers.js";

const ENV = { NYXOS_SECRETS_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;
const JSONH = { "content-type": "application/json" };
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const until = async (f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("Zeit abgelaufen");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("stdio-Konnektor über den Agent-Container", () => {
  it("Test läuft im Arbeiter; ohne Arbeiter sagt NyxOS ehrlich, dass der Motor fehlt", async () => {
    const db = await sharedDb();
    const remote = new RemoteEngine({ tokenConfigured: true });
    const runtime = new HaikuRuntime({ db, tools: buildDefaultRegistry(), cliEngine: remote, apiEngine: null });
    const built = await setup({ models: { env: ENV }, haiku: { runtime, remoteEngine: remote, workerSecret: "geheim-n5" } });
    const server = serve({ fetch: built.app.fetch, port: 0, hostname: "127.0.0.1" });
    built.injectWebSocket(server);
    await new Promise((r) => server.once("listening", r));
    cleanup.push(() => server.close());
    const port = (server.address() as AddressInfo).port;

    const script = join(import.meta.dirname, "fixtures", "fake-mcp-stdio.mjs");
    const created = await built.app.request("/api/mcp/connectors", { method: "POST", headers: JSONH, body: JSON.stringify({ name: "lokal", label: "Lokal", transport: "stdio", command: process.execPath, args: [script], auth: "env", authName: "FAKE_TOKEN", token: "geheim" }) });
    const { id } = (await created.json()) as { id: number };

    const before = (await (await built.app.request(`/api/mcp/connectors/${id}/test`, { method: "POST", headers: JSONH, body: "{}" })).json()) as { ok: boolean; message: string };
    expect(before).toMatchObject({ ok: false, message: expect.stringMatching(/Nyx-Motor/) });

    cleanup.push(runWorker({ url: `ws://127.0.0.1:${port}/haiku-worker`, secret: "geheim-n5", engine: new ClaudeCliEngine({ apiUrl: "http://127.0.0.1:1", bin: "/nicht/da" }), tokenSet: true }));
    await until(() => remote.connectedAt !== null);
    const after = (await (await built.app.request(`/api/mcp/connectors/${id}/test`, { method: "POST", headers: JSONH, body: "{}" })).json()) as { ok: boolean; tools: { name: string }[] };
    expect(after).toMatchObject({ ok: true, tools: [{ name: "echo" }] });
  });
});
