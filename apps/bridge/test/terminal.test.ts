// Brücken-Seite des Terminals, gegen ein ECHTES tmux auf einem eigenen Wegwerf-Socket
// (nie `-L nyxos`, nie die installierte Brücke, nie die echten Shell-Startdateien).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeAddRequestSchema, type BridgeToServer } from "@nyxos/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSnapshot, ControlClient, decodeOutput, inputCommands } from "../src/terminal/control.js";
import { screenWaiting } from "../src/terminal/detect.js";
import { isIdlePrompt, RpcError, TerminalManager } from "../src/terminal/manager.js";
import { addBlock, bashFunctions, bashRunnerScript, hasBlock, installShell, rcBlock, removeBlock, shellPaths, shellTargets, uninstallShell, zshFunctions, tmuxConf, runnerScript } from "../src/terminal/shell.js";
import type { Tmux } from "../src/terminal/tmux.js";
import { disposeTmux, isolatedTmux, removeStaleTestSockets, TMUX_BIN as TMUX, until } from "./tmuxSockets.js";

const CONF = join(mkdtempSync(join(tmpdir(), "nyxos-p3-conf-")), "tmux.conf");
writeFileSync(CONF, tmuxConf());

// Jeder Test bekommt seinen EIGENEN tmux-Server (eigener Socket) — vorher teilten sich alle Tests
// einen Server, `set-environment -g` und hängende Sessions eines Tests wirkten in den nächsten hinein.
// Nach jedem Test: Server beenden + Socket-Datei löschen (tmux lässt sie sonst liegen).
let tmux: Tmux;
let socket = "";
beforeEach(() => {
  ({ tmux, socket } = isolatedTmux("p3", CONF));
});
afterEach(() => disposeTmux(socket));
// Reste früherer, abgebrochener Läufe: nur `zc-test-*`, nur ohne Server, nur wenn deren Testlauf beendet ist.
afterAll(() => removeStaleTestSockets(undefined, { onlyDeadOwner: true }));

/** Wegwerf-Projektordner mit einem falschen `claude`/`codex`, das Argumente + Umgebung protokolliert. */
function fakeProject() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-p3-")));
  const root = join(base, "projekte");
  const bin = join(base, "bin");
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, "app", ".worktrees", "feature-x"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const tool of ["claude", "codex"]) {
    const f = join(bin, tool);
    writeFileSync(
      f,
      // Erst in eine Zwischendatei, dann umbenennen: ein Test liest die Datei nie halb geschrieben.
      `#!/bin/sh\nprintf '%s\\n' "tmux=$NYXOS_TMUX_NAME" "cwd=$PWD" "$@" > "${base}/${tool}.tmp"\nmv "${base}/${tool}.tmp" "${base}/${tool}.log"\n[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"\necho "fertig"\nexit \${FAKE_RC:-7}\n`,
    );
    chmodSync(f, 0o755);
  }
  const log = (tool: string) => {
    try {
      return readFileSync(join(base, `${tool}.log`), "utf8");
    } catch {
      return "";
    }
  };
  const clear = (tool: string) => rmSync(join(base, `${tool}.log`), { force: true });
  return { base, root, bin, log, clear };
}

describe("Block in der Shell-Startdatei", () => {
  const block = rcBlock("/home/x/.nyxos/bridge/shell/nyxos.zsh");
  for (const [label, original] of [
    ["mit Zeilenende", 'export PATH="$HOME/.local/bin:$PATH"\nalias x=y\n'],
    ["ohne Zeilenende", "alias x=y"],
    ["leer", ""],
  ] as const) {
    it(`uninstall entfernt den Block rückstandsfrei (${label})`, () => {
      const added = addBlock(original, block);
      expect(added).toContain("# >>> nyxos shell >>>");
      expect(addBlock(added, block)).toBe(added); // idempotent, nie doppelt
      expect(removeBlock(added)).toBe(original); // Byte für Byte
    });
  }

  it("der PATH-Block des `nyxos`-Befehls bleibt unberührt; der Block älterer Installationen wird ersetzt", () => {
    const cliBlock = '# >>> nyxos >>>\nexport PATH="/home/x/.nyxos/bin:$PATH"\n# <<< nyxos <<<\n';
    const legacy = "# >>> nyxos >>>\n[ -r '/x/NyxOS/shell/nyxos.zsh' ] && source '/x/NyxOS/shell/nyxos.zsh'\n# <<< nyxos <<<\n";
    const original = `alias a=b\n${cliBlock}`;
    const added = addBlock(original + legacy, block);
    expect(added).toContain(cliBlock);
    expect(added).not.toContain("/x/NyxOS/shell");
    expect(removeBlock(added)).toBe(original);
  });

  it("installShell/uninstallShell: zsh und bash, Sicherungskopie, diff nach uninstall leer", () => {
    const p = fakeProject();
    const zshrc = join(p.base, ".zshrc");
    const bashrc = join(p.base, ".bashrc");
    const original = "# meine Shell\nexport NVM_DIR=\"$HOME/.nvm\"\n";
    writeFileSync(zshrc, original);
    writeFileSync(bashrc, original);
    const targets = shellTargets({ zshrc, bashrc }, "/bin/zsh");
    expect(targets.map((t) => t.kind)).toEqual(["zsh", "bash"]);
    const r1 = installShell({ supportDir: join(p.base, "support"), tmuxBin: TMUX, projectRoots: [p.root], targets });
    expect(r1.join("\n")).toMatch(/vor-nyxos/);
    expect(readFileSync(zshrc, "utf8")).toContain("nyxos.zsh");
    expect(readFileSync(bashrc, "utf8")).toContain("nyxos.bash");
    expect(hasBlock(zshrc) && hasBlock(bashrc)).toBe(true);
    uninstallShell({ rcFiles: [zshrc, bashrc] });
    expect(readFileSync(zshrc, "utf8")).toBe(original);
    expect(readFileSync(bashrc, "utf8")).toBe(original);
  });

  it("shellTargets: vorhandene Startdateien plus die der Login-Shell, sonst die übliche Shell des Systems", () => {
    const base = mkdtempSync(join(tmpdir(), "nyxos-rc-"));
    const rc = { zshrc: join(base, ".zshrc"), bashrc: join(base, ".bashrc") };
    expect(shellTargets(rc, "/usr/bin/bash", "linux")).toEqual([{ kind: "bash", rc: rc.bashrc }]);
    expect(shellTargets(rc, "", "linux")).toEqual([{ kind: "bash", rc: rc.bashrc }]);
    expect(shellTargets(rc, "", "darwin")).toEqual([{ kind: "zsh", rc: rc.zshrc }]);
    writeFileSync(rc.zshrc, "");
    expect(shellTargets(rc, "/usr/bin/bash", "linux").map((t) => t.kind)).toEqual(["zsh", "bash"]);
  });

  it("tmux-Konfiguration: Statusleiste aus, Maus an, 50.000 Zeilen, Farben, kein Präfix", () => {
    const c = tmuxConf();
    for (const line of ["set -g status off", "set -g mouse on", "set -g history-limit 50000", 'set -g default-terminal "xterm-256color"', "set -g prefix None"]) {
      expect(c).toContain(line);
    }
  });
});

// Ein echtes Terminal setzt immer TERM; ohne (CI-Rechner) verweigert `tmux new-session` den Start.
const PTY_TERM = process.env.TERM || "xterm-256color";

/** Startet eine zsh in einem Pseudo-Terminal (`script`), damit `tmux new-session` sich anhängen kann. */
function zshInPty(zshFile: string, cwd: string, command: string, env: Record<string, string>) {
  // Läuft der Test selbst in einer NyxOS-tmux-Session (Agent nach Neustart), darf deren Name nicht durchsickern:
  // die Shell-Funktion hielte sich sonst schon für „in tmux“.
  const { NYXOS_TMUX_NAME: _inherited, ...hostEnv } = process.env;
  // Ergebnis über eine Datei statt über die Ausgabe von `script` (die Pty-Ausgabe kann beim Ende
  // abgeschnitten werden).
  const rcFile = join(mkdtempSync(join(tmpdir(), "nyxos-p3-rc-")), "rc");
  spawnSync("/usr/bin/script", ["-q", "/dev/null", "/bin/zsh", "-f", "-c", `source '${zshFile}'; cd '${cwd}'; ${command}; print -r -- "rc=$?" > '${rcFile}'`], {
    env: { ...hostEnv, TERM: PTY_TERM, TMUX: "", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], // `script` braucht ein stdin ohne Socket
    timeout: 20_000,
  });
  try {
    return readFileSync(rcFile, "utf8");
  } catch {
    return "";
  }
}

/** Wie `zshInPty`, für eine beliebige Shell; `RCFILE` im Befehl wird durch die Ergebnis-Datei ersetzt. */
function shellInPty(shellBin: string, shellArgs: string[], fnFile: string, cwd: string, command: string, env: Record<string, string>) {
  const { NYXOS_TMUX_NAME: _inherited, ...hostEnv } = process.env;
  const rcFile = join(mkdtempSync(join(tmpdir(), "nyxos-p3-rc-")), "rc");
  const script = `source '${fnFile}'; cd '${cwd}'; ${command.replace("RCFILE", `'${rcFile}'`)}`;
  const args = process.platform === "darwin" ? ["-q", "/dev/null", shellBin, ...shellArgs, script] : ["-q", "-e", "-c", [shellBin, ...shellArgs, `'${script.replace(/'/g, `'\\''`)}'`].join(" "), "/dev/null"];
  spawnSync("/usr/bin/script", args, { env: { ...hostEnv, TERM: PTY_TERM, TMUX: "", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  try {
    return readFileSync(rcFile, "utf8");
  } catch {
    return "";
  }
}

describe.runIf(existsSync("/bin/zsh"))("Shell-Funktion claude/codex in einer zsh", () => {
  const p = fakeProject();
  const sp = shellPaths(join(p.base, "support"));
  const shell = isolatedTmux("shell", null);
  beforeAll(() => {
    mkdirSync(sp.dir, { recursive: true });
    writeFileSync(sp.conf, tmuxConf());
    writeFileSync(sp.runner, runnerScript());
    chmodSync(sp.runner, 0o755);
    writeFileSync(sp.zsh, zshFunctions({ tmuxBin: TMUX, projectRoots: [p.root], paths: sp, socket: shell.socket }));
    writeFileSync(sp.bashRunner, bashRunnerScript());
    chmodSync(sp.bashRunner, 0o755);
    writeFileSync(sp.bash, bashFunctions({ tmuxBin: TMUX, projectRoots: [p.root], paths: sp, socket: shell.socket }));
  });
  afterAll(() => disposeTmux(shell.socket));
  const env = { PATH: `${p.bin}:/usr/bin:/bin`, FAKE_RC: "7" };

  it("unter dem Projektordner: läuft in tmux (zc-claude-…), Argumente unverändert, Exit-Code kommt an", () => {
    const out = zshInPty(sp.zsh, p.root, `claude --model opus "zwei Wörter" 'a;b'`, env);
    expect(out).toMatch(/rc=7/);
    const log = p.log("claude").split("\n");
    expect(log[0]).toMatch(/^tmux=zc-claude-[a-z0-9]{8}$/);
    expect(log[1]).toBe(`cwd=${p.root}`);
    expect(log.slice(2, 6)).toEqual(["--model", "opus", "zwei Wörter", "a;b"]);
  });

  it("codex ebenso, in einer Worktree", () => {
    const out = zshInPty(sp.zsh, join(p.root, "app", ".worktrees", "feature-x"), `codex`, { ...env, FAKE_RC: "0" });
    expect(out).toMatch(/rc=0/);
    expect(p.log("codex")).toMatch(/^tmux=zc-codex-/);
  });

  it("NYXOS_TMUX=0 startet ohne tmux", () => {
    const out = zshInPty(sp.zsh, p.root, `NYXOS_TMUX=0 claude x`, env);
    expect(out).toMatch(/rc=7/);
    expect(p.log("claude").split("\n")[0]).toBe("tmux=");
  });

  it("außerhalb des Projektordners unverändert ohne tmux", () => {
    const out = zshInPty(sp.zsh, p.base, `claude y`, env);
    expect(out).toMatch(/rc=7/);
    expect(p.log("claude").split("\n")[0]).toBe("tmux=");
  });

  it("bash: dieselbe Funktion startet in tmux, Argumente und Exit-Code kommen an", () => {
    p.clear("claude");
    const out = shellInPty("/bin/bash", ["--norc", "--noprofile", "-c"], sp.bash, p.root, `claude --model opus "zwei Wörter"; echo "rc=$?" > RCFILE`, env);
    expect(out).toMatch(/rc=7/);
    const log = p.log("claude").split("\n");
    expect(log[0]).toMatch(/^tmux=zc-claude-[a-z0-9]{8}$/);
    expect(log.slice(2, 5)).toEqual(["--model", "opus", "zwei Wörter"]);
  });
});

describe("Steuermodus (Schritt 2)", () => {
  it("dekodiert %output-Oktalmaskierung inkl. UTF-8", () => {
    expect(decodeOutput("a\\015\\012b\\134c").toString("utf8")).toBe("a\r\nb\\c");
    expect(decodeOutput(Buffer.from("grün ❯", "utf8").toString("latin1")).toString("utf8")).toBe("grün ❯");
  });

  it("Eingaben werden nur als Hex-Bytes weitergereicht — keine Befehlsinjektion in tmux", () => {
    const cmds = inputCommands("zc-claude-abcd1234", '"; kill-server; display "x\r');
    for (const c of cmds) expect(c).toMatch(/^send-keys -t =zc-claude-abcd1234: -H( [0-9a-f]{2})+$/);
    expect(() => inputCommands("zc-claude-abc;kill", "x")).toThrow();
    expect(inputCommands("zc-claude-abcd1234", "x".repeat(600))).toHaveLength(3);
  });

  it("Bildschirm-Abzug setzt Cursor und Alternativ-Puffer", () => {
    const s = buildSnapshot("zeile1\nzeile2\n", "3 1 80 24 0 1 0 0 0 0 0");
    expect(s).toMatchObject({ cols: 80, rows: 24, cursor: { x: 3, y: 1 } });
    expect(s.d).toContain("zeile1\x1b[0m\r\nzeile2");
    expect(s.d).toContain("\x1b[2;4H");
    expect(buildSnapshot("a\nb\nc", "0 0 10 2 1 0 0 0 0 0 0").d.startsWith("\x1b[?1049h\x1b[Hb")).toBe(true);
  });

  it("echte tmux-Session: Abzug mit Verlauf, Eingabe kommt an, zwei Zuschauer sehen dasselbe", async () => {
    const name = "zc-claude-ctrl0001";
    await tmux.newSession({ name, cwd: tmpdir(), cols: 80, rows: 24, env: { PS1: "$ " }, command: ["/bin/sh"] });
    await tmux.run(["send-keys", "-t", `=${name}:`, "-l", "echo vorher-da"]);
    await tmux.run(["send-keys", "-t", `=${name}:`, "Enter"]);
    await until(async () => (await tmux.capture(name)).includes("vorher-da\n"));
    const views = [0, 1].map(() => ({ snap: "", out: "", sizes: [] as string[] }));
    const clients = views.map((v, i) => {
      const c = new ControlClient(tmux, name, {
        snapshot: (s) => (v.snap = s.d),
        output: (d) => (v.out += d),
        size: (cols, rows) => v.sizes.push(`${cols}x${rows}`),
        exit: () => {},
      });
      c.start({ cols: 100, rows: 30, readOnly: i === 1 });
      return c;
    });
    expect(await until(() => views.every((v) => v.snap.includes("vorher-da")))).toBe(true);
    clients[0]?.input("echo live-$((6*7))\r");
    expect(await until(() => views.every((v) => v.out.includes("live-42")))).toBe(true);
    clients[1]?.input("echo vom-zweiten\r"); // auch der zweite Client kann tippen (Nur-ansehen regelt der Server)
    expect(await until(() => views.every((v) => v.out.includes("vom-zweiten")))).toBe(true);
    for (const c of clients) c.close();
    await tmux.killSession(name);
  });

  it("„Nur ansehen“-Client setzt nie die Fenstergröße, ein schreibender schon", async () => {
    const name = "zc-claude-ctrl0003";
    await tmux.newSession({ name, cwd: tmpdir(), cols: 80, rows: 24, env: {}, command: ["/bin/sh"] });
    const size = async () => (await tmux.run(["display", "-p", "-t", `=${name}:`, "#{window_width}x#{window_height}"])).trim();
    let snap = false;
    const ro = new ControlClient(tmux, name, { snapshot: () => (snap = true), output: () => {}, size: () => {}, exit: () => {} });
    ro.start({ cols: 150, rows: 40, readOnly: true });
    await until(() => snap);
    await new Promise((r) => setTimeout(r, 150));
    expect(await size()).toBe("80x24");
    const rw = new ControlClient(tmux, name, { snapshot: () => {}, output: () => {}, size: () => {}, exit: () => {} });
    rw.start({ cols: 150, rows: 40, readOnly: false });
    expect(await until(async () => (await size()) === "150x40")).toBe(true);
    ro.close();
    rw.close();
    await tmux.killSession(name);
  });

  it("Session endet → Kanal meldet exit", async () => {
    const name = "zc-claude-ctrl0002";
    await tmux.newSession({ name, cwd: tmpdir(), cols: 80, rows: 24, env: {}, command: ["/bin/sh"] });
    let reason = "";
    const c = new ControlClient(tmux, name, { snapshot: () => {}, output: () => {}, size: () => {}, exit: (r) => (reason = r) });
    c.start({ cols: 80, rows: 24, readOnly: false });
    await new Promise((r) => setTimeout(r, 200));
    await tmux.killSession(name);
    expect(await until(() => reason !== "")).toBe(true);
  });

  it("unbekannte Session → exit", async () => {
    let reason = "";
    const c = new ControlClient(tmux, "zc-claude-gibtsnic", { snapshot: () => {}, output: () => {}, size: () => {}, exit: (r) => (reason = r) });
    c.start({ cols: 80, rows: 24, readOnly: false });
    expect(await until(() => reason !== "")).toBe(true);
  });
});

describe("Starten, Fortsetzen, Beenden", () => {
  const p = fakeProject();
  const mk = (processAttached = false) =>
    new TerminalManager({
      tmux,
      projectRoots: [p.root],
      path: `${p.bin}:/usr/bin:/bin`,
      log: () => {},
      processAttached: async () => processAttached,
      claudePids: async () => new Map(),
    });

  it("startet Claude in tmux mit vorab vergebener Session-ID, Codex ohne; beide < 3 s", async () => {
    const m = mk();
    const r1 = await m.start({ tool: "claude", model: "opus", cwd: p.root, prompt: "Hallo du", cols: 100, rows: 30, autoCompactEnv: null, autoCompactArgs: null });
    expect(r1.tmuxName).toMatch(/^zc-claude-[a-z0-9]{8}$/);
    expect(r1.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r1.startedMs).toBeLessThan(3000);
    expect(await until(() => p.log("claude").includes("--session-id"))).toBe(true);
    expect(p.log("claude").split("\n").slice(2, 8)).toEqual(["--session-id", r1.sessionId, "--model", "opus", "--", "Hallo du"]);
    const r2 = await m.start({ tool: "codex", model: null, cwd: join(p.root, "app", ".worktrees", "feature-x"), prompt: null, cols: 100, rows: 30, autoCompactEnv: null, autoCompactArgs: null });
    expect(r2).toMatchObject({ tool: "codex", sessionId: null });
    expect(r2.startedMs).toBeLessThan(3000);
  });

  it("Auftrags-Session bekommt Leitplanken-Hook (--settings) + autonomen Modus; ohne Hook kein Start", async () => {
    const without = mk();
    await expect(without.start({ tool: "claude", model: "claude-opus-5-5", cwd: p.root, prompt: "/goal x", cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null, auftrag: { id: "T-01", worktree: p.root } })).rejects.toThrow(/Leitplanken/);
    const m = new TerminalManager({
      tmux,
      projectRoots: [p.root],
      path: `${p.bin}:/usr/bin:/bin`,
      log: () => {},
      processAttached: async () => false,
      claudePids: async () => new Map(),
      guard: { command: "'/opt/nyxos/bridge'", configPath: "/tmp/cfg.json" },
    });
    const r = await m.start({ tool: "claude", model: "claude-opus-5-5", cwd: p.root, prompt: "/goal auftraege/T-01/GOAL.md", cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null, auftrag: { id: "T-01", worktree: p.root } });
    expect(await until(() => p.log("claude").includes(r.sessionId ?? "?"))).toBe(true);
    const args = p.log("claude").split("\n");
    const i = args.indexOf("--settings");
    expect(i).toBeGreaterThan(0);
    expect(JSON.parse(args[i + 1] ?? "{}")).toEqual({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/opt/nyxos/bridge' guard", timeout: 5 }] }] } });
    expect(args).toContain("auto");
    expect(args.filter((x) => x !== "").slice(-2)).toEqual(["--", "/goal auftraege/T-01/GOAL.md"]);
  });

  it("verweigert Ordner außerhalb des Projektordners (auch über ..)", async () => {
    const m = mk();
    await expect(m.start({ tool: "claude", model: null, cwd: p.base, prompt: null, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null })).rejects.toMatchObject({ code: "bad_folder" });
    await expect(m.start({ tool: "claude", model: null, cwd: join(p.root, ".."), prompt: null, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null })).rejects.toMatchObject({ code: "bad_folder" });
  });

  it("Fortsetzen bei noch laufendem Prozess wird verweigert (zwei Prozesse zerstören den Verlauf)", async () => {
    const m = mk(true);
    const err = await m.resume({ tool: "claude", sessionId: "abc", cwd: p.root, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: "process_running" });
    expect(p.log("claude").split("\n")).not.toContain("abc"); // nichts mit --resume abc gestartet
  });

  // (vorher wacklig unter Last): eigener tmux-Server je Test (s. oben), Log vorher leeren, auf den
  // VOLLSTÄNDIGEN Inhalt warten (Datei wird atomar ersetzt) und Claude/Codex getrennt, jeder mit eigenem Zeitbudget.
  it("Fortsetzen ohne Prozess: claude --resume <id> in tmux, im Arbeitsordner der Session", async () => {
    const m = mk(false);
    const sid = "5fd26341-0781-438b-a79f-b103a34c1902";
    p.clear("claude");
    const r = await m.resume({ tool: "claude", sessionId: sid, cwd: p.root, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null });
    expect(r.sessionId).toBe(sid);
    expect(await until(() => p.log("claude").includes(sid))).toBe(true);
    expect(p.log("claude").split("\n").slice(1, 4)).toEqual([`cwd=${p.root}`, "--resume", sid]);
  });

  it("Fortsetzen ohne Prozess: codex resume <id> in tmux (ohne Ordner → Projektordner)", async () => {
    const m = mk(false);
    const cid = "01a0c424-0000-7000-8000-00000000c0de";
    p.clear("codex");
    await m.resume({ tool: "codex", sessionId: cid, cwd: null, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null });
    expect(await until(() => p.log("codex").includes(cid))).toBe(true);
    expect(p.log("codex").split("\n").slice(1, 4)).toEqual([`cwd=${p.root}`, "resume", cid]);
  });

  it("zwei gleichzeitige Fortsetzen-Anfragen → genau eine startet", async () => {
    const m = mk(false);
    const sid = "7a1c0000-0000-4000-8000-00000000race";
    const results = await Promise.allSettled([
      m.resume({ tool: "claude", sessionId: sid, cwd: p.root, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null }),
      m.resume({ tool: "claude", sessionId: sid, cwd: p.root, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "process_running" } });
  });

  it("Prompt, der mit -- beginnt, wird nie als Programm-Option gelesen", async () => {
    const m = mk();
    await m.start({ tool: "codex", model: null, cwd: p.root, prompt: "--dangerously-bypass", cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null });
    expect(await until(() => p.log("codex").includes("--dangerously-bypass"))).toBe(true);
    expect(p.log("codex").split("\n").slice(2, 4)).toEqual(["--", "--dangerously-bypass"]);
  });

  it("zweites Fortsetzen derselben Session, während sie schon in tmux läuft → verweigert", async () => {
    const m = mk(false);
    // Eigener Server je Test: erst starten, dann gilt die Umgebung nur für DIESEN Test.
    await tmux.run(["start-server", ";", "set-environment", "-g", "FAKE_SLEEP", "30"]);
    try {
      const r = await m.start({ tool: "claude", model: null, cwd: p.root, prompt: null, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null });
      await until(async () => (await m.mappingTick()).length > 0 || false, 2000);
      await expect(m.resume({ tool: "claude", sessionId: r.sessionId ?? "", cwd: p.root, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: null })).rejects.toMatchObject({ code: "process_running" });
      // Zuordnung meldet die Session als anhängbar; nach „Prozess beenden" nicht mehr.
      const killed = await m.kill({ tool: "claude", sessionId: r.sessionId ?? "", tmuxName: r.tmuxName });
      expect(killed).toEqual({ killed: true, via: "tmux" });
      const after = await m.mappingTick();
      expect(after).toContainEqual(expect.objectContaining({ type: "terminal", terminal: expect.objectContaining({ sessionId: r.sessionId, attachable: false }) }));
    } finally {
      await tmux.run(["set-environment", "-gu", "FAKE_SLEEP"]);
    }
  });

  it("send_text: nur wenn die Session wartet; sonst {sent:false}", async () => {
    const m = mk(false);
    const name = "zc-claude-send0001";
    await tmux.newSession({ name, cwd: tmpdir(), cols: 80, rows: 24, env: {}, command: ["/bin/sh", "-c", "printf 'arbeite … (esc to interrupt)\\n'; sleep 30"] });
    await until(async () => (await tmux.capture(name)).includes("esc to interrupt"));
    expect(await m.sendText({ tmuxName: name, text: "/compact", submit: true, onlyWhenWaiting: true })).toEqual({ sent: false, reason: "Session arbeitet gerade" });
    const name2 = "zc-claude-send0002";
    await tmux.newSession({ name: name2, cwd: tmpdir(), cols: 80, rows: 24, env: {}, command: ["/bin/sh", "-c", "printf '> '; read x; echo \"bekommen:$x\"; sleep 5"] });
    await until(async () => (await tmux.capture(name2)).includes(">"));
    expect(await m.sendText({ tmuxName: name2, text: "/compact", submit: true, onlyWhenWaiting: true })).toEqual({ sent: true });
    expect(await until(async () => (await tmux.capture(name2)).includes("bekommen:/compact"))).toBe(true);
  });

  it("Ordner-Liste: Projektordner, Unterordner, Worktrees", () => {
    const labels = mk().listFolders().map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(["projekte", "projekte/app", "Worktree app/feature-x"]));
  });

  it("Server-Nachricht mit ungültigem tmux-Namen wird nie an tmux gegeben", async () => {
    const m = mk();
    const sent: BridgeToServer[] = [];
    await m.handle(JSON.stringify({ op: "open", ch: 1, tmuxName: "zc-claude-x;kill-server", cols: 80, rows: 24, readOnly: false }), (x) => sent.push(x));
    expect(sent).toHaveLength(0);
    expect(m.channelCount).toBe(0);
  });
});

// Ein-Klick-Start legt den Worktree über DIESE RPC an — die Brücke sucht das Repo zum Anker und berechnet
// den Pfad SELBST (`<repo>/.worktrees/<slug>`, nie einen vom Server gelieferten Pfad übernehmen) und führt
// `git worktree add` per `execFile` mit einer Argument-LISTE aus (kein `sh -c`, keine Injektion über
// `branch` möglich — ohnehin schon durch `WorktreeAddRequestSchema` auf `[a-z0-9-]`/`auftrag/…` beschränkt).
describe("worktree_add", () => {
  /** Wegwerf-Projektordner mit zwei echten Git-Repos (`git worktree add` braucht ein echtes Repo). */
  function fakeGitProject() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-p3-wt-")));
    const root = join(base, "projekte");
    const appDir = join(root, "app");
    const toolDir = join(root, "werkzeug");
    for (const dir of [appDir, toolDir]) {
      mkdirSync(join(dir, "docs", "auftrag"), { recursive: true });
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      spawnSync("git", ["config", "user.email", "test@nyxos.local"], { cwd: dir });
      spawnSync("git", ["config", "user.name", "NyxOS Test"], { cwd: dir });
      writeFileSync(join(dir, "README.md"), "x\n");
      writeFileSync(join(dir, "docs", "auftrag", "GOAL.md"), "# Ziel\n");
      spawnSync("git", ["add", "."], { cwd: dir });
      spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    }
    return { base, root, appDir, toolDir };
  }

  const mkManager = (root: string) =>
    new TerminalManager({ tmux, projectRoots: [root], path: `${TMUX}:/usr/bin:/bin`, log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });

  it("legt den Worktree im Repo des Ankers unter .worktrees/<slug> an (Branch stimmt, Anker relativ zum Repo)", async () => {
    const g = fakeGitProject();
    const m = mkManager(g.root);
    const result = await m.worktreeAdd({ anchor: "app/docs/auftrag/GOAL.md", slug: "1-mein-auftrag", branch: "auftrag/1-mein-auftrag" });
    expect(result).toMatchObject({ repoRoot: g.appDir, worktreePath: join(g.appDir, ".worktrees", "1-mein-auftrag"), branch: "auftrag/1-mein-auftrag", anchorInRepo: "docs/auftrag/GOAL.md", reused: false });
    expect(spawnSync("git", ["-C", result.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe("auftrag/1-mein-auftrag");
    // Der Ordner mit den Arbeitskopien taucht im Hauptrepo nicht als „ungesichert“ auf.
    expect(spawnSync("git", ["-C", g.appDir, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim()).toBe("");
  });

  it("ein Ordner als Anker (anderes Repo) und ein zweiter Aufruf mit demselben Slug verwendet den Worktree weiter", async () => {
    const g = fakeGitProject();
    const m = mkManager(g.root);
    const first = await m.worktreeAdd({ anchor: "werkzeug", slug: "2-etwas", branch: "auftrag/2-etwas" });
    expect(first).toMatchObject({ repoRoot: g.toolDir, worktreePath: join(g.toolDir, ".worktrees", "2-etwas"), anchorInRepo: null });
    const again = await m.worktreeAdd({ anchor: "werkzeug", slug: "2-etwas", branch: "auftrag/2-etwas" });
    expect(again).toMatchObject({ worktreePath: first.worktreePath, reused: true });
    await expect(m.worktreeAdd({ anchor: "werkzeug", slug: "2-etwas", branch: "auftrag/anderer-zweig" })).rejects.toThrow();
  });

  it("läuft auch über den normalen RPC-Weg ('rpc(\"worktree_add\", …)'), nicht nur direkt aufgerufen", async () => {
    const g = fakeGitProject();
    const m = mkManager(g.root);
    const result = (await m.rpc("worktree_add", { anchor: "app", slug: "3-per-rpc", branch: "auftrag/3-per-rpc" })) as { worktreePath: string };
    expect(result.worktreePath).toBe(join(g.appDir, ".worktrees", "3-per-rpc"));
  });

  it("Anker ohne Repo, unbekannter Anker oder Projektordner ohne Repo werden abgelehnt", async () => {
    const g = fakeGitProject();
    mkdirSync(join(g.root, "lose"), { recursive: true });
    const m = mkManager(g.root);
    await expect(m.worktreeAdd({ anchor: "lose", slug: "5-x", branch: "auftrag/5-x" })).rejects.toThrow();
    await expect(m.worktreeAdd({ anchor: "gibt/es/nicht", slug: "5-y", branch: "auftrag/5-y" })).rejects.toThrow();
    await expect(m.worktreeAdd({ anchor: "", slug: "5-z", branch: "auftrag/5-z" })).rejects.toThrow();
  });

  it("zeigt .worktrees als Symlink nach AUSSERHALB des Repos, wird abgelehnt (realpath-Prüfung, nicht nur Textvergleich)", async () => {
    const g = fakeGitProject();
    const outside = mkdtempSync(join(tmpdir(), "nyxos-p3-outside-"));
    symlinkSync(outside, join(g.appDir, ".worktrees"));
    const m = mkManager(g.root);
    await expect(m.worktreeAdd({ anchor: "app", slug: "4-x", branch: "auftrag/4-x" })).rejects.toThrow();
  });

  it("ein Anker nach draußen (Symlink) wird nie benutzt", async () => {
    const g = fakeGitProject();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-p3-draussen-")));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: outside });
    symlinkSync(outside, join(g.root, "link"));
    const m = mkManager(g.root);
    await expect(m.worktreeAdd({ anchor: "link", slug: "6-x", branch: "auftrag/6-x" })).rejects.toThrow();
  });

  it("Slug/Anker mit Pfad-Traversal oder Sonderzeichen scheitern schon am Schema, bevor die Brücke irgendetwas tut", () => {
    expect(() => WorktreeAddRequestSchema.parse({ anchor: "", slug: "../../etc", branch: "auftrag/x" })).toThrow();
    expect(() => WorktreeAddRequestSchema.parse({ anchor: "", slug: "x; rm -rf /", branch: "auftrag/x" })).toThrow();
    expect(() => WorktreeAddRequestSchema.parse({ anchor: "", slug: "x", branch: "x; rm -rf /" })).toThrow();
    expect(() => WorktreeAddRequestSchema.parse({ anchor: "../x", slug: "x", branch: "auftrag/x" })).toThrow();
    expect(() => WorktreeAddRequestSchema.parse({ anchor: "/etc", slug: "x", branch: "auftrag/x" })).toThrow();
  });
});

describe("Zustand „wartet“ aus dem Bildschirm (Schritt 5)", () => {
  const fixture = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "screens", n), "utf8");
  it("Claude-Freigabe-Frage (echter Abzug) → wartet", () => {
    expect(screenWaiting("claude", fixture("claude-permission.txt"))).toMatchObject({ waiting: true });
  });
  it("Claude arbeitet (echter Abzug) → wartet nicht", () => {
    expect(screenWaiting("claude", fixture("claude-working.txt")).waiting).toBe(false);
  });
  it("arbeitende Session (Spinner, echter Abzug) gilt nicht als bereit für /compact", () => {
    expect(isIdlePrompt("claude", fixture("claude-working.txt"))).toBe(false);
  });
  it("Rechte-Abfrage mit ❯-Menü (echter Abzug) gilt NIE als wartende leere Eingabe", () => {
    expect(isIdlePrompt("claude", fixture("claude-permission.txt"))).toBe(false);
  });
  it("halb getippter Text vor dem Prompt-Zeichen wird nie gesendet", () => {
    expect(isIdlePrompt("claude", "❯ Vorheriger Befehl\n\n❯ touch zc-pr")).toBe(false);
    expect(isIdlePrompt("codex", "› Vorheriger Befehl\n\n› touch zc-pr")).toBe(false);
  });
  it("leere Eingabezeile (letzte nicht-leere Zeile) gilt als wartend", () => {
    expect(isIdlePrompt("claude", "❯ Vorheriger Befehl\n\n❯ ")).toBe(true);
    expect(isIdlePrompt("codex", "› Vorheriger Befehl\n\n› ")).toBe(true);
  });
  it("Codex-Freigabe-Menü (letzte Zeile ist ein Menüpunkt, keine leere Eingabe) wird nie gesendet", () => {
    expect(isIdlePrompt("codex", "Allow command?\n❯ 1. Yes\n  2. No")).toBe(false);
  });
  it("Rechte-Abfrage per screenWaiting-Regel greift auch dann, wenn die letzte Zeile zufällig wie eine leere Eingabe aussieht", () => {
    expect(isIdlePrompt("claude", "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\n❯ ")).toBe(false);
  });
});

describe("Brücke akzeptiert nur eine Positivliste für autoCompact env/-c", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-p3-ac-")));
  const root = join(base, "projekte");
  const bin = join(base, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const tool of ["claude", "codex"]) {
    const f = join(bin, tool);
    writeFileSync(f, `#!/bin/sh\nprintf 'env=%s|%s|%s\\nargs=%s\\n' "$CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" "$EVIL_ENV" "$LD_PRELOAD" "$*" > "${base}/${tool}.log"\necho fertig\nexit 0\n`);
    chmodSync(f, 0o755);
  }
  const log = (tool: string) => {
    try {
      return readFileSync(join(base, `${tool}.log`), "utf8");
    } catch {
      return "";
    }
  };
  // Jeder Test teilt sich die Log-Datei mit den anderen (ein Projektordner je describe, wie
  // `fakeProject()`) — vor jedem Start löschen, sonst liest `until()` u. U. den Rest-Stand des
  // vorigen Tests und meldet fälschlich "fertig", bevor der neue Prozess überhaupt geschrieben hat.
  const clearLog = (tool: string) => {
    try {
      rmSync(join(base, `${tool}.log`));
    } catch {
      // gab es noch nicht
    }
  };
  const mk = () => new TerminalManager({ tmux, projectRoots: [root], path: `${bin}:/usr/bin:/bin`, log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });

  it("env: nur CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (50–100) kommt an, weitere Schlüssel werden verworfen", async () => {
    const m = mk();
    clearLog("claude");
    await m.start({
      tool: "claude",
      model: null,
      cwd: root,
      prompt: null,
      cols: 80,
      rows: 24,
      autoCompactEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80", EVIL_ENV: "böse", LD_PRELOAD: "/tmp/evil.so" },
      autoCompactArgs: null,
    });
    expect(await until(() => log("claude").includes("env="))).toBe(true);
    expect(log("claude").split("\n")[0]).toBe("env=80||");
  });

  it("env: Wert außerhalb 50–100 wird komplett verworfen (nie geraten/geklemmt)", async () => {
    const m = mk();
    clearLog("claude");
    await m.start({ tool: "claude", model: null, cwd: root, prompt: null, cols: 80, rows: 24, autoCompactEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "30" }, autoCompactArgs: null });
    expect(await until(() => log("claude").includes("env="))).toBe(true);
    expect(log("claude").split("\n")[0]).toBe("env=||");
  });

  it("env: nicht-numerischer Wert (Befehls-Einschleusung über die Umgebung) wird verworfen", async () => {
    const m = mk();
    clearLog("claude");
    await m.start({ tool: "claude", model: null, cwd: root, prompt: null, cols: 80, rows: 24, autoCompactEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80; rm -rf /" }, autoCompactArgs: null });
    expect(await until(() => log("claude").includes("env="))).toBe(true);
    expect(log("claude").split("\n")[0]).toBe("env=||");
  });

  it("-c: nur `model_auto_compact_token_limit=<Zahl>` als alleiniges Argumentpaar kommt an", async () => {
    const m = mk();
    clearLog("codex");
    await m.start({
      tool: "codex",
      model: null,
      cwd: root,
      prompt: null,
      cols: 80,
      rows: 24,
      autoCompactEnv: null,
      autoCompactArgs: ["-c", "model_auto_compact_token_limit=207520"],
    });
    expect(await until(() => log("codex").includes("args="))).toBe(true);
    expect(log("codex").split("\n")[1]).toBe("args=-c model_auto_compact_token_limit=207520");
  });

  it("-c: zusätzliche/andere Argumente daneben lassen das ganze Paar verwerfen", async () => {
    const m = mk();
    clearLog("codex");
    await m.start({
      tool: "codex",
      model: null,
      cwd: root,
      prompt: null,
      cols: 80,
      rows: 24,
      autoCompactEnv: null,
      autoCompactArgs: ["-c", "model_auto_compact_token_limit=1", "--dangerously-bypass-approvals-and-sandbox"],
    });
    expect(await until(() => log("codex").includes("args="))).toBe(true);
    expect(log("codex").split("\n")[1]).toBe("args=");
  });

  it("-c: nicht-numerischer Limit-Wert wird verworfen", async () => {
    const m = mk();
    clearLog("codex");
    await m.start({ tool: "codex", model: null, cwd: root, prompt: null, cols: 80, rows: 24, autoCompactEnv: null, autoCompactArgs: ["-c", "model_auto_compact_token_limit=$(rm -rf /)"] });
    expect(await until(() => log("codex").includes("args="))).toBe(true);
    expect(log("codex").split("\n")[1]).toBe("args=");
  });
});

describe("status (Verbindungs-Prüfung)", () => {
  it("meldet über den RPC-Weg Puffer/Scans aus dem Daemon plus echten tmux-Stand, schreibt nichts", async () => {
    const p = fakeProject();
    const base = {
      at: 1,
      version: "r1",
      queued: 4,
      dead: 1,
      lastOkAt: 2,
      lastError: null,
      archiveError: null,
      watchedFiles: 7,
      scans: { usage: 3, git: null, vault: 5, catalog: null },
      vaultError: null,
    };
    const m = new TerminalManager({ tmux, projectRoots: [p.root], path: `${p.bin}:/usr/bin:/bin`, log: () => {}, processAttached: async () => false, claudePids: async () => new Map(), status: () => base });
    const r = (await m.rpc("status", {})) as Record<string, unknown>;
    expect(r).toMatchObject({ ...base, tmux: { ok: true, error: null } });
    expect(typeof (r.tmux as { sessions: number }).sessions).toBe("number");
  });

  it("ohne Daemon-Stand (Tests/Probe): Grundwerte statt Fehler", async () => {
    const p = fakeProject();
    const m = new TerminalManager({ tmux, projectRoots: [p.root], path: `${p.bin}:/usr/bin:/bin`, log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });
    expect(await m.rpc("status", {})).toMatchObject({ version: null, queued: 0, tmux: { ok: true } });
  });
});
