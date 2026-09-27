// Brücken-Befehle ohne Verzögerung (früher kam die ~/Downloads-Liste erst nach 6,8 s): Der Server stellt einen Brücken-Befehl
// sofort zu (kein Abfrage-Takt, keine Warteschlange) und loggt langsame Antworten mit Aufteilung in
// „Mac rechnet“ (`macMs`, meldet die Brücke) und „Weg“ (`wegMs`, SSH-Tunnel hin und zurück + Warten).
import { describe, expect, it } from "vitest";
import { BridgeHub, RPC_SLOW_MS } from "../src/terminal/bridgeHub.js";

function hubWithClock() {
  let now = 1000;
  const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
  const sent: string[] = [];
  const hub = new BridgeHub(
    () => {},
    (msg, extra) => logs.push({ msg, extra }),
    () => now,
  );
  hub.attach({ send: (d) => sent.push(d), close: () => {} }, "mac");
  return { hub, logs, sent, tick: (ms: number) => (now += ms) };
}

describe("Brücken-Befehle: sofort zugestellt, langsame belegt", () => {
  it("der Befehl geht im selben Moment an die Brücke (nicht erst beim nächsten Takt)", () => {
    const { hub, sent } = hubWithClock();
    void hub.rpc("finder", { op: "list", root: "downloads", rel: "" });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ op: "rpc", method: "finder", params: { op: "list" } });
  });

  it("langsame Antwort: Log mit Gesamtzeit, Mac-Zeit und Weg-Zeit", async () => {
    const { hub, sent, logs, tick } = hubWithClock();
    const p = hub.rpc("finder", { op: "list", root: "downloads", rel: "" });
    const id = (JSON.parse(sent[0] ?? "{}") as { id: number }).id;
    tick(6800);
    hub.handle(JSON.stringify({ op: "rpc_result", id, ok: true, result: { entries: [] }, ms: 25 }));
    expect((await p).ok).toBe(true);
    const slow = logs.find((l) => l.msg === "bruecke-befehl-langsam");
    expect(slow?.extra).toMatchObject({ method: "finder", op: "list", gesamtMs: 6800, macMs: 25, wegMs: 6775 });
  });

  it("schnelle Antwort: kein Log; ältere Brücke ohne `ms`: Mac-Zeit unbekannt statt geraten", async () => {
    const { hub, sent, logs, tick } = hubWithClock();
    const fast = hub.rpc("finder", { op: "roots" });
    tick(RPC_SLOW_MS - 1);
    hub.handle(JSON.stringify({ op: "rpc_result", id: (JSON.parse(sent[0] ?? "{}") as { id: number }).id, ok: true, result: [] }));
    await fast;
    expect(logs).toHaveLength(0);
    const old = hub.rpc("finder", { op: "roots" });
    tick(RPC_SLOW_MS + 10);
    hub.handle(JSON.stringify({ op: "rpc_result", id: (JSON.parse(sent[1] ?? "{}") as { id: number }).id, ok: true, result: [] }));
    await old;
    expect(logs[0]?.extra).toMatchObject({ macMs: null, wegMs: null, gesamtMs: RPC_SLOW_MS + 10 });
  });
});
