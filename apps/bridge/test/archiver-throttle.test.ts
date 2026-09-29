// Archiv-Uploads gedrosselt: Gemessen: die 16-MB-Verlaufsdatei (gzip 6,7 MB) ging alle 30 s
// komplett hoch, durch dieselbe SSH-Verbindung wie der Brücken-Kanal. Jetzt: Pings haben Vorrang, Pause je
// nach Größe, große Dateien seltener.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Archiver, BIG_FILE_BYTES } from "../src/archiver.js";
import { newOutbox, noLog, sandbox, SID_A } from "./helpers.js";

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops.length = 0;
});

async function world(opts: ConstructorParameters<typeof Archiver>[6] = {}) {
  const sb = sandbox();
  mkdirSync(join(sb.home, "support"), { recursive: true });
  const outbox = await newOutbox(join(sb.home, "support"));
  const uploads: { t: number; path: string; bytes: number }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    uploads.push({ t: Date.now(), path: decodeURIComponent(String((init?.headers as Record<string, string>)["x-nyxos-path"] ?? "")), bytes: (init?.body as Buffer).length });
    return new Response("{}", { status: 200 });
  };
  const archiver = new Archiver(sb.cfg, outbox, () => true, noLog, fetchImpl, 20, opts);
  stops.push(async () => {
    await archiver.stop();
    outbox.db.close();
  });
  return { sb, archiver, uploads, outbox, fetchImpl };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Archiv-Drosselung (A1b)", () => {
  it("wartet der Kanal auf ein Lebenszeichen, bleibt der Upload zurück — danach geht er raus", async () => {
    let hold = true;
    const w = await world({ holdWhile: () => hold });
    const f = join(w.sb.proj, `${SID_A}.jsonl`);
    writeFileSync(f, "{}\n");
    w.archiver.schedule(f, "claude", SID_A);
    await wait(700);
    expect(w.uploads).toHaveLength(0);
    hold = false;
    await wait(800);
    expect(w.uploads).toHaveLength(1);
  });

  it("nach jedem Upload eine Pause gemäß Größe (hier 1 KB/s)", async () => {
    const w = await world({ bytesPerSecond: 1000 });
    const a = join(w.sb.proj, `${SID_A}.jsonl`);
    const b = join(w.sb.proj, "bbbbbbbb-0000-4000-8000-000000000002.jsonl");
    // Zufallsinhalt, damit gzip kaum schrumpft: ~600 Byte → ~0,6 s Pause.
    const noise = () => Array.from({ length: 600 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join("");
    writeFileSync(a, noise());
    writeFileSync(b, noise());
    w.archiver.schedule(a, "claude", SID_A);
    w.archiver.schedule(b, "claude", "bbbbbbbb-0000-4000-8000-000000000002");
    await w.archiver.idle();
    expect(w.uploads).toHaveLength(2);
    const [first, second] = w.uploads;
    expect((second?.t ?? 0) - (first?.t ?? 0)).toBeGreaterThanOrEqual(Math.floor(((first?.bytes ?? 0) / 1000) * 1000) - 50);
  });

  it(`große Dateien (≥ ${BIG_FILE_BYTES / 1024 / 1024} MB) nicht bei jeder Änderung nach Sekunden erneut`, async () => {
    const w = await world({ bytesPerSecond: 1e12 });
    const big = join(w.sb.proj, `${SID_A}.jsonl`);
    const small = join(w.sb.proj, "cccccccc-0000-4000-8000-000000000003.jsonl");
    writeFileSync(big, Buffer.alloc(BIG_FILE_BYTES + 1024, 0x61));
    writeFileSync(small, "{}\n");
    w.archiver.schedule(big, "claude", SID_A);
    w.archiver.schedule(small, "claude", "cccccccc-0000-4000-8000-000000000003");
    await w.archiver.idle();
    expect(w.uploads).toHaveLength(2);
    // Beide ändern sich erneut: die kleine geht nach der kurzen Ruhezeit, die große wartet (30 s Ruhe / 2 min).
    appendFileSync(big, "x");
    appendFileSync(small, "x");
    w.archiver.schedule(big, "claude", SID_A);
    w.archiver.schedule(small, "claude", "cccccccc-0000-4000-8000-000000000003");
    await wait(600);
    expect(w.uploads).toHaveLength(3);
    expect(w.uploads[2]?.path.endsWith("cccccccc-0000-4000-8000-000000000003.jsonl")).toBe(true);
  });
  it("Brücke endet während der Wartezeit einer großen Datei → nach dem Neustart geht der neueste Stand trotzdem hoch", async () => {
    // Die 2-min-Wartezeit großer Dateien darf beim Beenden (Update, Neustart, Abmelden) nichts
    // verlieren. Der Nachholer (`sweep`, beim Start und jede Minute) vergleicht Größe/Zeit mit dem Archiv.
    const w = await world({ bytesPerSecond: 1e12 });
    const big = join(w.sb.proj, `${SID_A}.jsonl`);
    writeFileSync(big, Buffer.alloc(BIG_FILE_BYTES + 1024, 0x61));
    w.outbox.upsertFile(big, "claude", SID_A);
    w.archiver.schedule(big, "claude", SID_A);
    await w.archiver.idle();
    expect(w.uploads).toHaveLength(1);
    appendFileSync(big, "neu");
    w.archiver.schedule(big, "claude", SID_A); // wartet jetzt bis zu 2 min …
    await wait(100);
    await w.archiver.stop(); // … und die Brücke wird beendet
    expect(w.uploads).toHaveLength(1);

    const next = new Archiver(w.sb.cfg, w.outbox, () => true, noLog, w.fetchImpl, 20, { bytesPerSecond: 1e12 });
    stops.push(() => next.stop());
    expect(await next.sweep()).toBe(1);
    await next.idle();
    expect(w.uploads).toHaveLength(2);
    expect(w.uploads[1]?.bytes).toBeGreaterThan(0);
    expect(w.outbox.file(big)?.archived_size).toBe(BIG_FILE_BYTES + 1024 + 3);
  });
});
