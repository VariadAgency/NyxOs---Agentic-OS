// Brücke flackert rot/grün. Ursache: Die Web-App rechnete „online" aus
// `machines.last_seen_at` (< 60 s, Browser-Uhr), und diese Spalte wurde nur bei HTTP-Ingest-Aufrufen der
// Brücke frisch — nie über den dauerhaft offenen Kanal `WS /bridge`. In ruhigen Minuten ohne Ereignisse
// sprang die Anzeige auf rot, obwohl der Kanal die ganze Zeit offen war.
// Neu: Der Server rechnet den Zustand selbst (Kanal + Ping/Pong-Lebenszeichen, Server-Uhr), puffert kurze
// Aussetzer als „verbindet neu …" und protokolliert jeden Wechsel in `bridge_events`.
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeEvents, machines } from "../src/db/schema.js";
import {
  BridgePresence,
  GRACE_MS,
  HEARTBEAT_LATE_MS,
  HeartbeatWatch,
  REASONS,
  classifyClose,
  computePresence,
  type PresenceFacts,
} from "../src/bridge/presence.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { TOKEN, setup } from "./helpers.js";

const T0 = Date.parse("2026-09-25T08:34:26.862Z");
const base: PresenceFacts = { channelOpen: true, openSince: T0, lastHeartbeatAt: T0, closedAt: null, closeKind: null, startedAt: T0 - 1000 };

describe("computePresence (Server-Uhr, rein)", () => {
  it("Kanal offen + Lebenszeichen frisch → online, auch wenn seit Minuten kein Ingest kam", () => {
    const v = computePresence({ ...base, lastHeartbeatAt: T0 + 10 * 60_000 }, T0 + 10 * 60_000 + 5_000);
    expect(v.state).toBe("online");
    expect(v.reason).toBeNull();
    expect(v.heartbeatAgeMs).toBe(5_000);
  });

  it("Lebenszeichen genau an der Kante: 44 999 ms online, 45 000 ms „verbindet neu“ (nie rot)", () => {
    expect(computePresence(base, T0 + HEARTBEAT_LATE_MS - 1).state).toBe("online");
    const late = computePresence(base, T0 + HEARTBEAT_LATE_MS);
    expect(late.state).toBe("reconnecting");
    expect(late.reason).toBe(REASONS.late);
  });

  it("Kanal offen, Lebenszeichen verspätet bis knapp 90 s → verbindet neu; ab 90 s → offline „Rechner schläft/offline“", () => {
    expect(computePresence(base, T0 + GRACE_MS - 1).state).toBe("reconnecting");
    const off = computePresence(base, T0 + GRACE_MS);
    expect(off).toMatchObject({ state: "offline", reason: REASONS.silent, since: T0 });
  });

  it("kurzer Aussetzer (Tunnel-Neuaufbau < 90 s) → verbindet neu, nicht rot", () => {
    const f: PresenceFacts = { ...base, channelOpen: false, closedAt: T0 + 60_000, closeKind: "tunnel" };
    expect(computePresence(f, T0 + 60_000 + 30_000)).toMatchObject({ state: "reconnecting", reason: REASONS.reconnect, since: T0 + 60_000 });
    expect(computePresence(f, T0 + 60_000 + GRACE_MS - 1).state).toBe("reconnecting");
  });

  it("echter Ausfall zeigt Grund und Beginn: Tunnel zu / Dienst gestoppt / Rechner schläft", () => {
    const closed = (closeKind: PresenceFacts["closeKind"]): PresenceFacts => ({ ...base, channelOpen: false, closedAt: T0 + 1000, closeKind });
    const at = T0 + 1000 + GRACE_MS;
    expect(computePresence(closed("tunnel"), at)).toMatchObject({ state: "offline", reason: REASONS.tunnel, since: T0 + 1000 });
    expect(computePresence(closed("stopped"), at)).toMatchObject({ state: "offline", reason: REASONS.stopped });
    expect(computePresence(closed("silent"), at)).toMatchObject({ state: "offline", reason: REASONS.silent });
  });

  it("nach Server-Neustart ohne Brücke: erst 90 s „verbindet neu“, dann offline", () => {
    const f: PresenceFacts = { channelOpen: false, openSince: null, lastHeartbeatAt: null, closedAt: null, closeKind: null, startedAt: T0 };
    expect(computePresence(f, T0 + 10_000)).toMatchObject({ state: "reconnecting", reason: REASONS.serverRestart });
    expect(computePresence(f, T0 + GRACE_MS)).toMatchObject({ state: "offline", reason: REASONS.never });
  });

  it("Schließ-Codes: 1000/1001/1005 = Dienst gestoppt, 1006 und Rest = Tunnel zu", () => {
    expect(classifyClose(1000)).toBe("stopped");
    expect(classifyClose(1001)).toBe("stopped");
    expect(classifyClose(1005)).toBe("stopped");
    expect(classifyClose(1006)).toBe("tunnel");
    expect(classifyClose(undefined)).toBe("tunnel");
  });
});

describe("HeartbeatWatch (Ping/Pong am rohen Socket)", () => {
  function fakeSocket() {
    const s = { pings: 0, terminated: false, pong: null as null | (() => void) };
    return {
      s,
      raw: {
        ping: () => void s.pings++,
        on: (ev: string, fn: () => void) => {
          if (ev === "pong") s.pong = fn;
        },
        terminate: () => void (s.terminated = true),
      },
    };
  }

  it("Pong zählt als Lebenszeichen; ohne Antwort 90 s lang wird der Socket getrennt (Grund: still)", () => {
    let now = T0;
    const beats: number[] = [];
    let silentCalled = false;
    const { s, raw } = fakeSocket();
    const w = new HeartbeatWatch(raw, { now: () => now, onBeat: () => beats.push(now), onSilent: () => (silentCalled = true), lastBeat: () => beats.at(-1) ?? T0 });
    w.tick();
    expect(s.pings).toBe(1);
    now += 15_000;
    s.pong?.();
    expect(beats).toEqual([T0 + 15_000]);
    now += GRACE_MS - 1;
    w.tick();
    expect(s.terminated).toBe(false);
    now += 1;
    w.tick();
    expect(s.terminated).toBe(true);
    expect(silentCalled).toBe(true);
  });
});

describe("BridgePresence · Verlauf (bridge_events)", () => {
  it("protokolliert Wechsel; „verbindet neu“ → online bleibt als kurzer Aussetzer, → offline wird zur Ausfall-Zeile", async () => {
    const { db } = await setup();
    let now = T0;
    const p = new BridgePresence({ db, now: () => now });
    await p.tick(); // Server gerade gestartet, keine Brücke
    p.connected("m1");
    now += 5_000;
    await p.tick();
    // kurzer Aussetzer: 20 s zu, dann wieder offen
    now += 60_000;
    p.heartbeat();
    p.disconnected("tunnel");
    const blipAt = now;
    now += 5_000;
    await p.tick();
    now += 15_000;
    p.connected("m1");
    await p.tick();
    // echter Ausfall: Dienst gestoppt, 3 min weg
    now += 60_000;
    p.disconnected("stopped");
    const outAt = now;
    now += 5_000;
    await p.tick();
    now += GRACE_MS;
    await p.tick();
    now += 90_000;
    p.connected("m1");
    await p.tick();

    const rows = await db.select().from(bridgeEvents).orderBy(bridgeEvents.id);
    expect(rows.map((r) => [r.state, r.reason])).toEqual([
      ["reconnecting", REASONS.serverRestart],
      ["online", null],
      ["reconnecting", REASONS.reconnect],
      ["online", null],
      ["offline", REASONS.stopped],
      ["online", null],
    ]);
    expect(Date.parse(rows[2]?.at ?? "")).toBe(blipAt);
    expect(Date.parse(rows[4]?.at ?? "")).toBe(outAt); // Beginn des Ausfalls, nicht der Zeitpunkt der Erkennung

    const hist = await p.history(24);
    expect(hist.map((h) => h.durationMs)).toEqual([0, 65_000, 20_000, 60_000, 5_000 + GRACE_MS + 90_000, null]);
    expect(hist[4]).toMatchObject({ state: "offline", reason: REASONS.stopped, durationMs: 5_000 + GRACE_MS + 90_000 });
  });

  it("räumt auf: Einträge älter als 30 Tage werden gelöscht, jüngere bleiben", async () => {
    const { db } = await setup();
    let now = T0;
    await db.insert(bridgeEvents).values([
      { machineId: "m1", at: new Date(T0 - 31 * 86_400_000).toISOString(), state: "online", reason: null },
      { machineId: "m1", at: new Date(T0 - 29 * 86_400_000).toISOString(), state: "offline", reason: REASONS.silent },
    ]);
    const p = new BridgePresence({ db, now: () => now });
    p.connected("m1");
    await p.flush();
    const left = await db.select().from(bridgeEvents).orderBy(bridgeEvents.at);
    expect(left.map((r) => r.state)).toEqual(["offline", "online"]);
    // weitere Takte ändern nichts am Verlauf
    for (let i = 0; i < 10; i++) {
      now += 5_000;
      p.heartbeat();
      await p.tick();
    }
    expect(await db.select().from(bridgeEvents)).toHaveLength(2);
  });

  it("Lebenszeichen hält machines.last_seen_at frisch (gedrosselt), ohne einen einzigen Ingest-Aufruf", async () => {
    const { db } = await setup();
    let now = T0;
    const p = new BridgePresence({ db, now: () => now });
    p.connected("m1");
    for (let i = 0; i < 12; i++) {
      now += 15_000;
      p.heartbeat();
    }
    await p.flush();
    const [m] = await db.select({ lastSeenAt: machines.lastSeenAt }).from(machines).where(eq(machines.id, "m1"));
    // letzter Schreibvorgang höchstens 30 s vor dem letzten Lebenszeichen
    expect(now - Date.parse(m?.lastSeenAt ?? "")).toBeLessThanOrEqual(30_000);
  });
});

describe("GET /api/bridge/presence über echten Server + echte Brücken-Verbindung", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const c of closers.splice(0)) c();
  });

  async function start() {
    let now = T0;
    const hub = new BridgeHub();
    const ctx = await setup({ bridgeHub: hub, bridgeNow: () => now, bridgePingMs: 30 });
    const presence = ctx.bridgePresence;
    const server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
    ctx.injectWebSocket(server);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    closers.push(() => server.close());
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { authorization: `Bearer ${TOKEN}` } } as unknown as string[]);
    await new Promise((r) => ws.addEventListener("open", r));
    closers.push(() => ws.close());
    await new Promise((r) => setTimeout(r, 80));
    const get = async () => (await ctx.app.request("/api/bridge/presence")).json() as Promise<Record<string, unknown>>;
    return { ctx, ws, get, presence, advance: (ms: number) => (now += ms), port };
  }

  it("Kanal offen, 2 min kein Ingest, Pongs kommen → online (vorher: rot nach 60 s)", async () => {
    const { get, advance } = await start();
    expect(await get()).toMatchObject({ state: "online", channelOpen: true, machine: { name: "macbook" } });
    for (let i = 0; i < 8; i++) {
      advance(15_000);
      await new Promise((r) => setTimeout(r, 50)); // Server pingt alle 30 ms, der WebSocket-Client antwortet selbst
    }
    const p = await get();
    expect(p.state).toBe("online");
    expect(p.heartbeatAgeMs as number).toBeLessThan(HEARTBEAT_LATE_MS);
    expect(typeof p.serverNow).toBe("string");
  });

  it("Brücke beendet sich sauber (1000) → erst „verbindet neu“, nach 90 s „Dienst gestoppt“ mit Beginn", async () => {
    const { ws, get, advance, ctx } = await start();
    ws.close(1000, "beende"); // WebSocket-API erlaubt Clients nur 1000 oder 3000–4999
    await new Promise((r) => setTimeout(r, 80));
    expect(await get()).toMatchObject({ state: "reconnecting", channelOpen: false });
    advance(GRACE_MS);
    const p = await get();
    expect(p).toMatchObject({ state: "offline", reason: REASONS.stopped });
    expect(typeof p.since).toBe("string");
    const h = (await (await ctx.app.request("/api/bridge/presence/history?hours=24")).json()) as { events: { state: string }[] };
    expect(h.events.map((e) => e.state)).toContain("offline");
  });
});
