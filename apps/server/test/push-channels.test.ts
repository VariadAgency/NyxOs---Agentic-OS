// Push kommt wirklich an: jede Mitteilung geht an Mac (Brücke), Browser (Live) und iPhone (ntfy).
// Vorher ging alles nur an den eigenen ntfy-Dienst, den kein iPhone erreichen konnte (nur 127.0.0.1).
import type { PushChannelResult, PushSubscribeInfo, PushTestResponse, ServerToBridge } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { MultiChannelSender, type BridgeNotifier, type LiveBroadcaster } from "../src/push/channels.js";
import { notify } from "../src/push/dispatcher.js";
import { loadOrInitSettings, patchSettings } from "../src/push/settings.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

class FakeBridge implements BridgeNotifier {
  calls: Array<{ method: string; params: unknown }> = [];
  constructor(
    public online = true,
    private readonly caps = new Set(["notify"]),
    private readonly answer: { ok: boolean; error?: string } = { ok: true },
  ) {}
  supports(cap: string): boolean {
    return this.caps.has(cap);
  }
  async rpc(method: "notify", params: unknown) {
    this.calls.push({ method, params });
    return this.answer;
  }
}

class FakeLive implements LiveBroadcaster {
  sent: unknown[] = [];
  constructor(public size = 1) {}
  broadcast(message: unknown): void {
    this.sent.push(message);
  }
}

const MSG = { topic: "nyxos-abc", title: "Wartet auf dich", message: "Session „Push“", priority: "default" as const, clickUrl: null, kind: "session_waiting" as const, path: "/sessions/x" };
const byChannel = (rs: PushChannelResult[] | undefined) => Object.fromEntries((rs ?? []).map((r) => [r.channel, r]));

/** Echte BridgeHub mit einer Attrappen-Brücke, die `notify` beantwortet (wie skills-library.test.ts). */
function macBridge(caps: string[] = ["notify"]): { hub: BridgeHub; notified: unknown[] } {
  const hub = new BridgeHub();
  const notified: unknown[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op === "rpc" && msg.method === "notify") {
          notified.push(msg.params);
          queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result: { shown: true } })));
        }
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "p3", tmuxSocket: "nyxos", caps }));
  return { hub, notified };
}

describe("MultiChannelSender", () => {
  it("schickt an die Brücke (RPC notify mit Titel + Text), den Browser und ntfy", async () => {
    const bridge = new FakeBridge();
    const live = new FakeLive(2);
    const ntfy = new FakeNtfySender();
    const res = await new MultiChannelSender({ ntfy: () => ntfy, bridge, live }).send(MSG);
    expect(bridge.calls).toEqual([{ method: "notify", params: { title: "Wartet auf dich", message: "Session „Push“" } }]);
    expect(live.sent).toEqual([expect.objectContaining({ type: "push", kind: "session_waiting", title: "Wartet auf dich", path: "/sessions/x", macShown: true })]);
    expect(ntfy.sent).toHaveLength(1);
    expect(res.ok).toBe(true);
    const r = byChannel(res.channels);
    expect(r.mac?.ok).toBe(true);
    expect(r.browser?.ok).toBe(true);
    expect(r.ntfy?.ok).toBe(true);
  });

  it("ausgeschaltete Wege werden übersprungen, nicht versucht", async () => {
    const bridge = new FakeBridge();
    const ntfy = new FakeNtfySender();
    const res = await new MultiChannelSender({ ntfy: () => ntfy, bridge, live: new FakeLive() }).send({ ...MSG, channels: { ntfy: false, browser: false } });
    expect(ntfy.sent).toHaveLength(0);
    expect(bridge.calls).toHaveLength(1);
    const r = byChannel(res.channels);
    expect(r.ntfy).toMatchObject({ ok: false, skipped: true });
    expect(r.browser).toMatchObject({ ok: false, skipped: true });
  });

  it("nennt den Grund, wenn ein Weg nicht geht (Brücke offline, zu alt, kein Fenster, ntfy weg)", async () => {
    const ntfy = new FakeNtfySender();
    ntfy.nextOk = false;
    const offline = await new MultiChannelSender({ ntfy: () => ntfy, bridge: new FakeBridge(false), live: new FakeLive(0) }).send(MSG);
    const r = byChannel(offline.channels);
    expect(offline.ok).toBe(false);
    expect(r.mac?.detail).toMatch(/nicht verbunden/);
    expect(r.browser?.detail).toMatch(/Kein NyxOS-Fenster/);
    expect(r.ntfy?.detail).toMatch(/lehnt ab \(500\)/);
    const old = await new MultiChannelSender({ ntfy: () => ntfy, bridge: new FakeBridge(true, new Set()), live: new FakeLive() }).send(MSG);
    expect(byChannel(old.channels).mac?.detail).toMatch(/zu alt/);
  });

  it("ntfy-Ziel ntfy.sh nimmt den öffentlichen Transport", async () => {
    const own = new FakeNtfySender();
    const pub = new FakeNtfySender();
    await new MultiChannelSender({ ntfy: (t) => (t === "ntfy_sh" ? pub : own), bridge: new FakeBridge(), live: new FakeLive() }).send({ ...MSG, ntfyTarget: "ntfy_sh" });
    expect(pub.sent).toHaveLength(1);
    expect(own.sent).toHaveLength(0);
  });
});

describe("Dispatcher + Einstellungen", () => {
  it("Standard: Mac + Browser + iPhone an, eigenes ntfy-Ziel", async () => {
    const t = await setup({ pushSender: new FakeNtfySender() });
    const s = await loadOrInitSettings(t.db);
    expect(s.channels).toEqual({ mac: true, browser: true, ntfy: true });
    expect(s.ntfyTarget).toBe("own");
  });

  it("ein Anlass (wartet auf dich) landet über den Dispatcher auf dem Rechner", async () => {
    const { hub, notified } = macBridge();
    const t = await setup({ bridgeHub: hub, pushSender: new FakeNtfySender() });
    const settings = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00" });
    const res = await notify({ kind: "session_waiting", title: "Wartet auf dich", message: "Push reparieren" }, { db: t.db, sender: t.pushSender, settings });
    expect(res.sent).toBe(true);
    expect(notified).toEqual([{ title: "Wartet auf dich", message: "Push reparieren" }]);
    expect(byChannel(res.channels).mac?.ok).toBe(true);
  });

  it("Weg aus in den Einstellungen → der Dispatcher schickt nicht an den Rechner", async () => {
    const { hub, notified } = macBridge();
    const t = await setup({ bridgeHub: hub, pushSender: new FakeNtfySender() });
    const settings = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00", channels: { mac: false } });
    await notify({ kind: "build_red", title: "Build rot", message: "x" }, { db: t.db, sender: t.pushSender, settings });
    expect(notified).toEqual([]);
  });
});

describe("Routen", () => {
  it("POST /api/push/test liefert das Ergebnis je Weg (✓ Mac, ✗ Browser mit Grund, ✓ iPhone)", async () => {
    const { hub, notified } = macBridge();
    const ntfy = new FakeNtfySender();
    const t = await setup({ bridgeHub: hub, pushSender: ntfy });
    const res = await t.app.request("/api/push/test", { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PushTestResponse;
    expect(body.results.map((r) => r.channel)).toEqual(["mac", "browser", "ntfy"]);
    const r = byChannel(body.results);
    expect(r.mac).toMatchObject({ ok: true });
    expect(r.browser).toMatchObject({ ok: false, detail: expect.stringMatching(/Kein NyxOS-Fenster/) });
    expect(r.ntfy).toMatchObject({ ok: true });
    expect(notified).toHaveLength(1);
    expect(ntfy.sent).toHaveLength(1);
  });

  it("POST /api/push/test ignoriert die Ruhezeit (ein Test soll immer ankommen)", async () => {
    const { hub, notified } = macBridge();
    const t = await setup({ bridgeHub: hub, pushSender: new FakeNtfySender() });
    await patchSettings(t.db, { quietStart: "00:00", quietEnd: "23:59" });
    await t.app.request("/api/push/test", { method: "POST", headers: { "content-type": "application/json" } });
    expect(notified).toHaveLength(1);
  });

  it("GET /api/push/subscribe zeigt Thema + ehrlichen Hinweis, nur mit Anmeldung", async () => {
    const anon = await setup({ signedIn: false, pushSender: new FakeNtfySender() });
    expect((await anon.app.request("/api/push/subscribe")).status).toBe(401);

    const t = await setup({ pushSender: new FakeNtfySender() });
    const own = (await (await t.app.request("/api/push/subscribe")).json()) as PushSubscribeInfo;
    expect(own.topic).toMatch(/^nyxos-[0-9a-f]{24}$/);
    expect(own.reachable).toBe(false);
    expect(own.serverUrl).toBeNull();
    expect(own.note).toMatch(/Tailscale/);

    await t.app.request("/api/push/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ntfyTarget: "ntfy_sh" }) });
    const pub = (await (await t.app.request("/api/push/subscribe")).json()) as PushSubscribeInfo;
    expect(pub).toMatchObject({ target: "ntfy_sh", serverUrl: "https://ntfy.sh", reachable: true, topic: own.topic });
  });
});
