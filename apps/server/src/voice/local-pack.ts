// Local voice pack (local mode only): the `nyx-voice` Python service of server mode, run as a child process of
// this server instead of a container. Installed with `nyxos voice install` (terminal) or the button in
// Settings → Nyx → Voice, which runs that same command (`apps/cli/voice.mjs`) and reads its JSON progress lines.
//
//   ~/.nyxos/voice/pack.json     written last by the installer: the pack is complete → start the service
//   ~/.nyxos/voice/service.json  pid, port and key of the running service (0600; `nyxos voice status` reads it)
//   ~/.nyxos/voice/models/       speech models; the service downloads them on first start (SHA-256 checked)
//   ~/.nyxos/logs/voice.log      output of the service
//
// The service listens on 127.0.0.1 only (never another interface), on the port next to the server (+3) or any
// free one, and wants a fresh random key per start: other users of the same computer reach 127.0.0.1 too.
// It gets a minimal environment (never the server's own secrets), ends together with this server
// (NYX_PARENT_PID) and is restarted with growing pauses if it crashes.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { t, VOICE_PACK_DOWNLOAD_BYTES, VOICE_PACK_STEPS, voicePackErrorSentence, type NyxVoiceImport, type NyxVoiceSpeakRequest, type VoicePackStatus, type VoicePackStep } from "@nyxos/shared";
import { HttpNyxVoiceBackend, NyxVoiceBackendError, type NyxVoiceBackend, type NyxVoiceRawPart, type NyxVoiceRawStatus } from "../nyx/voice-backend.js";

/** Voices of the local pack: small, fast Piper voices, one per language (no PyTorch needed). */
export const LOCAL_VOICES = { de: "de_DE-thorsten-medium", en: "en_US-ljspeech-high" } as const;
/** Pauses before restarting a crashed service; a service that ran for a while starts again from the first. */
export const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const STABLE_AFTER_MS = 120_000;
const START_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 5_000;
const POLL_MS = 5_000;
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface LocalVoicePackOptions {
  /** NYXOS_HOME */
  home: string;
  logsDir: string;
  /** Folder with `nyx_voice/` and `requirements-local.txt` (release: `<release>/voice`, source: infra/nyx-voice). */
  voiceSrc: string | null;
  /** `nyxos` command file (`cli/nyxos.mjs`) and the Node.js that runs it. */
  cli: string | null;
  node: string;
  /** Preferred port (server port + 3); any free port if it is taken. */
  port: number;
  log?: Log;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Tests: faster polling and restarts. */
  pollMs?: number;
  restartDelaysMs?: number[];
}

interface Pack {
  format: number;
  requirementsSha256: string;
  python: string;
  ffmpeg: string;
  ffmpegSource: "imageio-ffmpeg" | "system";
}

type ChildState = "none" | "starting" | "running" | "restarting";
export type PackActionResult = { ok: true } | { ok: false; reason: string };

/** Release folder layout: server/dist/local.js → ../../voice and ../../cli/nyxos.mjs; source: apps/server/src → infra, apps/cli. */
export function findVoiceFiles(serverDir: string): { voiceSrc: string | null; cli: string | null } {
  const voice = [join(serverDir, "..", "..", "voice"), join(serverDir, "..", "..", "..", "infra", "nyx-voice")].find((d) => existsSync(join(d, "nyx_voice", "server.py")) && existsSync(join(d, "requirements-local.txt"))) ?? null;
  const cli = join(serverDir, "..", "..", "cli", "nyxos.mjs");
  return { voiceSrc: voice, cli: existsSync(cli) ? cli : null };
}

export function voicePackSupported(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === "darwin" || platform === "linux") && (arch === "arm64" || arch === "x64");
}

/** A free port on 127.0.0.1: `preferred` if nobody listens there, else one the system hands out. */
export async function freeLoopbackPort(preferred: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number | null>((done) => {
      const srv = createServer();
      srv.once("error", () => done(null));
      srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        const addr = srv.address();
        const got = typeof addr === "object" && addr ? addr.port : null;
        srv.close(() => done(got));
      });
    });
  return (await tryListen(preferred)) ?? (await tryListen(0)) ?? preferred;
}

export class LocalVoicePack {
  readonly dir: string;
  private readonly packFile: string;
  private readonly serviceFile: string;
  private readonly log: Log;
  private readonly spawnImpl: typeof spawn;
  private readonly delays: number[];

  private phase: "idle" | "installing" | "removing" = "idle";
  private step: VoicePackStep | null = null;
  private progress: number | null = null;
  private installError: string | null = null;
  private autoRepairTried = false;

  private child: ChildProcess | null = null;
  private childState: ChildState = "none";
  private port = 0;
  private token = "";
  private http: HttpNyxVoiceBackend | null = null;
  private startedAt = 0;
  private crashes = 0;
  private crashNote: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private syncing = false;

  /** The service as a voice backend for the routes (status, transcribe, speak, import). */
  readonly backend: NyxVoiceBackend;

  constructor(private readonly o: LocalVoicePackOptions) {
    this.dir = join(o.home, "voice");
    this.packFile = join(this.dir, "pack.json");
    this.serviceFile = join(this.dir, "service.json");
    this.log = o.log ?? (() => {});
    this.spawnImpl = o.spawnImpl ?? spawn;
    this.delays = o.restartDelaysMs ?? RESTART_DELAYS_MS;
    this.backend = new LocalVoiceBackend(() => this.endpoint());
  }

  private get supported(): boolean {
    return voicePackSupported(this.o.platform ?? process.platform, this.o.arch ?? process.arch);
  }

  // ─── pack on disk ──────────────────────────────────────────────────────────
  private readPack(): Pack | null {
    try {
      const p = JSON.parse(readFileSync(this.packFile, "utf8")) as Partial<Pack>;
      if (p.format !== 1 || typeof p.python !== "string" || typeof p.ffmpeg !== "string" || typeof p.requirementsSha256 !== "string") return null;
      return p as Pack;
    } catch {
      return null;
    }
  }

  /** false = the release brings other packages than the installed ones (needs `voice install` again). */
  private packCurrent(pack: Pack): boolean {
    if (!this.o.voiceSrc) return true;
    try {
      const text = readFileSync(join(this.o.voiceSrc, "requirements-local.txt"), "utf8");
      return createHash("sha256").update(text).digest("hex") === pack.requirementsSha256;
    } catch {
      return true;
    }
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────
  /** Starts the service when the pack is installed and keeps watching (a terminal install is picked up too). */
  start(): void {
    this.stopping = false;
    void this.sync();
    this.pollTimer = setInterval(() => void this.sync(), this.o.pollMs ?? POLL_MS);
    this.pollTimer.unref();
  }

  /** Ends the service (SIGTERM, then SIGKILL after 5 s). Called on server shutdown. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.stopChild();
  }

  /** Sync the running service with the pack on disk: start it, or stop it when the pack is gone. */
  private async sync(): Promise<void> {
    if (this.syncing || this.stopping || this.phase !== "idle") return;
    this.syncing = true;
    try {
      const pack = this.readPack();
      if (!pack) {
        if (this.child) await this.stopChild();
        return;
      }
      if (!this.packCurrent(pack) && !this.autoRepairTried) {
        // A NyxOS update brought other packages: bring the pack up to date once, then start.
        this.autoRepairTried = true;
        this.log("stimme-auffrischen", {});
        if (this.child) await this.stopChild();
        this.install();
        return;
      }
      if (!this.child && !this.restartTimer && this.o.voiceSrc) await this.spawnChild(pack);
    } finally {
      this.syncing = false;
    }
  }

  private async spawnChild(pack: Pack): Promise<void> {
    const voiceSrc = this.o.voiceSrc;
    if (!voiceSrc) return;
    mkdirSync(join(this.dir, "models"), { recursive: true, mode: 0o700 });
    mkdirSync(this.o.logsDir, { recursive: true });
    this.port = await freeLoopbackPort(this.o.port);
    this.token = randomBytes(24).toString("base64url");
    const logFile = join(this.o.logsDir, "voice.log");
    try {
      if (statSync(logFile).size > LOG_ROTATE_BYTES) renameSync(logFile, `${logFile}.1`);
    } catch {
      // no log yet
    }
    const fd = openSync(logFile, "a", 0o600);
    // Minimal environment: never pass on the server's secrets (NYXOS_SECRETS_KEY, tokens).
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? this.o.home,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      LANG: process.env.LANG ?? "C.UTF-8",
      PYTHONPATH: voiceSrc,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      NYX_HOST: "127.0.0.1",
      NYX_PORT: String(this.port),
      NYX_TOKEN: this.token,
      NYX_PARENT_PID: String(process.pid),
      NYX_MODELS_DIR: join(this.dir, "models"),
      NYX_FFMPEG: pack.ffmpeg,
      NYX_TTS_VOICES: `${LOCAL_VOICES.de},${LOCAL_VOICES.en}`,
      NYX_TTS_DEFAULT: LOCAL_VOICES.de,
      NYX_TTS_DEFAULT_EN: LOCAL_VOICES.en,
      NYX_THREADS: String(Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))),
      HF_HUB_OFFLINE: "1",
    };
    let child: ChildProcess;
    try {
      child = this.spawnImpl(pack.python, ["-m", "nyx_voice"], { cwd: this.dir, env, stdio: ["ignore", fd, fd] });
    } catch (e) {
      closeSync(fd);
      this.onExit(null, `spawn: ${String(e)}`);
      return;
    }
    // the child has its own copy of the log file descriptor
    closeSync(fd);
    this.child = child;
    this.childState = "starting";
    this.startedAt = Date.now();
    this.http = new HttpNyxVoiceBackend(`http://127.0.0.1:${this.port}`, this.o.fetchImpl ?? fetch, this.token);
    if (child.pid) writeFileSync(this.serviceFile, JSON.stringify({ pid: child.pid, port: this.port, token: this.token }) + "\n", { mode: 0o600 });
    this.log("stimme-start", { port: this.port, pid: child.pid });
    child.once("error", (e) => {
      if (this.child === child) this.onExit(null, e.message);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.onExit(code, signal ?? "");
    });
    void this.waitHealthy(child);
  }

  private async waitHealthy(child: ChildProcess): Promise<void> {
    const until = Date.now() + START_TIMEOUT_MS;
    while (this.child === child && this.childState === "starting" && Date.now() < until) {
      try {
        await this.http?.status();
        if (this.child === child) {
          this.childState = "running";
          this.log("stimme-bereit", { port: this.port, startMs: Date.now() - this.startedAt });
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    // Did not answer in time: end it, the exit handler schedules a restart.
    if (this.child === child && this.childState === "starting") {
      this.log("stimme-antwortet-nicht", { port: this.port });
      child.kill("SIGKILL");
    }
  }

  private onExit(code: number | null, detail: string): void {
    const ranMs = Date.now() - this.startedAt;
    this.child = null;
    this.http = null;
    rmSync(this.serviceFile, { force: true });
    if (this.stopping || this.phase !== "idle") {
      this.childState = "none";
      return;
    }
    if (ranMs >= STABLE_AFTER_MS) this.crashes = 0;
    const delay = this.delays[Math.min(this.crashes, this.delays.length - 1)] ?? 60_000;
    this.crashes++;
    this.childState = "restarting";
    this.crashNote = this.crashes >= 3 ? t("Die Stimme stürzt immer wieder ab. Protokoll: {cmd}", { cmd: "nyxos logs" }) : null;
    this.log("stimme-beendet", { code, detail: detail.slice(0, 200), restartInMs: delay, crashes: this.crashes });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.childState = "none";
      void this.sync();
    }, delay);
    this.restartTimer.unref();
  }

  private async stopChild(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) {
      this.childState = "none";
      return;
    }
    // Forget it first: its exit is wanted, so the exit handler must not schedule a restart.
    this.child = null;
    this.http = null;
    this.childState = "none";
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
    rmSync(this.serviceFile, { force: true });
  }

  // ─── install / remove (the `nyxos voice` command does the work) ───────────
  private runCli(args: string[], onLine: (obj: Record<string, unknown>) => void, onDone: (code: number | null, stderr: string) => void): boolean {
    if (!this.o.cli) return false;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? this.o.home, LANG: process.env.LANG ?? "C.UTF-8", NYXOS_HOME: this.o.home };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    let child: ChildProcess;
    try {
      child = this.spawnImpl(this.o.node, [this.o.cli, "voice", ...args, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return false;
    }
    let buf = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          onLine(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not a progress line
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-2000);
    });
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      onDone(code, stderr);
    };
    child.once("error", (e) => {
      stderr += e.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
    return true;
  }

  /** Starts the installation in the background (progress via `status()`). */
  install(): PackActionResult {
    if (!this.supported) return { ok: false, reason: "unsupported" };
    if (this.phase !== "idle") return { ok: false, reason: "busy" };
    if (!this.o.voiceSrc || !this.o.cli) return { ok: false, reason: "source_missing" };
    this.phase = "installing";
    this.step = "check";
    this.progress = null;
    this.installError = null;
    let errorCode: string | null = null;
    const started = this.runCli(
      ["install"],
      (obj) => {
        if (typeof obj.error === "string") {
          errorCode = obj.error;
          this.log("stimme-installation-fehler", { code: obj.error, detail: String(obj.detail ?? "").slice(0, 300) });
          return;
        }
        if (typeof obj.step === "string" && (VOICE_PACK_STEPS as readonly string[]).includes(obj.step)) {
          this.step = obj.step as VoicePackStep;
          const done = Number(obj.done ?? 0);
          const total = Number(obj.total ?? 0);
          this.progress = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
        }
      },
      (code, stderr) => {
        this.phase = "idle";
        this.step = null;
        this.progress = null;
        if (code === 0) {
          this.crashes = 0;
          this.crashNote = null;
          this.log("stimme-installiert", {});
        } else {
          this.installError = voicePackErrorSentence(errorCode ?? "failed");
          if (!errorCode) this.log("stimme-installation-fehler", { code, stderr: stderr.slice(-300) });
        }
        void this.sync();
      },
    );
    if (!started) {
      this.phase = "idle";
      this.step = null;
      return { ok: false, reason: "source_missing" };
    }
    return { ok: true };
  }

  /** Stops the service and removes the pack (models, Python, packages). */
  remove(): PackActionResult {
    if (this.phase !== "idle") return { ok: false, reason: "busy" };
    if (!this.o.cli) return { ok: false, reason: "source_missing" };
    this.phase = "removing";
    this.installError = null;
    void (async () => {
      await this.stopChild();
      const started = this.runCli(
        ["remove"],
        () => {},
        (code, stderr) => {
          this.phase = "idle";
          this.crashes = 0;
          this.crashNote = null;
          if (code !== 0) {
            this.installError = t("Die Stimme ließ sich nicht ganz entfernen – bitte noch einmal versuchen.");
            this.log("stimme-entfernen-fehler", { code, stderr: stderr.slice(-300) });
          } else this.log("stimme-entfernt", {});
          void this.sync();
        },
      );
      if (!started) {
        this.phase = "idle";
        this.installError = t("Die Stimme ließ sich nicht ganz entfernen – bitte noch einmal versuchen.");
      }
    })();
    return { ok: true };
  }

  // ─── state ─────────────────────────────────────────────────────────────────
  status(): VoicePackStatus {
    const pack = this.readPack();
    const base = { installed: !!pack, step: null, progress: null, downloadBytes: VOICE_PACK_DOWNLOAD_BYTES, ffmpeg: pack?.ffmpegSource ?? null } as const;
    if (!this.supported) return { ...base, state: "unsupported", error: voicePackErrorSentence("unsupported") };
    if (this.phase === "installing") return { ...base, state: "installing", step: this.step, progress: this.progress, error: null };
    if (this.phase === "removing") return { ...base, state: "removing", error: null };
    if (!pack) return { ...base, state: this.installError ? "failed" : "not_installed", error: this.installError };
    if (this.childState === "running") return { ...base, state: "running", error: null };
    if (this.childState === "restarting") return { ...base, state: "restarting", error: this.crashNote ?? this.installError };
    return { ...base, state: "starting", error: this.installError };
  }

  /** Where requests go right now, or why they cannot. */
  private endpoint(): HttpNyxVoiceBackend {
    if (this.childState === "running" && this.http) return this.http;
    const pack = this.readPack();
    if (!pack || this.phase === "removing") throw new NyxVoiceBackendError("not_configured", 503, "Stimmen-Paket nicht installiert");
    if (this.childState === "restarting") throw new NyxVoiceBackendError("offline", 503, "Stimmen-Dienst startet nach einem Absturz neu");
    throw new NyxVoiceBackendError("starting", 503, "Stimmen-Dienst startet");
  }
}

/** Thin backend that always talks to the service currently running (port and key change per start). */
class LocalVoiceBackend implements NyxVoiceBackend {
  constructor(private readonly target: () => HttpNyxVoiceBackend) {}

  status(): Promise<NyxVoiceRawStatus> {
    return this.call((b) => b.status());
  }

  transcribe(audio: Uint8Array, opts: { mime: string; language: string }) {
    return this.call((b) => b.transcribe(audio, opts));
  }

  speak(req: NyxVoiceSpeakRequest, format: "ogg" | "wav") {
    return this.call((b) => b.speak(req, format));
  }

  importVoice(req: NyxVoiceImport): Promise<NyxVoiceRawPart & { added: boolean }> {
    return this.call((b) => b.importVoice(req));
  }

  speakStream(req: NyxVoiceSpeakRequest, signal?: AbortSignal) {
    return this.call((b) => b.speakStream(req, signal));
  }

  private async call<T>(fn: (b: HttpNyxVoiceBackend) => Promise<T>): Promise<T> {
    return fn(this.target());
  }
}
