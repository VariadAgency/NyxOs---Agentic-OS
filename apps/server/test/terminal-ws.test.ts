// Terminal-Kanal über einen echten HTTP-/WebSocket-Server (Route-Logik war ungetestet):
// Origin muss genau zum Host passen, „Nur ansehen" verwirft Eingabe UND Größe, nicht anhängbare Sessions
// werden abgewiesen, der Abzug trägt den Modus.
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { ServerToBridge, TermServerMsg } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/terminal/auth.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function startServer() {
  const hub = new BridgeHub();
  const ctx = await setup({ bridgeHub: hub, signedIn: false });
  const server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
  ctx.injectWebSocket(server);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  closers.push(() => server.close());
  // Brücke im selben Prozess: antwortet auf „open" mit einem Abzug und merkt sich alles.
  const sent: ServerToBridge[] = [];
  hub.attach(
    {
      send(d) {
        const m = JSON.parse(d) as ServerToBridge;
        sent.push(m);
        if (m.op === "open") queueMicrotask(() => hub.handle(JSON.stringify({ op: "snapshot", ch: m.ch, d: "hallo", cols: 80, rows: 24, cursor: { x: 0, y: 0 } })));
      },
      close() {},
    },
    "m1",
  );
  await ctx.post("/ingest/events", {
    items: [
      { type: "terminal", terminal: { tool: "claude", sessionId: "s-ws", tmuxName: "zc-claude-wstest01", attachable: true, screenWaiting: null, observedAt: new Date().toISOString() } },
      { type: "state", state: { tool: "claude", sessionId: "s-plain", running: true, observedAt: new Date().toISOString() } },
    ],
  });
  const host = `127.0.0.1:${port}`;
  const open = (path: string, origin: string | null) =>
    new Promise<{ ws: WebSocket; msgs: TermServerMsg[]; opened: boolean }>((resolve) => {
      const msgs: TermServerMsg[] = [];
      const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${ctx.login.token}` };
      if (origin) headers.origin = origin;
      const ws = new WebSocket(`ws://${host}${path}`, { headers } as unknown as string[]);
      ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)) as TermServerMsg);
      ws.onopen = () => setTimeout(() => resolve({ ws, msgs, opened: true }), 100);
      ws.onerror = () => resolve({ ws, msgs, opened: false });
    });
  return { host, open, sent };
}

describe("WS /terminal/:id über echten Server", () => {
  it("fremder Origin (auch anderer localhost-Port) oder gar keiner → abgelehnt, trotz gültigem Cookie", async () => {
    const { host, open } = await startServer();
    expect((await open("/terminal/claude:s-ws?mode=rw", "http://localhost:5173")).opened).toBe(false);
    expect((await open("/terminal/claude:s-ws?mode=rw", "https://boese.example")).opened).toBe(false);
    expect((await open("/terminal/claude:s-ws?mode=rw", null)).opened).toBe(false);
    const ok = await open("/terminal/claude:s-ws?mode=rw", `http://${host}`);
    expect(ok.opened).toBe(true);
    ok.ws.close();
  });

  it("„Nur ansehen“: Eingabe und Größe erreichen die Brücke nie; Abzug trägt readOnly", async () => {
    const { host, open, sent } = await startServer();
    const c = await open("/terminal/claude:s-ws?mode=ro&cols=100&rows=30", `http://${host}`);
    c.ws.send(JSON.stringify({ t: "in", d: "rm -rf /\r" }));
    c.ws.send(JSON.stringify({ t: "resize", cols: 200, rows: 50 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.map((m) => m.op)).toEqual(["open"]);
    expect(sent[0]).toMatchObject({ op: "open", tmuxName: "zc-claude-wstest01", readOnly: true });
    expect(c.msgs).toContainEqual(expect.objectContaining({ t: "snapshot", readOnly: true }));
    c.ws.close();
  });

  it("Schreiben: Eingabe und Größe gehen an denselben Kanal; ohne mode ist der Kanal nur zum Ansehen", async () => {
    const { host, open, sent } = await startServer();
    const c = await open("/terminal/claude:s-ws?mode=rw", `http://${host}`);
    c.ws.send(JSON.stringify({ t: "in", d: "ls\r" }));
    c.ws.send(JSON.stringify({ t: "resize", cols: 90, rows: 20 }));
    await new Promise((r) => setTimeout(r, 100));
    const ch = (sent[0] as { ch: number }).ch;
    expect(sent.slice(1)).toEqual([
      { op: "in", ch, d: "ls\r" },
      { op: "resize", ch, cols: 90, rows: 20 },
    ]);
    expect(c.msgs).toContainEqual(expect.objectContaining({ t: "snapshot", readOnly: false }));
    c.ws.close();
    const d = await open("/terminal/claude:s-ws", `http://${host}`);
    expect(sent.filter((m) => m.op === "open").at(-1)).toMatchObject({ op: "open", readOnly: true });
    d.ws.close();
  });

  it("Session nicht in tmux → Status „nicht anhängbar“, keine Anfrage an die Brücke", async () => {
    const { host, open, sent } = await startServer();
    const c = await open("/terminal/claude:s-plain?mode=rw", `http://${host}`);
    await new Promise((r) => setTimeout(r, 100));
    expect(c.msgs).toContainEqual(expect.objectContaining({ t: "status", s: "not_attachable" }));
    // keine Technik-Meldung („nicht in tmux“) — ein Satz, der sagt, was los ist.
    expect(JSON.stringify(c.msgs)).not.toMatch(/tmux/i);
    expect(JSON.stringify(c.msgs)).toMatch(/eigenen Fenster/);
    expect(sent).toHaveLength(0);
  });
});
