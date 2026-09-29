// „Nyx kann nicht mehr antworten“ – der Cursor-Befehl kam im Browser nie an bzw. wurde still verworfen,
// Nyx sagte nur „wahrscheinlich im Hintergrund“. Jetzt bestätigt jedes Fenster den Empfang; ist nur ein Hintergrund-
// Fenster offen, führt eben dieses aus; das Zeitlimit nennt den echten Grund und steht im Log.
import { describe, expect, it } from "vitest";
import { NyxUiBridge } from "../src/nyx/ui.js";

type Sent = Record<string, unknown>;

function setup(opts: { timeoutMs?: number; graceMs?: number } = {}) {
  const sent: Sent[] = [];
  const logs: Record<string, unknown>[] = [];
  let onSend: ((m: Sent) => void) | null = null;
  const hub = {
    size: 1,
    broadcast(m: unknown) {
      sent.push(m as Sent);
      onSend?.(m as Sent);
    },
  };
  const bridge = new NyxUiBridge({ hub, timeoutMs: opts.timeoutMs ?? 400, hiddenGraceMs: opts.graceMs ?? 30, log: (msg, extra) => logs.push({ msg, ...extra }) });
  return { sent, logs, bridge, answer: (fn: (m: Sent) => void) => (onSend = fn) };
}

const ack = (requestId: unknown, tabId: string, visible: boolean) => ({ type: "nyx.ui.ack", requestId, tabId, visible, route: "/briefing" });

describe("nyx.ui – Empfangsbestätigung und Hintergrund-Fenster", () => {
  it("nur ein Hintergrund-Fenster bestätigt → der Server bittet genau dieses, auszuführen", async () => {
    const { sent, bridge, answer } = setup();
    answer((m) => {
      if (m.type === "nyx.ui") queueMicrotask(() => bridge.receive(ack(m.requestId, "tab-hidden", false)));
      if (m.type === "nyx.ui.run") queueMicrotask(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: true, route: "/sessions" }));
    });
    const r = await bridge.send({ action: "navigate", route: "/sessions" });
    expect(r).toMatchObject({ ok: true, route: "/sessions" });
    expect(sent.map((m) => m.type)).toEqual(["nyx.ui", "nyx.ui.run"]);
    expect(sent[1]).toMatchObject({ tabId: "tab-hidden", requestId: sent[0]?.requestId });
  });

  it("Bestätigung des Hintergrund-Fensters kommt erst NACH der Karenz → trotzdem ausführen statt 12 s warten", async () => {
    const { sent, bridge, answer } = setup({ graceMs: 20 });
    answer((m) => {
      if (m.type === "nyx.ui") setTimeout(() => bridge.receive(ack(m.requestId, "tab-hidden", false)), 60);
      if (m.type === "nyx.ui.run") queueMicrotask(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: true, route: "/sessions" }));
    });
    const r = await bridge.send({ action: "navigate", route: "/sessions" });
    expect(r).toMatchObject({ ok: true, route: "/sessions" });
    expect(sent.map((m) => m.type)).toEqual(["nyx.ui", "nyx.ui.run"]);
  });

  it("späte sichtbare Bestätigung nach der Karenz → kein Hintergrund-Auftrag", async () => {
    const { sent, bridge, answer } = setup({ graceMs: 20 });
    answer((m) => {
      if (m.type !== "nyx.ui") return;
      setTimeout(() => bridge.receive(ack(m.requestId, "tab-vis", true)), 40);
      setTimeout(() => bridge.receive(ack(m.requestId, "tab-hidden", false)), 50);
      setTimeout(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: true }), 80);
    });
    const r = await bridge.send({ action: "click", target: "item:session" });
    expect(r.ok).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(["nyx.ui"]);
  });

  it("ein sichtbares Fenster bestätigt → kein Auftrag an Hintergrund-Fenster", async () => {
    const { sent, bridge, answer } = setup();
    answer((m) => {
      if (m.type !== "nyx.ui") return;
      queueMicrotask(() => bridge.receive(ack(m.requestId, "tab-hidden", false)));
      queueMicrotask(() => bridge.receive(ack(m.requestId, "tab-vis", true)));
      setTimeout(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: true }), 60);
    });
    const r = await bridge.send({ action: "click", target: "item:session" });
    expect(r.ok).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(["nyx.ui"]);
  });

  it("niemand bestätigt → ehrlicher Grund (Verbindung) und Log-Zeile", async () => {
    const { bridge, logs } = setup({ timeoutMs: 60 });
    const r = await bridge.send({ action: "read_screen" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/nicht angekommen/);
    expect(logs).toContainEqual(expect.objectContaining({ msg: "nyx-ui-zeitlimit", action: "read_screen", bestaetigt: 0 }));
  });

  it("sichtbares Fenster bestätigt, liefert aber kein Ergebnis → anderer Grund, nicht „Hintergrund“", async () => {
    const { bridge, logs, answer } = setup({ timeoutMs: 80 });
    answer((m) => {
      if (m.type === "nyx.ui") queueMicrotask(() => bridge.receive(ack(m.requestId, "tab-vis", true)));
    });
    const r = await bridge.send({ action: "click", target: "item:session" });
    expect(r.ok === false && r.reason).toMatch(/nicht fertig/);
    expect(r.ok === false && r.reason).not.toMatch(/Hintergrund/);
    expect(logs).toContainEqual(expect.objectContaining({ msg: "nyx-ui-zeitlimit", sichtbar: 1 }));
  });

  it("zu spätes Ergebnis wird geloggt (Dauer), aber nicht mehr verwendet", async () => {
    const { bridge, logs, sent } = setup({ timeoutMs: 30 });
    await bridge.send({ action: "read_screen" });
    expect(bridge.receive({ type: "nyx.ui.result", requestId: sent[0]?.requestId, ok: true })).toBe(false);
    expect(logs).toContainEqual(expect.objectContaining({ msg: "nyx-ui-spaet" }));
  });

  it("Fehler im Browser landet im Log", async () => {
    const { bridge, logs, answer } = setup();
    answer((m) => {
      if (m.type === "nyx.ui") queueMicrotask(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: false, detail: "Fehler im Browser: kaputt" }));
    });
    const r = await bridge.send({ action: "click", target: "x" });
    expect(r.ok).toBe(false);
    expect(logs).toContainEqual(expect.objectContaining({ msg: "nyx-ui-fehlgeschlagen", detail: "Fehler im Browser: kaputt" }));
  });
});

describe("/live-Herzschlag", () => {
  it("pingt nur, wenn jemand verbunden ist, und lässt sich stoppen", async () => {
    const { LiveHub } = await import("../src/live.js");
    const hub = new LiveHub();
    const got: string[] = [];
    const stop = hub.heartbeat(10);
    await new Promise((r) => setTimeout(r, 35));
    expect(got).toEqual([]);
    hub.add({ send: (d) => got.push(d) });
    await new Promise((r) => setTimeout(r, 35));
    stop();
    const n = got.length;
    expect(n).toBeGreaterThan(0);
    expect(got.every((d) => JSON.parse(d).type === "ping")).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(got.length).toBe(n);
  });
});
