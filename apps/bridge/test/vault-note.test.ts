// „In Obsidian ablegen“ – die Brücke schreibt einen Nyx-Faden als Notiz in den Vault.
// Ordner und Dateiname rechnet sie SELBST (nie ein Pfad vom Server), überschreibt nie, bleibt im Vault.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RpcError, TerminalManager } from "../src/terminal/manager.js";
import { Tmux } from "../src/terminal/tmux.js";
import { VAULT_NOTE_FOLDER, vaultNoteName, writeVaultNote } from "../src/vault/note.js";

const vault = () => realpathSync(mkdtempSync(join(tmpdir(), "nyxos-vault-")));
const MD = "---\ntyp: nyx-chat\n---\n\n# Test\n";

describe("vault_note", () => {
  it("legt die Notiz unter „01 Sessions/Nyx“ an, Name wie die Session-Notizen (Datum + Titel)", () => {
    const dir = vault();
    const r = writeVaultNote(dir, { day: "2026-09-25", title: "Deploy-Plan für Freitag", markdown: MD });
    expect(VAULT_NOTE_FOLDER).toBe("01 Sessions/Nyx");
    expect(r.relPath).toBe("01 Sessions/Nyx/2026-09-25 Nyx – Deploy-Plan für Freitag.md");
    expect(readFileSync(join(dir, r.relPath), "utf8")).toBe(MD);
  });

  it("überschreibt nie: zweite Ablage bekommt „(2)“", () => {
    const dir = vault();
    const a = writeVaultNote(dir, { day: "2026-09-25", title: "Gleich", markdown: "eins" });
    const b = writeVaultNote(dir, { day: "2026-09-25", title: "Gleich", markdown: "zwei" });
    expect(b.relPath).toBe("01 Sessions/Nyx/2026-09-25 Nyx – Gleich (2).md");
    expect(readFileSync(join(dir, a.relPath), "utf8")).toBe("eins");
    expect(readFileSync(join(dir, b.relPath), "utf8")).toBe("zwei");
  });

  it("Titel mit Pfad-Zeichen bleibt ein harmloser Dateiname im Ordner", () => {
    expect(vaultNoteName("2026-09-25", "../../etc/passwd")).toBe("2026-09-25 Nyx – etc passwd.md");
    expect(vaultNoteName("2026-09-25", "a/b\\c:d*e?f\"g<h>i|j#k^l[m]n")).toBe("2026-09-25 Nyx – a b c d e f g h i j k l m n.md");
    expect(vaultNoteName("2026-09-25", "...")).toBe("2026-09-25 Nyx – Faden.md");
    expect(vaultNoteName("2026-09-25", "x".repeat(300)).length).toBeLessThanOrEqual(120);
    const dir = vault();
    const r = writeVaultNote(dir, { day: "2026-09-25", title: "../../raus", markdown: MD });
    expect(readdirSync(join(dir, "01 Sessions", "Nyx"))).toEqual(["2026-09-25 Nyx – raus.md"]);
    expect(r.relPath.startsWith("01 Sessions/Nyx/")).toBe(true);
  });

  it("Ordner als Link nach draußen → abgelehnt, nichts geschrieben", () => {
    const dir = vault();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-draussen-")));
    mkdirSync(join(dir, "01 Sessions"), { recursive: true });
    symlinkSync(outside, join(dir, "01 Sessions", "Nyx"));
    expect(() => writeVaultNote(dir, { day: "2026-09-25", title: "X", markdown: MD })).toThrow(RpcError);
    expect(readdirSync(outside)).toEqual([]);
  });

  // `mkdirSync(recursive)` folgte dem Link und legte „Nyx“ DRAUSSEN an, bevor die Prüfung griff.
  it("Zwischenordner als Link nach draußen → abgelehnt, draußen wird auch kein Ordner angelegt", () => {
    const dir = vault();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-draussen-")));
    symlinkSync(outside, join(dir, "01 Sessions"));
    expect(() => writeVaultNote(dir, { day: "2026-09-25", title: "X", markdown: MD })).toThrow(RpcError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("unsichtbare Steuer-/Richtungszeichen fliegen aus dem Dateinamen", () => {
    expect(vaultNoteName("2026-09-25", "abc‮gpj.exe​\u007F")).toBe("2026-09-25 Nyx – abc gpj.exe.md");
  });

  it("über den RPC-Weg der Brücke; ohne Vault ehrlich abgelehnt", async () => {
    const dir = vault();
    const tmux = new Tmux({ bin: "/usr/bin/false", socket: `zc-test-vault-${process.pid}`, conf: "/dev/null" });
    const base = { tmux, projectRoots: [dir], path: "/usr/bin:/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map<number, string>() };
    const withVault = new TerminalManager({ ...base, vaultDir: dir });
    const r = (await withVault.rpc("vault_note", { day: "2026-09-25", title: "Über RPC", markdown: MD })) as { relPath: string };
    expect(existsSync(join(dir, r.relPath))).toBe(true);
    await expect(withVault.rpc("vault_note", { day: "25.09.2026", title: "x", markdown: MD })).rejects.toThrow();
    const without = new TerminalManager({ ...base, vaultDir: null });
    await expect(without.rpc("vault_note", { day: "2026-09-25", title: "x", markdown: MD })).rejects.toBeInstanceOf(RpcError);
  });
});
