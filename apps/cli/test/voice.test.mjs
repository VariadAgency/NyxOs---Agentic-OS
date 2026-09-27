// `nyxos voice install|status|remove`: paths, pinned downloads, where the Python source is, the ffmpeg check,
// and that removing the pack leaves nothing behind. The real install (network, ~1 GB) is not run here.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { layout } from "../nyxos.mjs";
import { ffmpegWorks, installVoice, packIsCurrent, removeVoice, sha256Text, UV_SHA256, UV_VERSION, uvEnv, uvTarget, voicePaths, voiceSource, voiceStatus } from "../voice.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

function tempHome() {
  const root = mkdtempSync(join(tmpdir(), "nyxos-voice-"));
  return layout({ NYXOS_HOME: join(root, ".nyxos") }, root);
}

describe("nyxos voice", () => {
  it("keeps the whole pack inside NYXOS_HOME", () => {
    const p = layout({ NYXOS_HOME: "/tmp/x" }, "/home/alex");
    const v = voicePaths(p);
    expect(v.dir).toBe("/tmp/x/voice");
    expect(v.venvPython).toBe("/tmp/x/voice/venv/bin/python");
    expect(v.models).toBe("/tmp/x/voice/models");
    expect(v.uv).toBe("/tmp/x/runtime/uv/uv");
    expect(v.log).toBe("/tmp/x/logs/voice.log");
    // uv never writes to ~/.local/share/uv, ~/.cache/uv or reads a uv.toml of the user.
    const env = uvEnv(v, { PATH: "/usr/bin" });
    expect(env).toMatchObject({ UV_PYTHON_INSTALL_DIR: "/tmp/x/voice/python", UV_CACHE_DIR: "/tmp/x/voice/.cache", UV_NO_CONFIG: "1", UV_PYTHON_PREFERENCE: "only-managed" });
  });

  it("downloads a pinned uv for macOS and Linux (x64, arm64) and nothing else", () => {
    expect(uvTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(uvTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(uvTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(uvTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(uvTarget("win32", "x64")).toBeNull();
    expect(uvTarget("linux", "ia32")).toBeNull();
    expect(UV_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) expect(UV_SHA256[target]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds the Python service in the source folder and in a release", () => {
    // from source: the command lives in apps/cli, its "release" folder is apps/
    const fromSource = voiceSource(join(repo, "apps"));
    expect(fromSource?.dir).toBe(join(repo, "infra", "nyx-voice"));
    // a release has <release>/voice/{nyx_voice,requirements-local.txt}
    const rel = mkdtempSync(join(tmpdir(), "nyxos-rel-"));
    mkdirSync(join(rel, "voice", "nyx_voice"), { recursive: true });
    writeFileSync(join(rel, "voice", "nyx_voice", "server.py"), "");
    writeFileSync(join(rel, "voice", "requirements-local.txt"), "x==1\n");
    expect(voiceSource(rel)?.dir).toBe(join(rel, "voice"));
    expect(voiceSource(mkdtempSync(join(tmpdir(), "nyxos-empty-")))).toBeNull();
  });

  it("installs only pinned wheels with SHA-256, with ffmpeg and without PyTorch", () => {
    const text = readFileSync(join(repo, "infra", "nyx-voice", "requirements-local.txt"), "utf8");
    const reqs = text.split("\n").filter((l) => /^[a-z]/i.test(l));
    expect(reqs.length).toBeGreaterThan(3);
    for (const r of reqs) expect(r).toMatch(/^[A-Za-z0-9_.-]+==[0-9][^ ]* \\$/);
    expect(text.split("\n").filter((l) => l.trim().startsWith("--hash=sha256:")).length).toBeGreaterThan(reqs.length);
    expect(reqs.map((r) => r.split("==")[0].toLowerCase())).toEqual(expect.arrayContaining(["sherpa-onnx", "numpy", "imageio-ffmpeg"]));
    expect(text).not.toMatch(/^torch|^pocket-tts/m);
    // the Docker requirements are a subset (same versions): server and local mode run the same code
    const docker = readFileSync(join(repo, "infra", "nyx-voice", "requirements.txt"), "utf8").split("\n").filter((l) => /^[a-z]/i.test(l));
    for (const d of docker) expect(reqs.some((r) => r.toLowerCase().replace("_", "-").startsWith(d.toLowerCase().replace("_", "-")))).toBe(true);
  });

  it("knows when a new release needs the pack updated", () => {
    const pack = { format: 1, requirementsSha256: sha256Text("a==1\n") };
    expect(packIsCurrent(pack, "a==1\n")).toBe(true);
    expect(packIsCurrent(pack, "a==2\n")).toBe(false);
    expect(packIsCurrent(null, "a==1\n")).toBe(false);
  });

  it("refuses other systems and releases without the voice before touching anything", async () => {
    const p = tempHome();
    await expect(installVoice(p, { release: join(repo, "apps"), os: "win32", arch: "x64" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(installVoice(p, { release: mkdtempSync(join(tmpdir(), "nyxos-norel-")), os: "darwin", arch: "arm64" })).rejects.toMatchObject({ code: "source_missing" });
    expect(existsSync(voicePaths(p).dir)).toBe(false);
  });

  it("an ffmpeg that cannot do Opus does not count", () => {
    expect(ffmpegWorks(null)).toBe(false);
    expect(ffmpegWorks("/gibt/es/nicht/ffmpeg")).toBe(false);
    const fake = join(mkdtempSync(join(tmpdir(), "nyxos-ff-")), "ffmpeg");
    writeFileSync(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(ffmpegWorks(fake)).toBe(false);
  });

  it.skipIf(spawnSync("sh", ["-c", "command -v ffmpeg"]).status !== 0)("a real ffmpeg with Opus passes the check (encode Ogg/WebM, decode both)", () => {
    const bin = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
    const hasOpus = spawnSync(bin, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout.includes("libopus");
    expect(ffmpegWorks(bin)).toBe(hasOpus);
  });

  it("remove deletes models, Python, packages and uv — and waits for a running install", async () => {
    const p = tempHome();
    const v = voicePaths(p);
    mkdirSync(join(v.models, "parakeet"), { recursive: true });
    mkdirSync(join(v.venv, "bin"), { recursive: true });
    mkdirSync(v.uvDir, { recursive: true });
    writeFileSync(v.uv, "");
    writeFileSync(v.pack, JSON.stringify({ format: 1, requirementsSha256: "x", python: "p", ffmpeg: "f" }));
    // an install is running (lock held by a live process): nothing is removed
    writeFileSync(v.lock, String(process.pid));
    expect(() => removeVoice(p)).toThrow(expect.objectContaining({ code: "busy" }));
    expect(existsSync(v.pack)).toBe(true);
    // a stale lock (process gone) does not block
    writeFileSync(v.lock, "4194305"); // above every pid_max
    removeVoice(p);
    expect(existsSync(v.dir)).toBe(false);
    expect(existsSync(v.uvDir)).toBe(false);
    const s = await voiceStatus(p, join(repo, "apps"));
    expect(s).toMatchObject({ installed: false, running: false, installing: false });
  });
});
