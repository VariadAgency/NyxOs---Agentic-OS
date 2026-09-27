// Test-tmux auf einem EIGENEN Wegwerf-Socket je Test (bzw. je Block) — statt eines geteilten
// Servers für die ganze Datei. Grund für den wackligen Test „Fortsetzen ohne Prozess“: alle Tests der
// Datei teilten sich einen tmux-Server (`set-environment -g` eines Tests galt für alle, eine hängende
// Session bremste den nächsten Start) und eine Log-Datei; unter Last reichte das Zeitbudget nicht.
//
// Aufräumen: `tmux kill-server` lässt die Socket-Datei in `/tmp/tmux-<uid>/` liegen (tmux 3.6, gemessen).
// Daher sammelten sich dort über 100 alte `zc-test-*`-Dateien. `disposeTmux` löscht sie jetzt mit, und
// `removeStaleTestSockets` räumt Reste früherer Läufe weg — aber NUR Dateien mit Test-Präfix, auf denen
// nachweislich KEIN Server mehr lauscht (Verbindungsversuch scheitert).
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { findTmux } from "../src/config.js";
import { Tmux } from "../src/terminal/tmux.js";

export const TEST_SOCKET_PREFIX = "zc-test-";
export const TMUX_BIN = findTmux();

/** Ordner, in dem tmux seine Sockets anlegt (`$TMUX_TMPDIR` oder `/tmp`, dann `tmux-<uid>`). */
export function tmuxSocketDir(): string {
  const base = process.env.TMUX_TMPDIR || "/tmp";
  return join(base, `tmux-${process.getuid?.() ?? 0}`);
}

let counter = 0;

/** Frischer tmux auf eigenem Socket `zc-test-<pid>-<n>-<tag>`; ein Server entsteht erst beim ersten Start. */
export function isolatedTmux(tag: string, conf: string | null): { tmux: Tmux; socket: string } {
  const socket = `${TEST_SOCKET_PREFIX}${process.pid}-${++counter}-${tag}`;
  return { tmux: new Tmux({ bin: TMUX_BIN, socket, conf }), socket };
}

/** Server beenden UND die liegen gebliebene Socket-Datei löschen. */
export function disposeTmux(socket: string): void {
  if (!socket.startsWith(TEST_SOCKET_PREFIX)) throw new Error(`kein Test-Socket: ${socket}`);
  spawnSync(TMUX_BIN, ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5000 });
  try {
    unlinkSync(join(tmuxSocketDir(), socket));
  } catch {
    // gab es nie (kein Server gestartet)
  }
}

/** Lauscht auf dieser Socket-Datei noch ein Prozess? (Verbindung klappt = ja.) */
export function socketAlive(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(true), timeoutMs); // im Zweifel: lebt (nie etwas Lebendes löschen)
    s.once("connect", () => done(true));
    s.once("error", (e: NodeJS.ErrnoException) => done(!(e.code === "ECONNREFUSED" || e.code === "ENOENT")));
  });
}

/** PID des Testlaufs, der den Socket angelegt hat (`zc-test-<pid>…`, `zc-test-cg-<pid>`), sonst null. */
export function ownerPid(name: string): number | null {
  const m = /^zc-test-(?:[a-z]+-)?(\d+)/.exec(name);
  return m ? Number(m[1]) : null;
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Alte Test-Sockets ohne Server löschen. Fasst nur `zc-test-*`-Sockets an, nie `nyxos`, `nyxos-probe*` o. Ä.
 * `onlyDeadOwner` (für den automatischen Lauf nach den Tests): zusätzlich muss der Testlauf, der den Socket
 * angelegt hat, beendet sein — so trifft es nie einen parallel laufenden Test, dessen Server gerade erst startet.
 */
export async function removeStaleTestSockets(dir = tmuxSocketDir(), opts: { onlyDeadOwner?: boolean } = {}): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { removed, kept };
  }
  for (const name of names) {
    if (!name.startsWith(TEST_SOCKET_PREFIX)) continue;
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isSocket()) continue;
    } catch {
      continue;
    }
    const owner = ownerPid(name);
    if (opts.onlyDeadOwner && (owner === null || owner === process.pid || processAlive(owner))) {
      kept.push(name);
      continue;
    }
    if (await socketAlive(path)) {
      kept.push(name);
      continue;
    }
    try {
      unlinkSync(path);
      removed.push(name);
    } catch {
      kept.push(name);
    }
  }
  return { removed, kept };
}

/** Auf eine Bedingung warten statt auf eine feste Zeit. */
export async function until(fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}
