// Brücken-Seite des Session-Chats gegen ein ECHTES tmux auf einem eigenen Wegwerf-Socket
// (nie `-L nyxos`, nie die installierte Brücke): Anhänge ablegen (`save_upload`) und Nachricht
// einfügen (`send_message`: Bildpfade als eigene Einfügungen, Text als EIN Einfügen, dann Enter).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findTmux } from "../src/config.js";
import { RpcError, TerminalManager } from "../src/terminal/manager.js";
import { tmuxConf } from "../src/terminal/shell.js";
import { Tmux } from "../src/terminal/tmux.js";

const TMUX = findTmux();
const SOCKET = `zc-test-chat-${process.pid}`;
const CONF = join(mkdtempSync(join(tmpdir(), "nyxos-chat-conf-")), "tmux.conf");
writeFileSync(CONF, tmuxConf());
const tmux = new Tmux({ bin: TMUX, socket: SOCKET, conf: CONF });
afterAll(() => {
  spawnSync(TMUX, ["-L", SOCKET, "kill-server"]);
});

const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-chat-")));
const uploadsDir = join(base, "Application Support", "NyxOS", "uploads");
const manager = new TerminalManager({ tmux, projectRoots: [base], path: "/usr/bin:/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map(), uploadsDir });

/**
 * Wie Claude Code: schaltet „bracketed paste“ ein, liest roh und schreibt jedes empfangene Byte in
 * eine Datei — so sieht der Test genau, was ankommt (Einfüge-Klammern, Zeilenumbrüche, Enter).
 */
function recorder(out: string, screen = "> "): string[] {
  const py = [
    "import os, sys, tty",
    "fd = sys.stdin.fileno()",
    "tty.setraw(fd)",
    `sys.stdout.write("\\x1b[?2004h" + ${JSON.stringify(screen)}); sys.stdout.flush()`,
    "buf = b''",
    "while True:",
    "    buf += os.read(fd, 4096)",
    `    open(${JSON.stringify(out)}, 'wb').write(buf)`,
  ].join("\n");
  return ["/usr/bin/python3", "-c", py];
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("Anhänge auf dem Rechner ablegen (save_upload)", () => {
  it("legt Dateien unter uploads/<tool>-<id>/ ab, Inhalt stimmt, Namen harmlos, Ordner nur für den Nutzer", async () => {
    const r = (await manager.rpc("save_upload", {
      sessionKey: "claude:s1",
      files: [
        { name: "Bildschirmfoto 1.png", dataBase64: PNG.toString("base64") },
        { name: "../../geheim.txt", dataBase64: Buffer.from("hallo").toString("base64") },
      ],
    })) as { files: { name: string; path: string; bytes: number }[] };
    expect(r.files).toHaveLength(2);
    const dir = join(uploadsDir, "claude-s1");
    for (const f of r.files) {
      expect(f.path.startsWith(dir + "/")).toBe(true);
      expect(existsSync(f.path)).toBe(true);
    }
    expect(r.files[0]?.name).toBe("Bildschirmfoto-1.png");
    expect(readFileSync(r.files[0]?.path as string)).toEqual(PNG);
    expect(r.files[1]?.name).toBe("geheim.txt");
    expect(readFileSync(r.files[1]?.path as string, "utf8")).toBe("hallo");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("zweimal derselbe Name überschreibt nie", async () => {
    const one = (await manager.rpc("save_upload", { sessionKey: "claude:s2", files: [{ name: "a.txt", dataBase64: Buffer.from("1").toString("base64") }] })) as { files: { path: string }[] };
    const two = (await manager.rpc("save_upload", { sessionKey: "claude:s2", files: [{ name: "a.txt", dataBase64: Buffer.from("2").toString("base64") }] })) as { files: { path: string }[] };
    expect(one.files[0]?.path).not.toBe(two.files[0]?.path);
    expect(readFileSync(one.files[0]?.path as string, "utf8")).toBe("1");
  });

  it("verbotene Dateiart und kaputter Session-Schlüssel werden abgelehnt", async () => {
    await expect(manager.rpc("save_upload", { sessionKey: "claude:s1", files: [{ name: "x.exe", dataBase64: "AAAA" }] })).rejects.toBeInstanceOf(RpcError);
    await expect(manager.rpc("save_upload", { sessionKey: "../etc", files: [{ name: "a.txt", dataBase64: "AAAA" }] })).rejects.toThrow();
  });
});

describe("Nachricht einfügen (send_message)", () => {
  it("Bildpfad als eigenes Einfügen, mehrzeiliger Text als EIN Einfügen, danach genau ein Enter", async () => {
    const out = join(base, "empfang-1.bin");
    const name = "zc-claude-chat0001";
    await tmux.newSession({ name, cwd: base, cols: 100, rows: 30, env: {}, command: recorder(out) });
    await until(async () => (await tmux.capture(name)).includes(">"));
    const r = await manager.rpc("send_message", { tmuxName: name, images: ["/pfad mit leer/rot.png"], text: "Zeile 1\nZeile 2" });
    expect(r).toEqual({ sent: true, busy: false });
    const want = "\x1b[200~/pfad mit leer/rot.png\x1b[201~\x1b[200~ Zeile 1\rZeile 2\x1b[201~\r";
    expect(await until(() => existsSync(out) && readFileSync(out, "latin1").length >= want.length)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(want);
  });

  it("arbeitet die Session gerade → trotzdem eingefügt, als „in der Warteschlange“ gemeldet", async () => {
    const out = join(base, "empfang-2.bin");
    const name = "zc-claude-chat0002";
    await tmux.newSession({ name, cwd: base, cols: 100, rows: 30, env: {}, command: recorder(out, "✽ Unraveling… (2s · thinking)\r\n> ") });
    await until(async () => (await tmux.capture(name)).includes("Unraveling"));
    expect(await manager.rpc("send_message", { tmuxName: name, images: [], text: "danach bitte" })).toEqual({ sent: true, busy: true });
    expect(await until(() => existsSync(out) && readFileSync(out, "utf8").endsWith("\r"))).toBe(true);
  });

  it("offene Freigabe-Frage → NICHTS eingefügt (sonst träfe Enter eine Auswahl)", async () => {
    const out = join(base, "empfang-3.bin");
    const name = "zc-claude-chat0003";
    await tmux.newSession({ name, cwd: base, cols: 100, rows: 30, env: {}, command: recorder(out, "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n") });
    await until(async () => (await tmux.capture(name)).includes("proceed"));
    const r = (await manager.rpc("send_message", { tmuxName: name, images: [], text: "ja" })) as { sent: boolean; reason?: string };
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/Freigabe/);
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(out) ? readFileSync(out, "utf8") : "").toBe("");
  });

  it("Steuerzeichen im Text brechen nie aus dem Einfügen aus", async () => {
    const out = join(base, "empfang-4.bin");
    const name = "zc-claude-chat0004";
    await tmux.newSession({ name, cwd: base, cols: 100, rows: 30, env: {}, command: recorder(out) });
    await until(async () => (await tmux.capture(name)).includes(">"));
    await manager.rpc("send_message", { tmuxName: name, images: [], text: "a\x1b[201~b\x03" });
    const want = "\x1b[200~a[201~b\x1b[201~\r";
    expect(await until(() => existsSync(out) && readFileSync(out, "latin1").length >= want.length)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(want);
  });

  it("Semikolon am Ende und „\\;“ kommen unverändert an (tmux liest ein End-Semikolon sonst als Befehlstrenner)", async () => {
    const out = join(base, "empfang-5.bin");
    const name = "zc-claude-chat0005";
    await tmux.newSession({ name, cwd: base, cols: 100, rows: 30, env: {}, command: recorder(out) });
    await until(async () => (await tmux.capture(name)).includes(">"));
    await manager.rpc("send_message", { tmuxName: name, images: [], text: "a;b\\;c;" });
    const want = "\x1b[200~a;b\\;c;\x1b[201~\r";
    expect(await until(() => existsSync(out) && readFileSync(out, "latin1").length >= want.length)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(want);
  });

  it("unbekannte tmux-Session → Fehler „not_found“, nichts passiert", async () => {
    await expect(manager.rpc("send_message", { tmuxName: "zc-claude-gibtsnix", images: [], text: "x" })).rejects.toMatchObject({ code: "not_found" });
  });
});
