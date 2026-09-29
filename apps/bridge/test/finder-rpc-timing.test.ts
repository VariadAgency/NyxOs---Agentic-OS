// Finder-Tempo: Der Weg Web → Server → Brücke ist kein Abfrage-Takt — der Befehl kommt
// sofort über den offenen Kanal und läuft neben anderen Befehlen her (nicht in einer Warteschlange). Die
// Brücke schickt jetzt ihre Rechenzeit mit (`ms`), und ~/Downloads wird kurz nach dem Start der Brücke
// einmal vorgewärmt (der erste Zugriff eines frisch gestarteten Brücken-Prozesses war der teure).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeToServer } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { FinderFs } from "../src/finder/fs.js";
import { TerminalManager } from "../src/terminal/manager.js";
import { Tmux } from "../src/terminal/tmux.js";

function setup(onStat?: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "nyxos-finder-rpc-"));
  const project = join(home, "projekte");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, "Downloads"), { recursive: true });
  for (let i = 0; i < 300; i++) writeFileSync(join(home, "Downloads", `d-${i}.txt`), "x");
  const finder = new FinderFs({ projectRoots: [project], home, screenshotsDir: null, backupsDir: join(home, "b"), onStat });
  const manager = new TerminalManager({
    finder,
    tmux: new Tmux({ bin: "/nonexistent/tmux", socket: "finder-rpc", conf: null }),
    projectRoots: [project],
    path: "/usr/bin:/bin",
    log: () => {},
    processAttached: async () => false,
    claudePids: async () => new Map(),
  });
  return { home, finder, manager };
}

describe("Finder-Befehl über den Brücken-Kanal", () => {
  it("die Antwort trägt die Rechenzeit auf dem Rechner (ms), damit der Server Weg und Rechnen trennen kann", async () => {
    const { manager } = setup();
    const out: BridgeToServer[] = [];
    await manager.handle(JSON.stringify({ op: "rpc", id: 7, method: "finder", params: { op: "list", root: "downloads", rel: "" } }), (m) => out.push(m));
    const res = out.find((m) => m.op === "rpc_result");
    expect(res).toMatchObject({ op: "rpc_result", id: 7, ok: true });
    expect(typeof (res as { ms?: unknown }).ms).toBe("number");
    expect((res as { ms: number }).ms).toBeGreaterThanOrEqual(0);
  });

  it("ein langsamer Befehl hält einen schnellen nicht auf (kein Nacheinander in der Brücke)", async () => {
    let slow = true;
    const { manager } = setup(async () => {
      if (slow) await new Promise((r) => setTimeout(r, 2));
    });
    const order: number[] = [];
    const send = (m: BridgeToServer) => {
      if (m.op === "rpc_result") order.push(m.id);
    };
    // 1 = große Liste (300 × 2 ms / 32), 2 = kleine Abfrage — 2 muss zuerst fertig sein.
    const a = manager.handle(JSON.stringify({ op: "rpc", id: 1, method: "finder", params: { op: "list", root: "downloads", rel: "" } }), send);
    const b = manager.handle(JSON.stringify({ op: "rpc", id: 2, method: "finder", params: { op: "roots" } }), send);
    await Promise.all([a, b]);
    slow = false;
    expect(order).toEqual([2, 1]);
  });

  it("Vorwärmen nach dem Start liest ~/Downloads einmal und meldet die Anzahl", async () => {
    let stats = 0;
    const { finder } = setup(async () => {
      stats++;
    });
    expect(await finder.prewarm()).toBe(300);
    expect(stats).toBe(300);
  });
});
