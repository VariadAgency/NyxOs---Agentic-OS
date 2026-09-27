// Brücken-Seite: Kein Weg tippt ohne Bildschirm-Prüfung. Echte Abzüge (fixtures/screens/),
// ein Attrappen-tmux, das nur mitschreibt, was gesendet würde.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalManager } from "../src/terminal/manager.js";
import type { Tmux } from "../src/terminal/tmux.js";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "screens", n), "utf8");

function fake(screen: string) {
  const sent: string[] = [];
  const fakeTmux = {
    hasSession: async () => true,
    capture: async () => screen,
    paste: async (_n: string, t: string) => void sent.push(t),
    enter: async () => void sent.push("<Enter>"),
    sendText: async (_n: string, t: string) => void sent.push(t),
    sendKey: async (_n: string, k: string) => void sent.push(`<${k}>`),
  } as unknown as Tmux;
  const m = new TerminalManager({ tmux: fakeTmux, projectRoots: [tmpdir()], path: "/usr/bin:/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });
  return { m, sent };
}

describe("send_text: Bildschirm wird immer geprüft (auch alter Server mit onlyWhenWaiting: false)", () => {
  it("offene Freigabe-Frage → nie tippen", async () => {
    const { m, sent } = fake(fx("claude-permission.txt"));
    const r = (await m.rpc("send_text", { tmuxName: "zc-claude-fx4a0001", text: "Freigabe erteilt", submit: true, onlyWhenWaiting: false })) as { sent: boolean; reason?: string };
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/Freigabe/);
    expect(sent).toEqual([]);
  });
  it("angefangener Text des Nutzers → nie anhängen", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-typed.ansi"));
    expect(((await m.rpc("send_text", { tmuxName: "zc-claude-fx4a0002", text: "/compact", submit: true, onlyWhenWaiting: false })) as { sent: boolean }).sent).toBe(false);
    expect(sent).toEqual([]);
  });
  it("leere Eingabe → geht raus", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-idle-done.ansi"));
    expect(await m.rpc("send_text", { tmuxName: "zc-claude-fx4a0003", text: "/compact", submit: true, onlyWhenWaiting: true, hookWaiting: true })).toEqual({ sent: true });
    expect(sent).toEqual(["/compact"]);
  });
});

describe("send_message mit onlyWhenIdle (Server hat eigene Warteschlange)", () => {
  it("Spinner läuft → nicht einfügen, busy melden", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-spinner.ansi"));
    const r = await m.sendMessage({ tmuxName: "zc-claude-fx4b0001", images: [], text: "danach", hookWaiting: true, onlyWhenIdle: true });
    expect(r).toMatchObject({ sent: false, busy: true });
    expect(sent).toEqual([]);
  });
  it("leere Eingabe → einfügen + Enter", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-idle-done.ansi"));
    expect(await m.sendMessage({ tmuxName: "zc-claude-fx4b0002", images: [], text: "hallo", hookWaiting: true, onlyWhenIdle: true })).toEqual({ sent: true, busy: false });
    expect(sent).toEqual(["hallo", "<Enter>"]);
  });
});

describe("interrupt (Esc): nur bei arbeitender Session", () => {
  it("arbeitet (Spinner) → genau ein Esc", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-spinner.ansi"));
    expect(await m.rpc("interrupt", { tmuxName: "zc-claude-fx4c0001" })).toEqual({ interrupted: true });
    expect(sent).toEqual(["<Escape>"]);
  });
  it("offene Freigabe-Frage → kein Esc (würde ablehnen, ohne dass der Nutzer entschieden hat)", async () => {
    const { m, sent } = fake(fx("claude-permission.txt"));
    expect(await m.rpc("interrupt", { tmuxName: "zc-claude-fx4c0002" })).toMatchObject({ interrupted: false });
    expect(sent).toEqual([]);
  });
  it("angefangener Text → kein Esc", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-typed.ansi"));
    expect(await m.rpc("interrupt", { tmuxName: "zc-claude-fx4c0003" })).toMatchObject({ interrupted: false });
    expect(sent).toEqual([]);
  });
  it("wartet schon → kein Esc, ehrlicher Grund", async () => {
    const { m, sent } = fake(fx("claude-2.1.282-idle-done.ansi"));
    expect(await m.rpc("interrupt", { tmuxName: "zc-claude-fx4c0004" })).toMatchObject({ interrupted: false, reason: expect.stringMatching(/wartet schon/) });
    expect(sent).toEqual([]);
  });
});
