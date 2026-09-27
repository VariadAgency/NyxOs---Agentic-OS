// Hilfen für den Ersatz-SSH (`fixtures/fake-ssh.mjs`): Zustandsordner, Aufruf-Skript, Protokoll.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "fixtures", "fake-ssh.mjs");

export interface FakeEvent {
  t: number;
  pid: number;
  kind: "start" | "upgrade" | "ingest" | "health";
  items?: number;
}

export function fakeSsh() {
  const dir = mkdtempSync(join(tmpdir(), "nyxos-fakessh-"));
  const bin = join(dir, "ssh");
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  writeFileSync(bin, `#!/bin/sh\nexec ${q(process.execPath)} ${q(SCRIPT)} "$@"\n`);
  chmodSync(bin, 0o755);
  const events = (): FakeEvent[] => {
    try {
      return readFileSync(join(dir, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeEvent);
    } catch {
      return [];
    }
  };
  return {
    /** Zustandsordner = „Host" für die ssh-Argumente. */
    dir,
    bin,
    set: (name: "mode" | "pings" | "ping-ms", value: string) => writeFileSync(join(dir, name), value),
    events,
    of: (kind: FakeEvent["kind"]) => events().filter((e) => e.kind === kind),
    /** Startet den Ersatz direkt (ohne Tunnel-Klasse), z. B. als Server für den Brücken-Kanal. */
    spawnServer(port: number): ChildProcess {
      return spawn(bin, ["-N", "-L", `127.0.0.1:${port}:127.0.0.1:1`, dir], { stdio: "ignore" });
    },
  };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export async function until(cond: () => boolean, timeoutMs = 10_000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("Zeit abgelaufen");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
