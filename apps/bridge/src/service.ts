// Der Brücken-Dienst: startet `node bridge.js run` dauerhaft und nach jeder Anmeldung.
//
// - macOS: launchd-Agent (`gui/<uid>`, auf Rechnern ohne Anmelde-Oberfläche `user/<uid>`).
// - Linux: systemd-Benutzer-Unit (`systemctl --user`), plus `loginctl enable-linger`, damit die Brücke
//   auch ohne offene Anmeldung weiterläuft.
// - Wo beides nicht geht (Container, CI, WSL ohne systemd, macOS ohne Sitzung): ein abgelöster Prozess
//   mit PID-Datei. Er startet nicht von selbst neu, `status`/`restart`/`stop` funktionieren trotzdem.
//
// Der gewählte Weg steht in `<bridge>/service.json`, damit `status`, `restart`, `stop` und `uninstall`
// denselben Weg nehmen wie die Installation.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "@nyxos/shared";
import { LABEL, SYSTEMD_UNIT, type BridgePaths } from "./config.js";
import { loadLaunchAgent, unloadLaunchAgent, type LaunchctlRunner } from "./launchd.js";
import { EXTRA_BIN_DIRS } from "./platform.js";

export type ServiceMode = "launchd" | "systemd" | "process";

export interface CmdResult {
  code: number;
  out: string;
}
/** Ein Programm ausführen, nie werfen: Exit-Code und Ausgabe zurück. */
export type CmdRunner = (bin: string, args: string[]) => CmdResult;

export const realCmd: CmdRunner = (bin, args) => {
  try {
    const out = execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20_000 });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err.message ?? e) };
  }
};

export interface ServiceSpec {
  /** node-Programm, mit dem die Brücke läuft. */
  node: string;
  /** Pfad zu `bridge.js`. */
  entry: string;
}

export interface ServiceDeps {
  paths: BridgePaths;
  platform?: NodeJS.Platform;
  uid?: number;
  /** Nutzername für `loginctl enable-linger`. */
  user?: string;
  env?: NodeJS.ProcessEnv;
  run?: CmdRunner;
  sleep?: (ms: number) => Promise<void>;
  /** Startet den abgelösten Prozess und liefert seine PID (Tests ersetzen das). */
  spawnDetached?: (args: string[], env: NodeJS.ProcessEnv, logFile: string) => number;
  /** Lebt diese PID und ist es die Brücke? (Tests ersetzen das) */
  isBridgePid?: (pid: number) => boolean;
  /** Wie lange auf „läuft" gewartet wird (ms). */
  verifyMs?: number;
}

interface ServiceRecord {
  mode: ServiceMode;
  /** launchd-Domäne, z. B. `gui/501` oder `user/501`. */
  domain?: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS = 250;

/** Befehlszeile des Dienstes. */
export function serviceArgs(spec: ServiceSpec): string[] {
  return [spec.node, "--disable-warning=ExperimentalWarning", spec.entry, "run"];
}

/** PATH für den Dienst: Ordner von node, PATH beim Installieren, dann die typischen Programm-Ordner. */
export function servicePath(node: string, installPath: string | undefined): string {
  const dirs: string[] = [];
  // Only absolute folders: a relative entry (".", "node_modules/.bin") would run e.g. a `git` shipped inside the
  // repository the bridge is scanning.
  for (const d of [dirname(node), ...(installPath ?? "").split(":"), ...EXTRA_BIN_DIRS]) if (d.startsWith("/") && !dirs.includes(d)) dirs.push(d);
  return dirs.join(":");
}

/** Umgebung des Dienstes: PATH, HOME (das Nutzerverzeichnis der Installation) und (falls gesetzt) NYXOS_HOME. */
export function serviceEnv(spec: ServiceSpec, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { PATH: servicePath(spec.node, env.PATH) };
  if (env.HOME?.trim()) out.HOME = env.HOME.trim();
  if (env.NYXOS_HOME?.trim()) out.NYXOS_HOME = env.NYXOS_HOME.trim();
  if (env.LANG?.trim()) out.LANG = env.LANG.trim();
  return out;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * launchd-Eintrag. `ProcessType=Interactive`: Kanal und Web-Terminal sind interaktiv (Tastendrücke laufen
 * hindurch); im Hintergrund-Band bekäme die Brücke unter Last minutenlang keine Rechenzeit. Die schwere Arbeit
 * (Nachimport, Archiv, Vault) gibt dafür selbst regelmäßig ab und ist gedrosselt.
 */
export function plist(args: string[], log: string, env: Record<string, string>): string {
  const envXml = Object.entries(env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>${envXml}</dict>
</dict>
</plist>
`;
}

/** Ein Wort für systemd: in Anführungszeichen, `\\`, `"`, `%` und `$` geschützt. */
function sdQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/**
 * systemd-Benutzer-Unit. `KillMode=process`: bei Neustart/Stopp nur die Brücke selbst beenden — die tmux-Server
 * mit den laufenden Claude-/Codex-Sessions hängen in derselben Kontrollgruppe und müssen weiterlaufen.
 */
export function systemdUnit(args: string[], log: string, env: Record<string, string>): string {
  return [
    "[Unit]",
    "Description=NyxOS bridge",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${args.map(sdQuote).join(" ")}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    "Restart=always",
    "RestartSec=5",
    "KillMode=process",
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function recordFile(p: BridgePaths): string {
  return join(p.support, "service.json");
}
function pidFile(p: BridgePaths): string {
  return join(p.support, "bridge.pid");
}

export function readServiceRecord(p: BridgePaths): ServiceRecord | null {
  try {
    const r = JSON.parse(readFileSync(recordFile(p), "utf8")) as Partial<ServiceRecord>;
    return r.mode === "launchd" || r.mode === "systemd" || r.mode === "process" ? { mode: r.mode, ...(typeof r.domain === "string" ? { domain: r.domain } : {}) } : null;
  } catch {
    return null;
  }
}

function writeServiceRecord(p: BridgePaths, r: ServiceRecord): void {
  mkdirSync(p.support, { recursive: true });
  writeFileSync(recordFile(p), JSON.stringify(r) + "\n");
}

function readPid(p: BridgePaths): number | null {
  try {
    const n = Number(readFileSync(pidFile(p), "utf8").trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

/** Lebt der Prozess, und ist es wirklich eine Brücke (`bridge.js run`)? Schützt vor wiederverwendeten PIDs. */
function realIsBridgePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const r = realCmd("ps", ["-o", "args=", "-p", String(pid)]);
  return r.code === 0 && /\bbridge(\.js)?\b.*\brun\b/.test(r.out);
}

const realSpawnDetached = (args: string[], env: NodeJS.ProcessEnv, logFile: string): number => {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const [bin, ...rest] = args;
    const child = spawn(bin as string, rest, { detached: true, stdio: ["ignore", fd, fd], env });
    child.unref();
    if (!child.pid) throw new Error(t("Brücke ließ sich nicht starten"));
    return child.pid;
  } finally {
    closeSync(fd);
  }
};

class Service {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly env: NodeJS.ProcessEnv;
  readonly run: CmdRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isBridgePid: (pid: number) => boolean;

  constructor(readonly d: ServiceDeps) {
    this.platform = d.platform ?? process.platform;
    this.uid = d.uid ?? process.getuid?.() ?? 0;
    this.env = d.env ?? process.env;
    this.run = d.run ?? realCmd;
    this.sleep = d.sleep ?? realSleep;
    this.isBridgePid = d.isBridgePid ?? realIsBridgePid;
  }

  get p(): BridgePaths {
    return this.d.paths;
  }

  launchctl: LaunchctlRunner = (args) => this.run("/bin/launchctl", args);
  systemctl = (...args: string[]) => this.run("systemctl", ["--user", ...args]);

  target(domain: string): string {
    return `${domain}/${LABEL}`;
  }

  // ── abgelöster Prozess ──────────────────────────────────────────────────────────────────────

  processPid(): number | null {
    const pid = readPid(this.p);
    return pid !== null && this.isBridgePid(pid) ? pid : null;
  }

  async startProcess(spec: ServiceSpec): Promise<string[]> {
    const running = this.processPid();
    if (running) return [t("Brücke läuft schon (pid {pid})", { pid: running })];
    const env = { ...this.env, ...serviceEnv(spec, this.env) };
    const pid = (this.d.spawnDetached ?? realSpawnDetached)(serviceArgs(spec), env, this.p.log);
    mkdirSync(this.p.support, { recursive: true });
    writeFileSync(pidFile(this.p), `${pid}\n`);
    return [t("Brücke als eigener Prozess gestartet (pid {pid}, startet nach einem Neustart des Rechners nicht von selbst)", { pid })];
  }

  async stopProcess(): Promise<boolean> {
    const pid = this.processPid();
    rmSync(pidFile(this.p), { force: true });
    if (!pid) return false;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
    for (let waited = 0; waited < 8_000; waited += POLL_MS) {
      if (!this.isBridgePid(pid)) return true;
      await this.sleep(POLL_MS);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // schon weg
    }
    return true;
  }

  // ── launchd ─────────────────────────────────────────────────────────────────────────────────

  async installLaunchd(spec: ServiceSpec): Promise<{ domain: string; report: string[] } | { error: string }> {
    mkdirSync(dirname(this.p.launchAgent), { recursive: true });
    writeFileSync(this.p.launchAgent, plist(serviceArgs(spec), this.p.log, serviceEnv(spec, this.env)));
    let lastError = "";
    for (const domain of [`gui/${this.uid}`, `user/${this.uid}`]) {
      // Ohne Anmelde-Oberfläche (SSH, Server-Mac) gibt es die gui-Domäne nicht — dann gar nicht erst versuchen.
      if (this.launchctl(["print", domain]).code !== 0) {
        lastError = t("launchd-Domäne {domain} nicht verfügbar", { domain });
        continue;
      }
      try {
        const report = await loadLaunchAgent({ target: this.target(domain), domain, plist: this.p.launchAgent, uid: this.uid, run: this.launchctl, sleep: this.sleep, logFile: this.p.log, ...(this.d.verifyMs !== undefined ? { verifyMs: this.d.verifyMs } : {}) });
        return { domain, report };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        await unloadLaunchAgent({ target: this.target(domain), run: this.launchctl, sleep: this.sleep });
      }
    }
    rmSync(this.p.launchAgent, { force: true });
    return { error: lastError };
  }

  launchdRunning(domain: string): boolean {
    const r = this.launchctl(["print", this.target(domain)]);
    return r.code === 0 && /\bstate = running\b/.test(r.out);
  }

  // ── systemd ─────────────────────────────────────────────────────────────────────────────────

  async installSystemd(spec: ServiceSpec): Promise<{ report: string[] } | { error: string }> {
    const probe = this.systemctl("show-environment");
    if (probe.code !== 0) return { error: probe.out.split("\n")[0] || t("systemd für Benutzer nicht erreichbar") };
    mkdirSync(dirname(this.p.systemdUnit), { recursive: true });
    writeFileSync(this.p.systemdUnit, systemdUnit(serviceArgs(spec), this.p.log, serviceEnv(spec, this.env)));
    const report: string[] = [t("systemd-Unit → {file}", { file: this.p.systemdUnit })];
    for (const args of [["daemon-reload"], ["enable", SYSTEMD_UNIT], ["restart", SYSTEMD_UNIT]]) {
      const r = this.systemctl(...args);
      if (r.code !== 0) {
        rmSync(this.p.systemdUnit, { force: true });
        this.systemctl("daemon-reload");
        return { error: r.out.split("\n")[0] || t("systemctl {cmd} fehlgeschlagen", { cmd: args.join(" ") }) };
      }
    }
    // Ohne „linger" endet die Brücke mit der letzten Anmeldung; klappt das nicht (keine Rechte), läuft sie trotzdem.
    const user = this.d.user ?? this.env.USER ?? this.env.LOGNAME;
    if (user) this.run("loginctl", ["enable-linger", user]);
    for (let waited = 0; waited <= (this.d.verifyMs ?? 10_000); waited += POLL_MS) {
      if (this.systemdRunning()) {
        report.push(t("Brücke läuft (systemd)"));
        return { report };
      }
      await this.sleep(POLL_MS);
    }
    report.push(t("Brücke gestartet, meldet sich aber noch nicht als aktiv. Log: {log}", { log: this.p.log }));
    return { report };
  }

  systemdRunning(): boolean {
    const r = this.systemctl("is-active", SYSTEMD_UNIT);
    return r.code === 0 && r.out.trim() === "active";
  }

  // ── gemeinsame Befehle ──────────────────────────────────────────────────────────────────────

  async install(spec: ServiceSpec): Promise<{ mode: ServiceMode; report: string[] }> {
    await this.stop();
    const report: string[] = [];
    if (this.platform === "darwin") {
      const r = await this.installLaunchd(spec);
      if ("domain" in r) {
        writeServiceRecord(this.p, { mode: "launchd", domain: r.domain });
        return { mode: "launchd", report: [...report, ...r.report] };
      }
      report.push(t("launchd nicht nutzbar ({error}) — Brücke läuft als eigener Prozess", { error: r.error }));
    } else if (this.platform === "linux") {
      const r = await this.installSystemd(spec);
      if ("report" in r) {
        writeServiceRecord(this.p, { mode: "systemd" });
        return { mode: "systemd", report: [...report, ...r.report] };
      }
      report.push(t("systemd nicht nutzbar ({error}) — Brücke läuft als eigener Prozess", { error: r.error }));
    }
    writeServiceRecord(this.p, { mode: "process" });
    return { mode: "process", report: [...report, ...(await this.startProcess(spec))] };
  }

  mode(): ServiceMode | null {
    return readServiceRecord(this.p)?.mode ?? null;
  }

  running(): boolean {
    const rec = readServiceRecord(this.p);
    if (!rec) return this.processPid() !== null;
    if (rec.mode === "launchd") return this.launchdRunning(rec.domain ?? `gui/${this.uid}`);
    if (rec.mode === "systemd") return this.systemdRunning();
    return this.processPid() !== null;
  }

  /** Beendet die Brücke (egal auf welchem Weg sie läuft). Die Dienst-Datei bleibt stehen. */
  async stop(): Promise<string[]> {
    const rec = readServiceRecord(this.p);
    const report: string[] = [];
    if (rec?.mode === "launchd" || (!rec && this.platform === "darwin" && existsSync(this.p.launchAgent))) {
      for (const domain of rec?.domain ? [rec.domain] : [`gui/${this.uid}`, `user/${this.uid}`]) await unloadLaunchAgent({ target: this.target(domain), run: this.launchctl, sleep: this.sleep });
      report.push(t("launchd-Agent angehalten"));
    }
    if (rec?.mode === "systemd" || (!rec && this.platform === "linux" && existsSync(this.p.systemdUnit))) {
      this.systemctl("stop", SYSTEMD_UNIT);
      report.push(t("systemd-Unit angehalten"));
    }
    if (await this.stopProcess()) report.push(t("Brücken-Prozess beendet"));
    return report;
  }

  async restart(spec: ServiceSpec): Promise<string[]> {
    const rec = readServiceRecord(this.p);
    if (rec?.mode === "launchd") {
      const domain = rec.domain ?? `gui/${this.uid}`;
      if (this.launchctl(["print", this.target(domain)]).code === 0) {
        const r = this.launchctl(["kickstart", "-k", this.target(domain)]);
        if (r.code !== 0) throw new Error(t("Neustart fehlgeschlagen: {error}", { error: r.out.split("\n")[0] ?? "" }));
        return [t("Brücke neu gestartet (launchd)")];
      }
      return loadLaunchAgent({ target: this.target(domain), domain, plist: this.p.launchAgent, uid: this.uid, run: this.launchctl, sleep: this.sleep, logFile: this.p.log });
    }
    if (rec?.mode === "systemd") {
      const r = this.systemctl("restart", SYSTEMD_UNIT);
      if (r.code !== 0) throw new Error(t("Neustart fehlgeschlagen: {error}", { error: r.out.split("\n")[0] ?? "" }));
      return [t("Brücke neu gestartet (systemd)")];
    }
    await this.stopProcess();
    writeServiceRecord(this.p, { mode: "process" });
    return this.startProcess(spec);
  }

  async uninstall(): Promise<string[]> {
    const report = await this.stop();
    if (existsSync(this.p.launchAgent)) {
      rmSync(this.p.launchAgent, { force: true });
      report.push(t("launchd-Agent entfernt"));
    }
    if (existsSync(this.p.systemdUnit)) {
      this.systemctl("disable", SYSTEMD_UNIT);
      rmSync(this.p.systemdUnit, { force: true });
      this.systemctl("daemon-reload");
      report.push(t("systemd-Unit entfernt"));
    }
    rmSync(recordFile(this.p), { force: true });
    rmSync(pidFile(this.p), { force: true });
    return report;
  }
}

export function service(d: ServiceDeps): Service {
  return new Service(d);
}

export type BridgeService = Service;
