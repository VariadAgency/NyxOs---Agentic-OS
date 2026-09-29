// Warte-Erkennung am Bildschirm: Eine wartende Claude-Session darf nicht als „arbeitet“ gelten (würde
// nur die letzte Bildschirmzeile geprüft, ginge z. B. „Kontext komprimieren“ nie durch). Echte Abzüge von
// Claude Code 2.1.282 und Codex 0.153 (Probe-Socket) liegen unter fixtures/screens/:
// `*.txt` = `capture-pane -p`, `*.ansi` = `capture-pane -p -e` (mit Farben, grauer Vorschlag erkennbar).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findTmux } from "../src/config.js";
import { isIdlePrompt, TerminalManager } from "../src/terminal/manager.js";
import { promptState } from "../src/terminal/prompt.js";
import { tmuxConf } from "../src/terminal/shell.js";
import { Tmux } from "../src/terminal/tmux.js";

const DIR = join(import.meta.dirname, "fixtures", "screens");
const fx = (n: string) => readFileSync(join(DIR, n), "utf8");

describe("Warte-Erkennung an echten Bildschirmen (Claude Code 2.1.282)", () => {
  it("wartend mit grauem Vorschlag in der Eingabe → wartet (mit Farben)", () => {
    expect(isIdlePrompt("claude", fx("claude-2.1.282-idle-placeholder.ansi"))).toBe(true);
  });
  it("wartend nach einer Antwort, Trennlinie + Statuszeilen darunter → wartet (mit und ohne Farben)", () => {
    expect(isIdlePrompt("claude", fx("claude-2.1.282-idle-done.ansi"))).toBe(true);
    expect(isIdlePrompt("claude", fx("claude-2.1.282-idle-done.txt"))).toBe(true);
  });
  it("Vorschlag ohne Farben ist nicht von getipptem Text zu unterscheiden → lieber nicht senden", () => {
    expect(promptState("claude", fx("claude-2.1.282-idle-placeholder.txt"))).toBe("typed");
  });
  it("halb getippter Text in der Eingabe → nie senden", () => {
    expect(promptState("claude", fx("claude-2.1.282-typed.ansi"))).toBe("typed");
    expect(promptState("claude", fx("claude-2.1.282-typed.txt"))).toBe("typed");
  });
  it("Spinner über der Eingabe (mit und ohne Zeitangabe) → arbeitet", () => {
    expect(promptState("claude", fx("claude-2.1.282-spinner.ansi"))).toBe("working");
    expect(promptState("claude", fx("claude-2.1.282-spinner-no-time.ansi"))).toBe("working");
    expect(promptState("claude", fx("claude-working.txt"))).toBe("working");
  });
  it("Freigabe-Frage → nie wartend", () => {
    expect(promptState("claude", fx("claude-permission.txt"))).toBe("dialog");
  });
  it("das Wort „Working“ weit oben in einer Antwort blockiert nicht", () => {
    const screen = `⏺ Working tree ist sauber.\n${"\n".repeat(12)}${fx("claude-2.1.282-idle-done.ansi")}`;
    expect(promptState("claude", screen)).toBe("idle");
  });
  it("Text zwischen Eingabe und unterer Trennlinie (mehrzeilige Eingabe) → nicht leer", () => {
    const rule = "─".repeat(40);
    expect(promptState("claude", `${rule}\n❯ \n  zweite Zeile\n${rule}\n  ⏸ manual mode on`)).not.toBe("idle");
  });
  it("Farbwert mit „2“ (38;5;246) gilt nicht als grau", () => {
    expect(promptState("claude", "\x1b[39m❯ \x1b[38;5;246mecht getippt\x1b[39m")).toBe("typed");
    expect(promptState("claude", "\x1b[39m❯ \x1b[38;2;2;2;2mecht getippt\x1b[39m")).toBe("typed");
  });
});

describe("Warte-Erkennung an echten Bildschirmen (Codex 0.153)", () => {
  it("leere Eingabe mit grauem Vorschlag + Statuszeile → wartet", () => {
    expect(promptState("codex", fx("codex-0.153-idle.ansi"))).toBe("idle");
  });
  it("Update-Menü „› 1. Update now“ → nie wartend", () => {
    expect(isIdlePrompt("codex", fx("codex-0.153-update-menu.ansi"))).toBe(false);
    expect(isIdlePrompt("codex", fx("codex-0.153-update-menu.txt"))).toBe(false);
  });
});

// Echtes tmux: der Bildschirm einer wartenden Claude-Session (Abzug mit Farben) wird in ein Wegwerf-Feld
// gezeichnet; `send_text` mit `onlyWhenWaiting` muss ankommen. Der Hook-Zustand ist die zweite Quelle.
const TMUX = findTmux();
const SOCKET = `zc-test-fx2a-${process.pid}`;
const CONF = join(mkdtempSync(join(tmpdir(), "nyxos-fx2a-conf-")), "tmux.conf");
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
const manager = new TerminalManager({ tmux, projectRoots: [tmpdir()], path: "/usr/bin:/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });

/** Zeichnet einen Abzug ins Feld (ohne letzten Zeilenumbruch) und schreibt danach Empfangenes in `out`. */
async function paneWith(name: string, fixture: string, out: string): Promise<void> {
  const screen = fx(fixture).replace(/\n+$/, "");
  const file = join(mkdtempSync(join(tmpdir(), "nyxos-fx2a-")), "screen.bin");
  writeFileSync(file, screen.replace(/\n/g, "\r\n"));
    const py = ["import sys, os, tty", "fd = sys.stdin.fileno()", "tty.setraw(fd)", "buf = b''", `open(${JSON.stringify(out)}, 'wb').write(buf)`, "while True:", "    buf += os.read(fd, 4096)", `    open(${JSON.stringify(out)}, 'wb').write(buf)`].join("\n");
  // Bildschirm mit `cat` zeichnen (wie ein Programm im Feld), danach liest ein roher Leser alles Empfangene mit.
  await tmux.newSession({ name, cwd: tmpdir(), cols: 160, rows: 45, env: {}, command: ["/bin/sh", "-c", 'sleep 0.3; cat "$0"; exec /usr/bin/python3 -c "$1"', file, py] });
  await until(async () => (await tmux.capture(name)).includes("manual mode on"));
  await until(() => existsSync(out)); // Leser bereit (`setraw` verwirft vorher Getipptes)
}

describe("send_text an einer wartenden Session (echtes tmux, echter Claude-Bildschirm)", () => {
  it("wartende Claude-Session 2.1.282 → /compact kommt an", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "nyxos-fx2a-out-")), "in.bin");
    await paneWith("zc-claude-fx2a0001", "claude-2.1.282-idle-done.ansi", out);
    expect(await manager.sendText({ tmuxName: "zc-claude-fx2a0001", text: "/compact", submit: true, onlyWhenWaiting: true, hookWaiting: true })).toEqual({ sent: true });
    expect(await until(() => { try { return /\/compact[\r\n]/.test(readFileSync(out, "utf8")); } catch { return false; } })).toBe(true);
  });
  it("grauer Vorschlag in der Eingabe (Farben aus dem Feld) → trotzdem wartend", async () => {
    await paneWith("zc-claude-fx2a0002", "claude-2.1.282-idle-placeholder.ansi", join(tmpdir(), `fx2a-${process.pid}-2.bin`));
    expect(await manager.sendText({ tmuxName: "zc-claude-fx2a0002", text: "/compact", submit: true, onlyWhenWaiting: true })).toEqual({ sent: true });
  });
  it("zweite Quelle: Hook sagt „arbeitet“ (Antwort läuft, kein Spinner zu sehen) → nicht senden", async () => {
    await paneWith("zc-claude-fx2a0003", "claude-2.1.282-streaming.ansi", join(tmpdir(), `fx2a-${process.pid}-3.bin`));
    expect(await manager.sendText({ tmuxName: "zc-claude-fx2a0003", text: "/compact", submit: true, onlyWhenWaiting: true, hookWaiting: false })).toEqual({ sent: false, reason: "Session arbeitet gerade" });
  });
  it("halb getippter Text → nicht senden, ehrlicher Grund", async () => {
    await paneWith("zc-claude-fx2a0004", "claude-2.1.282-typed.ansi", join(tmpdir(), `fx2a-${process.pid}-4.bin`));
    const r = await manager.sendText({ tmuxName: "zc-claude-fx2a0004", text: "/compact", submit: true, onlyWhenWaiting: true, hookWaiting: true });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/angefangener Text/);
  });
  it("Chat: wartende Session → sofort (busy:false); Hook „arbeitet“ → Warteschlange (busy:true)", async () => {
    await paneWith("zc-claude-fx2a0005", "claude-2.1.282-idle-done.ansi", join(tmpdir(), `fx2a-${process.pid}-5.bin`));
    expect(await manager.rpc("send_message", { tmuxName: "zc-claude-fx2a0005", images: [], text: "hallo" })).toEqual({ sent: true, busy: false });
    await paneWith("zc-claude-fx2a0006", "claude-2.1.282-streaming.ansi", join(tmpdir(), `fx2a-${process.pid}-6.bin`));
    expect(await manager.rpc("send_message", { tmuxName: "zc-claude-fx2a0006", images: [], text: "danach", hookWaiting: false })).toEqual({ sent: true, busy: true });
  });
});

// Der Bildschirm allein darf nie „wartet“ sagen, während Claude arbeitet — Hooks können
// fehlen (verloren, älterer Server). Und der Chat darf nie in den Entwurf des Nutzers oder in ein Menü schreiben.
describe("Sicherheit der Warte-Erkennung", () => {
  it("Antwort wird geschrieben (kein Spinner, Prompt-Zeichen grau) → nie „wartet“, auch ohne Hook", () => {
    expect(promptState("claude", fx("claude-2.1.282-streaming.ansi"))).toBe("working");
    expect(promptState("claude", fx("claude-2.1.282-spinner.ansi"))).toBe("working");
  });
  it("Spinner läuft UND der Nutzer hat schon etwas getippt → „getippt“ (Chat darf nicht anhängen)", () => {
    const screen = fx("claude-2.1.282-spinner.ansi").replace("\x1b[38;5;246m❯\xa0\x1b[39m", "\x1b[38;5;246m❯\xa0\x1b[39mmein Entwurf");
    expect(screen).toContain("mein Entwurf");
    expect(promptState("claude", screen)).toBe("typed");
  });
  const fake = (screen: string) => {
    const sent: string[] = [];
    const fakeTmux = {
      hasSession: async () => true,
      capture: async () => screen,
      paste: async (_n: string, t: string) => void sent.push(t),
      enter: async () => void sent.push("<Enter>"),
      sendText: async (_n: string, t: string) => void sent.push(t),
    } as unknown as Tmux;
    const m = new TerminalManager({ tmux: fakeTmux, projectRoots: [tmpdir()], path: "/usr/bin:/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });
    return { m, sent };
  };
  it("Chat: angefangener Text in der Eingabe → nicht senden (sonst landet die Nachricht im Entwurf des Nutzers)", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-typed.ansi"));
    const r = await m.sendMessage({ tmuxName: "zc-claude-krit0001", images: [], text: "hallo", hookWaiting: true });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/angefangener Text/);
    expect(sent).toEqual([]);
  });
  it("Chat: Eingabe nicht zu sehen (Menü offen) → nicht senden (Enter würde eine Auswahl treffen)", async () => {
    const { m, sent } = fake(fx("codex-0.153-update-menu.ansi"));
    const r = await m.sendMessage({ tmuxName: "zc-codex-krit0002", images: [], text: "hallo", hookWaiting: true });
    expect(r.sent).toBe(false);
    expect(sent).toEqual([]);
  });
  it("send_text ohne Hook-Zustand, Antwort läuft → nicht senden", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-streaming.ansi"));
    expect((await m.sendText({ tmuxName: "zc-claude-krit0003", text: "/compact", submit: true, onlyWhenWaiting: true })).sent).toBe(false);
    expect(sent).toEqual([]);
  });
});
