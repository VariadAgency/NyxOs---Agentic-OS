// Schritt 2 · Der Server leitet Browser-Terminals über EINE dauerhafte, ausgehende Verbindung der
// Brücke (`WS /bridge`) weiter. Jeder Browser-Tab bekommt einen eigenen Kanal (`ch`), die Brücke
// hängt dafür einen eigenen tmux-Steuer-Client an (mehrere Zuschauer = mehrere tmux-Clients).
//
// Gegendruck: staut sich beim Browser mehr als HIGH_WATER an (langsames Netz), bittet der Server die
// Brücke, den Kanal anzuhalten (`pause`), und gibt ihn unter LOW_WATER wieder frei (`resume`). Die
// Brücke hält dann das Lesen des tmux-Steuer-Clients an — tmux puffert selbst.
import { BridgeToServerSchema, type BridgeRpcMethod, type ServerToBridge, type TermServerMsg, type UsageReadingsMsg, t } from "@nyxos/shared";
import { parseCodexBarReport, usageReadings } from "../usage/official.js";

/** echte Claude-Limits aus CodexBar (Mac) geprüft in den Nutzungs-Speicher; Unplausibles fällt still weg. */
function ingestUsageReadings(m: UsageReadingsMsg): void {
  const r = parseCodexBarReport(m);
  if (r) usageReadings.recordCodexBar(r);
}

export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 128 * 1024;
const RPC_TIMEOUT_MS = 15_000;
/**
 * (~/Downloads-Liste nach 6,8 s, die Brücke selbst braucht warm 25 ms): Befehle, die länger
 * brauchen, werden mit Aufteilung geloggt — `macMs` (Rechenzeit auf dem Rechner, meldet die Brücke) und
 * `wegMs` (Rest = SSH-Tunnel hin und zurück + Warten). So ist beim nächsten Mal belegt, wo die Zeit bleibt.
 */
export const RPC_SLOW_MS = 1500;

export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface BrowserSink {
  send(msg: TermServerMsg): void;
  /** Bytes, die noch nicht zum Browser raus sind (ws.bufferedAmount). */
  buffered(): number;
  close(): void;
}

export interface RpcOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

interface Channel {
  id: number;
  sink: BrowserSink;
  paused: boolean;
}

export interface TerminalChannel {
  id: number;
  input(d: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export class BridgeHub {
  private bridge: { socket: BridgeSocket; machineId: string; since: number; tmuxSocket: string | null; caps: Set<string> } | null = null;
  private readonly channels = new Map<number, Channel>();
  private readonly pending = new Map<number, { resolve: (r: RpcOutcome) => void; timer: NodeJS.Timeout; method: string; op: string | null; at: number }>();
  private nextId = 1;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onChange: (online: boolean) => void = () => {},
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
    private readonly nowMs: () => number = () => performance.now(),
    private readonly onUsageReadings: (m: UsageReadingsMsg) => void = ingestUsageReadings,
  ) {}

  get online(): boolean {
    return this.bridge !== null;
  }

  /** kann die verbundene Brücke das (aus ihrem `hello`)? Ältere Brücken melden nichts. */
  supports(cap: string): boolean {
    return this.bridge?.caps.has(cap) ?? false;
  }

  /** tmux-Socket der verbundenen Brücke (aus „hello“), `null` ohne Brücke. „nyxos“ = echt, sonst Probe. */
  tmuxSocket(): string | null {
    return this.bridge?.tmuxSocket ?? null;
  }

  status() {
    // `tmuxSocket` aus dem `hello` der Brücke (Verbindungs-Prüfung: meldet die Brücke tmux?).
    return { online: this.online, machineId: this.bridge?.machineId ?? null, since: this.bridge ? new Date(this.bridge.since).toISOString() : null, tmuxSocket: this.bridge?.tmuxSocket ?? null };
  }

  /** Eine neue Brücken-Verbindung ersetzt eine alte (z. B. nach Netzwechsel). */
  attach(socket: BridgeSocket, machineId: string): void {
    if (this.bridge) {
      const old = this.bridge.socket;
      this.drop(t("Brücke hat sich neu verbunden"));
      try {
        old.close(4000, "ersetzt");
      } catch {
        // schon zu
      }
    }
    this.bridge = { socket, machineId, since: Date.now(), tmuxSocket: null, caps: new Set() };
    this.onChange(true);
  }

  /** Liefert `false`, wenn der Socket schon ersetzt war (dann ist die Brücke weiter verbunden). */
  detach(socket: BridgeSocket): boolean {
    if (this.bridge?.socket !== socket) return false;
    this.drop(t("Brücke getrennt"));
    this.onChange(false);
    return true;
  }

  private drop(reason: string): void {
    this.bridge = null;
    for (const ch of this.channels.values()) {
      ch.sink.send({ t: "status", s: "bridge_offline", msg: reason });
      ch.sink.close();
    }
    this.channels.clear();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: t("Brücke offline"), code: "bridge_offline" });
      this.pending.delete(id);
    }
  }

  private toBridge(msg: ServerToBridge): boolean {
    if (!this.bridge) return false;
    try {
      this.bridge.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  rpc(method: BridgeRpcMethod, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<RpcOutcome> {
    if (!this.bridge) return Promise.resolve({ ok: false, error: t("Brücke offline"), code: "bridge_offline" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const op = typeof (params as { op?: unknown } | null)?.op === "string" ? String((params as { op: string }).op) : null;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log("bruecke-befehl-zeitueberschreitung", { method, op, ms: timeoutMs });
        resolve({ ok: false, error: t("Brücke antwortet nicht"), code: "timeout" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, method, op, at: this.nowMs() });
      if (!this.toBridge({ op: "rpc", id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: t("Brücke offline"), code: "bridge_offline" });
      }
    });
  }

  open(opts: { tmuxName: string; cols: number; rows: number; readOnly: boolean }, sink: BrowserSink): TerminalChannel | null {
    if (!this.bridge) return null;
    const id = this.nextId++;
    const ch: Channel = { id, sink, paused: false };
    this.channels.set(id, ch);
    this.toBridge({ op: "open", ch: id, ...opts });
    return {
      id,
      input: (d) => {
        if (this.channels.has(id)) this.toBridge({ op: "in", ch: id, d });
      },
      resize: (cols, rows) => {
        if (this.channels.has(id)) this.toBridge({ op: "resize", ch: id, cols, rows });
      },
      close: () => {
        if (this.channels.delete(id)) this.toBridge({ op: "close", ch: id });
      },
    };
  }

  /** Eine Nachricht der Brücke verarbeiten. Ungültiges wird verworfen (nie ein Absturz). */
  handle(raw: string): void {
    let parsed;
    try {
      parsed = BridgeToServerSchema.safeParse(JSON.parse(raw));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.op) {
      case "hello":
        if (this.bridge) {
          this.bridge.tmuxSocket = msg.tmuxSocket;
          this.bridge.caps = new Set(msg.caps ?? []);
        }
        return;
      case "rpc_result": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        const totalMs = Math.round(this.nowMs() - p.at);
        if (totalMs >= RPC_SLOW_MS) {
          const macMs = msg.ms === undefined ? null : Math.round(msg.ms);
          this.log("bruecke-befehl-langsam", { method: p.method, op: p.op, ok: msg.ok, gesamtMs: totalMs, macMs, wegMs: macMs === null ? null : Math.max(0, totalMs - macMs), bytes: raw.length });
        }
        p.resolve({ ok: msg.ok, result: msg.result, error: msg.error, code: msg.code });
        return;
      }
      case "snapshot": {
        const ch = this.channels.get(msg.ch);
        ch?.sink.send({ t: "snapshot", d: msg.d, cols: msg.cols, rows: msg.rows, cursor: msg.cursor, readOnly: false });
        return;
      }
      case "out": {
        const ch = this.channels.get(msg.ch);
        if (!ch) return;
        ch.sink.send({ t: "out", d: msg.d });
        if (!ch.paused && ch.sink.buffered() > HIGH_WATER) {
          ch.paused = true;
          this.toBridge({ op: "pause", ch: ch.id });
          this.watchDrain();
        }
        return;
      }
      case "size": {
        this.channels.get(msg.ch)?.sink.send({ t: "size", cols: msg.cols, rows: msg.rows });
        return;
      }
      case "usage_readings":
        this.onUsageReadings(msg);
        return;
      case "exit": {
        const ch = this.channels.get(msg.ch);
        if (!ch) return;
        this.channels.delete(msg.ch);
        ch.sink.send({ t: "status", s: msg.reason === "not_found" ? "not_attachable" : "ended", msg: msg.reason });
        ch.sink.close();
        return;
      }
    }
  }

  private watchDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      let anyPaused = false;
      for (const ch of this.channels.values()) {
        if (!ch.paused) continue;
        if (ch.sink.buffered() < LOW_WATER) {
          ch.paused = false;
          this.toBridge({ op: "resume", ch: ch.id });
        } else anyPaused = true;
      }
      if (!anyPaused && this.drainTimer) {
        clearInterval(this.drainTimer);
        this.drainTimer = null;
      }
    }, 20);
    this.drainTimer.unref?.();
  }

  get channelCount(): number {
    return this.channels.size;
  }
}
