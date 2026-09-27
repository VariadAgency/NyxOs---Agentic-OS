// Server-SSH: Terminal zu einem eigenen Server als eigene tmux-Session `zc-ssh-*` mit FESTEM Befehl
// `ssh -t -- <host>` (Host aus der Server-Einstellung, per Schema geprüft). Gegen ein echtes tmux auf einem
// Wegwerf-Socket und ein falsches ssh, das nur seine Argumente protokolliert (nie ein echter Server, nie `-L nyxos`).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSH_TMUX_NAME_RE, SendTextRequestSchema, ServerToBridgeSchema, TMUX_NAME_RE, type BridgeToServer } from "@nyxos/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverSshCommand, TerminalManager, toolOfTmuxName } from "../src/terminal/manager.js";
import { tmuxConf } from "../src/terminal/shell.js";
import type { Tmux } from "../src/terminal/tmux.js";
import { disposeTmux, isolatedTmux, removeStaleTestSockets, TMUX_BIN as TMUX, until } from "./tmuxSockets.js";

const CONF = join(mkdtempSync(join(tmpdir(), "nyxos-ssh-conf-")), "tmux.conf");
writeFileSync(CONF, tmuxConf());

let tmux: Tmux;
let socket = "";
beforeEach(() => {
  ({ tmux, socket } = isolatedTmux("ssh", CONF));
});
afterEach(() => disposeTmux(socket));
afterAll(() => removeStaleTestSockets(undefined, { onlyDeadOwner: true }));

/** Falsches ssh: schreibt seine Argumente (eine Zeile je Argument) in eine Datei und bleibt dann offen. */
function fakeSsh() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-ssh-")));
  const root = join(base, "projekte");
  mkdirSync(root, { recursive: true });
  const bin = join(base, "ssh");
  const logFile = join(base, "ssh.log");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${logFile}.tmp"\nmv "${logFile}.tmp" "${logFile}"\nexec sleep 30\n`);
  chmodSync(bin, 0o755);
  const log = () => {
    try {
      return readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  return { root, bin, log };
}

const HOST = "mein-server";

const mk = (p: ReturnType<typeof fakeSsh>) =>
  new TerminalManager({ tmux, projectRoots: [p.root], path: `${TMUX}:/usr/bin:/bin`, log: () => {}, processAttached: async () => false, claudePids: async () => new Map(), sshBin: p.bin });

describe("Server-SSH: fester Befehl", () => {
  it("der Startbefehl ist exakt `ssh -t -- <host>` – das Ziel nie als Schalter", () => {
    expect(serverSshCommand("/usr/bin/ssh", "mein-server")).toEqual(["/usr/bin/ssh", "-t", "--", "mein-server"]);
  });

  it("ssh-Sitzungen gelten nie als Claude/Codex (Zuordnung, Archiv, Chat)", () => {
    expect(toolOfTmuxName("zc-ssh-abcd1234")).toBeNull();
    expect(toolOfTmuxName("zc-claude-abcd1234")).toBe("claude");
    expect(toolOfTmuxName("zc-codex-abcd1234")).toBe("codex");
    expect(TMUX_NAME_RE.test("zc-ssh-abcd1234")).toBe(false);
    expect(SSH_TMUX_NAME_RE.test("zc-ssh-abcd1234")).toBe(true);
    // Text/Chat/Esc in die Produktions-Shell schicken geht schon am Schema nicht vorbei.
    expect(SendTextRequestSchema.safeParse({ tmuxName: "zc-ssh-abcd1234", text: "ls" }).success).toBe(false);
  });

  it("Kanal `open` akzeptiert die ssh-Sitzung, aber keine erfundenen Namen", () => {
    const open = (tmuxName: string) => ServerToBridgeSchema.safeParse({ op: "open", ch: 1, tmuxName, cols: 80, rows: 24, readOnly: false }).success;
    expect(open("zc-ssh-abcd1234")).toBe(true);
    expect(open("zc-claude-abcd1234")).toBe(true);
    expect(open("zc-bash-abcd1234")).toBe(false);
    expect(open("zc-ssh-abcd1234;ls")).toBe(false);
  });

  it("ssh_start lehnt unbekannte Parameter und Schalter als Ziel ab", async () => {
    const m = mk(fakeSsh());
    await expect(m.rpc("ssh_start", { cols: 80, rows: 24, host: "mein-server", command: "rm -rf /" })).rejects.toThrow();
    await expect(m.rpc("ssh_start", { cols: 80, rows: 24, host: "-oProxyCommand=touch /tmp/x" })).rejects.toThrow();
    await expect(m.rpc("ssh_start", { cols: 80, rows: 24, host: "a b" })).rejects.toThrow();
    await expect(m.rpc("ssh_start", { cols: 80, rows: 24 })).rejects.toThrow();
    await expect(m.rpc("ssh_stop", { tmuxName: "zc-claude-abcd1234" })).rejects.toThrow();
  });
});

describe("Server-SSH: Starten, Wiederverwenden, Beenden (echtes tmux)", () => {
  it("startet zc-ssh-* mit genau `-t -- <host>`, verwendet sie wieder und wird nie als Session gemeldet", async () => {
    const p = fakeSsh();
    const m = mk(p);
    expect(await m.rpc("ssh_status", {})).toEqual({ running: false, tmuxName: null });
    const r1 = (await m.rpc("ssh_start", { cols: 100, rows: 30, host: HOST })) as { tmuxName: string; reused: boolean };
    expect(r1.tmuxName).toMatch(/^zc-ssh-[a-z0-9]{8}$/);
    expect(r1.reused).toBe(false);
    expect(await until(() => p.log() !== "")).toBe(true);
    expect(p.log().trimEnd().split("\n")).toEqual(["-t", "--", HOST]);

    // Zweiter Klick / zweiter Tab: dieselbe Sitzung, keine zweite ssh-Verbindung.
    const r2 = (await m.rpc("ssh_start", { cols: 80, rows: 24, host: HOST })) as { tmuxName: string; reused: boolean };
    expect(r2).toEqual({ tmuxName: r1.tmuxName, reused: true });
    // Zwei gleichzeitige Starts: trotzdem nur eine.
    await m.rpc("ssh_stop", {});
    const [a, b] = (await Promise.all([m.rpc("ssh_start", { cols: 80, rows: 24, host: HOST }), m.rpc("ssh_start", { cols: 80, rows: 24, host: HOST })])) as { tmuxName: string }[];
    expect(a?.tmuxName).toBe(b?.tmuxName);
    const all = await tmux.run(["list-sessions", "-F", "#{session_name}"]);
    expect(all.split("\n").filter((n) => n.startsWith("zc-ssh-"))).toHaveLength(1);

    expect(await m.rpc("ssh_status", {})).toEqual({ running: true, tmuxName: a?.tmuxName });
    // Session-Erkennung: weder in der Pane-Liste der Werkzeuge noch als Terminal-Zuordnung gemeldet.
    expect((await tmux.listPanes()).map((x) => x.name)).not.toContain(a?.tmuxName);
    expect(await m.mappingTick()).toEqual([]);

    expect(await m.rpc("ssh_stop", {})).toEqual({ stopped: 1 });
    expect(await m.rpc("ssh_status", {})).toEqual({ running: false, tmuxName: null });
  });

  it("Browser-Kanal hängt sich an die ssh-Sitzung (Abzug kommt)", async () => {
    const m = mk(fakeSsh());
    const { tmuxName } = (await m.rpc("ssh_start", { cols: 80, rows: 24, host: HOST })) as { tmuxName: string };
    const got: BridgeToServer[] = [];
    await m.handle(JSON.stringify({ op: "open", ch: 7, tmuxName, cols: 80, rows: 24, readOnly: false }), (x) => got.push(x));
    expect(await until(() => got.some((x) => x.op === "snapshot"))).toBe(true);
    m.closeAll();
  });
});
