// Rot unter Last bei offenem Kanal (12:38, 12:47): Pong fehlte > 90 s. Schwere Arbeit der Brücke darf
// die Ereignisschleife nie am Stück blockieren — sonst bleiben Pings, Tunnel-Prüfung und Terminal stehen.
// Gemessen wird die CPU-Zeit des eigenen Threads zwischen zwei Takten (unabhängig von fremder Last auf
// dem Rechner: wird der Prozess nur verdrängt, zählt das nicht als Blockade).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Tracker } from "../src/tracker.js";
import { VaultSync } from "../src/vault/sync.js";
import { newOutbox, noLog, ROOT, sandbox, SID_A } from "./helpers.js";

const LIMIT_MS = 50;

type CpuFn = () => { user: number; system: number };
const threadCpu: CpuFn = (process as unknown as { threadCpuUsage?: CpuFn }).threadCpuUsage?.bind(process) ?? (() => process.cpuUsage());

/** Längste Strecke ohne Takt: min(Wanduhr, eigene CPU-Zeit) zwischen zwei aufeinanderfolgenden Takten. */
function blockMeter() {
  let max = 0;
  let on = true;
  let lastWall = performance.now();
  let lastCpu = threadCpu();
  const tick = () => {
    const wall = performance.now();
    const cpu = threadCpu();
    const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    max = Math.max(max, Math.min(wall - lastWall, cpuMs));
    lastWall = wall;
    lastCpu = cpu;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    stop(): number {
      on = false;
      return max;
    },
  };
}

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops.length = 0;
});

describe(`Ereignisschleife: schwere Arbeit blockiert höchstens ${LIMIT_MS} ms am Stück (A1b)`, () => {
  it("Nachimport einer großen Verlaufsdatei (30 000 Zeilen, ~11 MB)", async () => {
    const sb = sandbox();
    const lines: string[] = [];
    for (let i = 0; i < 30_000; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          uuid: `z-${i}`,
          timestamp: "2026-09-25T10:00:00.000Z",
          sessionId: SID_A,
          cwd: ROOT,
          message: { role: "user", content: `Zeile ${i} `.padEnd(300, "x") },
        }),
      );
    }
    writeFileSync(join(sb.proj, `${SID_A}.jsonl`), lines.join("\n") + "\n");
    mkdirSync(join(sb.home, "support"), { recursive: true });
    const outbox = await newOutbox(join(sb.home, "support"));
    stops.push(() => outbox.db.close());
    const tracker = new Tracker(sb.cfg, outbox, noLog);

    const meter = blockMeter();
    expect(await tracker.scanAll()).toBe(1);
    const max = meter.stop();
    expect(outbox.size()).toBeGreaterThan(30_000); // alles eingelesen
    expect(max).toBeLessThanOrEqual(LIMIT_MS);
  }, 60_000);

  it("Vault-Vollabgleich mit 5 000 Notizen (inkl. Auszügen und Senden in Teilen)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nyxos-vault-gross-"));
    for (let i = 0; i < 5000; i++) {
      const dir = join(root, `Ordner ${i % 40}`);
      mkdirSync(dir, { recursive: true });
      const body = [
        "---",
        `tags: [thema-${i % 17}, gross]`,
        "---",
        `# Notiz ${i}`,
        `Verweis auf [[Notiz ${(i + 1) % 5000}]] und [[Notiz ${(i + 7) % 5000}]].`,
        "Ein Absatz mit etwas Text, der als Auszug taugt. ".repeat(12),
        "- [ ] Aufgabe eins",
        "- [x] Aufgabe zwei",
      ].join("\n");
      writeFileSync(join(dir, `Notiz ${i}.md`), body);
    }
    let sent = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      sent += (JSON.parse(String(init?.body)) as { notes: unknown[] }).notes.length;
      return new Response("{}", { status: 200 });
    };
    const sync = new VaultSync({ vaultDir: root, serverUrl: "http://127.0.0.1:1", token: "t" }, noLog, fetchImpl, { watch: false, fullResyncMs: 0 });
    stops.push(() => sync.stop());

    const meter = blockMeter();
    await sync.start();
    const max = meter.stop();
    expect(sent).toBe(5000);
    expect(sync.status.notes).toBe(5000);
    expect(max).toBeLessThanOrEqual(LIMIT_MS);
  }, 60_000);
});
