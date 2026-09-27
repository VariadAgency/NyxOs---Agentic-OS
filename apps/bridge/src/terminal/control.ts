// P3 Schritt 2 · Übertragung über den tmux-Steuermodus (`tmux -C attach`). Kein PTY, kein natives
// Modul: tmux liefert die Ausgabe des Programms als `%output %<feld> <bytes, oktal maskiert>` und nimmt
// Befehle zeilenweise auf stdin an. Jeder Browser-Tab bekommt einen eigenen Steuer-Client → mehrere
// Zuschauer sehen dasselbe, Eingaben aus allen kommen an (tmux regelt das selbst).
//
// Eingaben gehen nur als `send-keys -H <hex> …` hinein (reine Hex-Wörter) — eine Befehlsinjektion in
// den Steuer-Kanal ist damit ausgeschlossen, egal was im Browser getippt wird.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { TERM_SNAPSHOT_HISTORY } from "@nyxos/shared";
import { target, type Tmux } from "./tmux.js";

/** `%output`-Nutzdaten dekodieren: tmux maskiert Bytes < 0x20 und `\` als `\ooo`. */
export function decodeOutput(escaped: string): Buffer {
  const bytes: number[] = [];
  const raw = Buffer.from(escaped, "latin1");
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] as number;
    if (b === 0x5c && i + 3 < raw.length + 0 && isOct(raw[i + 1]) && isOct(raw[i + 2]) && isOct(raw[i + 3])) {
      bytes.push(((raw[i + 1] as number) - 48) * 64 + ((raw[i + 2] as number) - 48) * 8 + ((raw[i + 3] as number) - 48));
      i += 3;
    } else bytes.push(b);
  }
  return Buffer.from(bytes);
}
const isOct = (b: number | undefined) => b !== undefined && b >= 48 && b <= 55;

/** Eingabe als `send-keys -H`-Befehle, höchstens `chunk` Bytes je Zeile. */
export function inputCommands(name: string, data: string, chunk = 256): string[] {
  const buf = Buffer.from(data, "utf8");
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += chunk) {
    const hex = [...buf.subarray(i, i + chunk)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    lines.push(`send-keys -t ${target(name)} -H ${hex}`);
  }
  return lines;
}

export interface Snapshot {
  d: string;
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
}

/** Aus `capture-pane` + Feld-Zustand eine Byte-Folge bauen, die xterm.js in denselben Zustand bringt. */
export function buildSnapshot(captured: string, info: string): Snapshot {
  const [cx, cy, w, h, alt, curFlag, kpFlag, mAny, mBtn, mStd, mSgr] = info.trim().split(" ").map(Number);
  const cols = w ?? 80;
  const rows = h ?? 24;
  let lines = captured.replace(/\n$/, "").split("\n");
  let prefix = "";
  if (alt === 1) {
    // Vollbild-Programm: nur der sichtbare Bildschirm, im Alternativ-Puffer.
    lines = lines.slice(-rows);
    prefix = "\x1b[?1049h\x1b[H";
  }
  const modes =
    (kpFlag === 1 ? "\x1b[?1h" : "") +
    (mAny === 1 ? "\x1b[?1003h" : mBtn === 1 ? "\x1b[?1002h" : mStd === 1 ? "\x1b[?1000h" : "") +
    (mSgr === 1 ? "\x1b[?1006h" : "") +
    (curFlag === 0 ? "\x1b[?25l" : "");
  const d = prefix + lines.join("\x1b[0m\r\n") + `\x1b[0m\x1b[${(cy ?? 0) + 1};${(cx ?? 0) + 1}H` + modes;
  return { d, cols, rows, cursor: { x: cx ?? 0, y: cy ?? 0 } };
}

const INFO_FORMAT =
  "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{alternate_on} #{cursor_flag} #{keypad_cursor_flag} #{mouse_any_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag}";

export interface ControlEvents {
  snapshot(s: Snapshot): void;
  output(d: string): void;
  size(cols: number, rows: number): void;
  exit(reason: string): void;
}

/**
 * Ein Steuer-Client für eine tmux-Session. Ablauf beim Anhängen: (1) Größe setzen (nur wenn nicht
 * „Nur ansehen"), (2) in EINER Befehlsliste `capture-pane` + Zustand abfragen — tmux führt beide ohne
 * Zwischenschritt aus, also passt der Cursor zum Bildschirm, (3) alles an `%output` vor dieser Antwort
 * ist schon im Bildschirm enthalten und wird verworfen, alles danach live weitergereicht.
 */
export class ControlClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private block: { lines: string[]; mine: boolean } | null = null;
  private readonly replies: ((lines: string[]) => void)[] = [];
  private live = false;
  private ended = false;
  private readonly decoder = new StringDecoder("utf8");
  private lastSize = "";

  constructor(
    private readonly tmux: Tmux,
    readonly name: string,
    private readonly ev: ControlEvents,
  ) {}

  start(opts: { cols: number; rows: number; readOnly: boolean }): void {
    const child = spawn(this.tmux.o.bin, [...this.tmux.base(), "-C", "attach-session", "-t", `=${this.name}`], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("latin1"); // Bytes 1:1, `%output` wird selbst dekodiert
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-300)));
    child.on("error", () => this.finish("tmux_missing"));
    child.on("exit", () => this.finish(/can't find session|no server running|session not found/i.test(stderr) ? "not_found" : "ended"));
    child.stdin.on("error", () => {});
    if (!opts.readOnly) this.command(`refresh-client -C ${opts.cols}x${opts.rows}`);
    const t = target(this.name);
    this.command(`capture-pane -p -e -t ${t} -S -${TERM_SNAPSHOT_HISTORY} ; display-message -p -t ${t} "${INFO_FORMAT}"`, 2, ([cap, info]) => {
      const snap = buildSnapshot((cap ?? []).join("\n"), (info ?? [])[0] ?? "");
      this.lastSize = `${snap.cols}x${snap.rows}`;
      this.ev.snapshot(snap);
      this.live = true;
    });
  }

  private command(line: string, blocks = 1, onReply?: (replies: string[][]) => void): void {
    if (!this.child || this.ended) return;
    const collected: string[][] = [];
    for (let i = 0; i < blocks; i++) {
      this.replies.push((lines) => {
        collected.push(lines);
        if (collected.length === blocks) onReply?.(collected);
      });
    }
    this.child.stdin.write(line + "\n");
  }

  input(data: string): void {
    for (const line of inputCommands(this.name, data)) this.command(line);
  }

  resize(cols: number, rows: number): void {
    this.command(`refresh-client -C ${cols}x${rows}`);
  }

  pause(): void {
    this.child?.stdout.pause();
  }

  resume(): void {
    this.child?.stdout.resume();
  }

  close(): void {
    if (!this.child || this.ended) return;
    try {
      this.child.stdin.write("detach-client\n");
      this.child.stdin.end();
    } catch {
      // schon zu
    }
    const c = this.child;
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGTERM");
    }, 1000).unref();
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.ev.exit(reason);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (this.block) {
      if (line.startsWith("%end ") || line.startsWith("%error ")) {
        const { lines, mine } = this.block;
        this.block = null;
        // Flag 1 = Antwort auf einen Befehl dieses Clients; Flag 0 = das Anhängen selbst.
        if (mine) this.replies.shift()?.(line.startsWith("%error ") ? [] : lines.map((l) => Buffer.from(l, "latin1").toString("utf8")));
        return;
      }
      this.block.lines.push(line);
      return;
    }
    if (line.startsWith("%begin ")) {
      this.block = { lines: [], mine: line.trim().endsWith(" 1") };
      return;
    }
    if (line.startsWith("%output ")) {
      if (!this.live) return; // schon im Bildschirm-Abzug enthalten
      const sp = line.indexOf(" ", 8);
      if (sp < 0) return;
      const text = this.decoder.write(decodeOutput(line.slice(sp + 1)));
      if (text) this.ev.output(text);
      return;
    }
    if (line.startsWith("%layout-change ")) {
      const m = /,(\d+)x(\d+),/.exec(line);
      if (m && this.live) {
        const size = `${m[1]}x${m[2]}`;
        if (size !== this.lastSize) {
          this.lastSize = size;
          this.ev.size(Number(m[1]), Number(m[2]));
        }
      }
      return;
    }
    if (line.startsWith("%exit")) this.finish("ended");
  }
}
