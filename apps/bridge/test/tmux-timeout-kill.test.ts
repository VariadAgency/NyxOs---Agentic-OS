// Ein hängender tmux-Aufruf, der SIGTERM ignoriert, darf nach dem Zeitlimit nicht als Waise weiterlaufen.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Tmux } from "../src/terminal/tmux.js";

describe("Tmux.run – Zeitlimit", () => {
  it("beendet einen SIGTERM-ignorierenden Aufruf hart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-kill-"));
    const bin = join(dir, "fake-tmux");
    const pidFile = join(dir, "pid");
    writeFileSync(bin, `#!/bin/sh\necho $$ > "${pidFile}"\ntrap '' TERM\nwhile :; do sleep 0.05; done\n`);
    chmodSync(bin, 0o755);
    const t = new Tmux({ bin, socket: "zc-test-kill" } as ConstructorParameters<typeof Tmux>[0]);
    await expect(t.run(["list-panes"], 300)).rejects.toThrow();
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((r) => setTimeout(r, 150));
    let alive = true;
    try {
      execFileSync("kill", ["-0", String(pid)]);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
