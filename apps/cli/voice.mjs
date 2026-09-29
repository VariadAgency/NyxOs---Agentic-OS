// Voice pack of a local installation: `nyxos voice install|status|remove`.
//
// The voice (speech-to-text and text-to-speech, German and English) is the same Python service as the
// `nyx-voice` container of server mode (infra/nyx-voice). Locally it gets its own small Python world,
// without system Python, Homebrew, apt or admin rights:
//   runtime/uv/uv           uv (astral-sh/uv, MIT/Apache-2.0), pinned version, SHA-256 checked
//   voice/python/           Python 3.12 that uv downloads (python-build-standalone, checked by uv)
//   voice/venv/             packages of infra/nyx-voice/requirements-local.txt (every file SHA-256 pinned),
//                           incl. imageio-ffmpeg: a ready ffmpeg with Opus, no system ffmpeg needed
//   voice/models/           speech models, downloaded by the service itself on first start (SHA-256 checked)
//   voice/pack.json         written last: "the pack is installed" (the server starts the service when it sees it)
//   voice/service.json      pid, port and key of the running service (written by the server, 0600)
//
// The server runs this same command (`nyxos voice install --json`) for the button in the settings and
// reads one JSON line per step from stdout. Node built-ins only (the release has no node_modules).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const german = /^de/i.test(process.env.NYXOS_LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "");
const say = (de, en) => (german ? de : en);

/** uv release that the voice pack uses. SHA-256 values from the release's `.sha256` files (checked 2026-09-27). */
export const UV_VERSION = "0.12.19";
export const UV_SHA256 = {
  "aarch64-apple-darwin": "a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba",
  "x86_64-apple-darwin": "cb5fa57bafe68fc0fb94b17f06bee0b0b9a7feb94ccbd110445afa0696e39273",
  "x86_64-unknown-linux-gnu": "23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8",
  "aarch64-unknown-linux-gnu": "0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436",
};
export const VOICE_PYTHON = "3.12";
/** Models (~0.7 GB) + Python and packages (~0.2 GB) + room for unpacking. */
export const VOICE_MIN_FREE_BYTES = 2 * 1024 ** 3;
/** Version of pack.json; a newer release that needs a different layout raises it. */
export const VOICE_PACK_FORMAT = 1;

/** Files and folders of the voice pack. `p` = layout() of nyxos.mjs. */
export function voicePaths(p) {
  const dir = join(p.root, "voice");
  return {
    dir,
    python: join(dir, "python"),
    venv: join(dir, "venv"),
    venvPython: join(dir, "venv", "bin", "python"),
    models: join(dir, "models"),
    cache: join(dir, ".cache"),
    pack: join(dir, "pack.json"),
    service: join(dir, "service.json"),
    lock: join(dir, ".install.lock"),
    uvDir: join(p.runtime, "uv"),
    uv: join(p.runtime, "uv", "uv"),
    log: join(p.logs, "voice.log"),
  };
}

/** uv build for this computer, or null (Windows, 32-bit, other CPUs: no voice pack). */
export function uvTarget(os = platform(), arch = process.arch) {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (!cpu) return null;
  if (os === "darwin") return `${cpu}-apple-darwin`;
  if (os === "linux") return `${cpu}-unknown-linux-gnu`;
  return null;
}

/**
 * Where the Python code of the service and its requirements are: `<release>/voice` in a release,
 * `infra/nyx-voice` when NyxOS runs from the source folder. `release` = folder of this command's release.
 */
export function voiceSource(release) {
  for (const dir of [join(release, "voice"), resolve(release, "..", "infra", "nyx-voice")]) {
    const requirements = join(dir, "requirements-local.txt");
    if (existsSync(join(dir, "nyx_voice", "server.py")) && existsSync(requirements)) return { dir, requirements };
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The pack as recorded by the last successful install, or null. */
export function readPack(p) {
  const pack = readJson(voicePaths(p).pack);
  return pack && typeof pack === "object" && pack.format === VOICE_PACK_FORMAT ? pack : null;
}

/** Installed pack whose packages match these requirements (a release with other requirements needs `voice install` again). */
export function packIsCurrent(pack, requirementsText) {
  return !!pack && pack.requirementsSha256 === sha256Text(requirementsText);
}

// ─── errors ──────────────────────────────────────────────────────────────────
/** `code` is what the server shows (its own sentence per code); `message` is for the terminal. */
export class VoiceInstallError extends Error {
  constructor(code, message, detail = "") {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, de, en, detail = "") => {
  throw new VoiceInstallError(code, say(de, en), detail);
};

// ─── helpers ─────────────────────────────────────────────────────────────────
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** Only one install at a time (button and terminal at once): lock file with the pid, a dead holder is taken over. */
function takeLock(file) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const holder = Number(readFileSync(file, "utf8").trim());
      if (holder > 0 && holder !== process.pid && alive(holder)) fail("busy", "Die Stimme wird gerade schon installiert.", "The voice is already being installed.");
      rmSync(file, { force: true });
    }
  }
  fail("busy", "Die Stimme wird gerade schon installiert.", "The voice is already being installed.");
}

export function installLocked(p) {
  const holder = Number(readJson(voicePaths(p).lock) ?? 0);
  return holder > 0 && alive(holder);
}

function freeBytes(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Downloads `url` to `file`, reporting progress; returns the SHA-256 of what was written. */
async function downloadTo(url, file, onProgress) {
  const res = await fetch(url, { headers: { "user-agent": "nyxos-cli" }, redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  const hash = createHash("sha256");
  const out = createWriteStream(file, { mode: 0o600 });
  let done = 0;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      if (Date.now() - last > 250) {
        last = Date.now();
        onProgress?.(done, total);
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  onProgress?.(done, total || done);
  return hash.digest("hex");
}

/** Runs a program, streams nothing, returns {status, stdout, stderr}; never throws. */
function runAsync(cmd, args, opts = {}) {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ status: -1, stdout, stderr: String(e?.message ?? e) });
      return;
    }
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", (e) => done({ status: -1, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => done({ status: code ?? -1, stdout, stderr }));
  });
}

/** Environment for uv: everything stays inside NYXOS_HOME (no ~/.local/share/uv, no ~/.cache/uv, no uv.toml). */
export function uvEnv(v, base = process.env) {
  return {
    ...base,
    UV_PYTHON_INSTALL_DIR: v.python,
    UV_CACHE_DIR: v.cache,
    UV_NO_CONFIG: "1",
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_PYTHON_DOWNLOADS: "automatic",
    UV_NO_PROGRESS: "1",
    VIRTUAL_ENV: "",
    PYTHONHOME: "",
    PYTHONPATH: "",
  };
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────
/** 0.4 s of a quiet 440 Hz tone as raw float32 samples (16 kHz mono). */
function testTone() {
  const n = 6400;
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) buf.writeFloatLE(0.2 * Math.sin((2 * Math.PI * 440 * i) / 16000), i * 4);
  return buf;
}

/**
 * Can this ffmpeg do what the service needs? Write Ogg/Opus (Telegram voice messages) and read what browsers
 * record (WebM/Opus, Ogg/Opus) — tested for real, with the same input guard the service uses (audio.py).
 */
export function ffmpegWorks(bin) {
  if (!bin) return false;
  const tone = testTone();
  const dir = mkdtempSync(join(tmpdir(), "nyxos-ffmpeg-"));
  try {
    for (const [format, file] of [
      ["ogg", "tone.ogg"],
      ["webm", "tone.webm"],
    ]) {
      const enc = spawnSync(bin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-f", format, "pipe:1"], {
        input: tone,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (enc.status !== 0 || !enc.stdout?.length) return false;
      writeFileSync(join(dir, file), enc.stdout);
      const dec = spawnSync(
        bin,
        ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-format_whitelist", "matroska,webm,ogg,mov,mp4,m4a,wav,mp3,flac,aac", "-i", join(dir, file), "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      );
      // Opus adds a little padding; anything close to the 0.4 s we wrote counts.
      if (dec.status !== 0 || (dec.stdout?.length ?? 0) < tone.length / 2) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function systemFfmpeg() {
  const r = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// ─── install ─────────────────────────────────────────────────────────────────
/**
 * Installs (or repairs/updates) the voice pack. `report({step, done?, total?})` is called for progress:
 * steps `check`, `uv`, `python`, `packages`, `ffmpeg`, `done`. Throws VoiceInstallError.
 */
export async function installVoice(p, { release, report = () => {}, os = platform(), arch = process.arch } = {}) {
  const v = voicePaths(p);
  const target = uvTarget(os, arch);
  if (!target) fail("unsupported", "Die Stimme gibt es nur für macOS und Linux auf Intel/AMD oder ARM (64 Bit).", "The voice is only available for macOS and Linux on Intel/AMD or ARM (64-bit).");
  const source = voiceSource(release);
  if (!source) fail("source_missing", "Diese NyxOS-Version enthält die Stimme nicht – bitte zuerst aktualisieren (nyxos update).", "This NyxOS version does not include the voice – please update first (nyxos update).");
  mkdirSync(v.dir, { recursive: true, mode: 0o700 });
  const unlock = takeLock(v.lock);
  try {
    report({ step: "check" });
    if (freeBytes(v.dir) < VOICE_MIN_FREE_BYTES) fail("disk", "Zu wenig freier Speicher – die Stimme braucht etwa 2 GB.", "Not enough free disk space – the voice needs about 2 GB.");

    // 1. uv (pinned version, SHA-256 from this file). Reused when the right version is already there.
    const uvOk = existsSync(v.uv) && spawnSync(v.uv, ["--version"], { encoding: "utf8" }).stdout?.includes(UV_VERSION);
    if (!uvOk) {
      report({ step: "uv", done: 0, total: 0 });
      mkdirSync(v.uvDir, { recursive: true });
      const tmp = mkdtempSync(join(tmpdir(), "nyxos-uv-"));
      try {
        const tarball = join(tmp, `uv-${target}.tar.gz`);
        let got;
        try {
          got = await downloadTo(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.tar.gz`, tarball, (done, total) => report({ step: "uv", done, total }));
        } catch (e) {
          fail("download", "Der Download ist fehlgeschlagen – bitte Internet prüfen und noch einmal versuchen.", "The download failed – please check the internet connection and try again.", String(e?.message ?? e));
        }
        if (got !== UV_SHA256[target]) fail("checksum", "Die heruntergeladene Datei ist nicht in Ordnung (Prüfsumme) – bitte noch einmal versuchen.", "The downloaded file is damaged (checksum) – please try again.", `uv ${got}`);
        const un = spawnSync("tar", ["-xzf", tarball, "-C", tmp]);
        if (un.status !== 0) fail("failed", "uv ließ sich nicht entpacken.", "uv could not be unpacked.", String(un.stderr ?? ""));
        renameSync(join(tmp, `uv-${target}`, "uv"), `${v.uv}.new`);
        chmodSync(`${v.uv}.new`, 0o755);
        renameSync(`${v.uv}.new`, v.uv);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    // 2. Python 3.12 (uv downloads a standalone build into voice/python and checks it) + a fresh venv.
    report({ step: "python" });
    const env = uvEnv(v);
    const venvOk = existsSync(v.venvPython) && spawnSync(v.venvPython, ["-c", "import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)"]).status === 0;
    if (!venvOk) {
      const r = await runAsync(v.uv, ["venv", "--clear", "--python", VOICE_PYTHON, v.venv], { env });
      if (r.status !== 0) fail("python", "Python für die Stimme ließ sich nicht einrichten – bitte Internet prüfen und noch einmal versuchen.", "Python for the voice could not be set up – please check the internet connection and try again.", r.stderr.slice(-600));
    }

    // 3. Packages: exactly the pinned wheels (hashes checked, nothing is compiled on this computer).
    report({ step: "packages" });
    const requirementsText = readFileSync(source.requirements, "utf8");
    const r = await runAsync(v.uv, ["pip", "sync", "--require-hashes", "--no-build", "--python", v.venvPython, source.requirements], { env });
    if (r.status !== 0) fail("packages", "Die Pakete für die Stimme ließen sich nicht installieren – bitte noch einmal versuchen.", "The packages for the voice could not be installed – please try again.", r.stderr.slice(-600));
    const smoke = spawnSync(v.venvPython, ["-c", "import sherpa_onnx, numpy, nyx_voice.server"], { env: { ...process.env, PYTHONPATH: source.dir, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
    if (smoke.status !== 0) fail("packages", "Die Stimme startet auf diesem Computer nicht (Pakete passen nicht).", "The voice does not start on this computer (packages do not fit).", String(smoke.stderr).slice(-600));

    // 4. ffmpeg: the one from imageio-ffmpeg (no admin rights), else a system ffmpeg that can do Opus.
    report({ step: "ffmpeg" });
    const bundled = spawnSync(v.venvPython, ["-c", "import imageio_ffmpeg, sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8" }).stdout?.trim() || null;
    let ffmpeg = null;
    let ffmpegSource = null;
    if (bundled && ffmpegWorks(bundled)) [ffmpeg, ffmpegSource] = [bundled, "imageio-ffmpeg"];
    else {
      const sys = systemFfmpeg();
      if (sys && ffmpegWorks(sys)) [ffmpeg, ffmpegSource] = [sys, "system"];
    }
    if (!ffmpeg) {
      fail(
        "ffmpeg",
        `Es fehlt ein ffmpeg mit Opus. Bitte installieren (${os === "darwin" ? "brew install ffmpeg" : "sudo apt install ffmpeg"}) und dann noch einmal.`,
        `An ffmpeg with Opus is missing. Please install it (${os === "darwin" ? "brew install ffmpeg" : "sudo apt install ffmpeg"}) and try again.`,
      );
    }

    // 5. Done: pack.json last — only a complete install counts. The download cache is not needed any more.
    const pack = {
      format: VOICE_PACK_FORMAT,
      requirementsSha256: sha256Text(requirementsText),
      python: v.venvPython,
      ffmpeg,
      ffmpegSource,
      uv: UV_VERSION,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(`${v.pack}.new`, JSON.stringify(pack, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${v.pack}.new`, v.pack);
    rmSync(v.cache, { recursive: true, force: true });
    report({ step: "done" });
    return pack;
  } finally {
    unlock();
  }
}

// ─── running service ─────────────────────────────────────────────────────────
/** pid/port/key of the service the server started (voice/service.json), or null. */
export function readService(p) {
  const s = readJson(voicePaths(p).service);
  return s && Number.isInteger(s.pid) && Number.isInteger(s.port) && typeof s.token === "string" ? s : null;
}

function isVoiceProcess(pid) {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("nyx_voice");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Stops the voice service if it runs (the server would restart it — so pack.json is removed first). */
export function stopVoiceService(p) {
  const s = readService(p);
  if (!s || !alive(s.pid) || !isVoiceProcess(s.pid)) return;
  try {
    process.kill(s.pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 40 && alive(s.pid); i++) sleepSync(125);
  if (alive(s.pid)) {
    try {
      process.kill(s.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Removes the whole pack: service, models, Python, packages and uv. */
export function removeVoice(p) {
  const v = voicePaths(p);
  if (installLocked(p)) fail("busy", "Die Stimme wird gerade installiert – bitte warten, bis das fertig ist.", "The voice is being installed right now – please wait until it is done.");
  rmSync(v.pack, { force: true });
  stopVoiceService(p);
  rmSync(v.dir, { recursive: true, force: true });
  rmSync(v.uvDir, { recursive: true, force: true });
}

/** State of the pack and of the running service (for `nyxos voice status` and `nyxos doctor`). */
export async function voiceStatus(p, release) {
  const v = voicePaths(p);
  const pack = readPack(p);
  const source = voiceSource(release);
  const current = pack && source ? packIsCurrent(pack, readFileSync(source.requirements, "utf8")) : null;
  const svc = readService(p);
  let health = null;
  if (pack && svc && alive(svc.pid)) {
    try {
      const res = await fetch(`http://127.0.0.1:${svc.port}/health`, { headers: { authorization: `Bearer ${svc.token}` }, signal: AbortSignal.timeout(2500) });
      health = res.ok ? await res.json() : null;
    } catch {
      health = null;
    }
  }
  return {
    installed: !!pack,
    installing: installLocked(p),
    current,
    ffmpeg: pack?.ffmpegSource ?? null,
    running: !!health,
    port: health ? svc.port : null,
    stt: health ? { model: health.stt?.model ?? null, state: health.stt?.state ?? null, bytesDone: health.stt?.bytesDone ?? 0, bytesTotal: health.stt?.bytesTotal ?? 0 } : null,
    tts: health ? { voice: health.tts?.voice ?? null, voiceEn: health.tts?.voiceEn ?? null, state: health.tts?.state ?? null } : null,
    dir: v.dir,
  };
}

// ─── command ─────────────────────────────────────────────────────────────────
const STEP_TEXT = {
  check: () => say("Prüfe den Speicherplatz …", "Checking disk space …"),
  uv: () => say("Lade das Installationsprogramm (uv) …", "Downloading the installer (uv) …"),
  python: () => say("Richte Python ein …", "Setting up Python …"),
  packages: () => say("Installiere die Sprach-Pakete …", "Installing the speech packages …"),
  ffmpeg: () => say("Prüfe die Ton-Umwandlung (ffmpeg) …", "Checking audio conversion (ffmpeg) …"),
  done: () => say("Fertig.", "Done."),
};

/** `nyxos voice install|status|remove [--json]`. */
export async function cmdVoice(p, args, release) {
  const [sub] = args;
  const json = args.includes("--json");
  const line = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  if (sub === "install") {
    let lastStep = null;
    try {
      await installVoice(p, {
        release,
        report: (r) => {
          if (json) return line(r);
          if (r.step !== lastStep) console.log(STEP_TEXT[r.step]?.() ?? r.step);
          lastStep = r.step;
        },
      });
    } catch (e) {
      if (json) {
        line({ error: e instanceof VoiceInstallError ? e.code : "failed", detail: String(e?.detail || e?.message || e).slice(0, 600) });
        return 1;
      }
      throw e;
    }
    if (!json) {
      console.log(say("Die Stimme ist installiert. NyxOS startet sie gleich; beim ersten Start lädt sie ihre Sprachmodelle (etwa 0,7 GB).", "The voice is installed. NyxOS starts it in a moment; on first start it downloads its speech models (about 0.7 GB)."));
    }
    return 0;
  }
  if (sub === "remove" || sub === "uninstall") {
    removeVoice(p);
    if (json) line({ step: "removed" });
    else console.log(say("Die Stimme ist entfernt.", "The voice has been removed."));
    return 0;
  }
  if (sub === "status" || sub === undefined) {
    const s = await voiceStatus(p, release);
    if (json) {
      line(s);
      return 0;
    }
    if (!s.installed) console.log(s.installing ? say("Die Stimme wird gerade installiert.", "The voice is being installed.") : say("Die Stimme ist nicht installiert. Installieren: nyxos voice install", "The voice is not installed. Install it: nyxos voice install"));
    else if (!s.running) console.log(say("Die Stimme ist installiert, läuft aber gerade nicht (sie startet mit NyxOS). Log: nyxos logs", "The voice is installed but not running right now (it starts with NyxOS). Log: nyxos logs"));
    else {
      const loading = s.stt?.state !== "ready" || s.tts?.state !== "ready";
      console.log(loading ? say("Die Stimme startet – sie lädt noch ihre Sprachmodelle.", "The voice is starting – it is still downloading its speech models.") : say("Die Stimme läuft.", "The voice is running."));
      console.log(`  ${say("Erkennung", "Recognition")}: ${s.stt?.model ?? "–"} (${s.stt?.state ?? "–"})`);
      console.log(`  ${say("Deutsch", "German")}: ${s.tts?.voice ?? "–"} · ${say("Englisch", "English")}: ${s.tts?.voiceEn ?? "–"}`);
    }
    if (s.installed && s.current === false) console.log(say("Hinweis: Die Stimme passt nicht mehr zu dieser NyxOS-Version – NyxOS bringt sie beim nächsten Start selbst auf den neuen Stand.", "Note: the voice does not match this NyxOS version – NyxOS updates it by itself on the next start."));
    return s.installed ? 0 : 1;
  }
  console.log(`nyxos voice install   ${say("Stimme installieren (Hören und Sprechen, lokal)", "install the voice (listening and speaking, local)")}
nyxos voice status    ${say("Zustand der Stimme", "state of the voice")}
nyxos voice remove    ${say("Stimme mit allen Modellen entfernen", "remove the voice with all models")}`);
  return sub === "help" || sub === "--help" ? 0 : 2;
}
