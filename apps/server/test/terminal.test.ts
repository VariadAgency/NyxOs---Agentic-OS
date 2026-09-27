// Server-Seite des Terminals: Anmeldung/CSRF, Brücken-Verbindung (Kanäle, RPC,
// Gegendruck, offline), Start/Fortsetzen/Beenden über die Brücke, tmux-Zuordnung im Ingest, Zustand
// „wartet" aus dem Bildschirm.
import type { ServerToBridge, TermServerMsg } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authSessions, sessions } from "../src/db/schema.js";
import { computeSessionState } from "../src/state.js";
import { CSRF_HEADER, SESSION_COOKIE, consumeSetupCode, createSetupCode, needsAuth } from "../src/terminal/auth.js";
import { BridgeHub, HIGH_WATER, type BrowserSink } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

const now = Date.parse("2026-09-25T10:00:00Z");

/** Eine Brücke im selben Prozess: beantwortet RPCs über `reply`, merkt sich alles Gesendete. */
function fakeBridge(hub: BridgeHub, reply: (msg: ServerToBridge) => unknown = () => undefined) {
  const sent: ServerToBridge[] = [];
  const socket = {
    send(data: string) {
      const msg = JSON.parse(data) as ServerToBridge;
      sent.push(msg);
      const answer = reply(msg);
      if (answer !== undefined) queueMicrotask(() => hub.handle(JSON.stringify(answer)));
    },
    close() {},
  };
  hub.attach(socket, "m1");
  return { sent, socket };
}

function sink() {
  const got: TermServerMsg[] = [];
  let buffered = 0;
  let closed = false;
  const s: BrowserSink & { got: TermServerMsg[]; setBuffered(n: number): void; closed(): boolean } = {
    got,
    send: (m) => got.push(m),
    buffered: () => buffered,
    close: () => (closed = true),
    setBuffered: (n) => (buffered = n),
    closed: () => closed,
  };
  return s;
}

describe("Zustand aus dem Bildschirm (Schritt 5)", () => {
  const base = { status: "running", turnOpen: true, sessionEndReceivedAt: null, lastActivityAt: new Date(now - 1000).toISOString(), closedAt: null };
  it("Freigabe-Frage im Bildschirm → wartet, auch wenn der Hook die Runde noch offen hält", () => {
    expect(computeSessionState({ ...base, screenWaiting: true }, now)).toBe("waiting");
    expect(computeSessionState({ ...base, screenWaiting: false }, now)).toBe("running");
  });
  it("nur ergänzend: nie gegen geschlossen, nie bei totem Prozess", () => {
    expect(computeSessionState({ ...base, screenWaiting: true, closedAt: new Date(now).toISOString() }, now)).toBe("closed");
    expect(computeSessionState({ ...base, status: "ended", screenWaiting: true }, now)).toBe("crashed");
  });
});

describe("Anmeldung für alles, was schreibt", () => {
  it("welche Wege geschützt sind", () => {
    expect(needsAuth("POST", "/api/sessions/x/close", false)).toBe(true);
    expect(needsAuth("GET", "/terminal/abc", false)).toBe(true);
    expect(needsAuth("GET", "/api/sessions", false)).toBe(false);
    expect(needsAuth("GET", "/api/sessions", true)).toBe(true);
    expect(needsAuth("GET", "/live", true)).toBe(true);
    expect(needsAuth("POST", "/api/auth/login/options", false)).toBe(false);
    expect(needsAuth("POST", "/ingest/events", false)).toBe(false);
  });

  it("ohne Anmeldung lehnen Terminal-Kanal, Start, Fortsetzen, Beenden und alle schreibenden Endpunkte mit 401 ab", async () => {
    const { app } = await setup({ signedIn: false });
    const json = { "content-type": "application/json" };
    const cases: [string, string][] = [
      ["POST", "/api/terminal/start"],
      ["POST", "/api/sessions/claude:x/resume"],
      ["POST", "/api/sessions/claude:x/kill"],
      ["POST", "/api/sessions/claude:x/close"],
      ["POST", "/api/sessions/claude:x/reopen"],
      ["POST", "/api/sessions/claude:x/assign"],
      ["POST", "/api/sessions/claude:x/assign/preview"],
      ["POST", "/api/sessions/claude:x/unassign"],
      ["PATCH", "/api/sort-rules/1"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, { method, headers: json, body: "{}" });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    const ws = await app.request("/terminal/claude:x?mode=rw", { headers: { upgrade: "websocket", connection: "Upgrade" } });
    expect(ws.status).toBe(401);
  });

  it("mit Cookie, aber ohne/mit falschem CSRF-Kopf → 403 (CSRF-Test schlägt fehl, wie gewünscht)", async () => {
    const { app, login } = await setup({ signedIn: false });
    const cookie = `${SESSION_COOKIE}=${login.token}`;
    const noCsrf = await app.request("/api/sessions/claude:x/close", { method: "POST", headers: { "content-type": "application/json", cookie }, body: '{"by":"x"}' });
    expect(noCsrf.status).toBe(403);
    const wrong = await app.request("/api/sessions/claude:x/close", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, [CSRF_HEADER]: "falsch" },
      body: '{"by":"x"}',
    });
    expect(wrong.status).toBe(403);
    const ok = await app.request("/api/sessions/claude:x/close", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, [CSRF_HEADER]: login.csrf },
      body: '{"by":"x"}',
    });
    expect(ok.status).toBe(404); // durch die Anmeldung durch, Session gibt es nur nicht
  });

  it("fremder Origin bleibt auch mit gültiger Anmeldung gesperrt (Cross-Site-Anfrage)", async () => {
    const { app } = await setup();
    const res = await app.request("/api/sessions/claude:x/close", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://boese.example", host: "127.0.0.1:47893" },
      body: '{"by":"x"}',
    });
    expect(res.status).toBe(403);
  });

  it("abgelaufene Sitzung zählt nicht", async () => {
    const { app, db, login } = await setup({ signedIn: false });
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await app.request("/api/terminal/start", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("Status-Endpunkt verrät ohne Anmeldung kein CSRF-Token; Passkey-Optionen brauchen einen Namen statt IP", async () => {
    const { app } = await setup({ signedIn: false });
    const st = (await (await app.request("/api/auth/status")).json()) as { authenticated: boolean; csrf: string | null; hasPasskey: boolean };
    expect(st).toMatchObject({ authenticated: false, csrf: null, hasPasskey: false });
    const ip = await app.request("/api/auth/login/options", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:47893" }, body: "{}" });
    expect(ip.status).toBe(400);
    const noKey = await app.request("/api/auth/login/options", { method: "POST", headers: { "content-type": "application/json", host: "localhost:47893" }, body: "{}" });
    expect(noKey.status).toBe(404);
    const reg = await app.request("/api/auth/register/options", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:47893" },
      body: JSON.stringify({ setupCode: "geraten-123456" }),
    });
    expect(reg.status).toBe(403);
  });

  it("die Brücke braucht ihr Maschinen-Token", async () => {
    const { app } = await setup({ signedIn: false });
    expect((await app.request("/bridge", { headers: { upgrade: "websocket" } })).status).toBe(401);
    expect((await app.request("/bridge", { headers: { upgrade: "websocket", authorization: "Bearer falsch" } })).status).toBe(401);
  });

  // der CSRF-Vergleich lief über `!==` statt zeitkonstant. Verhalten bleibt
  // exakt dasselbe (s. Test oben "mit Cookie, aber ohne/mit falschem CSRF-Kopf") — dieser Test prüft
  // zusätzlich Grenzfälle, die eine naive `timingSafeEqual(Buffer.from(a), Buffer.from(b))` OHNE
  // vorheriges Hashen zum Absturz bringen würde (unterschiedlich lange Puffer werfen dort).
  it("CSRF-Vergleich wirft nie, egal wie lang/kurz der mitgeschickte Kopf ist", async () => {
    const { app, login } = await setup({ signedIn: false });
    const cookie = `${SESSION_COOKIE}=${login.token}`;
    for (const bad of ["", "x", "a".repeat(500)]) {
      const res = await app.request("/api/sessions/claude:x/close", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, [CSRF_HEADER]: bad },
        body: '{"by":"x"}',
      });
      expect(res.status).toBe(403);
    }
  });

  // Früher: Prüfung und Verbrauch des Einrichtungs-Codes waren getrennt —
  // zwei parallele Anfragen mit demselben Code hätten beide "gültig" gesehen. Jetzt ein atomares
  // `UPDATE … WHERE used_at IS NULL … RETURNING`: von zwei gleichzeitigen Verbrauchs-Versuchen
  // gewinnt GENAU einer, ein dritter (danach) schlägt ebenfalls fehl.
  it("consumeSetupCode: von zwei gleichzeitigen Versuchen mit demselben Code gewinnt genau einer", async () => {
    const { db } = await setup({ signedIn: false });
    const code = await createSetupCode(db);
    const [a, b] = await Promise.all([consumeSetupCode(db, code), consumeSetupCode(db, code)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await consumeSetupCode(db, code)).toBe(false); // schon verbraucht — auch danach kein zweites Mal
  });
});

describe("BridgeHub: Kanäle, RPC, Gegendruck, offline", () => {
  it("leitet Bildschirm und Ausgabe an den richtigen Kanal, Eingabe/Größe an die Brücke", () => {
    const hub = new BridgeHub();
    const { sent } = fakeBridge(hub);
    const a = sink();
    const b = sink();
    const cha = hub.open({ tmuxName: "zc-claude-abcd1234", cols: 80, rows: 24, readOnly: false }, a);
    const chb = hub.open({ tmuxName: "zc-claude-abcd1234", cols: 100, rows: 30, readOnly: true }, b);
    if (!cha || !chb) throw new Error("kein Kanal");
    expect(cha.id).not.toBe(chb.id);
    hub.handle(JSON.stringify({ op: "snapshot", ch: cha.id, d: "hallo", cols: 80, rows: 24, cursor: { x: 5, y: 0 } }));
    hub.handle(JSON.stringify({ op: "out", ch: chb.id, d: "nur b" }));
    expect(a.got).toEqual([{ t: "snapshot", d: "hallo", cols: 80, rows: 24, cursor: { x: 5, y: 0 }, readOnly: false }]);
    expect(b.got).toEqual([{ t: "out", d: "nur b" }]);
    cha.input("ls\r");
    cha.resize(90, 20);
    cha.close();
    cha.input("nach dem Schließen");
    expect(sent.map((m) => m.op)).toEqual(["open", "open", "in", "resize", "close"]);
    expect(sent[2]).toMatchObject({ op: "in", ch: cha.id, d: "ls\r" });
  });

  it("ungültige Nachrichten der Brücke werden verworfen, ohne Absturz", () => {
    const hub = new BridgeHub();
    fakeBridge(hub);
    expect(() => hub.handle("kein json")).not.toThrow();
    expect(() => hub.handle(JSON.stringify({ op: "out", ch: "x" }))).not.toThrow();
  });

  it("RPC: Antwort kommt beim Aufrufer an; ohne Brücke sofort bridge_offline", async () => {
    const hub = new BridgeHub();
    expect(await hub.rpc("start", {})).toMatchObject({ ok: false, code: "bridge_offline" });
    fakeBridge(hub, (m) => (m.op === "rpc" ? { op: "rpc_result", id: m.id, ok: true, result: { echo: m.method } } : undefined));
    expect(await hub.rpc("list_folders", {})).toEqual({ ok: true, result: { echo: "list_folders" }, error: undefined, code: undefined });
  });

  it("RPC ohne Antwort endet mit timeout", async () => {
    const hub = new BridgeHub();
    fakeBridge(hub);
    expect(await hub.rpc("start", {}, 20)).toMatchObject({ ok: false, code: "timeout" });
  });

  it("Gegendruck: staut sich der Browser, wird der Kanal angehalten und später fortgesetzt", async () => {
    const hub = new BridgeHub();
    const { sent } = fakeBridge(hub);
    const s = sink();
    const ch = hub.open({ tmuxName: "zc-claude-abcd1234", cols: 80, rows: 24, readOnly: false }, s);
    if (!ch) throw new Error("kein Kanal");
    s.setBuffered(HIGH_WATER + 1);
    hub.handle(JSON.stringify({ op: "out", ch: ch.id, d: "x" }));
    hub.handle(JSON.stringify({ op: "out", ch: ch.id, d: "y" }));
    expect(sent.filter((m) => m.op === "pause")).toHaveLength(1);
    s.setBuffered(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.filter((m) => m.op === "resume")).toHaveLength(1);
    expect(s.got.map((m) => (m.t === "out" ? m.d : ""))).toEqual(["x", "y"]); // nichts verloren
  });

  it("Brücke weg → alle Kanäle bekommen „Mac offline“, offene RPCs enden sofort", async () => {
    const changes: boolean[] = [];
    const hub = new BridgeHub((o) => changes.push(o));
    const { socket } = fakeBridge(hub);
    const s = sink();
    hub.open({ tmuxName: "zc-claude-abcd1234", cols: 80, rows: 24, readOnly: false }, s);
    const pending = hub.rpc("start", {});
    hub.detach(socket);
    expect(await pending).toMatchObject({ ok: false, code: "bridge_offline" });
    expect(s.got).toContainEqual({ t: "status", s: "bridge_offline", msg: "Brücke getrennt" });
    expect(s.closed()).toBe(true);
    expect(hub.online).toBe(false);
    expect(changes).toEqual([true, false]);
  });
});

describe("Starten, Fortsetzen, Beenden über die Brücke", () => {
  it("Start: Claude-Session erscheint sofort mit tmux-Namen in der Liste", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    const sid = "0b5e2b1c-1111-4222-8333-944455556666";
    fakeBridge(hub, (m) =>
      m.op === "rpc" && m.method === "start"
        ? { op: "rpc_result", id: m.id, ok: true, result: { tmuxName: "zc-claude-q1w2e3r4", tool: "claude", sessionId: sid, startedMs: 120 } }
        : undefined,
    );
    const res = await app.request("/api/terminal/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", model: "opus", cwd: "/Users/x/projects", prompt: null }),
    });
    expect(res.status).toBe(200);
    const list = (await (await app.request("/api/sessions")).json()) as { sessions: { sessionId: string; tmuxName: string; attachable: boolean; state: string }[] };
    expect(list.sessions.find((s) => s.sessionId === sid)).toMatchObject({ tmuxName: "zc-claude-q1w2e3r4", attachable: true, state: "running" });
  });

  it("Start lehnt ungültige Angaben ab, bevor die Brücke gefragt wird (Modell mit Shell-Zeichen)", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    const { sent } = fakeBridge(hub);
    const res = await app.request("/api/terminal/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", model: "opus; rm -rf ~", cwd: "/x" }),
    });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("Fortsetzen bei noch laufendem Prozess → 409, keine Änderung an der Session", async () => {
    const hub = new BridgeHub();
    const { app, post, db } = await setup({ bridgeHub: hub });
    await post("/ingest/events", { items: [{ type: "state", state: { tool: "claude", sessionId: "s-run", running: true, observedAt: new Date().toISOString() } }] });
    fakeBridge(hub, (m) => (m.op === "rpc" ? { op: "rpc_result", id: m.id, ok: false, error: "Prozess läuft noch", code: "process_running" } : undefined));
    const res = await app.request("/api/sessions/claude:s-run/resume", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(409);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, "claude:s-run"));
    expect(row?.tmuxName).toBeNull();
  });

  it("Beenden braucht eine ausdrückliche Bestätigung", async () => {
    const hub = new BridgeHub();
    const { app, post } = await setup({ bridgeHub: hub });
    await post("/ingest/events", { items: [{ type: "state", state: { tool: "claude", sessionId: "s-k", running: true, observedAt: new Date().toISOString() } }] });
    const { sent } = fakeBridge(hub, (m) => (m.op === "rpc" ? { op: "rpc_result", id: m.id, ok: true, result: { killed: true } } : undefined));
    const no = await app.request("/api/sessions/claude:s-k/kill", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(no.status).toBe(400);
    expect(sent).toHaveLength(0);
    const yes = await app.request("/api/sessions/claude:s-k/kill", { method: "POST", headers: { "content-type": "application/json" }, body: '{"confirm":true}' });
    expect(yes.status).toBe(200);
    expect(sent[0]).toMatchObject({ op: "rpc", method: "kill" });
  });

  it("Terminal-Kanal ohne Brücke/ohne tmux: Status-Endpunkt meldet offline", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    expect(await (await app.request("/api/terminal/status")).json()).toMatchObject({ online: false });
    fakeBridge(hub);
    expect(await (await app.request("/api/terminal/status")).json()).toMatchObject({ online: true, machineId: "m1" });
  });
});

describe("tmux-Zuordnung im Ingest", () => {
  it("setzt tmux_name/attachable/screen_waiting; ältere Meldungen überschreiben nie neuere", async () => {
    const { post, db } = await setup();
    const t1 = "2026-09-25T10:00:00.000Z";
    const t0 = "2026-09-25T09:59:00.000Z";
    await post("/ingest/events", {
      items: [
        { type: "state", state: { tool: "claude", sessionId: "s-t", running: true, observedAt: t1 } },
        { type: "terminal", terminal: { tool: "claude", sessionId: "s-t", tmuxName: "zc-claude-abcd1234", attachable: true, screenWaiting: true, observedAt: t1 } },
      ],
    });
    let [row] = await db.select().from(sessions).where(eq(sessions.id, "claude:s-t"));
    expect(row).toMatchObject({ tmuxName: "zc-claude-abcd1234", attachable: true, screenWaiting: true, state: "waiting" });
    await post("/ingest/events", {
      items: [{ type: "terminal", terminal: { tool: "claude", sessionId: "s-t", tmuxName: null, attachable: false, screenWaiting: null, observedAt: t0 } }],
    });
    [row] = await db.select().from(sessions).where(eq(sessions.id, "claude:s-t"));
    expect(row).toMatchObject({ tmuxName: "zc-claude-abcd1234", attachable: true });
  });

  it("lehnt tmux-Namen ab, die nicht dem Muster zc-<werkzeug>-<id> folgen", async () => {
    const { post } = await setup();
    const res = await post("/ingest/events", {
      items: [{ type: "terminal", terminal: { tool: "claude", sessionId: "s-x", tmuxName: "evil;kill-server", attachable: true, observedAt: new Date().toISOString() } }],
    });
    expect(res.status).toBe(400);
  });
});
