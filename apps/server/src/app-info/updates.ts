// Update check against the GitHub releases of the NyxOS repository, plus installing an update in local mode.
// The actual swap is done by the `nyxos` command (`nyxos update`), which downloads the release, checks its
// SHA-256 sum, switches the `current` folder and restarts the services. The server only starts it.
import { compareVersions, NYXOS_REPO, t, type AppUpdateState } from "@nyxos/shared";
import { spawn } from "node:child_process";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UpdaterOptions {
  version: string;
  repo?: string;
  /** Path of the `nyxos` command; only set in local mode (the launcher passes it). */
  cli: string | null;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Called by the daily check to find out whether updates may be installed automatically. */
  autoUpdate?: () => Promise<boolean>;
  spawnImpl?: typeof spawn;
  /** Tests: environment and platform that decide how the update process is started. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Command line that starts `nyxos update` so it survives the restart of this server. Under systemd a plain
 * detached child is not enough: stopping the service kills every process in its control group, including the
 * update in the middle of its work. `systemd-run --user` gives it a unit (and control group) of its own.
 */
export function updateCommand(cli: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { cmd: string; args: string[] } {
  const args = ["update", "--yes"];
  if (platform === "linux" && env.INVOCATION_ID) {
    const keep = ["NYXOS_HOME", "PATH", "HOME", "LANG"].filter((k) => env[k]).map((k) => `--setenv=${k}=${env[k]}`);
    return { cmd: "systemd-run", args: ["--user", "--collect", "--quiet", "--unit", `nyxos-update-${Date.now()}`, ...keep, cli, ...args] };
  }
  return { cmd: cli, args };
}

export class Updater {
  private state: AppUpdateState;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly o: UpdaterOptions) {
    this.state = { latest: null, available: false, checkedAt: null, canInstall: o.cli !== null, installing: false, error: null };
  }

  get repo(): string {
    return this.o.repo ?? NYXOS_REPO;
  }

  snapshot(): AppUpdateState {
    return { ...this.state };
  }

  /** Asks GitHub for the latest release. Placeholder repository (before publishing) = no check. */
  async check(): Promise<AppUpdateState> {
    if (this.repo.startsWith("OWNER/")) return this.snapshot();
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": `nyxos/${this.o.version}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const body = (await res.json()) as { tag_name?: string };
      const latest = (body.tag_name ?? "").replace(/^v/, "") || null;
      this.state = { ...this.state, latest, available: latest !== null && compareVersions(latest, this.o.version) > 0, checkedAt: new Date().toISOString(), error: null };
    } catch (e) {
      this.state = { ...this.state, checkedAt: new Date().toISOString(), error: t("Update-Prüfung fehlgeschlagen: {msg}", { msg: String((e as Error).message ?? e) }) };
    }
    return this.snapshot();
  }

  /** Starts `nyxos update` detached; the service restarts afterwards, so this process ends soon. */
  install(): AppUpdateState {
    if (!this.o.cli) {
      this.state = { ...this.state, error: t("Im Server-Modus wird mit Docker Compose aktualisiert (siehe Hilfe).") };
      return this.snapshot();
    }
    if (this.state.installing) return this.snapshot();
    const { cmd, args } = updateCommand(this.o.cli, this.o.env ?? process.env, this.o.platform ?? process.platform);
    const child = (this.o.spawnImpl ?? spawn)(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => {
      this.state = { ...this.state, installing: false, error: String(e.message) };
    });
    // A successful update restarts this server; still running after a failed exit = the update did not happen.
    child.on("exit", (code) => {
      if (code !== 0) this.state = { ...this.state, installing: false, error: `nyxos update: exit ${code ?? "?"} (nyxos logs)` };
    });
    child.unref();
    this.state = { ...this.state, installing: true, error: null };
    this.o.log?.("update-gestartet", { latest: this.state.latest });
    return this.snapshot();
  }

  start(): void {
    const run = async () => {
      const s = await this.check();
      if (s.available && s.canInstall && (await this.o.autoUpdate?.().catch(() => false))) this.install();
    };
    setTimeout(() => void run(), 60_000).unref();
    this.timer = setInterval(() => void run(), DAY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
