// Kontext-Wächter — Start-Umgebung: die Brücke reicht nur durch, was der Server berechnet
// (kein eigenes Wissen über Schwellen/Fenstergrößen). Gegen ECHTES tmux (wie terminal.test.ts,
// eigener Wegwerf-Socket, nie -L nyxos, nie die echten Shell-Startdateien).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TerminalManager } from "../src/terminal/manager.js";
import { tmuxConf } from "../src/terminal/shell.js";
import { disposeTmux, isolatedTmux } from "./tmuxSockets.js";

const CONF = join(mkdtempSync(join(tmpdir(), "nyxos-w1-conf-")), "tmux.conf");
writeFileSync(CONF, tmuxConf());
// Eigener Socket; danach Server beenden UND Socket-Datei löschen (tmux lässt sie sonst liegen).
const { tmux, socket: SOCKET } = isolatedTmux("cg", CONF);
afterAll(() => disposeTmux(SOCKET));

const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

/** Wegwerf-Projektordner mit einem falschen `claude`/`codex`, das Umgebung + Argumente protokolliert. */
function fakeProject() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-w1-")));
  const root = join(base, "projekte");
  mkdirSync(root, { recursive: true });
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["claude", "codex"]) {
    const f = join(bin, tool);
    writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "override=$CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" "$@" > "${base}/${tool}.log"\necho "fertig"\nexit 0\n`);
    chmodSync(f, 0o755);
  }
  const log = (tool: string) => {
    try {
      return readFileSync(join(base, `${tool}.log`), "utf8");
    } catch {
      return "";
    }
  };
  const reset = (tool: string) => {
    try {
      rmSync(join(base, `${tool}.log`));
    } catch {
      // gab es noch nicht — nichts zu tun
    }
  };
  return { base, root, bin, log, reset };
}

const p = fakeProject();
const mk = () =>
  new TerminalManager({
    tmux,
    projectRoots: [p.root],
    path: `${p.bin}:/usr/bin:/bin`,
    log: () => {},
    processAttached: async () => false,
    claudePids: async () => new Map(),
  });

describe("Start-Umgebung — die Brücke reicht Auto-Compact-Werte nur durch", () => {
  it("Claude: `autoCompactEnv` landet als Umgebungsvariable im tmux-Prozess", async () => {
    p.reset("claude");
    const m = mk();
    const r = await m.start({
      tool: "claude",
      model: null,
      cwd: p.root,
      prompt: null,
      cols: 80,
      rows: 24,
      autoCompactEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" },
      autoCompactArgs: null,
    });
    expect(r.tmuxName).toMatch(/^zc-claude-/);
    expect(await until(() => p.log("claude").includes("override="))).toBe(true);
    expect(p.log("claude").split("\n")[0]).toBe("override=80");
  });

  it("ohne autoCompactEnv bleibt die Variable unverändert leer (Erzwingen abgeschaltet)", async () => {
    p.reset("claude");
    const m = mk();
    await m.start({ tool: "claude", model: null, cwd: p.root, prompt: null, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null });
    expect(await until(() => p.log("claude").includes("override="))).toBe(true);
    expect(p.log("claude").split("\n")[0]).toBe("override=");
  });

  it("Codex: `autoCompactArgs` stehen VOR Modell/Prompt (`-c model_auto_compact_token_limit=<n>`)", async () => {
    p.reset("codex");
    const m = mk();
    await m.start({
      tool: "codex",
      model: "gpt-6-astra",
      cwd: p.root,
      prompt: "hallo",
      cols: 80,
      rows: 24,
      autoCompactEnv: null,
      autoCompactArgs: ["-c", "model_auto_compact_token_limit=206720"],
    });
    expect(await until(() => p.log("codex").includes("hallo"))).toBe(true);
    // Zeile 0 ist "override=" (Codex kennt die Variable nicht, harmlos leer), ab Zeile 1 die Argumente.
    expect(p.log("codex").split("\n").slice(1, 6)).toEqual(["-c", "model_auto_compact_token_limit=206720", "-m", "gpt-6-astra", "--"]);
  });

  it("Fortsetzen (`resume`) reicht dieselben Werte durch", async () => {
    p.reset("claude");
    const m = mk();
    await m.resume({
      tool: "claude",
      sessionId: "5fd26341-0781-438b-a79f-b103a34c1902",
      cwd: p.root,
      cols: 80,
      rows: 24,
      autoCompactEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75" },
      autoCompactArgs: null,
    });
    expect(await until(() => p.log("claude").includes("--resume"))).toBe(true);
    expect(p.log("claude").split("\n")[0]).toBe("override=75");
  });
});
