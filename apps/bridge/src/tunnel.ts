// Optionaler SSH-Tunnel zu einem entfernten Server (nur wenn `config.tunnel` gesetzt ist; lokal läuft der
// Server auf 127.0.0.1 und braucht keinen Tunnel).
import { spawn, type ChildProcess } from "node:child_process";
import { findBin } from "./platform.js";
import type { Log } from "./tracker.js";

const MIN_RESTART_MS = 5000;
const MAX_RESTART_MS = 5 * 60 * 1000;
/** Hielt die Verbindung so lange, gilt sie als stabil und der Abstand fängt wieder klein an. */
const STABLE_MS = 60_000;
/** ssh meldet sich bei -N nicht; nach so langer Zeit ohne Abbruch gilt der Tunnel als offen. */
const UP_AFTER_MS = 1500;
/** Tunnel-Wächter: so oft `GET /health` durch den Tunnel … */
export const TUNNEL_HEALTH_EVERY_MS = 30_000;
/** … mit diesem Zeitlimit … */
export const TUNNEL_HEALTH_TIMEOUT_MS = 10_000;
/** … und nach so vielen Fehlschlägen in Folge wird der eigene ssh neu gestartet. */
export const TUNNEL_FAILURES_BEFORE_RESTART = 2;
/** Nach SIGTERM so lange warten, dann SIGKILL. */
const KILL_GRACE_MS = 3000;

export function sshArgs(t: { host: string; localPort: number; remotePort: number }): string[] {
  return [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-L", `127.0.0.1:${t.localPort}:127.0.0.1:${t.remotePort}`,
    t.host,
  ];
}

/**
 * Welche Fehler der Prüfung zeigen einen kaputten Tunnel? Nur Zeitüberschreitung (ssh lebt, leitet
 * aber nichts weiter) und „abgewiesen" (ssh lauscht nicht mehr auf dem lokalen Port). Jede HTTP-Antwort,
 * auch 503, beweist einen tragenden Tunnel; ein sofort geschlossener Kanal heißt, hinter dem Server-Port
 * lauscht gerade niemand (Server-Neustart) — ein ssh-Neustart hilft da nicht. `null` = zählt nicht.
 */
export function tunnelFailure(e: unknown): "zeitueberschreitung" | "abgewiesen" | null {
  const err = e as { name?: string; code?: string; cause?: { code?: string; name?: string } } | null;
  if (!err) return null;
  if (err.name === "TimeoutError" || err.name === "AbortError" || err.cause?.name === "TimeoutError") return "zeitueberschreitung";
  const code = err.code ?? err.cause?.code;
  if (code === "ECONNREFUSED" || code === "ConnectionRefused") return "abgewiesen";
  return null;
}

export interface TunnelOptions {
  /** Für Tests: Ersatz-ssh. */
  sshBin?: string;
  upAfterMs?: number;
  healthEveryMs?: number;
  healthTimeoutMs?: number;
  failuresBeforeRestart?: number;
  minRestartMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Hält den SSH-Tunnel zum Server offen, bis Tailscale steht. Neustarts mit
 * wachsendem Abstand, damit fail2ban die eigene IP nicht sperrt.
 *
 * Eigener Wächter. Ein ssh, der lebt, aber nichts mehr weiterleitet (unter Last, halb offene
 * Verbindung), fällt über `ServerAliveInterval` nicht immer auf. Darum prüft die Brücke regelmäßig
 * `GET /health` durch den Tunnel; schlägt das mehrmals in Folge fehl, beendet sie NUR ihren eigenen
 * ssh-Prozess (nie `pkill`) und baut ihn neu auf (`tunnel-watchdog`).
 */
export class Tunnel {
  private child: ChildProcess | null = null;
  private delay: number;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private checking = false;
  private failures = 0;
  up = false;

  constructor(
    private readonly t: { host: string; localPort: number; remotePort: number },
    private readonly log: Log,
    private readonly onUp: () => void,
    private readonly o: TunnelOptions = {},
  ) {
    this.delay = o.minRestartMs ?? MIN_RESTART_MS;
  }

  start(): void {
    if (this.stopped) return;
    this.timer = null;
    const startedAt = Date.now();
    const child = spawn(this.o.sshBin ?? findBin("ssh") ?? "ssh", sshArgs(this.t), { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    this.failures = 0;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
    const upTimer = setTimeout(() => {
      if (this.child !== child) return;
      this.up = true;
      this.log("tunnel-offen", { host: this.t.host, port: this.t.localPort });
      this.onUp();
    }, this.o.upAfterMs ?? UP_AFTER_MS);
    child.on("error", (e) => this.log("tunnel-fehler", { error: String(e) })); // „exit" folgt
    child.on("exit", (code, signal) => {
      clearTimeout(upTimer);
      if (this.child !== child) return;
      this.up = false;
      this.child = null;
      if (this.stopped) return;
      if (Date.now() - startedAt > STABLE_MS) this.delay = this.o.minRestartMs ?? MIN_RESTART_MS;
      this.log("tunnel-zu", { code, signal, stderr: stderr.trim().slice(-200), retryMs: this.delay });
      this.timer = setTimeout(() => this.start(), this.delay);
      this.delay = Math.min(this.delay * 2, MAX_RESTART_MS);
    });
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => void this.checkNow(), this.o.healthEveryMs ?? TUNNEL_HEALTH_EVERY_MS);
      this.healthTimer.unref?.();
    }
  }

  /** Eine Prüfung durch den Tunnel (auch außer der Reihe, z. B. wenn der Kanal-Wächter anschlägt). */
  async checkNow(): Promise<void> {
    const child = this.child;
    if (this.stopped || this.checking || !this.up || !child) return;
    this.checking = true;
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`http://127.0.0.1:${this.t.localPort}/health`, {
        signal: AbortSignal.timeout(this.o.healthTimeoutMs ?? TUNNEL_HEALTH_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      this.failures = 0;
    } catch (e) {
      const kind = tunnelFailure(e);
      if (kind === null || this.child !== child) return;
      this.failures++;
      if (this.failures < (this.o.failuresBeforeRestart ?? TUNNEL_FAILURES_BEFORE_RESTART)) return;
      this.log("tunnel-watchdog", { grund: kind, fehlversuche: this.failures, pid: child.pid ?? null });
      this.failures = 0;
      this.restartOwn(child);
    } finally {
      this.checking = false;
    }
  }

  /** Nur den EIGENEN ssh beenden; „exit" startet ihn dann mit dem üblichen Abstand neu. */
  private restartOwn(child: ChildProcess): void {
    this.up = false;
    child.kill("SIGTERM");
    const hard = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    hard.unref?.();
    child.once("exit", () => clearTimeout(hard));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.child?.kill("SIGTERM");
  }
}
