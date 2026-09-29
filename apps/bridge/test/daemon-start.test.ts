// Start unter Last : Nach `launchctl kickstart -k` blieb die neue Brücke minutenlang
// ohne Tunnel — `startDaemon` baute den Tunnel erst NACH Spool, Datei-Wächter und dem kompletten
// Nachimport auf (1 924 Einträge im Puffer, 613 Verlaufsdateien). Jetzt: Tunnel und Kanal zuerst, der
// Rückstand danach im Hintergrund. Hier mit Ersatz-ssh (ist zugleich der Server) und 2 000 Einträgen.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IngestItem } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/daemon.js";
import { fakeSsh, freePort, until } from "./fake-ssh.js";
import { newOutbox, ROOT, sandbox, SID_A } from "./helpers.js";

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops.length = 0;
});

const BACKLOG = 2000;

function backlogItems(n: number): IngestItem[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "event" as const,
    event: { id: `alt-${i}`, tool: "claude" as const, sessionId: SID_A, ts: "2026-09-25T10:00:00.000Z", kind: "hook", source: "hook" as const, data: { event: "Stop", cwd: ROOT } },
  })) as IngestItem[];
}

/** Große Verlaufsdatei, damit der Nachimport spürbar dauert. */
function bigTranscript(path: string, lines: number): void {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      JSON.stringify({
        type: "user",
        uuid: `big-${i}`,
        timestamp: "2026-09-25T10:00:00.000Z",
        sessionId: SID_A,
        cwd: ROOT,
        message: { role: "user", content: `Zeile ${i} `.padEnd(300, "x") },
      }),
    );
  }
  writeFileSync(path, out.join("\n") + "\n");
}

describe("Start-Reihenfolge der Brücke (A1b)", () => {
  it("Tunnel und Kanal stehen, bevor der Rückstand abgearbeitet wird; danach geht alles raus", async () => {
    const sb = sandbox();
    const fake = fakeSsh();
    const port = await freePort();
    sb.cfg.serverUrl = `http://127.0.0.1:${port}`;
    sb.cfg.tunnel = { host: fake.dir, localPort: port, remotePort: 1 };
    // Terminal-Dienst an (für den Kanal), aber ohne echtes tmux.
    sb.cfg.terminal = { socket: "nyxos-probe-a1b-test", tmuxBin: join(sb.home, "kein-tmux"), conf: null, path: null };
    bigTranscript(join(sb.proj, `${SID_A}.jsonl`), 20_000);

    const dbPath = join(sb.home, "support", "buffer.sqlite");
    mkdirSync(join(sb.home, "support"), { recursive: true });
    const pre = await newOutbox(join(sb.home, "support"));
    pre.enqueue(backlogItems(BACKLOG));
    expect(pre.size()).toBe(BACKLOG);
    pre.db.close();

    const logs: { t: number; msg: string; extra: Record<string, unknown> }[] = [];
    const t0 = Date.now();
    const d = await startDaemon(sb.cfg, {
      spoolDir: join(sb.home, "spool"),
      dbPath,
      log: (msg, extra = {}) => logs.push({ t: Date.now(), msg, extra }),
      liveness: async () => ({ claudeRunning: new Set<string>(), codexProcess: false }),
      vault: false,
      tunnel: { sshBin: fake.bin, upAfterMs: 200 },
    });
    stops.push(() => d.stop());

    await until(() => logs.some((l) => l.msg === "nachimport"), 60_000);
    await until(() => fake.of("upgrade").length >= 1, 20_000);
    const upgradeAt = fake.of("upgrade")[0]?.t ?? Infinity;
    const importDone = logs.find((l) => l.msg === "nachimport")?.t ?? 0;
    // Kern der Sache: der Kanal ist offen, BEVOR der Nachimport fertig ist …
    expect(upgradeAt).toBeLessThan(importDone);
    // … und die erste Sendung des Rückstands kommt erst nach dem Kanal.
    await until(() => fake.of("ingest").length >= 1, 20_000);
    expect(fake.of("ingest")[0]?.t ?? 0).toBeGreaterThanOrEqual(upgradeAt);

    // Start-Phasen mit Zeiten im Log.
    const phases = logs.filter((l) => l.msg === "start-phase").map((l) => l.extra.phase);
    expect(phases).toEqual(expect.arrayContaining(["puffer-offen", "tunnel-gestartet", "kanal-bereit", "nachimport-fertig"]));
    expect(phases.indexOf("kanal-bereit")).toBeLessThan(phases.indexOf("nachimport-fertig"));
    expect(logs.find((l) => l.msg === "start-phase" && l.extra.phase === "puffer-offen")?.extra.puffer).toBe(BACKLOG);

    // Am Ende ist der ganze Rückstand beim Server.
    await until(() => fake.of("ingest").reduce((n, e) => n + (e.items ?? 0), 0) >= BACKLOG, 60_000);
    await d.ready;
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 90_000);
  it("Server beim Start nicht erreichbar → der Rest startet nach der Wartegrenze trotzdem (kein Hängen)", async () => {
    // ssh bricht sofort ab (kein Netz), der Kanal kommt nie. Spool, Nachimport und Puffer
    // müssen nach `channelWaitMs` trotzdem laufen; die Brücke puffert dann wie gewohnt.
    const sb = sandbox();
    const port = await freePort();
    sb.cfg.serverUrl = `http://127.0.0.1:${port}`; // dort lauscht niemand
    sb.cfg.tunnel = { host: "nirgendwo", localPort: port, remotePort: 1 };
    sb.cfg.terminal = { socket: "nyxos-probe-a1b-test2", tmuxBin: join(sb.home, "kein-tmux"), conf: null, path: null };
    bigTranscript(join(sb.proj, `${SID_A}.jsonl`), 50);
    const logs: { msg: string; extra: Record<string, unknown> }[] = [];
    const t0 = Date.now();
    const d = await startDaemon(sb.cfg, {
      spoolDir: join(sb.home, "spool"),
      dbPath: join(sb.home, "buffer.sqlite"),
      log: (msg, extra = {}) => logs.push({ msg, extra }),
      liveness: async () => ({ claudeRunning: new Set<string>(), codexProcess: false }),
      vault: false,
      tunnel: { sshBin: "/usr/bin/false", upAfterMs: 200, minRestartMs: 60_000 },
      channelWaitMs: 800,
    });
    stops.push(() => d.stop());
    await d.ready;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(logs.find((l) => l.msg === "start-phase" && l.extra.phase === "kanal-bereit")?.extra.offen).toBe(false);
    expect(logs.some((l) => l.msg === "nachimport")).toBe(true);
    expect(d.outbox.size()).toBeGreaterThan(0); // gepuffert, nicht verloren
    expect(d.link?.connected).toBe(false);
  }, 30_000);
});
