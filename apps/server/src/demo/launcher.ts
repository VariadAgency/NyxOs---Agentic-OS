// "Demo ansehen" in the onboarding: the local instance starts ONE demo instance next to itself — the same
// program (same Node, same entry file, same loader flags when run from source) with invented data in its own
// folder <NYXOS_HOME>/demo and its own port — and hands the browser a one-time sign-in link to it.
// The child is not detached: it ends with this server (`stop`), notices on its own when this server is gone
// (NYXOS_DEMO_PARENT_PID) and quits after an hour without requests (NYXOS_DEMO_IDLE_MINUTES, see local.ts).
import { spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { Lang } from "@nyxos/shared";

export const DEMO_DEFAULT_PORT = 47802;
export const DEMO_IDLE_MINUTES = 60;

/** The part of a child process the launcher needs (a fake in tests). */
export interface DemoProcess {
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
}

export type DemoSpawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: StdioOptions }) => DemoProcess;

export interface DemoLauncherOptions {
  /** NYXOS_HOME of this instance: demo data in <home>/demo, log in <home>/logs/demo.log. */
  home: string;
  port?: number;
  /** Program and arguments of the child (default: this process' Node, loader flags and entry file). */
  command?: string;
  args?: string[];
  /** Environment the child starts from (default: this process' environment). */
  env?: NodeJS.ProcessEnv;
  spawn?: DemoSpawn;
  fetch?: typeof fetch;
  startTimeoutMs?: number;
  pollMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Can the demo bind this port? (default: a real bind test on 127.0.0.1). */
  portFree?: (port: number) => Promise<boolean>;
}

/** Binds 127.0.0.1:`port` for a moment: true = free. `port` 0 asks the system for any free port. */
function tryBind(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : null;
      server.close(() => resolve(bound));
    });
  });
}

export class DemoStartError extends Error {}

/** Node flags of this process minus the debugger ones (a second process must not grab the same inspector port). */
function loaderFlags(execArgv: readonly string[]): string[] {
  return execArgv.filter((a) => !/^--inspect(-brk|-port|-wait)?(=|$)/.test(a) && !/^--debug(-brk|-port)?(=|$)/.test(a));
}

/** How to start the same program again: Node + loader flags (tsx when run from source) + entry file. */
export function selfCommand(proc: { execPath: string; execArgv: readonly string[]; argv: readonly string[] } = process): { command: string; args: string[]; fromSource: boolean } {
  const entry = proc.argv[1] ?? "";
  return { command: proc.execPath, args: [...loaderFlags(proc.execArgv), entry], fromSource: entry.endsWith(".ts") };
}

export class DemoLauncher {
  private child: DemoProcess | null = null;
  private current: { lang: Lang; homeUrl: string } | null = null;
  private pending: Promise<string> | null = null;
  /** Port of the demo; moves to a free one when the preferred port is taken by another program. */
  port: number;
  readonly dataDir: string;
  readonly logFile: string;

  constructor(private readonly opts: DemoLauncherOptions) {
    this.port = opts.port ?? DEMO_DEFAULT_PORT;
    this.dataDir = join(opts.home, "demo");
    this.logFile = join(opts.home, "logs", "demo.log");
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Is a demo child of ours running right now? */
  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.signalCode;
  }

  /**
   * One-time sign-in URL of a healthy demo instance (reused if one runs with the same language and way home,
   * otherwise started fresh with fresh data). Concurrent calls share one start.
   */
  start(input: { lang: Lang; homeUrl: string }): Promise<string> {
    this.pending ??= this.startOnce(input).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async startOnce(input: { lang: Lang; homeUrl: string }): Promise<string> {
    const same = this.current && this.current.lang === input.lang && this.current.homeUrl === input.homeUrl;
    if (this.running && same && (await this.healthy())) return this.signInUrl();
    await this.stop();
    await this.choosePort();
    this.spawnChild(input);
    await this.waitUntilHealthy();
    return this.signInUrl();
  }

  /** Keeps the preferred port when it is free, otherwise takes any free port (the sign-in link carries it). */
  private async choosePort(): Promise<void> {
    const preferred = this.opts.port ?? DEMO_DEFAULT_PORT;
    const free = this.opts.portFree ?? (async (port: number) => (await tryBind(port)) !== null);
    if (await free(preferred)) {
      this.port = preferred;
      return;
    }
    const other = await tryBind(0);
    if (other === null) throw new DemoStartError("no free port for the demo");
    this.opts.log?.("demo-port-belegt", { preferred, port: other });
    this.port = other;
  }

  private spawnChild(input: { lang: Lang; homeUrl: string }): void {
    // Fresh invented data on every start (all timestamps are relative to "now").
    rmSync(this.dataDir, { recursive: true, force: true });
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.logFile), { recursive: true, mode: 0o700 });
    const self = selfCommand();
    const command = this.opts.command ?? self.command;
    const args = this.opts.args ?? self.args;
    const base = { ...(this.opts.env ?? process.env) };
    // Values this instance derived for itself must not leak into the demo (own key, own port).
    delete base.NYXOS_SECRETS_KEY;
    delete base.PORT;
    const env: NodeJS.ProcessEnv = {
      ...base,
      NYXOS_DEMO: "1",
      NYXOS_DATA_DIR: this.dataDir,
      PORT: String(this.port),
      NYXOS_DEMO_LANG: input.lang,
      NYXOS_DEMO_HOME_URL: input.homeUrl,
      NYXOS_DEMO_IDLE_MINUTES: String(DEMO_IDLE_MINUTES),
      NYXOS_DEMO_PARENT_PID: String(process.pid),
    };
    // From source (tsx) this instance has no built web app of its own: the demo serves apps/web/dist.
    const entry = args[args.length - 1] ?? "";
    if (!env.WEB_DIR && entry.endsWith(".ts")) env.WEB_DIR = join(dirname(entry), "..", "..", "web", "dist");
    const log = openSync(this.logFile, "a", 0o600);
    try {
      const child = (this.opts.spawn ?? (nodeSpawn as unknown as DemoSpawn))(command, args, { env, stdio: ["ignore", log, log] });
      this.child = child;
      this.current = { ...input };
      child.once("exit", () => {
        if (this.child === child) this.child = null;
        this.opts.log?.("demo-beendet");
      });
      this.opts.log?.("demo-gestartet", { port: this.port });
    } finally {
      closeSync(log);
    }
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.origin}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 40_000);
    const poll = this.opts.pollMs ?? 250;
    while (Date.now() < deadline) {
      if (!this.running) throw new DemoStartError("demo process ended");
      if (await this.healthy()) return;
      await new Promise((r) => setTimeout(r, poll));
    }
    await this.stop();
    throw new DemoStartError("demo did not become healthy in time");
  }

  private async signInUrl(): Promise<string> {
    const token = readFileSync(join(this.dataDir, "bridge-token"), "utf8").trim();
    const res = await (this.opts.fetch ?? fetch)(`${this.origin}/local/login-code`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new DemoStartError(`login code: ${res.status}`);
    const { code } = (await res.json()) as { code?: unknown };
    if (typeof code !== "string" || !code) throw new DemoStartError("login code missing");
    return `${this.origin}/auth/local?code=${encodeURIComponent(code)}&next=/overview`;
  }

  /** Ends the demo child (SIGTERM, SIGKILL after `graceMs`). Safe to call when none runs. */
  async stop(graceMs = 5000): Promise<void> {
    const child = this.child;
    this.child = null;
    this.current = null;
    if (!child || child.exitCode !== null || child.signalCode) return;
    await new Promise<void>((resolve) => {
      const hard = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, graceMs);
      hard.unref?.();
      child.once("exit", () => {
        clearTimeout(hard);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  /** Synchronous last resort when this process exits anyway (no waiting possible). */
  killNow(): void {
    if (this.running) this.child?.kill("SIGTERM");
  }
}
