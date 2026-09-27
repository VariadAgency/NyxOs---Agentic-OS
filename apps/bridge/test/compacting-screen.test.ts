// Während Claude nach `/compact` 30–60 s komprimiert, sagt der Hook schon
// „wartet“ (Stop kam vorher, `/compact` löst kein UserPromptSubmit aus). Dann darf NUR noch der Bildschirm
// die Warteschlange bremsen: „Compacting conversation…“ muss als „arbeitet“ gelten.
// Kein echter Abzug vom Komprimieren vorhanden → aus dem echten Abzug claude-2.1.282-idle-done.ansi
// gebaut (Eingabe in STANDARDFARBE = schlimmster Fall, der Grau-Hinweis greift dann nicht), nur die
// Statuszeile über der Eingabe ersetzt — im Stil des echten Spinners claude-2.1.282-spinner.ansi.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promptState } from "../src/terminal/prompt.js";
import { TerminalManager } from "../src/terminal/manager.js";
import type { Tmux } from "../src/terminal/tmux.js";

const idle = readFileSync(join(import.meta.dirname, "fixtures", "screens", "claude-2.1.282-idle-done.ansi"), "utf8");
const DONE_LINE = "\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mCogitated for 2s · done 14:56\x1b[39m";

function compacting(status: string, below = ""): string {
  expect(idle).toContain(DONE_LINE);
  return idle.replace(DONE_LINE, below ? `${status}\n${below}` : status);
}

const VARIANTS: Record<string, string> = {
  "Spinner mit Zeit": compacting("\x1b[38;5;174m\x1b[49m✻\x1b[39m \x1b[38;5;174mCompacting conversation… \x1b[38;5;246m(23s · ↓ 1.2k tokens)\x1b[39m"),
  "erste Sekunde, ohne Zeit": compacting("\x1b[38;5;174m\x1b[49m✶\x1b[39m \x1b[38;5;174mCompacting conversation…\x1b[39m"),
  "mit „esc to interrupt“": compacting("\x1b[38;5;174m✢\x1b[39m \x1b[38;5;174mCompacting conversation… \x1b[38;5;246m(esc to interrupt)\x1b[39m"),
  "mit Tipp-Zeile darunter": compacting("\x1b[38;5;174m✳\x1b[39m \x1b[38;5;174mCompacting conversation… \x1b[38;5;246m(4s)\x1b[39m", "  \x1b[38;5;246m⎿  Tip: Use /memory to edit your CLAUDE.md\x1b[39m"),
  "Spinner-Zeichen gerade aus (Blinken)": compacting("  \x1b[38;5;174mCompacting conversation…\x1b[39m"),
};

describe("Komprimieren läuft → die Warteschlange tippt nie", () => {
  it("Gegenprobe: derselbe Abzug ohne Komprimieren ist „idle“", () => {
    expect(promptState("claude", idle)).toBe("idle");
  });

  for (const [name, screen] of Object.entries(VARIANTS)) {
    it(`${name} → „working“`, () => {
      expect(promptState("claude", screen)).toBe("working");
    });
  }

  it("send_text aus der Warteschlange (Hook sagt „wartet“) → nichts getippt", async () => {
    const sent: string[] = [];
    const fakeTmux = {
      hasSession: async () => true,
      capture: async () => VARIANTS["Spinner-Zeichen gerade aus (Blinken)"],
      sendText: async (_n: string, t: string) => void sent.push(t),
    } as unknown as Tmux;
    const m = new TerminalManager({ tmux: fakeTmux, projectRoots: [tmpdir()], path: "/usr/bin:/bin", log: () => {}, processAttached: async () => false, claudePids: async () => new Map() });
    const r = (await m.rpc("send_text", { tmuxName: "zc-claude-fx4c0001", text: "Freigabe erteilt", submit: true, onlyWhenWaiting: true, hookWaiting: true })) as { sent: boolean };
    expect(r.sent).toBe(false);
    expect(sent).toEqual([]);
  });
});
