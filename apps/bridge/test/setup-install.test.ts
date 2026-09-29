// Einrichtung ohne echten Rechner: Pfade unter NYXOS_HOME, Konfiguration (mehrere Projektordner), Dienst
// (launchd/systemd/eigener Prozess, alles mit Attrappen), Installieren/Entfernen und die Onboarding-Befehle
// `setup.state`/`setup.apply` — jeweils in einem Wegwerf-Home, nie im echten.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupStateSchema } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { inProjects, loadConfig, normalizeRoots, paths, saveConfig, underRoot, type BridgeConfig } from "../src/config.js";
import { hooksPresent, install, shellIntegrationPresent, uninstall } from "../src/install.js";
import { foldCase } from "../src/platform.js";
import { service, type CmdRunner } from "../src/service.js";
import { SetupError, SetupService, suggestVaults } from "../src/setup.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tempHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "nyxos-home-")));
  const env = { NYXOS_HOME: join(home, ".nyxos"), PATH: process.env.PATH ?? "/usr/bin:/bin" } as NodeJS.ProcessEnv;
  return { home, env, p: paths(home, env) };
}

/** Attrappe für launchctl/systemctl/loginctl/ps: Antworten je Befehl, alle Aufrufe protokolliert. */
function fakeRunner(answer: (bin: string, args: string[]) => { code: number; out: string }) {
  const calls: string[] = [];
  const run: CmdRunner = (bin, args) => {
    calls.push([bin.split("/").pop(), ...args].join(" "));
    return answer(bin, args);
  };
  return { run, calls };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Startet ein harmloses `sleep` als „Brücke“ (echter Prozess, damit stop() wirklich etwas beenden kann). */
function sleepSpawner() {
  const spawned: number[] = [];
  const spawnDetached = () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid as number;
    spawned.push(pid);
    cleanups.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    return pid;
  };
  return { spawnDetached, spawned };
}

const SPEC = { node: "/opt/node/bin/node", entry: "/opt/nyxos/app/bridge/bridge.js" };

describe("Pfade und Konfiguration", () => {
  it("alles liegt unter NYXOS_HOME (sonst ~/.nyxos): Brücken-Daten, Log, Modelle", () => {
    const { home, p } = tempHome();
    expect(p.root).toBe(join(home, ".nyxos"));
    expect(p.config).toBe(join(home, ".nyxos", "bridge", "config.json"));
    expect(p.hook).toBe(join(home, ".nyxos", "bridge", "nyxos-hook"));
    expect(p.log).toBe(join(home, ".nyxos", "logs", "bridge.log"));
    expect(p.whisperModels).toBe(join(home, ".nyxos", "models", "whisper"));
    expect(p.systemdUnit).toBe(join(home, ".config", "systemd", "user", "nyxos-bridge.service"));
    expect(paths("/home/x", {}).root).toBe("/home/x/.nyxos");
    expect(paths("/home/x", { NYXOS_HOME: "~/anders" }).root).toBe("/home/x/anders");
  });

  it("ältere Konfiguration mit einem `projectRoot` wird zu `projectRoots`; ohne Angabe: leer, kein Vault", () => {
    const { p } = tempHome();
    mkdirSync(p.support, { recursive: true });
    writeFileSync(p.config, JSON.stringify({ serverUrl: "http://127.0.0.1:47800", token: "t", projectRoot: "/srv/code/" }));
    expect(loadConfig(p.config).projectRoots).toEqual(["/srv/code"]);
    expect(loadConfig(p.config)).not.toHaveProperty("projectRoot");
    writeFileSync(p.config, JSON.stringify({ serverUrl: "http://127.0.0.1:47800", token: "t" }));
    expect(loadConfig(p.config)).toMatchObject({ projectRoots: [], vaultDir: null, tunnel: null });
  });

  it("saveConfig schreibt atomar und nur für den Nutzer lesbar", () => {
    const { p } = tempHome();
    const cfg = { serverUrl: "http://127.0.0.1:47800", token: "t", tunnel: null, projectRoots: ["/a"], claudeDir: "/c", codexDir: "/x" } satisfies BridgeConfig;
    saveConfig(cfg, p.config);
    expect(JSON.parse(readFileSync(p.config, "utf8"))).toMatchObject({ projectRoots: ["/a"] });
    expect(statSync(p.config).mode & 0o777).toBe(0o600);
  });

  it("Projektordner: ohne Einträge gehört alles dazu, sonst nur darunter; Doppelte und `/` am Ende fallen weg", () => {
    expect(inProjects("/irgendwo", [])).toBe(true);
    expect(inProjects(null, [])).toBe(false);
    expect(inProjects("/srv/code/app", ["/srv/code"])).toBe(true);
    expect(inProjects("/srv/codex", ["/srv/code"])).toBe(false);
    expect(normalizeRoots(["/srv/code/", "/srv/code", "~/p", 3, ""], "/home/x")).toEqual(["/srv/code", "/home/x/p"]);
  });

  it("Groß-/Kleinschreibung zählt nur auf macOS nicht", () => {
    expect(foldCase("/Srv/Code", "darwin")).toBe("/srv/code");
    expect(foldCase("/Srv/Code", "linux")).toBe("/Srv/Code");
    expect(underRoot("/srv/code/App", "/srv/code")).toBe(true);
    expect(underRoot("/SRV/code/app", "/srv/code")).toBe(process.platform === "darwin");
  });
});

describe("Dienst", () => {
  it("Linux mit systemd: Unit schreiben, neu laden, einschalten, linger; Status und Neustart über systemctl", async () => {
    const { p, env } = tempHome();
    let active = false;
    const f = fakeRunner((bin, args) => {
      if (args.includes("is-active")) return { code: active ? 0 : 3, out: active ? "active\n" : "inactive\n" };
      if (args.includes("restart")) active = true;
      return { code: 0, out: "" };
    });
    const svc = service({ paths: p, platform: "linux", uid: 1000, user: "alex", env, run: f.run, sleep: async () => {}, verifyMs: 1000 });
    const r = await svc.install(SPEC);
    expect(r.mode).toBe("systemd");
    const unit = readFileSync(p.systemdUnit, "utf8");
    expect(unit).toContain(`ExecStart="${SPEC.node}" "--disable-warning=ExperimentalWarning" "${SPEC.entry}" "run"`);
    expect(unit).toContain(`Environment="NYXOS_HOME=${env.NYXOS_HOME}"`);
    expect(f.calls).toEqual(expect.arrayContaining(["systemctl --user daemon-reload", "systemctl --user enable nyxos-bridge.service", "systemctl --user restart nyxos-bridge.service", "loginctl enable-linger alex"]));
    expect(svc.mode()).toBe("systemd");
    expect(svc.running()).toBe(true);
    await svc.restart(SPEC);
    expect(f.calls.filter((c) => c === "systemctl --user restart nyxos-bridge.service")).toHaveLength(2);
    await svc.uninstall();
    expect(existsSync(p.systemdUnit)).toBe(false);
    expect(f.calls).toContain("systemctl --user disable nyxos-bridge.service");
    expect(svc.mode()).toBeNull();
  });

  it("Linux ohne erreichbares systemd (Container, CI): eigener Prozess mit PID-Datei; status/stop/restart folgen ihm", async () => {
    const { p, env } = tempHome();
    const f = fakeRunner(() => ({ code: 1, out: "Failed to connect to bus: No medium found" }));
    const s = sleepSpawner();
    const svc = service({ paths: p, platform: "linux", uid: 1000, env, run: f.run, spawnDetached: s.spawnDetached, isBridgePid: alive, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
    const r = await svc.install(SPEC);
    expect(r.mode).toBe("process");
    expect(r.report.join("\n")).toContain("Failed to connect to bus");
    expect(existsSync(p.systemdUnit)).toBe(false);
    const pid = Number(readFileSync(join(p.support, "bridge.pid"), "utf8"));
    expect(pid).toBe(s.spawned[0]);
    expect(svc.running()).toBe(true);
    await svc.restart(SPEC);
    expect(s.spawned).toHaveLength(2);
    expect(alive(s.spawned[0] as number)).toBe(false);
    expect(svc.running()).toBe(true);
    await svc.stop();
    expect(svc.running()).toBe(false);
    expect(alive(s.spawned[1] as number)).toBe(false);
    expect(existsSync(join(p.support, "bridge.pid"))).toBe(false);
  });

  it("macOS ohne Anmelde-Oberfläche: gui/<uid> fehlt → user/<uid>", async () => {
    const { p, env } = tempHome();
    let loaded = false;
    const f = fakeRunner((_bin, args) => {
      const [cmd, target] = args;
      if (cmd === "print" && target === "gui/501") return { code: 113, out: "Bad request. Could not find domain for port identifier: gui/501" };
      if (cmd === "print" && target === "user/501") return { code: 0, out: "domain = user/501" };
      if (cmd === "print" && target === "user/501/app.nyxos.bridge") return loaded ? { code: 0, out: "state = running\n\tpid = 4242\n" } : { code: 113, out: "not found" };
      if (cmd === "bootstrap") loaded = true;
      if (cmd === "bootout") loaded = false;
      return { code: 0, out: "" };
    });
    const svc = service({ paths: p, platform: "darwin", uid: 501, env, run: f.run, sleep: async () => {} });
    const r = await svc.install(SPEC);
    expect(r.mode).toBe("launchd");
    expect(f.calls).toContain(`launchctl bootstrap user/501 ${p.launchAgent}`);
    expect(f.calls.some((c) => c.startsWith("launchctl bootstrap gui/"))).toBe(false);
    expect(readFileSync(p.launchAgent, "utf8")).toContain("<string>--disable-warning=ExperimentalWarning</string>");
    expect(svc.running()).toBe(true);
    await svc.restart(SPEC);
    expect(f.calls).toContain("launchctl kickstart -k user/501/app.nyxos.bridge");
  });
});

describe("install / uninstall (Wegwerf-Home, Dienst als Attrappe)", () => {
  it("--no-hooks --no-shell: nur Konfiguration, Hook-Skript und Dienst; danach alles wieder weg", async () => {
    const { home, p, env } = tempHome();
    writeFileSync(join(home, ".zshrc"), "# meins\n");
    const s = sleepSpawner();
    const deps = { platform: "freebsd" as NodeJS.Platform, env, spawnDetached: s.spawnDetached, isBridgePid: alive, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))) };
    const r = await install({ serverUrl: "http://127.0.0.1:47800", token: "geheim", tunnel: null, node: SPEC.node, entry: SPEC.entry, projectRoots: [], hooks: false, shell: false, paths: p, service: deps });
    expect(r.mode).toBe("process");
    const cfg = loadConfig(p.config);
    expect(cfg).toMatchObject({ serverUrl: "http://127.0.0.1:47800", token: "geheim", tunnel: null, projectRoots: [], vaultDir: null });
    expect(statSync(p.hook).mode & 0o111).not.toBe(0);
    expect(readFileSync(p.hook, "utf8")).toContain(`exec '${SPEC.node}' --disable-warning=ExperimentalWarning '${SPEC.entry}' "$@"`);
    expect(existsSync(p.claudeSettings)).toBe(false);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# meins\n");
    expect(existsSync(p.tmuxConf)).toBe(true);

    // Eine Neuinstallation (Update) behält, was das Onboarding eingestellt hat.
    saveConfig({ ...cfg, projectRoots: [home] }, p.config);
    await install({ serverUrl: "http://127.0.0.1:47800", token: "neu", tunnel: null, node: SPEC.node, entry: SPEC.entry, projectRoots: [], hooks: false, shell: false, paths: p, service: deps });
    expect(loadConfig(p.config)).toMatchObject({ token: "neu", projectRoots: [home] });

    await uninstall(true, { paths: p, service: deps });
    expect(existsSync(p.support)).toBe(false);
    await new Promise((r) => setTimeout(r, 100)); // beendete Kinder einsammeln lassen
    expect(s.spawned.every((pid) => !alive(pid))).toBe(true);
  });

  it("mit Hooks und Shell: fremde Einträge bleiben, Sicherungskopie; uninstall räumt nur unsere weg", async () => {
    const { home, p, env } = tempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(p.claudeSettings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "fremd" }] }] } }));
    writeFileSync(join(home, ".bashrc"), "# bash\n");
    const s = sleepSpawner();
    const deps = { platform: "freebsd" as NodeJS.Platform, env, spawnDetached: s.spawnDetached, isBridgePid: alive, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))) };
    await install({ serverUrl: "http://127.0.0.1:47800", token: "t", tunnel: null, node: SPEC.node, entry: SPEC.entry, projectRoots: [home], hooks: true, shell: true, paths: p, service: deps });
    expect(hooksPresent(p.claudeSettings)).toBe(true);
    expect(hooksPresent(p.codexHooks)).toBe(true);
    const settings = JSON.parse(readFileSync(p.claudeSettings, "utf8")) as { model: string; hooks: Record<string, unknown[]> };
    expect(settings.model).toBe("opus");
    expect(JSON.stringify(settings.hooks.Stop)).toContain("fremd");
    expect(shellIntegrationPresent(p)).toBe(true);
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain("nyxos.bash");

    await uninstall(false, { paths: p, service: deps });
    expect(hooksPresent(p.claudeSettings)).toBe(false);
    expect(JSON.stringify(JSON.parse(readFileSync(p.claudeSettings, "utf8")))).toContain("fremd");
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe("# bash\n");
    expect(existsSync(p.config)).toBe(true); // ohne --purge bleiben Konfiguration und Puffer
  });
});

describe("Onboarding: setup.state / setup.apply", () => {
  function world() {
    const t = tempHome();
    const cfg: BridgeConfig = { serverUrl: "http://127.0.0.1:47800", token: "t", tunnel: null, projectRoots: [], claudeDir: join(t.home, ".claude"), codexDir: join(t.home, ".codex"), vaultDir: null };
    saveConfig(cfg, t.p.config);
    // Vorschläge: ~/Projects mit einem Repo darin, ~/dev ohne Repo, ein Vault in ~/Documents.
    mkdirSync(join(t.home, "Projects", "shop", ".git"), { recursive: true });
    mkdirSync(join(t.home, "dev", "leer"), { recursive: true });
    mkdirSync(join(t.home, "Documents", "Notizen", ".obsidian"), { recursive: true });
    let changed = 0;
    const svc = new SetupService({ cfg, configPath: t.p.config, paths: t.p, home: t.home, onChanged: () => changed++, self: SPEC });
    return { ...t, svc, changed: () => changed };
  }

  it("Stand: gültig nach Vertrag, mit Vorschlägen (nur Ordner mit Repo, Vaults mit .obsidian)", async () => {
    const w = world();
    const state = await w.svc.state();
    expect(SetupStateSchema.parse(state)).toEqual(state);
    expect(state).toMatchObject({ bridgeOnline: true, projectRoots: [], vaultDir: null, vaultExists: false, hooks: { claude: false, codex: false }, shellIntegration: false });
    expect(state.suggestions.projectRoots).toEqual([join(w.home, "Projects")]);
    expect(state.suggestions.projectRootDetails).toEqual([expect.objectContaining({ path: join(w.home, "Projects"), repos: 1, sessions: 0, recommended: false })]);
    expect(state.suggestions.vaults).toEqual([join(w.home, "Documents", "Notizen")]);
    expect(state.tools.node).toBe(process.version);
    expect(suggestVaults(join(w.home, "gibt-es-nicht"))).toEqual([]);
    // Ordner, die (noch) nicht gelesen werden dürfen, fallen aus der Vault-Suche.
    expect(suggestVaults(w.home, (dir) => !dir.endsWith("Documents"))).toEqual([]);
  });

  it("übernimmt Projektordner und legt einen Vault an; speichert atomar und baut die Brücke neu auf", async () => {
    const w = world();
    const vault = join(w.home, "Vault");
    const state = await w.svc.apply({ projectRoots: [join(w.home, "Projects")], vaultDir: vault, createVault: true });
    expect(state).toMatchObject({ projectRoots: [join(w.home, "Projects")], vaultDir: vault, vaultExists: true });
    expect(existsSync(join(vault, ".obsidian"))).toBe(true);
    expect(loadConfig(w.p.config)).toMatchObject({ projectRoots: [join(w.home, "Projects")], vaultDir: vault });
    // Vorschläge ohne schon eingetragene Ordner.
    expect(state.suggestions.projectRoots).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(w.changed()).toBe(1);
  });

  it("prüft alles, bevor etwas geschrieben wird: fehlende Ordner, `/`, unbekannte Felder", async () => {
    const w = world();
    await expect(w.svc.apply({ projectRoots: [join(w.home, "fehlt")] })).rejects.toMatchObject({ code: "missing_folder" });
    await expect(w.svc.apply({ projectRoots: ["/"] })).rejects.toBeInstanceOf(SetupError);
    await expect(w.svc.apply({ vaultDir: join(w.home, "kein-vault") })).rejects.toMatchObject({ code: "missing_folder" });
    await expect(w.svc.apply({ irgendwas: true })).rejects.toMatchObject({ code: "bad_request" });
    // relative Pfade hingen vom Arbeitsordner des Dienstes ab; `/` ist auch als Vault kein Ziel
    await expect(w.svc.apply({ projectRoots: ["Projects"] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(w.svc.apply({ vaultDir: "Notizen", createVault: true })).rejects.toMatchObject({ code: "bad_request" });
    await expect(w.svc.apply({ vaultDir: "/", createVault: true })).rejects.toMatchObject({ code: "bad_request" });
    expect(loadConfig(w.p.config).projectRoots).toEqual([]);
    expect(w.changed()).toBe(0);
  });

  it("„Alles einrichten“ ohne Hook-Skript: nichts halb übernehmen (Ordner bleiben, wie sie waren)", async () => {
    const t = tempHome();
    const cfg: BridgeConfig = { serverUrl: "http://127.0.0.1:47800", token: "t", tunnel: null, projectRoots: [], claudeDir: join(t.home, ".claude"), codexDir: join(t.home, ".codex"), vaultDir: null };
    saveConfig(cfg, t.p.config);
    mkdirSync(join(t.home, "Projects", "shop", ".git"), { recursive: true });
    let changed = 0;
    const svc = new SetupService({ cfg, configPath: t.p.config, paths: t.p, home: t.home, onChanged: () => changed++ });
    await expect(svc.apply({ projectRoots: [join(t.home, "Projects")], installHooks: true })).rejects.toMatchObject({ code: "failed" });
    expect(loadConfig(t.p.config).projectRoots).toEqual([]);
    expect(hooksPresent(t.p.claudeSettings)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(changed).toBe(0);
  });

  it("Hooks und Shell-Anbindung ein und wieder aus (Hook-Skript entsteht bei Bedarf)", async () => {
    const w = world();
    writeFileSync(join(w.home, ".zshrc"), "# z\n");
    const on = await w.svc.apply({ installHooks: true, shellIntegration: true, projectRoots: [join(w.home, "Projects")] });
    expect(on.hooks).toEqual({ claude: true, codex: true });
    expect(on.shellIntegration).toBe(true);
    expect(readFileSync(w.p.hook, "utf8")).toContain(SPEC.entry);
    expect(readFileSync(join(w.p.support, "shell", "nyxos.zsh"), "utf8")).toContain(join(w.home, "Projects"));
    const off = await w.svc.apply({ installHooks: false, shellIntegration: false });
    expect(off.hooks).toEqual({ claude: false, codex: false });
    expect(off.shellIntegration).toBe(false);
    expect(readFileSync(join(w.home, ".zshrc"), "utf8")).toBe("# z\n");
  });
});
