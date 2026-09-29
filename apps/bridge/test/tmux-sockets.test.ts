// Aufräumen alter Test-Sockets: nur `zc-test-*`, nur ohne lauschenden Server. Läuft in einem
// eigenen Wegwerf-Ordner (`tmux -S <pfad>`), nie in `/tmp/tmux-<uid>/` selbst.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { disposeTmux, isolatedTmux, ownerPid, removeStaleTestSockets, socketAlive, TMUX_BIN, tmuxSocketDir } from "./tmuxSockets.js";

// Kurzer Ordner: Unix-Socket-Pfade dürfen auf macOS höchstens ~104 Zeichen lang sein.
const DIR = realpathSync(mkdtempSync(join("/tmp", "zc-d2-")));
const started: string[] = [];
afterAll(() => {
  for (const p of started) spawnSync(TMUX_BIN, ["-S", p, "kill-server"], { stdio: "ignore" });
  rmSync(DIR, { recursive: true, force: true });
});

/** tmux-Server auf eigenem Pfad starten; `dead` = Server hart beenden, die Socket-Datei bleibt liegen. */
function server(name: string, dead: boolean): string {
  const path = join(DIR, name);
  started.push(path);
  spawnSync(TMUX_BIN, ["-S", path, "-f", "/dev/null", "new-session", "-d", "sleep", "60"], { stdio: "ignore" });
  if (dead) {
    const pid = Number(spawnSync(TMUX_BIN, ["-S", path, "display", "-p", "#{pid}"], { encoding: "utf8" }).stdout.trim());
    process.kill(pid, "SIGKILL");
  }
  return path;
}

/** PID eines Prozesses, der sicher schon beendet ist. */
function deadPid(): number {
  const r = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

describe("alte tmux-Test-Sockets aufräumen", () => {
  it("löscht nur tote `zc-test-*`-Sockets; lebende und fremde bleiben", async () => {
    const gone = deadPid();
    const live = server(`zc-test-${gone}-live`, false);
    const dead = server(`zc-test-${gone}-dead`, true);
    const foreign = server("nyxos-probe-x", true);
    await new Promise((r) => setTimeout(r, 100));
    expect(await socketAlive(live)).toBe(true);
    expect(await socketAlive(dead)).toBe(false);
    const r = await removeStaleTestSockets(DIR);
    expect(r.removed).toEqual([`zc-test-${gone}-dead`]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it("automatischer Lauf: Sockets eines noch laufenden Testlaufs bleiben, auch wenn gerade niemand lauscht", async () => {
    const mine = server(`zc-test-${process.pid}-own`, true);
    const r = await removeStaleTestSockets(DIR, { onlyDeadOwner: true });
    expect(r.removed).not.toContain(`zc-test-${process.pid}-own`);
    expect(existsSync(mine)).toBe(true);
  });

  it("erkennt den Besitzer im Namen (alte und neue Schreibweise)", () => {
    expect(ownerPid("zc-test-12345")).toBe(12345);
    expect(ownerPid("zc-test-cg-777")).toBe(777);
    expect(ownerPid("zc-test-42-3-resume")).toBe(42);
    expect(ownerPid("nyxos")).toBeNull();
  });

  it("disposeTmux beendet den Server UND löscht die Socket-Datei (tmux selbst lässt sie liegen)", async () => {
    const { tmux, socket } = isolatedTmux("dispose", null);
    await tmux.newSession({ name: "zc-claude-disp0001", cwd: "/tmp", cols: 80, rows: 24, env: {}, command: ["/bin/sleep", "30"] });
    const path = join(tmuxSocketDir(), socket);
    expect(existsSync(path)).toBe(true);
    disposeTmux(socket);
    expect(existsSync(path)).toBe(false);
    expect(() => disposeTmux("nyxos")).toThrow();
  });
});
