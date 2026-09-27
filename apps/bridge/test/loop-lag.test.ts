// Messung der Ereignisschleifen-Verzögerung in der Brücke: Warnung im Log ab 1 s (`eventloop-lag`),
// damit ein Ausfall unter Last künftig belegt ist (Blockade in der Brücke oder Mac überlastet).
import { afterEach, describe, expect, it } from "vitest";
import { LoopLagMonitor } from "../src/loop-lag.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.reverse()) s();
  stops.length = 0;
});

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // absichtlich blockieren
  }
}

describe("LoopLagMonitor (A1b)", () => {
  it("meldet eine Blockade über 1 s mit ihrer Dauer", async () => {
    const logs: { msg: string; extra: Record<string, unknown> }[] = [];
    const m = new LoopLagMonitor((msg, extra = {}) => logs.push({ msg, extra }), { intervalMs: 50 });
    m.start();
    stops.push(() => m.stop());
    await new Promise((r) => setTimeout(r, 120));
    busy(1300);
    await new Promise((r) => setTimeout(r, 120));
    const warn = logs.find((l) => l.msg === "eventloop-lag");
    expect(warn).toBeDefined();
    expect(Number(warn?.extra.ms)).toBeGreaterThanOrEqual(1000);
    expect(m.maxLagMs).toBeGreaterThanOrEqual(1000);
  });

  it("schweigt bei kurzen Verzögerungen", async () => {
    const logs: string[] = [];
    const m = new LoopLagMonitor((msg) => logs.push(msg), { intervalMs: 50 });
    m.start();
    stops.push(() => m.stop());
    await new Promise((r) => setTimeout(r, 100));
    busy(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(logs).not.toContain("eventloop-lag");
  });

  it("takeMax liefert das Maximum seit dem letzten Abruf und setzt zurück", async () => {
    const m = new LoopLagMonitor(() => {}, { intervalMs: 20 });
    m.start();
    stops.push(() => m.stop());
    await new Promise((r) => setTimeout(r, 50));
    busy(150);
    await new Promise((r) => setTimeout(r, 60));
    expect(m.takeMax()).toBeGreaterThanOrEqual(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(m.takeMax()).toBeLessThan(100);
  });
});
