// Der Lebenszeichen-Takt darf nie überlappen — ein langsamer `pgrep`/
// `lsof`-Lauf (oder ein injiziertes `opts.liveness`) darf nicht dazu führen, dass der nächste Takt
// schon startet, bevor der vorige fertig ist (sonst stapeln sich Kindprozesse, s. `liveness.ts`).
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/daemon.js";
import { noLog, sandbox } from "./helpers.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops.length = 0;
});

describe("Lebenszeichen-Takt: Busy-Flag gegen Überlappung", () => {
  it("startet nie einen zweiten Takt, während der vorige noch läuft — auch bei einem sehr kurzen Timer", async () => {
    const sb = sandbox();
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const d = await startDaemon(sb.cfg, {
      spoolDir: join(sb.home, "spool"),
      dbPath: join(sb.home, "support", "buffer.sqlite"),
      log: noLog,
      fetchImpl: () => Promise.reject(new TypeError("fetch failed (offline, Test)")),
      entrySources: false,
      livenessMs: 10, // absichtlich viel kürzer als die simulierte Lebenszeichen-Dauer unten
      liveness: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(60); // simuliert einen langsamen pgrep/lsof-Lauf
        inFlight--;
        return { claudeRunning: new Set<string>(), codexProcess: false };
      },
    });
    stops.push(() => d.stop());

    await sleep(400);
    // Vor dem Stoppen den gerade laufenden Takt zu Ende laufen lassen (sonst schließt `d.stop()` die
    // DB, während die simulierte Lebenszeichen-Prüfung noch mitten in einer Transaktion steckt).
    while (inFlight > 0) await sleep(5);

    // Kein einziger Takt lief je gleichzeitig mit einem anderen — trotz 10-ms-Timer bei 60 ms Dauer.
    expect(maxInFlight).toBe(1);
    // Ohne Busy-Flag hätte der 10-ms-Timer in 400 ms ~40 Aufrufe gestartet; mit Busy-Flag höchstens
    // so viele, wie 60-ms-Takte in die Zeit passen (~7), plus etwas Anlauf-Toleranz.
    expect(calls).toBeLessThan(15);
    expect(calls).toBeGreaterThan(0);
  });
});
