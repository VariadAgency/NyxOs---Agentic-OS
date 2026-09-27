// Nyx steuert die Plattform — Server-Teil (Vertrag `nyx.ui`).
// Werkzeuge `ui_navigate`, `ui_click`, `ui_type`, `ui_read_screen` senden `nyx.ui` an den Browser und
// warten auf dessen Antwort (`nyx.ui.result` / `nyx.ui.screen`). Riskante Ziele werden nie geklickt.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { NyxUiBridge, registerNyxUiRoutes, registerNyxUiTools } from "../src/nyx/ui.js";
import { ToolRegistry, type ToolContext } from "../src/haiku/tools.js";

type Sent = Record<string, unknown>;

/** Hub-Attrappe: merkt sich jede Sendung; `reply` antwortet wie ein Browser. */
function fakeHub(viewers = 1) {
  const sent: Sent[] = [];
  let onSend: ((m: Sent) => void) | null = null;
  return {
    sent,
    get size() {
      return viewers;
    },
    broadcast(message: unknown) {
      sent.push(message as Sent);
      onSend?.(message as Sent);
    },
    answerWith(fn: (m: Sent) => void) {
      onSend = fn;
    },
  };
}

// der Nutzer selbst (Web-Chat): nur solche Runden dürfen klicken/tippen/wählen.
const ctx = { db: null, scope: "full", ideaLink: null, ideas: null, kind: "chat", channel: "web" } as unknown as ToolContext;

function setupTools(viewers = 1, timeoutMs = 500) {
  const hub = fakeHub(viewers);
  const bridge = new NyxUiBridge({ hub, timeoutMs });
  const reg = new ToolRegistry();
  registerNyxUiTools(reg, bridge);
  return { hub, bridge, reg };
}

describe("NyxUiBridge", () => {
  it("sendet nyx.ui mit requestId und löst mit der Browser-Antwort auf", async () => {
    const { hub, bridge } = setupTools();
    hub.answerWith((m) => queueMicrotask(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: true, route: "/git" })));
    const r = await bridge.send({ action: "navigate", route: "/git" });
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]).toMatchObject({ type: "nyx.ui", action: "navigate", route: "/git" });
    expect(typeof hub.sent[0]?.requestId).toBe("string");
    expect(r).toMatchObject({ ok: true, route: "/git" });
  });

  it("ohne offenes NyxOS-Fenster: ehrliche Antwort sofort, nichts gesendet", async () => {
    const { hub, bridge } = setupTools(0);
    const r = await bridge.send({ action: "navigate", route: "/git" });
    expect(hub.sent).toHaveLength(0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/kein NyxOS-Fenster/);
  });

  it("Zeitlimit: Browser antwortet nicht → ok:false statt Hängen", async () => {
    const { bridge } = setupTools(1, 30);
    const r = await bridge.send({ action: "click", target: "nav:git" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/nicht angekommen/);
  });

  it("fremde/unbekannte Antworten werden ignoriert", () => {
    const { bridge } = setupTools();
    expect(bridge.receive({ type: "nyx.ui.result", requestId: "unbekannt-12345", ok: true })).toBe(false);
    expect(bridge.receive({ type: "etwas" })).toBe(false);
    expect(bridge.receive("kaputt")).toBe(false);
  });
});

describe("Werkzeuge ui_*", () => {
  it("vier Werkzeuge im Umfang full, keins im Ideen-Link-Umfang", () => {
    const { reg } = setupTools();
    for (const name of ["ui_navigate", "ui_click", "ui_type", "ui_read_screen"]) expect(reg.namesFor("full")).toContain(name);
    expect(reg.namesFor("idealink").filter((n) => n.startsWith("ui_"))).toEqual([]);
  });

  it("ui_navigate lehnt fremde Adressen ab", async () => {
    const { reg } = setupTools();
    await expect(reg.call("full", "ui_navigate", { route: "https://evil.example" }, ctx)).rejects.toThrow(/Ungültige Eingabe/);
    await expect(reg.call("full", "ui_navigate", { route: "//evil.example" }, ctx)).rejects.toThrow(/Ungültige Eingabe/);
  });

  it("ui_click auf ein riskantes Ziel klickt nie – es wird nur gezeigt (highlight)", async () => {
    const { hub, bridge, reg } = setupTools();
    hub.answerWith((m) => queueMicrotask(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: true })));
    const r = (await reg.call("full", "ui_click", { target: "Session löschen" }, ctx)) as Record<string, unknown>;
    expect(hub.sent.map((m) => m.action)).toEqual(["highlight"]);
    expect(r).toMatchObject({ erledigt: false, riskant: true });
  });

  it("ui_click: meldet der Browser „riskant“, sagt das Werkzeug das ehrlich", async () => {
    const { hub, bridge, reg } = setupTools();
    hub.answerWith((m) => queueMicrotask(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: false, risky: true, detail: "nur gezeigt" })));
    const r = (await reg.call("full", "ui_click", { target: "karte-ok" }, ctx)) as Record<string, unknown>;
    expect(hub.sent[0]).toMatchObject({ action: "click", target: "karte-ok" });
    expect(r).toMatchObject({ erledigt: false, riskant: true });
  });

  it("ui_type schickt Ziel und Text", async () => {
    const { hub, bridge, reg } = setupTools();
    hub.answerWith((m) => queueMicrotask(() => bridge.receive({ type: "nyx.ui.result", requestId: m.requestId, ok: true })));
    const r = (await reg.call("full", "ui_type", { target: "suche", text: "Heatmap" }, ctx)) as Record<string, unknown>;
    expect(hub.sent[0]).toMatchObject({ type: "nyx.ui", action: "type", target: "suche", text: "Heatmap" });
    expect(r).toMatchObject({ erledigt: true });
  });

  it("ui_read_screen liefert Route und sichtbare Elemente", async () => {
    const { hub, bridge, reg } = setupTools();
    hub.answerWith((m) =>
      queueMicrotask(() =>
        bridge.receive({
          type: "nyx.ui.screen",
          requestId: m.requestId,
          route: "/sessions",
          title: "Sessions",
          elements: [
            { id: "recent", label: "Zuletzt geöffnet", kind: "button", risk: false },
            { id: "close-confirm", label: "Session schließen", kind: "button", risk: true },
          ],
        }),
      ),
    );
    const r = (await reg.call("full", "ui_read_screen", {}, ctx)) as { route: string; elemente: { id: string; riskant: boolean }[] };
    expect(hub.sent[0]).toMatchObject({ type: "nyx.ui", action: "read_screen" });
    expect(r.route).toBe("/sessions");
    expect(r.elemente).toEqual([
      { id: "recent", label: "Zuletzt geöffnet", art: "button", riskant: false },
      { id: "close-confirm", label: "Session schließen", art: "button", riskant: true },
    ]);
  });
});

describe("Routen /api/nyx/ui/*", () => {
  function app() {
    const { hub, bridge } = setupTools();
    const a = new Hono();
    registerNyxUiRoutes(a as never, { bridge });
    return { a, hub, bridge };
  }

  it("POST /api/nyx/ui/reply beantwortet eine offene Anfrage", async () => {
    const { a, hub, bridge } = app();
    const pending = bridge.send({ action: "highlight", target: "nav:git" });
    const requestId = String(hub.sent[0]?.requestId);
    const res = await a.request("/api/nyx/ui/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "nyx.ui.result", requestId, ok: true }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(await pending).toMatchObject({ ok: true });
  });

  it("POST /api/nyx/ui/reply mit kaputter Antwort → 400", async () => {
    const { a } = app();
    const res = await a.request("/api/nyx/ui/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "nyx.ui.result" }) });
    expect(res.status).toBe(400);
  });

  it("POST /api/nyx/ui/command prüft den Befehl (fremde Route → 400)", async () => {
    const { a } = app();
    const res = await a.request("/api/nyx/ui/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "navigate", route: "http://x" }) });
    expect(res.status).toBe(400);
  });
});
