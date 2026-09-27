// Dünne, sichere Schicht über tmux: jeder Aufruf per execFile mit Argument-Liste (nie ein Shell-
// String), jeder Zielname gegen TMUX_NAME_RE (bzw. den Server-SSH-Namen) geprüft, eigener Socket (`-L`).
import { execFile } from "node:child_process";
import { isAttachableTmuxName, t, TMUX_NAME_RE } from "@nyxos/shared";

export interface TmuxOptions {
  bin: string;
  socket: string;
  /** Konfigurationsdatei — nur beim Start eines neuen tmux-Servers relevant. */
  conf: string | null;
}

export class TmuxError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "tmux_missing" | "failed",
  ) {
    super(message);
  }
}

export function assertName(name: string): string {
  if (!isAttachableTmuxName(name)) throw new TmuxError(t("Ungültiger tmux-Name: {name}", { name }), "failed");
  return name;
}

/** `=name:` = exakt diese Session (kein Präfix-Treffer), aktives Fenster/Feld. */
export const target = (name: string) => `=${assertName(name)}:`;

export class Tmux {
  constructor(readonly o: TmuxOptions) {}

  base(): string[] {
    return ["-L", this.o.socket, ...(this.o.conf ? ["-f", this.o.conf] : [])];
  }

  run(args: string[], timeoutMs = 5000, input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.o.bin, [...this.base(), ...args], {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        // Ein tmux-Aufruf ignorierte SIGTERM und drehte danach 10 h mit 99 % CPU weiter (Waise).
        // Nach dem Zeitlimit darum hart beenden.
        killSignal: "SIGKILL",
      }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new TmuxError(t("tmux nicht gefunden"), "tmux_missing"));
        const msg = String(stderr || err.message);
        if (/can't find session|no server running|session not found|error connecting|no current target|can't find pane|can't find window/i.test(msg)) return reject(new TmuxError(msg.trim(), "not_found"));
        reject(new TmuxError(msg.trim(), "failed"));
      });
      // Ohne `input` bleibt stdin wie bisher offen (tmux liest dann nichts davon).
      if (input !== undefined) {
        child.stdin?.on("error", () => {}); // Fehler meldet der Rückruf oben
        child.stdin?.end(input);
      }
    });
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", `=${assertName(name)}`]);
      return true;
    } catch (e) {
      if (e instanceof TmuxError && e.code !== "failed") return false;
      throw e;
    }
  }

  /** Neue Session im Hintergrund. `command` ist eine Argument-Liste, tmux führt sie direkt aus. */
  async newSession(o: { name: string; cwd: string; cols: number; rows: number; env: Record<string, string>; command: string[] }): Promise<void> {
    const env = Object.entries(o.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // Tmux wertet `-c` als Format aus (`#{session_name}` → „x“, gemessen mit tmux 3.6a) und
    // startet bei einem so verbogenen Pfad still im Home-Ordner. `##` ist ein wörtliches `#`.
    await this.run(["new-session", "-d", "-s", assertName(o.name), "-x", String(o.cols), "-y", String(o.rows), "-c", o.cwd.replaceAll("#", "##"), ...env, "--", ...o.command]);
  }

  async killSession(name: string): Promise<boolean> {
    try {
      await this.run(["kill-session", "-t", `=${assertName(name)}`]);
      return true;
    } catch (e) {
      if (e instanceof TmuxError && e.code === "not_found") return false;
      throw e;
    }
  }

  /** Alle Felder aller NyxOS-Sessions auf diesem Socket. */
  async listPanes(): Promise<{ name: string; panePid: number; paneId: string }[]> {
    let out: string;
    try {
      out = await this.run(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_id}"]);
    } catch (e) {
      if (e instanceof TmuxError && e.code !== "failed") return [];
      throw e;
    }
    return out
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((p): p is [string, string, string] => p.length === 3 && TMUX_NAME_RE.test(p[0] ?? ""))
      .map(([name, pid, paneId]) => ({ name, panePid: Number(pid), paneId }));
  }

  /** Namen aller Sessions auf diesem Socket, die `re` erfüllen (z. B. Server-SSH `zc-ssh-*`). */
  async listSessionNames(re: RegExp): Promise<string[]> {
    let out: string;
    try {
      out = await this.run(["list-sessions", "-F", "#{session_name}"]);
    } catch (e) {
      if (e instanceof TmuxError && e.code !== "failed") return [];
      throw e;
    }
    return out.split("\n").filter((n) => re.test(n));
  }

  /** Sichtbarer Bildschirm als reiner Text (für die Erkennung „wartet"). `escapes`: mit Farben/Stil
   * (`-e`) — nur so ist ein grauer Vorschlag in der Eingabe von getipptem Text zu unterscheiden (FX2a). */
  capture(name: string, history = 0, escapes = false): Promise<string> {
    return this.run(["capture-pane", "-p", ...(escapes ? ["-e"] : []), "-t", target(name), ...(history > 0 ? ["-S", String(-history)] : [])]);
  }

  /**
   * Text EINFÜGEN statt tippen — als „bracketed paste“ (`paste-buffer -p`), wenn das Programm
   * im Feld das eingeschaltet hat (Claude Code, Codex). Dann bleibt mehrzeiliger Text ein Prompt, und
   * ein einzelner Bildpfad wird zu „[Image #n]“. Eigener, einmaliger Puffer (`-d` löscht ihn danach).
   */
  async paste(name: string, text: string): Promise<void> {
    const buffer = `zc-paste-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // Über stdin (`load-buffer -`), nicht als Argument — tmux liest ein Argument, das auf
    // „;“ endet, als Befehlstrenner (Semikolon ginge verloren, „\;“ würde zu „;“).
    await this.run(["load-buffer", "-b", buffer, "-"], 5000, text);
    await this.run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", target(name)]);
  }

  /** Nur die Enter-Taste. */
  async enter(name: string): Promise<void> {
    await this.run(["send-keys", "-t", target(name), "Enter"]);
  }

  /** Eine einzelne Taste (z. B. `Escape`) senden — fest benannte Tasten, nie freier Text. */
  async sendKey(name: string, key: "Escape"): Promise<void> {
    await this.run(["send-keys", "-t", target(name), key]);
  }

  /** Text wörtlich eintippen (`-l`), optional mit Enter. */
  async sendText(name: string, text: string, submit: boolean): Promise<void> {
    await this.run(["send-keys", "-t", target(name), "-l", "--", text]);
    if (submit) await this.run(["send-keys", "-t", target(name), "Enter"]);
  }
}
