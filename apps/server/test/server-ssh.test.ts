// Server-SSH: Terminal zum eigenen Server über die Brücke (nur mit NYXOS_SERVER_SSH_HOST). Anmeldung +
// CSRF wie bei den anderen schreibenden Terminal-Wegen, strenge Parameter (kein Befehl, kein Host aus der
// Anfrage), ehrliche Meldung bei Brücke offline bzw. zu alter Brücke, Browser-Kanal nur an `zc-ssh-*`.
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { BRIDGE_CAP_SERVER_SSH, type ServerToBridge, type TermServerMsg } from "@nyxos/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CSRF_HEADER, SESSION_COOKIE, needsAuth } from "../src/terminal/auth.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

const NAME = "zc-ssh-a1b2c3d4";
const SSH_HOST = "deploy@example-server";

// Der Host kommt nur aus der Umgebung des Servers — hier für alle Tests dieser Datei gesetzt.
const before = process.env.NYXOS_SERVER_SSH_HOST;
beforeAll(() => {
  process.env.NYXOS_SERVER_SSH_HOST = SSH_HOST;
});
afterAll(() => {
  if (before === undefined) delete process.env.NYXOS_SERVER_SSH_HOST;
  else process.env.NYXOS_SERVER_SSH_HOST = before;
});

/** Brücke im selben Prozess; `caps` wie im `hello` einer echten Brücke. */
function fakeBridge(hub: BridgeHub, reply: (msg: ServerToBridge) => unknown = () => undefined, caps: string[] = [BRIDGE_CAP_SERVER_SSH]) {
  const sent: ServerToBridge[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        sent.push(msg);
        const answer = reply(msg);
        if (answer !== undefined) queueMicrotask(() => hub.handle(JSON.stringify(answer)));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "p3", tmuxSocket: "nyxos", caps }));
  return { sent };
}

const answer = (results: Record<string, unknown>) => (m: ServerToBridge) =>
  m.op === "rpc" && m.method in results ? { op: "rpc_result", id: m.id, ok: true, result: results[m.method] } : undefined;

const json = { "content-type": "application/json" };

describe("Server-SSH: Anmeldung und CSRF", () => {
  it("alle Wege sind immer geschützt (auch lesend)", () => {
    expect(needsAuth("GET", "/api/server/ssh", false)).toBe(true);
    expect(needsAuth("POST", "/api/server/ssh/start", false)).toBe(true);
    expect(needsAuth("POST", "/api/server/ssh/stop", false)).toBe(true);
    expect(needsAuth("GET", `/terminal/ssh/${NAME}`, false)).toBe(true);
  });

  it("ohne Anmeldung 401, mit Cookie aber ohne CSRF 403 – die Brücke wird nie gefragt", async () => {
    const hub = new BridgeHub();
    const { app, login } = await setup({ signedIn: false, bridgeHub: hub });
    const { sent } = fakeBridge(hub, answer({ ssh_start: { tmuxName: NAME, reused: false } }));
    expect((await app.request("/api/server/ssh")).status).toBe(401);
    expect((await app.request("/api/server/ssh/start", { method: "POST", headers: json, body: "{}" })).status).toBe(401);
    const cookie = `${SESSION_COOKIE}=${login.token}`;
    expect((await app.request("/api/server/ssh/start", { method: "POST", headers: { ...json, cookie }, body: "{}" })).status).toBe(403);
    expect((await app.request("/api/server/ssh/stop", { method: "POST", headers: { ...json, cookie, [CSRF_HEADER]: "falsch" }, body: '{"confirm":true}' })).status).toBe(403);
    expect(sent.filter((m) => m.op === "rpc")).toHaveLength(0);
    const ok = await app.request("/api/server/ssh/start", { method: "POST", headers: { ...json, cookie, [CSRF_HEADER]: login.csrf }, body: "{}" });
    expect(ok.status).toBe(200);
  });
});

describe("Server-SSH: Starten, Status, Trennen", () => {
  it("ohne NYXOS_SERVER_SSH_HOST ist die Funktion aus: Status sagt es, Start/Trennen 404, die Brücke wird nie gefragt", async () => {
    delete process.env.NYXOS_SERVER_SSH_HOST;
    try {
      const hub = new BridgeHub();
      const { app } = await setup({ bridgeHub: hub });
      const { sent } = fakeBridge(hub, answer({ ssh_start: { tmuxName: NAME, reused: false } }));
      const st = (await (await app.request("/api/server/ssh")).json()) as Record<string, unknown>;
      expect(st).toMatchObject({ configured: false, host: null, code: "not_configured", running: false });
      const res = await app.request("/api/server/ssh/start", { method: "POST", headers: json, body: "{}" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("not_configured");
      expect(sent.filter((m) => m.op === "rpc")).toHaveLength(0);
    } finally {
      process.env.NYXOS_SERVER_SSH_HOST = SSH_HOST;
    }
  });

  it("unbekannte Parameter (Befehl, Host) → 400, ohne die Brücke zu fragen", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    const { sent } = fakeBridge(hub, answer({ ssh_start: { tmuxName: NAME, reused: false } }));
    for (const body of [{ command: "rm -rf /" }, { host: "evil.example" }, { cols: 80, rows: 24, args: ["-o", "ProxyCommand=x"] }, { cols: "80; ls" }]) {
      const res = await app.request("/api/server/ssh/start", { method: "POST", headers: json, body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(sent.filter((m) => m.op === "rpc")).toHaveLength(0);
  });

  it("Start reicht nur die Feldgröße an die Brücke; Antwort trägt den tmux-Namen", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    const { sent } = fakeBridge(hub, answer({ ssh_start: { tmuxName: NAME, reused: false } }));
    const res = await app.request("/api/server/ssh/start", { method: "POST", headers: json, body: JSON.stringify({ cols: 100, rows: 30 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tmuxName: NAME, reused: false });
    const rpc = sent.find((m) => m.op === "rpc");
    // Der Host kommt aus der Einstellung des Servers, nie aus der Anfrage.
    expect(rpc).toMatchObject({ op: "rpc", method: "ssh_start", params: { cols: 100, rows: 30, host: SSH_HOST } });
  });

  it("Brücke meldet einen fremden Namen → nie an den Browser weitergeben", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    fakeBridge(hub, answer({ ssh_start: { tmuxName: "zc-claude-a1b2c3d4", reused: false } }));
    const res = await app.request("/api/server/ssh/start", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(502);
  });

  it("Brücke offline → 503 mit klarem Satz; Status sagt es ebenso", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    const res = await app.request("/api/server/ssh/start", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("bridge_offline");
    expect(body.error).toMatch(/Rechner/);
    const st = (await (await app.request("/api/server/ssh")).json()) as Record<string, unknown>;
    expect(st).toMatchObject({ bridgeOnline: false, supported: false, running: false, tmuxName: null });
    expect(String(st.message)).toMatch(/Rechner/);
  });

  it("zu alte Brücke (ohne Fähigkeit) → 503 mit Hinweis, nichts gestartet", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    const { sent } = fakeBridge(hub, answer({}), []);
    const res = await app.request("/api/server/ssh/start", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("bridge_outdated");
    expect(sent.filter((m) => m.op === "rpc")).toHaveLength(0);
  });

  it("Status fragt die Brücke; Trennen braucht eine Bestätigung", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    const { sent } = fakeBridge(hub, answer({ ssh_status: { running: true, tmuxName: NAME }, ssh_stop: { stopped: 1 } }));
    expect(await (await app.request("/api/server/ssh")).json()).toMatchObject({ bridgeOnline: true, supported: true, running: true, tmuxName: NAME, host: SSH_HOST, configured: true });
    const no = await app.request("/api/server/ssh/stop", { method: "POST", headers: json, body: "{}" });
    expect(no.status).toBe(400);
    expect(sent.some((m) => m.op === "rpc" && m.method === "ssh_stop")).toBe(false);
    const yes = await app.request("/api/server/ssh/stop", { method: "POST", headers: json, body: '{"confirm":true}' });
    expect(yes.status).toBe(200);
    expect(await yes.json()).toEqual({ stopped: 1 });
    expect(sent.find((m) => m.op === "rpc" && m.method === "ssh_stop")).toMatchObject({ params: {} });
  });
});

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

describe("WS /terminal/ssh/:name über echten Server", () => {
  async function startServer(online = true) {
    const hub = new BridgeHub();
    const ctx = await setup({ bridgeHub: hub, signedIn: false });
    const server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
    ctx.injectWebSocket(server);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    closers.push(() => server.close());
    const sent: ServerToBridge[] = [];
    if (online)
      hub.attach(
        {
          send(d) {
            const m = JSON.parse(d) as ServerToBridge;
            sent.push(m);
            if (m.op === "open") queueMicrotask(() => hub.handle(JSON.stringify({ op: "snapshot", ch: m.ch, d: "root@server:~# ", cols: 80, rows: 24, cursor: { x: 0, y: 0 } })));
          },
          close() {},
        },
        "m1",
      );
    const host = `127.0.0.1:${port}`;
    const open = (path: string, origin: string | null = `http://${host}`, signedIn = true) =>
      new Promise<{ ws: WebSocket; msgs: TermServerMsg[]; opened: boolean }>((resolve) => {
        const msgs: TermServerMsg[] = [];
        const headers: Record<string, string> = signedIn ? { cookie: `${SESSION_COOKIE}=${ctx.login.token}` } : {};
        if (origin) headers.origin = origin;
        const ws = new WebSocket(`ws://${host}${path}`, { headers } as unknown as string[]);
        ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)) as TermServerMsg);
        ws.onopen = () => setTimeout(() => resolve({ ws, msgs, opened: true }), 100);
        ws.onerror = () => resolve({ ws, msgs, opened: false });
      });
    return { open, sent };
  }

  it("hängt den Kanal an die ssh-Sitzung (Schreiben), fremder Origin bleibt draußen", async () => {
    const { open, sent } = await startServer();
    expect((await open(`/terminal/ssh/${NAME}?mode=rw`, "https://boese.example")).opened).toBe(false);
    const c = await open(`/terminal/ssh/${NAME}?mode=rw&cols=90&rows=20`);
    expect(c.opened).toBe(true);
    expect(sent[0]).toMatchObject({ op: "open", tmuxName: NAME, readOnly: false, cols: 90, rows: 20 });
    expect(c.msgs).toContainEqual(expect.objectContaining({ t: "snapshot" }));
    c.ws.send(JSON.stringify({ t: "in", d: "uptime\r" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.at(-1)).toMatchObject({ op: "in", d: "uptime\r" });
    c.ws.close();
  });

  it("ohne Anmeldung (z. B. ein /live-Mithörer) kein Kanal – auch nicht nur lesend", async () => {
    const { open, sent } = await startServer();
    expect((await open(`/terminal/ssh/${NAME}?mode=rw`, undefined, false)).opened).toBe(false);
    expect((await open(`/terminal/ssh/${NAME}?mode=ro`, undefined, false)).opened).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("nur zc-ssh-*: Werkzeug-Sessions und erfundene Namen werden abgewiesen", async () => {
    const { open, sent } = await startServer();
    for (const bad of ["zc-claude-a1b2c3d4", "zc-ssh-x", "zc-ssh-a1b2c3d4%3Bls"]) {
      const c = await open(`/terminal/ssh/${bad}?mode=rw`);
      await new Promise((r) => setTimeout(r, 50));
      expect(c.msgs, bad).toContainEqual(expect.objectContaining({ t: "status", s: "not_attachable" }));
    }
    expect(sent).toHaveLength(0);
  });

  it("Brücke offline → Status bridge_offline", async () => {
    const { open } = await startServer(false);
    const c = await open(`/terminal/ssh/${NAME}?mode=rw`);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.msgs).toContainEqual(expect.objectContaining({ t: "status", s: "bridge_offline" }));
  });
});
