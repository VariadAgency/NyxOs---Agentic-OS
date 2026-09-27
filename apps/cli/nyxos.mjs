#!/usr/bin/env node
// `nyxos` — manages a local NyxOS installation on macOS and Linux.
//
// Layout (NYXOS_HOME, default ~/.nyxos):
//   app/versions/<version>/   unpacked release (server, web app, bridge, this command)
//   app/current               symlink to the active version
//   runtime/node/             Node.js used by NyxOS (independent of any system Node)
//   data/                     database, archive, keys (the server creates them)
//   demo/                     data of the demo instance (`nyxos demo`)
//   bridge/                   bridge config, buffer, hook wrapper
//   logs/                     server.log, bridge.log, voice.log
//   voice/                    optional voice pack (`nyxos voice install`, see voice.mjs)
//   bin/nyxos                 this command
//
// Only Node built-ins, so it runs straight from the release without installing packages.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdtempSync, openSync, realpathSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdVoice, removeVoice, voiceStatus } from "./voice.mjs";

export const DEFAULT_PORT = 47800;
export const DEMO_PORT = 47802;
export const SERVER_LABEL = "app.nyxos.server";
const KEEP_VERSIONS = 3;
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

// ─── language ────────────────────────────────────────────────────────────────
const german = /^de/i.test(process.env.NYXOS_LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "");
/** One line in the user's language (German if the system is German, otherwise English). */
export const say = (de, en) => (german ? de : en);

// ─── paths ───────────────────────────────────────────────────────────────────
export function layout(env = process.env, home = homedir()) {
  const root = env.NYXOS_HOME ?? join(home, ".nyxos");
  const appDir = join(root, "app");
  // Settings chosen at install time (e.g. another port) live in nyxos.json; the environment wins.
  const saved = readJson(join(root, "nyxos.json"), {}) ?? {};
  return {
    root,
    home,
    appDir,
    versions: join(appDir, "versions"),
    current: join(appDir, "current"),
    runtime: join(root, "runtime"),
    node: env.NYXOS_NODE ?? join(root, "runtime", "node", "bin", "node"),
    data: join(root, "data"),
    demo: join(root, "demo"),
    logs: join(root, "logs"),
    bin: join(root, "bin"),
    cli: join(root, "bin", "nyxos"),
    port: Number(env.NYXOS_PORT ?? saved.port ?? DEFAULT_PORT),
    /** false = nobody chose a port yet (first install): `setup` may move off a busy default. */
    portChosen: env.NYXOS_PORT != null || saved.port != null,
    os: platform(),
    plist: join(home, "Library", "LaunchAgents", `${SERVER_LABEL}.plist`),
    unit: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user", "nyxos-server.service"),
  };
}

/** Release folder this command belongs to (…/versions/<v>/cli/nyxos.mjs → …/versions/<v>). */
export function ownRelease() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function releaseVersion(dir) {
  return readJson(join(dir, "package.json"), {})?.version ?? null;
}

/** A release version is used as a folder name and in download URLs: only plain semantic versions. */
export function isValidVersion(v) {
  return typeof v === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$/.test(v) && !v.includes("..");
}

// ─── service definitions ─────────────────────────────────────────────────────
function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Environment of the server service. PATH is taken from the installing shell so `claude`/`codex` are found. */
export function serverEnv(p, path = process.env.PATH ?? "") {
  return {
    NYXOS_HOME: p.root,
    NYXOS_CLI: p.cli,
    PORT: String(p.port),
    NYXOS_DEMO_PORT: String(p.port + 2),
    NODE_ENV: "production",
    // Only absolute folders: a relative entry (".", "node_modules/.bin") would run programs from a cloned repo.
    PATH: path.split(":").filter((d) => d.startsWith("/")).join(":"),
    HOME: p.home,
  };
}

export function launchdPlist(p, env = serverEnv(p)) {
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${SERVER_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(p.node)}</string>
      <string>--enable-source-maps</string>
      <string>${xmlEscape(join(p.current, "server", "dist", "local.js"))}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>WorkingDirectory</key><string>${xmlEscape(p.root)}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>StandardOutPath</key><string>${xmlEscape(join(p.logs, "server.log"))}</string>
    <key>StandardErrorPath</key><string>${xmlEscape(join(p.logs, "server.log"))}</string>
  </dict>
</plist>
`;
}

/** systemd expands `%` specifiers in (almost) every setting and `$VAR` in ExecStart: escape both. */
function systemdEscape(v) {
  return String(v).replace(/%/g, "%%");
}

/** One quoted word for Environment=: `\\`, `"` and `%` protected (no `$` expansion there). */
function systemdQuote(v) {
  return `"${systemdEscape(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One quoted word for ExecStart=, which additionally expands `$VAR`. */
function systemdExecWord(v) {
  return systemdQuote(v).replace(/\$/g, "$$$$");
}

export function systemdUnit(p, env = serverEnv(p)) {
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=NyxOS server
After=network.target

[Service]
Type=simple
ExecStart=${systemdExecWord(p.node)} --enable-source-maps ${systemdExecWord(join(p.current, "server", "dist", "local.js"))}
WorkingDirectory=${systemdEscape(p.root)}
${envLines}
Restart=always
RestartSec=5
StandardOutput=append:${systemdEscape(join(p.logs, "server.log"))}
StandardError=append:${systemdEscape(join(p.logs, "server.log"))}

[Install]
WantedBy=default.target
`;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

export function writeServerService(p) {
  mkdirSync(p.logs, { recursive: true });
  if (p.os === "darwin") {
    mkdirSync(dirname(p.plist), { recursive: true });
    writeFileSync(p.plist, launchdPlist(p));
  } else {
    mkdirSync(dirname(p.unit), { recursive: true });
    writeFileSync(p.unit, systemdUnit(p));
    run("systemctl", ["--user", "daemon-reload"]);
  }
}

function rotateLog(file) {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
}

function pidFile(p) {
  return join(p.root, "server.pid");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fallback without a service manager (containers, CI, WSL): a detached process with a pid file. */
function startDetached(p) {
  stopDetached(p);
  const log = join(p.logs, "server.log");
  const fd = openSync(log, "a");
  const child = spawn(p.node, ["--enable-source-maps", join(p.current, "server", "dist", "local.js")], {
    env: { ...process.env, ...serverEnv(p) },
    cwd: p.root,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  writeFileSync(pidFile(p), String(child.pid));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Is `pid` really our server? After a reboot the number in the pid file can belong to any other program. */
function isOurServer(pid) {
  const r = run("ps", ["-o", "command=", "-p", String(pid)]);
  return r.status === 0 && r.stdout.includes(join("server", "dist", "local.js"));
}

function stopDetached(p) {
  const pid = Number(readFileSafe(pidFile(p)));
  if (pid > 0 && alive(pid) && isOurServer(pid)) {
    process.kill(pid, "SIGTERM");
    // Wait until the port is free again, otherwise the next start fails with EADDRINUSE.
    for (let i = 0; i < 40 && alive(pid); i++) sleepSync(250);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(pidFile(p), { force: true });
}

function readFileSafe(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** Starts (or restarts) the server service. Returns the service manager that runs it. */
export function startServer(p) {
  rotateLog(join(p.logs, "server.log"));
  if (p.os === "darwin") {
    for (const domain of [`gui/${uid()}`, `user/${uid()}`]) {
      run("launchctl", ["bootout", `${domain}/${SERVER_LABEL}`]);
      if (run("launchctl", ["bootstrap", domain, p.plist]).status === 0) {
        stopDetached(p);
        return "launchd";
      }
    }
  } else if (run("systemctl", ["--user", "enable", "nyxos-server.service"]).status === 0) {
    const r = run("systemctl", ["--user", "restart", "nyxos-server.service"]);
    if (r.status === 0) {
      stopDetached(p);
      // Keep running after logout (servers without desktop session); harmless if not allowed.
      run("loginctl", ["enable-linger", process.env.USER ?? ""]);
      return "systemd";
    }
  }
  startDetached(p);
  return "process";
}

export function stopServer(p) {
  if (p.os === "darwin") {
    run("launchctl", ["bootout", `gui/${uid()}/${SERVER_LABEL}`]);
    run("launchctl", ["bootout", `user/${uid()}/${SERVER_LABEL}`]);
  } else run("systemctl", ["--user", "stop", "nyxos-server.service"]);
  stopDetached(p);
}

function removeServerService(p) {
  stopServer(p);
  if (p.os === "darwin") rmSync(p.plist, { force: true });
  else {
    run("systemctl", ["--user", "disable", "nyxos-server.service"]);
    rmSync(p.unit, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  }
}

// ─── bridge ──────────────────────────────────────────────────────────────────
function bridgeEntry(p) {
  return join(p.current, "bridge", "bridge.js");
}

function bridge(p, args, opts = {}) {
  return run(p.node, [bridgeEntry(p), ...args], { env: { ...process.env, NYXOS_HOME: p.root }, ...opts });
}

/**
 * (Re)installs the bridge service. Hooks and shell integration are switched on in the onboarding, never here:
 * `--no-hooks`/`--no-shell` leave existing entries untouched (the hook script itself is always rewritten).
 */
export function installBridge(p) {
  const args = ["install", "--server-url", `http://127.0.0.1:${p.port}`, "--token-file", join(p.data, "bridge-token"), "--node", p.node, "--no-hooks", "--no-shell"];
  const r = bridge(p, args);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim() || "bridge install failed");
}

// ─── server access ───────────────────────────────────────────────────────────
async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function health(port, timeoutMs = 3000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

/**
 * Does something already listen on 127.0.0.1:`port`? Two checks, because a program listening on all interfaces
 * does not always block a bind to 127.0.0.1 (macOS), and a bind can fail without anyone answering (Linux).
 */
export async function portInUse(port, host = "127.0.0.1") {
  const answers = await new Promise((done) => {
    const socket = createConnection({ port, host });
    socket.setTimeout(1000, () => {
      socket.destroy();
      done(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
  if (answers) return true;
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(true));
    server.listen({ port, host, exclusive: true }, () => server.close(() => done(false)));
  });
}

/**
 * Port for a fresh installation: `preferred` unless another program uses it (or the demo port next to it),
 * otherwise the next free one in steps of ten (47810, 47820, …). A NyxOS already running there keeps its port.
 */
export async function pickPort(preferred = DEFAULT_PORT, { inUse = portInUse, isNyxos = async (port) => (await runningVersion(port)) !== null } = {}) {
  if (await isNyxos(preferred)) return preferred;
  for (let port = preferred; port < preferred + 200; port += 10) {
    if (!(await inUse(port)) && !(await inUse(port + 2))) return port;
  }
  throw new Error(say(`Kein freier Port ab ${preferred} gefunden. Wähle einen mit NYXOS_PORT=…`, `No free port found from ${preferred} on. Pick one with NYXOS_PORT=…`));
}

export async function waitForHealth(port, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await health(port)).ok) return true;
    await sleep(500);
  }
  return false;
}

/** Version the server on `port` reports (public `GET /api/app/info`), or null. */
export async function runningVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/app/info`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json())?.version ?? null) : null;
  } catch {
    return null;
  }
}

/** Healthy AND the expected version — an old process that is still shutting down does not count. */
export async function waitForVersion(port, version, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await health(port)).ok && (await runningVersion(port)) === version) return true;
    await sleep(500);
  }
  return false;
}

async function waitForFile(file, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(file)) return true;
    await sleep(250);
  }
  return false;
}

/** One-time sign-in link: asks the server with the machine token (readable only by this user). */
export async function loginUrl(port, dataDir, next = "/") {
  const token = readFileSync(join(dataDir, "bridge-token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${port}/local/login-code`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`login-code ${res.status}`);
  const { code } = await res.json();
  return `http://127.0.0.1:${port}/auth/local?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`;
}

function hasDisplay() {
  return platform() === "darwin" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

function openBrowser(url) {
  const opener = platform() === "darwin" ? "open" : "xdg-open";
  if (!hasDisplay() || process.env.NYXOS_NO_BROWSER === "1") return false;
  const r = run(opener, [url], { stdio: "ignore" });
  return r.status === 0;
}

// ─── updates ─────────────────────────────────────────────────────────────────
export function repoName(dir) {
  const fromEnv = process.env.NYXOS_REPO;
  if (fromEnv) return fromEnv;
  return readJson(join(dir, "package.json"), {})?.nyxos?.repo ?? "OWNER/nyxos";
}

/** Only a real "owner/name" may be used in download URLs — never the placeholder of an unpublished checkout. */
export function checkRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.startsWith("OWNER/")) {
    throw new Error(say(`Kein gültiges Update-Repository (${repo}) — NYXOS_REPO setzen.`, `No valid update repository (${repo}) — set NYXOS_REPO.`));
  }
  return repo;
}

/** "install", "current" (already installed) or "older" (never downgrade unless the version was asked for). */
export function updateDecision(installed, version, explicit) {
  if (installed === version) return "current";
  if (explicit || !installed || !isValidVersion(installed)) return "install";
  const nums = (v) => v.split(/[-+]/)[0].split(".").map(Number);
  const [a, b] = [nums(version), nums(installed)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? "install" : "older";
  return "install";
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(url, file) {
  const res = await fetch(url, { headers: { "user-agent": "nyxos-cli" }, redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

export async function latestRelease(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "nyxos-cli" } });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const body = await res.json();
  return String(body.tag_name ?? "").replace(/^v/, "");
}

/** Unpacks a release tarball into versions/<version> and returns that folder. */
export function unpackRelease(p, tarball) {
  mkdirSync(p.versions, { recursive: true });
  const tmp = mkdtempSync(join(p.versions, ".unpack-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", tmp]);
    const inner = readdirSync(tmp).find((n) => n.startsWith("nyxos-"));
    if (!inner) throw new Error("release archive has no nyxos-* folder");
    const version = releaseVersion(join(tmp, inner));
    if (!version) throw new Error("release has no version");
    // The version becomes a folder name that is deleted and replaced below: never let it leave versions/.
    if (!isValidVersion(version)) throw new Error(`release has an invalid version: ${JSON.stringify(version).slice(0, 80)}`);
    const target = join(p.versions, version);
    rmSync(target, { recursive: true, force: true });
    renameSync(join(tmp, inner), target);
    return target;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Folder of the active release (resolved `current` link), or null. */
export function activeRelease(p) {
  try {
    return realpathSync(p.current);
  } catch {
    return null;
  }
}

export function activate(p, target) {
  const tmpLink = `${p.current}.new`;
  rmSync(tmpLink, { force: true });
  symlinkSync(target, tmpLink);
  renameSync(tmpLink, p.current);
  mkdirSync(p.bin, { recursive: true });
  const cliLink = p.cli;
  try {
    unlinkSync(cliLink);
  } catch {
    // not there yet
  }
  symlinkSync(join(p.current, "bin", "nyxos"), cliLink);
}

function pruneVersions(p) {
  const active = existsSync(p.current) ? readlinkSync(p.current) : null;
  const dirs = readdirSync(p.versions)
    .filter((n) => !n.startsWith("."))
    .map((n) => join(p.versions, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const dir of dirs.slice(KEEP_VERSIONS)) if (resolve(dir) !== (active && resolve(active))) rmSync(dir, { recursive: true, force: true });
}

// ─── commands ────────────────────────────────────────────────────────────────
/** Adds ~/.nyxos/bin to PATH in the shell start files (marked block, removed again by uninstall). */
export function addToShellPath(p) {
  // Inside "…" the shell still expands $, ` and \ — escape them so an unusual NYXOS_HOME stays a plain path.
  const bin = p.bin.replace(/[\\"$`]/g, (c) => `\\${c}`);
  const block = `${RC_MARK}\nexport PATH="${bin}:$PATH"\n${RC_END}\n`;
  const files = [".zshrc", ".bashrc"].map((f) => join(p.home, f));
  // macOS starts zsh by default; make sure its start file exists so the command is found right away.
  if (p.os === "darwin" && !existsSync(files[0])) writeFileSync(files[0], "");
  if (p.os !== "darwin" && !existsSync(files[1]) && !existsSync(files[0])) writeFileSync(files[1], "");
  for (const rc of files) {
    if (!existsSync(rc)) continue;
    const text = readFileSync(rc, "utf8");
    if (!text.includes(RC_MARK)) writeFileSync(rc, `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${block}`);
  }
  // Many Linux systems already have ~/.local/bin on PATH: link there too, so no new shell is needed.
  const localBin = join(p.home, ".local", "bin");
  if ((process.env.PATH ?? "").split(":").includes(localBin)) {
    mkdirSync(localBin, { recursive: true });
    const link = join(localBin, "nyxos");
    try {
      unlinkSync(link);
    } catch {
      // not there
    }
    symlinkSync(p.cli, link);
  }
}

async function cmdInstall(p, args) {
  const from = args[args.indexOf("--from") + 1];
  if (!args.includes("--from") || !from) throw new Error("install needs --from <nyxos-x.y.z.tar.gz>");
  const target = unpackRelease(p, resolve(from));
  activate(p, target);
  addToShellPath(p);
  await cmdSetup(p, args.filter((a) => a !== "--from" && a !== from));
  return 0;
}

async function cmdSetup(p, args) {
  const release = args.includes("--here") ? ownRelease() : null;
  if (release) activate(p, release);
  mkdirSync(p.data, { recursive: true, mode: 0o700 });
  if (!p.portChosen) {
    const port = await pickPort(p.port);
    if (port !== p.port) console.log(say(`Port ${p.port} ist schon belegt – NyxOS nimmt ${port}.`, `Port ${p.port} is already in use – NyxOS uses ${port}.`));
    p.port = port;
  }
  writeFileSync(join(p.root, "nyxos.json"), JSON.stringify({ port: p.port }, null, 2) + "\n");
  writeServerService(p);
  startServer(p);
  console.log(say("Starte NyxOS …", "Starting NyxOS …"));
  if (!(await waitForHealth(p.port))) throw new Error(say(`Der Server antwortet nicht. Log: ${join(p.logs, "server.log")}`, `The server does not respond. Log: ${join(p.logs, "server.log")}`));
  if (!(await waitForFile(join(p.data, "bridge-token")))) throw new Error("bridge-token missing");
  installBridge(p);
  console.log(say("NyxOS läuft.", "NyxOS is running."));
  if (!args.includes("--no-open")) await cmdOpen(p, []);
}

async function cmdOpen(p, args) {
  const next = args.find((a) => a.startsWith("/")) ?? "/";
  const url = await loginUrl(p.port, p.data, next);
  if (!openBrowser(url)) {
    console.log(say("Öffne diesen Link im Browser (2 Minuten gültig):", "Open this link in your browser (valid for 2 minutes):"));
    console.log(`  ${url}`);
    // Only on a machine without a screen (a server over SSH): there the browser runs on another computer.
    if (!hasDisplay() || process.env.SSH_CONNECTION) {
      console.log(say(`Auf einem anderen Rechner vorher: ssh -L ${p.port}:127.0.0.1:${p.port} <dieser-rechner>`, `From another computer first run: ssh -L ${p.port}:127.0.0.1:${p.port} <this-computer>`));
    }
  }
}

async function cmdStatus(p) {
  const h = await health(p.port);
  const b = bridge(p, ["status"]);
  const status = {
    version: existsSync(p.current) ? releaseVersion(p.current) : null,
    server: h.ok ? "ok" : `down (${h.error ?? "unhealthy"})`,
    url: `http://127.0.0.1:${p.port}`,
    bridge: b.status === 0 ? (readJsonText(b.stdout) ?? b.stdout.trim()) : "down",
    data: p.data,
  };
  console.log(JSON.stringify(status, null, 2));
  return h.ok ? 0 : 1;
}

function readJsonText(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function cmdRestart(p) {
  startServer(p);
  bridge(p, ["restart"]);
  const ok = await waitForHealth(p.port, 60_000);
  console.log(ok ? say("NyxOS läuft wieder.", "NyxOS is running again.") : say("Server startet nicht, siehe `nyxos logs`.", "The server didn't start – see `nyxos logs`."));
  return ok ? 0 : 1;
}

function cmdLogs(p, args) {
  const files = [join(p.logs, "server.log"), join(p.logs, "bridge.log"), join(p.logs, "update.log"), join(p.logs, "voice.log")].filter(existsSync);
  if (files.length === 0) {
    console.log(say("Noch keine Logs.", "No logs yet."));
    return 0;
  }
  const r = spawnSync("tail", [args.includes("-f") ? "-f" : "-n", ...(args.includes("-f") ? [] : ["100"]), ...files], { stdio: "inherit" });
  return r.status ?? 0;
}

function which(cmd) {
  const r = run(platform() === "win32" ? "where" : "sh", ["-c", `command -v ${cmd}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

async function cmdDoctor(p) {
  const checks = [];
  const add = (name, ok, hint) => checks.push({ name, ok, hint: ok ? "" : hint });
  add("Node.js", existsSync(p.node), say("Neu installieren: install.sh erneut ausführen", "To reinstall, run install.sh again"));
  add("tmux", !!which("tmux"), p.os === "darwin" ? "brew install tmux" : "sudo apt install tmux  |  sudo dnf install tmux");
  add("git", !!which("git"), p.os === "darwin" ? "xcode-select --install" : "sudo apt install git");
  add("Claude Code (claude)", !!which("claude"), say("Optional: curl -fsSL https://claude.ai/install.sh | bash, dann `claude` einmal starten und anmelden", "Optional: curl -fsSL https://claude.ai/install.sh | bash, then run `claude` once and sign in"));
  add("Codex (codex)", !!which("codex"), say("Optional: npm install -g @openai/codex", "Optional: npm install -g @openai/codex"));
  const h = await health(p.port);
  add(say("Server", "Server"), h.ok, "nyxos restart  ·  nyxos logs");
  const b = bridge(p, ["status"]);
  add(say("Brücke", "Bridge"), b.status === 0, "nyxos restart");
  // The voice is optional: not installed = only a hint; installed but not running = a real problem.
  const voice = await voiceStatus(p, ownRelease());
  if (voice.installed) add(say("Stimme", "Voice"), voice.running, say("nyxos voice status  ·  nyxos logs  ·  neu einrichten: nyxos voice install", "nyxos voice status  ·  nyxos logs  ·  set up again: nyxos voice install"));
  else add(say("Stimme (optional)", "Voice (optional)"), false, say("Hören und Sprechen, lokal: nyxos voice install (etwa 1 GB)", "Listening and speaking, local: nyxos voice install (about 1 GB)"));
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `  →  ${c.hint}`}`);
  return checks.every((c) => c.ok || c.name.includes("(")) ? 0 : 1;
}

/** Downloads release `version` from GitHub into a private temp folder and checks it against SHA256SUMS. */
async function downloadRelease(repo, version, dir) {
  const name = `nyxos-${version}.tar.gz`;
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  const tarball = join(dir, name);
  await download(`${base}/${name}`, tarball);
  await download(`${base}/SHA256SUMS`, join(dir, "SHA256SUMS"));
  const expected = readFileSync(join(dir, "SHA256SUMS"), "utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, f]) => f === name)?.[0];
  if (!expected || expected !== sha256(tarball)) throw new Error(say("Prüfsumme stimmt nicht — Update abgebrochen.", "Checksum mismatch — update aborted."));
  return tarball;
}

async function cmdUpdate(p, args) {
  const from = args[args.indexOf("--from") + 1];
  const wanted = args.includes("--version") ? args[args.indexOf("--version") + 1] : null;
  if (wanted !== null && !isValidVersion(wanted)) throw new Error(say(`Ungültige Version: ${wanted}`, `Invalid version: ${wanted}`));
  const repo = repoName(existsSync(p.current) ? p.current : ownRelease());
  if (!(args.includes("--from") && from)) checkRepo(repo);
  // Private folder (0700, random name): nobody else on this computer can swap the file after the check.
  const dir = mkdtempSync(join(tmpdir(), "nyxos-update-"));
  try {
    let tarball;
    if (args.includes("--from") && from) {
      tarball = resolve(from);
    } else {
      const version = wanted ?? (await latestRelease(repo));
      if (!isValidVersion(version)) throw new Error(say(`GitHub meldet keine gültige Version (${version})`, `GitHub reports no valid version (${version})`));
      const installed = existsSync(p.current) ? releaseVersion(p.current) : null;
      // The running version is never unpacked over itself (its folder is in use), and "latest" pointing to an
      // older release never downgrades (only an explicit --version does).
      const decision = updateDecision(installed, version, wanted !== null);
      if (decision !== "install") {
        console.log(
          decision === "current"
            ? say(`NyxOS ${version} ist schon installiert.`, `NyxOS ${version} is already installed.`)
            : say(`Installiert ist ${installed}, neuer als ${version} — nichts zu tun.`, `${installed} is installed, newer than ${version} — nothing to do.`),
        );
        return 0;
      }
      if (!args.includes("--yes") && process.stdin.isTTY) console.log(say(`Aktualisiere auf ${version} …`, `Updating to ${version} …`));
      tarball = await downloadRelease(repo, version, dir);
    }
    const previous = activeRelease(p);
    const target = unpackRelease(p, tarball);
    const version = releaseVersion(target);
    activate(p, target);
    writeServerService(p);
    startServer(p);
    if (!(await waitForVersion(p.port, version, 90_000))) {
      // Never leave a broken installation behind: switch back to the version that ran before.
      if (previous && previous !== target && existsSync(previous)) {
        const old = releaseVersion(previous);
        activate(p, previous);
        writeServerService(p);
        startServer(p);
        const back = await waitForVersion(p.port, old, 90_000);
        throw new Error(
          back
            ? say(`NyxOS ${version} startet nicht — zurück auf ${old}. Log: nyxos logs`, `NyxOS ${version} does not start — switched back to ${old}. Log: nyxos logs`)
            : say(`NyxOS ${version} startet nicht, und ${old} auch nicht mehr. Log: nyxos logs`, `NyxOS ${version} does not start, and neither does ${old} any more. Log: nyxos logs`),
        );
      }
      throw new Error(say(`NyxOS ${version} startet nicht. Log: nyxos logs`, `NyxOS ${version} does not start. Log: nyxos logs`));
    }
    installBridge(p);
    pruneVersions(p);
    console.log(say(`NyxOS ${version} ist installiert.`, `NyxOS ${version} is installed.`));
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function cmdDemo(p, args) {
  if (!args.includes("--keep")) rmSync(p.demo, { recursive: true, force: true });
  mkdirSync(p.demo, { recursive: true, mode: 0o700 });
  const port = process.env.NYXOS_DEMO_PORT ? Number(process.env.NYXOS_DEMO_PORT) : await pickPort(DEMO_PORT, { isNyxos: async () => false });
  const child = spawn(p.node, [join(p.current, "server", "dist", "local.js")], {
    env: { ...process.env, NYXOS_HOME: p.root, NYXOS_DATA_DIR: p.demo, NYXOS_DEMO: "1", PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (!(await waitForHealth(port, 60_000))) {
    stop();
    throw new Error(say("Demo startet nicht.", "The demo didn't start."));
  }
  await waitForFile(join(p.demo, "bridge-token"));
  const url = await loginUrl(port, p.demo, "/");
  console.log(say("NyxOS-Demo mit erfundenen Daten läuft. Beenden mit Strg+C.", "The NyxOS demo with made-up data is running. Press Ctrl+C to stop."));
  if (!openBrowser(url)) console.log(`  ${url}`);
  await new Promise((r) => child.on("exit", r));
  return 0;
}

const RC_MARK = "# >>> nyxos >>>";
const RC_END = "# <<< nyxos <<<";

export function stripRcBlock(text) {
  const re = new RegExp(`\\n?${RC_MARK}[\\s\\S]*?${RC_END}\\n?`, "g");
  return text.replace(re, "\n");
}

/**
 * Uninstall deletes app/, runtime/, bin/ (and with --purge the whole NYXOS_HOME): refuse when NYXOS_HOME is
 * not a folder of its own (e.g. set to the home folder by mistake, where ~/bin would be deleted).
 */
export function safeToRemove(p) {
  const root = resolve(p.root);
  const home = resolve(p.home);
  if (root === "/" || root === home || home.startsWith(`${root}/`)) return false;
  // Proof of an installation: files only NyxOS creates (a generic data/ folder is not enough).
  return existsSync(join(root, "nyxos.json")) || existsSync(p.current);
}

async function cmdUninstall(p, args) {
  const purge = args.includes("--purge");
  if (!safeToRemove(p)) {
    throw new Error(say(`${p.root} sieht nicht nach einer NyxOS-Installation aus (NYXOS_HOME prüfen) — nichts gelöscht.`, `${p.root} does not look like a NyxOS installation (check NYXOS_HOME) — nothing removed.`));
  }
  bridge(p, ["uninstall", ...(purge ? ["--purge"] : [])]);
  removeServerService(p);
  // The voice pack (models, Python, packages) is program, not user data: it always goes.
  try {
    removeVoice(p);
  } catch (e) {
    console.error(say(`Stimme nicht entfernt: ${e?.message ?? e}`, `Voice not removed: ${e?.message ?? e}`));
  }
  for (const rc of [".zshrc", ".bashrc", ".profile"].map((f) => join(p.home, f))) {
    if (!existsSync(rc)) continue;
    const text = readFileSync(rc, "utf8");
    if (text.includes(RC_MARK)) writeFileSync(rc, stripRcBlock(text));
  }
  for (const link of [join(p.home, ".local", "bin", "nyxos")]) {
    try {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link).startsWith(p.root)) unlinkSync(link);
    } catch {
      // not there
    }
  }
  rmSync(p.appDir, { recursive: true, force: true });
  rmSync(p.runtime, { recursive: true, force: true });
  rmSync(p.bin, { recursive: true, force: true });
  if (purge) rmSync(p.root, { recursive: true, force: true });
  console.log(
    purge
      ? say("NyxOS ist vollständig entfernt.", "NyxOS has been removed completely.")
      : say(`NyxOS ist entfernt. Deine Daten liegen weiter in ${p.data} (löschen: nyxos uninstall --purge vor dem Entfernen, oder den Ordner von Hand).`, `NyxOS has been removed. Your data is still in ${p.data} (delete that folder to remove it).`),
  );
  return 0;
}

function usage() {
  console.log(`nyxos — ${say("NyxOS verwalten", "manage NyxOS")}

  nyxos open        ${say("NyxOS im Browser öffnen (angemeldet)", "open NyxOS in the browser (signed in)")}
  nyxos status      ${say("Zustand von Server und Brücke", "show server and bridge status")}
  nyxos restart     ${say("Server und Brücke neu starten", "restart server and bridge")}
  nyxos logs [-f]   ${say("Logs zeigen", "show logs")}
  nyxos doctor      ${say("Voraussetzungen prüfen", "check requirements")}
  nyxos update      ${say("auf die neueste Version aktualisieren", "update to the latest version")}
  nyxos demo        ${say("Demo mit erfundenen Daten starten", "start a demo with made-up data")}
  nyxos voice       ${say("Stimme: install | status | remove (Hören und Sprechen, lokal)", "voice: install | status | remove (listening and speaking, local)")}
  nyxos uninstall   ${say("NyxOS entfernen (--purge löscht auch die Daten)", "remove NyxOS (--purge also deletes the data)")}
  nyxos version     ${say("Version anzeigen", "show the version")}`);
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...args] = argv;
  const p = layout();
  switch (cmd) {
    case "install":
      return cmdInstall(p, args);
    case "setup":
      await cmdSetup(p, args);
      return 0;
    case "open":
      await cmdOpen(p, args);
      return 0;
    case "status":
      return cmdStatus(p);
    case "start":
    case "restart":
      return cmdRestart(p);
    case "stop":
      stopServer(p);
      bridge(p, ["stop"]);
      return 0;
    case "logs":
      return cmdLogs(p, args);
    case "doctor":
      return cmdDoctor(p);
    case "update":
      try {
        return await cmdUpdate(p, args);
      } catch (e) {
        // Started from the web app, nobody sees this terminal: keep the reason for `nyxos logs`.
        try {
          mkdirSync(p.logs, { recursive: true });
          appendFileSync(join(p.logs, "update.log"), `${new Date().toISOString()} ${e?.message ?? e}\n`);
        } catch {
          // logging is best effort
        }
        throw e;
      }
    case "demo":
      return cmdDemo(p, args);
    case "voice":
      return cmdVoice(p, args, ownRelease());
    case "uninstall":
      return cmdUninstall(p, args);
    case "version":
    case "--version":
    case "-v":
      console.log(releaseVersion(existsSync(p.current) ? p.current : ownRelease()) ?? "unknown");
      return 0;
    default:
      usage();
      return cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 2 : 0;
  }
}

/** True when this file is the program being run (also when started through the `current` symlink). */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then(
    (code) => process.exit(code ?? 0),
    (e) => {
      console.error(`nyxos: ${e?.message ?? e}`);
      process.exit(1);
    },
  );
}
