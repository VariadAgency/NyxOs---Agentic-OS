// Halb offene Verbindung (gemessen): Der Server trennte den Kanal nach 90 s
// Stille (`bruecke-stumm`, 1006), die Brücke merkte es nie und blieb 30 min „verbunden". Jetzt prüft die
// Brücke selbst: Kommt länger als ~40 s kein Server-Ping (oder sonst etwas), gibt sie den Kanal auf
// und verbindet neu (`kanal-watchdog`). Gilt auch für einen Handschlag, der nie fertig wird.
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeLink, LINK_CHECK_MS, LINK_SILENT_MS, LINK_CONNECT_TIMEOUT_MS } from "../src/terminal/link.js";
import type { TerminalManager } from "../src/terminal/manager.js";
import { fakeSsh, freePort, until } from "./fake-ssh.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.reverse()) s();
  stops.length = 0;
});

function stubManager() {
  let closed = 0;
  const manager = { handle: async () => {}, closeAll: () => void closed++ } as unknown as TerminalManager;
  return { manager, closedCount: () => closed };
}

async function world(o: { silentMs: number; checkMs: number; connectTimeoutMs?: number; pingSource?: (ws: WebSocket, fn: () => void) => () => void }) {
  const fake = fakeSsh();
  const port = await freePort();
  const child: ChildProcess = fake.spawnServer(port);
  stops.push(() => child.kill("SIGKILL"));
  await until(() => fake.of("start").length === 1);
  const logs: { msg: string; extra: Record<string, unknown> }[] = [];
  const m = stubManager();
  const link = new BridgeLink({
    serverUrl: `http://127.0.0.1:${port}`,
    token: "t",
    manager: m.manager,
    tmuxSocket: "nyxos-probe-a1b",
    log: (msg, extra = {}) => logs.push({ msg, extra }),
    ...o,
  });
  stops.push(() => link.stop());
  return { fake, link, logs, m };
}

describe("Brücken-Kanal: Wächter gegen halb offene Verbindungen (A1b)", () => {
  it("Standardwerte: nach > 40 s ohne Ping gilt der Kanal als tot, neu verbunden ist spätestens nach 60 s", () => {
    expect(LINK_SILENT_MS).toBeLessThanOrEqual(45_000);
    expect(LINK_SILENT_MS).toBeGreaterThan(2 * 15_000); // zwei verpasste Server-Pings (alle 15 s) sind noch kein Ausfall
    // Erkennung (Stille + zwei Prüftakte, s. Bestätigungs-Takt) + erster Neuversuch (1 s) < 60 s
    expect(LINK_SILENT_MS + 2 * LINK_CHECK_MS + 1000).toBeLessThan(60_000);
    expect(LINK_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("Server-Pings halten den Kanal offen — kein unnötiger Neuaufbau", async () => {
    const w = await world({ silentMs: 500, checkMs: 50 });
    w.link.start();
    await until(() => w.link.connected);
    await new Promise((r) => setTimeout(r, 1500)); // dreimal so lang wie die Stille-Grenze
    expect(w.fake.of("upgrade")).toHaveLength(1);
    expect(w.logs.some((l) => l.msg === "kanal-watchdog")).toBe(false);
    expect(w.link.connected).toBe(true);
  });

  it("Server pingt nicht mehr, schließt aber auch nicht (halb offen) → Brücke gibt den Kanal auf und verbindet neu", async () => {
    const w = await world({ silentMs: 500, checkMs: 50 });
    w.link.start();
    await until(() => w.link.connected);
    await new Promise((r) => setTimeout(r, 300));
    w.fake.set("pings", "off");
    const t0 = Date.now();
    await until(() => w.logs.some((l) => l.msg === "kanal-watchdog"), 5000);
    const log = w.logs.find((l) => l.msg === "kanal-watchdog");
    expect(log?.extra.grund).toBe("kein-ping");
    expect(Number(log?.extra.stilleMs)).toBeGreaterThanOrEqual(500);
    // Neuer Handschlag beim Server; die Steuer-Clients der alten Verbindung wurden gelöst.
    w.fake.set("pings", "on");
    await until(() => w.fake.of("upgrade").length === 2 && w.link.connected, 5000);
    expect(Date.now() - t0).toBeLessThan(3000); // skaliert: 500 ms Stille statt 40 s
    expect(w.m.closedCount()).toBeGreaterThanOrEqual(1);
    // Die aufgegebene Verbindung löst später keinen zweiten Neuaufbau aus.
    await new Promise((r) => setTimeout(r, 800));
    expect(w.fake.of("upgrade")).toHaveLength(2);
  });

  // ── Fehlalarme des Wächters ──────────────────────────────────────────────────────────
  it("Laufzeit meldet keine Pings (z. B. ältere Bun-Fassung) → der Wächter verbindet NICHT alle 40 s neu", async () => {
    // Der Server pingt ganz normal, nur sieht die Brücke die Pings nicht. Ohne Schutz gälte jeder gesunde
    // Kanal nach 40 s als tot: Neuaufbau im Takt, jedes Mal fliegen die Terminal-Steuer-Clients raus.
    const w = await world({ silentMs: 300, checkMs: 50, pingSource: () => () => {} });
    w.link.start();
    await until(() => w.link.connected);
    await new Promise((r) => setTimeout(r, 1500)); // fünfmal die Stille-Grenze
    expect(w.fake.of("upgrade")).toHaveLength(1);
    expect(w.logs.filter((l) => l.msg === "kanal-watchdog")).toHaveLength(0);
    expect(w.logs.filter((l) => l.msg === "kanal-ohne-ping")).toHaveLength(1); // einmal sagen, nicht im Takt
    expect(w.m.closedCount()).toBe(0);
    expect(w.link.connected).toBe(true);
  });

  it("Brücke bekam lange keine Rechenzeit (Last/Swap), der Server pingte weiter → kein Neuaufbau nach dem Aufwachen", async () => {
    // Nach einer Blockade laufen fällige Timer VOR dem Lesen der inzwischen angekommenen Pings. Genau der
    // Fall der Dauermessung (Brücke minutenlang ohne CPU) — da darf der Wächter den gesunden Kanal nicht kappen.
    const w = await world({ silentMs: 500, checkMs: 50 });
    w.link.start();
    await until(() => w.link.connected);
    await new Promise((r) => setTimeout(r, 300));
    // Blockade in einem I/O-/Immediate-Rückruf (wie der Nachimport nach `readFile`): danach kommen im nächsten
    // Durchlauf ZUERST die fälligen Timer (Wächter), erst dann das Lesen der Sockets (Pings).
    await new Promise<void>((r) =>
      setImmediate(() => {
        const end = performance.now() + 1200;
        while (performance.now() < end) {
          // Ereignisschleife blockiert (Server pingt derweil alle 100 ms weiter)
        }
        r();
      }),
    );
    await new Promise((r) => setTimeout(r, 600));
    expect(w.logs.filter((l) => l.msg === "kanal-watchdog")).toHaveLength(0);
    expect(w.fake.of("upgrade")).toHaveLength(1);
    expect(w.link.connected).toBe(true);
  });

  it("Uhr springt vor (Zeitabgleich, Zeitzone) → kein Neuaufbau: der Wächter misst mit einer monotonen Uhr", async () => {
    const w = await world({ silentMs: 500, checkMs: 50 });
    w.link.start();
    await until(() => w.link.connected);
    await new Promise((r) => setTimeout(r, 200));
    const real = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + 3_600_000);
    try {
      await new Promise((r) => setTimeout(r, 400)); // < Stille-Grenze, aber die Wanduhr ist 1 h weiter
      expect(w.logs.filter((l) => l.msg === "kanal-watchdog")).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    expect(w.fake.of("upgrade")).toHaveLength(1);
  });

  it("Handschlag wird nie fertig (Tunnel hängt) → nach der Grenze neuer Versuch", async () => {
    const w = await world({ silentMs: 500, checkMs: 50, connectTimeoutMs: 300 });
    w.fake.set("mode", "hang");
    w.link.start();
    await until(() => w.logs.some((l) => l.msg === "kanal-watchdog" && l.extra.grund === "verbindungsaufbau"), 5000);
    w.fake.set("mode", "ok");
    await until(() => w.link.connected, 8000);
    expect(w.fake.of("upgrade").length).toBeGreaterThanOrEqual(1);
  });
});
