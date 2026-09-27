// Lokales Stimmen-Paket (`nyxos voice install`): der Server startet den Stimmen-Dienst als Kind-Prozess — nur auf
// 127.0.0.1, mit frischem Schlüssel, ohne die eigenen Geheimnisse in der Umgebung —, startet ihn nach einem Absturz
// neu, beendet ihn beim Herunterfahren und installiert/entfernt über denselben Befehl wie das Terminal.
// Echte Prozesse, aber ein nachgebauter Dienst (Node-Skript statt Python) und ein nachgebauter `nyxos`-Befehl.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NyxVoiceStatus, VoicePackStatus } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { NyxVoiceBackendError } from "../src/nyx/voice-backend.js";
import { readNyxVoiceStatus } from "../src/routes/nyx-voice.js";
import { freeLoopbackPort, LocalVoicePack, voicePackSupported } from "../src/voice/local-pack.js";
import { setup } from "./helpers.js";

const REQUIREMENTS = "sherpa-onnx==1.0\n";
const SHA = createHash("sha256").update(REQUIREMENTS).digest("hex");

/** Nachgebauter Stimmen-Dienst: prüft den Schlüssel, meldet sich bereit, schreibt seine Umgebung in den Arbeitsordner. */
const FAKE_SERVICE = `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync("env.json", JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));
const part = (id) => ({ id, state: "ready", ready: true, bytesDone: 1, bytesTotal: 1, error: null, loadMs: 1, license: "x", label: id, engine: "piper", language: "de" });
const status = { stt: { ...part("parakeet-tdt-0.6b-v3-int8"), model: "parakeet-tdt-0.6b-v3-int8", language: "auto" }, tts: { ...part("de_DE-thorsten-medium"), voice: "de_DE-thorsten-medium", voiceEn: "en_US-ljspeech-high", voices: [part("de_DE-thorsten-medium")] }, threads: 1, uptimeS: 1 };
http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + process.env.NYX_TOKEN) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"unauthorized","message":"x"}'); }
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(status)); }
  res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found","message":"x"}');
}).listen(Number(process.env.NYX_PORT), process.env.NYX_HOST);
process.on("SIGTERM", () => process.exit(0));
`;

/** Nachgebauter `nyxos`-Befehl: `voice install --json` schreibt pack.json (oder meldet einen Fehler), `voice remove` löscht. */
function fakeCli(python: string, sha: string, fail: string | null) {
  return `import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [, , , sub] = process.argv;
const dir = join(process.env.NYXOS_HOME, "voice");
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (sub === "install") {
  line({ step: "check" });
  await wait(30);
  line({ step: "uv", done: 5, total: 10 });
  await wait(150);
  ${fail ? `line({ error: ${JSON.stringify(fail)}, detail: "x" }); process.exit(1);` : ""}
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ format: 1, requirementsSha256: ${JSON.stringify(sha)}, python: ${JSON.stringify(python)}, ffmpeg: "/x/ffmpeg", ffmpegSource: "imageio-ffmpeg" }));
  line({ step: "done" });
} else if (sub === "remove") {
  rmSync(join(dir, "pack.json"), { force: true });
  rmSync(dir, { recursive: true, force: true });
  line({ step: "removed" });
}
`;
}

const JSON_POST = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
const packs: LocalVoicePack[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(packs.splice(0).map((p) => p.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(opts: { installed?: boolean; sha?: string; fail?: string | null; platform?: NodeJS.Platform } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nyxos-voicepack-"));
  dirs.push(root);
  const home = join(root, "home");
  const src = join(root, "src");
  mkdirSync(join(src, "nyx_voice"), { recursive: true });
  writeFileSync(join(src, "nyx_voice", "server.py"), "");
  writeFileSync(join(src, "requirements-local.txt"), REQUIREMENTS);
  const python = join(root, "fake-python");
  writeFileSync(python, FAKE_SERVICE);
  chmodSync(python, 0o755);
  const cli = join(root, "nyxos.mjs");
  writeFileSync(cli, fakeCli(python, SHA, opts.fail ?? null));
  if (opts.installed) {
    mkdirSync(join(home, "voice"), { recursive: true });
    writeFileSync(join(home, "voice", "pack.json"), JSON.stringify({ format: 1, requirementsSha256: opts.sha ?? SHA, python, ffmpeg: "/x/ffmpeg", ffmpegSource: "imageio-ffmpeg" }));
  }
  const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
  const pack = new LocalVoicePack({
    home,
    logsDir: join(home, "logs"),
    voiceSrc: src,
    cli,
    node: process.execPath,
    port: 0,
    log: (msg, extra) => logs.push({ msg, extra }),
    pollMs: 100,
    restartDelaysMs: [50],
    platform: opts.platform ?? "darwin",
    arch: "arm64",
  });
  packs.push(pack);
  return { pack, home, logs, serviceFile: join(home, "voice", "service.json") };
}

async function until<T>(fn: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("Zeitlimit");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const readService = (file: string) => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { pid: number; port: number; token: string }) : null);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("lokales Stimmen-Paket", () => {
  it("startet den Dienst nur auf 127.0.0.1, mit Schlüssel und ohne die Geheimnisse des Servers", async () => {
    process.env.NYXOS_SECRETS_KEY ??= "nie-weitergeben";
    const { pack, home, serviceFile } = world({ installed: true });
    pack.start();
    await until(() => pack.status().state === "running");
    const svc = await until(() => readService(serviceFile));
    expect(statSync(serviceFile).mode & 0o777).toBe(0o600);
    const { env, argv } = JSON.parse(readFileSync(join(home, "voice", "env.json"), "utf8")) as { env: Record<string, string>; argv: string[] };
    expect(argv).toEqual(["-m", "nyx_voice"]);
    expect(env.NYX_HOST).toBe("127.0.0.1");
    expect(env.NYX_TOKEN).toBe(svc.token);
    expect(env.NYX_TOKEN?.length ?? 0).toBeGreaterThanOrEqual(32);
    expect(env.NYX_PARENT_PID).toBe(String(process.pid));
    expect(env.NYX_MODELS_DIR).toBe(join(home, "voice", "models"));
    expect(env.NYX_TTS_VOICES).toBe("de_DE-thorsten-medium,en_US-ljspeech-high");
    expect(env.NYX_FFMPEG).toBe("/x/ffmpeg");
    expect(Object.keys(env).filter((k) => k.startsWith("NYXOS_"))).toEqual([]);
    // ohne Schlüssel kommt niemand an den Dienst, mit dem Paket-Backend schon.
    expect((await fetch(`http://127.0.0.1:${svc.port}/health`)).status).toBe(401);
    expect((await pack.backend.status()).tts.voice).toBe("de_DE-thorsten-medium");
  });

  it("startet nach einem Absturz neu und beendet den Dienst beim Herunterfahren", async () => {
    const { pack, serviceFile, logs } = world({ installed: true });
    pack.start();
    await until(() => pack.status().state === "running");
    const first = await until(() => readService(serviceFile));
    process.kill(first.pid, "SIGKILL");
    const second = await until(() => {
      const s = readService(serviceFile);
      return s && s.pid !== first.pid && pack.status().state === "running" ? s : null;
    });
    expect(second.token).not.toBe(first.token);
    expect(logs.some((l) => l.msg === "stimme-beendet")).toBe(true);
    await pack.stop();
    await until(() => !alive(second.pid));
    expect(existsSync(serviceFile)).toBe(false);
  });

  it("nicht installiert → „nicht eingerichtet“; Installieren zeigt Schritte und startet danach den Dienst", async () => {
    const { pack } = world();
    pack.start();
    expect(pack.status()).toMatchObject({ state: "not_installed", installed: false });
    await expect(pack.backend.status()).rejects.toMatchObject({ code: "not_configured" });
    expect(pack.install()).toEqual({ ok: true });
    expect(pack.install()).toEqual({ ok: false, reason: "busy" });
    const during = await until(() => (pack.status().step === "uv" ? pack.status() : null));
    expect(during).toMatchObject({ state: "installing", progress: 50 });
    await until(() => pack.status().state === "running");
    expect(pack.status()).toMatchObject({ installed: true, ffmpeg: "imageio-ffmpeg", error: null });
  });

  it("fehlgeschlagene Installation → ein einfacher Satz, kein Dienst", async () => {
    const { pack } = world({ fail: "disk" });
    pack.start();
    pack.install();
    const st = await until(() => (pack.status().state === "failed" ? pack.status() : null));
    expect(st.error).toBe("Zu wenig freier Speicher – die Stimme braucht etwa 2 GB.");
    expect(st.installed).toBe(false);
  });

  it("Entfernen beendet den Dienst und löscht das Paket", async () => {
    const { pack, serviceFile, home } = world({ installed: true });
    pack.start();
    await until(() => pack.status().state === "running");
    const svc = await until(() => readService(serviceFile));
    expect(pack.remove()).toEqual({ ok: true });
    expect(pack.status().state).toBe("removing");
    await until(() => pack.status().state === "not_installed");
    await until(() => !alive(svc.pid));
    expect(existsSync(join(home, "voice"))).toBe(false);
  });

  it("ein Update mit anderen Paketen frischt das Paket einmal auf, dann startet der Dienst", async () => {
    const { pack, logs } = world({ installed: true, sha: "veraltet" });
    pack.start();
    await until(() => pack.status().state === "running");
    expect(logs.map((l) => l.msg)).toContain("stimme-auffrischen");
    expect(logs.map((l) => l.msg)).toContain("stimme-installiert");
  });

  it("anderes Betriebssystem → „gibt es hier nicht“, Installieren wird abgelehnt", async () => {
    const { pack } = world({ platform: "win32" });
    expect(pack.status()).toMatchObject({ state: "unsupported" });
    expect(pack.install()).toEqual({ ok: false, reason: "unsupported" });
    expect(voicePackSupported("linux", "x64")).toBe(true);
    expect(voicePackSupported("linux", "arm64")).toBe(true);
    expect(voicePackSupported("linux", "ia32")).toBe(false);
  });

  it("nimmt einen freien Port, wenn der gewünschte belegt ist", async () => {
    const port = await freeLoopbackPort(0);
    const net = await import("node:net");
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
    try {
      const other = await freeLoopbackPort(port);
      expect(other).not.toBe(port);
      expect(other).toBeGreaterThan(0);
    } finally {
      srv.close();
    }
  });
});

describe("Stimme im lokalen Modus – Oberfläche und Wege", () => {
  it("Zustand spricht vom Installieren statt von Docker; „startet“ heißt Modell lädt", async () => {
    const notInstalled = await readNyxVoiceStatus({ status: () => Promise.reject(new NyxVoiceBackendError("not_configured", 503, "x")) } as never, "local");
    expect(notInstalled).toMatchObject({ scope: "local", sentence: "Die Stimme ist noch nicht installiert." });
    expect(notInstalled.fix).toMatch(/Einstellungen → Nyx → Stimme/);
    expect(JSON.stringify(notInstalled)).not.toMatch(/docker/i);
    const starting = await readNyxVoiceStatus({ status: () => Promise.reject(new NyxVoiceBackendError("starting", 503, "x")) } as never, "local");
    expect(starting.stt.state).toBe("loading");
    const offline = await readNyxVoiceStatus({ status: () => Promise.reject(new NyxVoiceBackendError("offline", 503, "x")) } as never, "local");
    expect(offline.fix).toMatch(/nyxos voice status/);
  });

  it("ganz heruntergeladen, aber noch am Entpacken → „wird geladen“ statt ewig „99 %“", async () => {
    const p = (state: string, done: number) => ({ id: "m", state, ready: false, bytesDone: done, bytesTotal: 100, error: null, loadMs: null });
    const raw = (done: number) => ({ stt: { ...p("downloading", done), model: "m", language: "auto" }, tts: { ...p("ready", 100), ready: true, state: "ready", voice: "v", voices: [] }, threads: 1, uptimeS: 1 });
    const half = await readNyxVoiceStatus({ status: async () => raw(50) } as never, "local");
    expect(half.stt).toMatchObject({ state: "downloading", progress: 50 });
    const unpacking = await readNyxVoiceStatus({ status: async () => raw(100) } as never, "local");
    expect(unpacking.stt).toMatchObject({ state: "loading", progress: null });
    expect(unpacking.sentence).toBe("Stimme startet noch – Modell wird geladen …");
  });

  it("GET /api/nyx/voice/pack, Installieren braucht Anmeldung + CSRF, Status mit lokalen Sätzen", async () => {
    const { pack } = world();
    const { app, authHeaders } = await setup({ voicePack: pack, voice: { whisperConfig: { binPath: "/gibt/es/nicht", modelPath: "" } } });
    const st = (await (await app.request("/api/nyx/voice/pack")).json()) as VoicePackStatus;
    expect(st).toMatchObject({ state: "not_installed", installed: false, downloadBytes: 800_000_000 });
    const voice = (await (await app.request("/api/nyx/voice/status")).json()) as NyxVoiceStatus;
    expect(voice).toMatchObject({ scope: "local", sentence: "Die Stimme ist noch nicht installiert." });
    // ohne CSRF-Kopf: abgelehnt, nichts gestartet.
    const noCsrf = await app.request("/api/nyx/voice/pack/install", { method: "POST", headers: { "content-type": "application/json", cookie: authHeaders.cookie, "x-nyxos-csrf": "falsch" }, body: "{}" });
    expect(noCsrf.status).toBe(403);
    expect(pack.status().state).toBe("not_installed");
    const res = await app.request("/api/nyx/voice/pack/install", JSON_POST);
    expect(res.status).toBe(202);
    expect(((await res.json()) as VoicePackStatus).state).toBe("installing");
    const again = await app.request("/api/nyx/voice/pack/install", JSON_POST);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("Die Stimme wird gerade schon installiert.");
    await until(() => pack.status().state === "not_installed" || pack.status().state === "running" || pack.status().state === "starting");
  });

  it("ohne Paket (Server-Modus, Demo) gibt es die Paket-Wege nicht", async () => {
    const { app } = await setup({ voice: { nyx: null, whisperConfig: { binPath: "/gibt/es/nicht", modelPath: "" } } });
    expect((await app.request("/api/nyx/voice/pack")).status).toBe(404);
  });
});
