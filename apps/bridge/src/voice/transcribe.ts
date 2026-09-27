// Spracheingabe (RPC `voice_probe` / `transcribe` vom Server). whisper.cpp (`whisper-cli`) und ffmpeg werden
// über den PATH der Brücke gesucht (Homebrew, apt, …; ein Dienst hat sonst nur /usr/bin:/bin — s.
// `config.terminal.path`). Das Modell liegt in `~/.nyxos/models/whisper/ggml-{small,base}.bin`;
// `small` vor `base` (Fachwörter klar besser, auf Apple Silicon < 1 s).
// Vom Server kommt nur das Audio + ein Mime-Typ aus einer festen Liste — kein Pfad, kein Befehl.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { t, voiceInitialPrompt, type VoiceBridgeRequest, type VoiceBridgeResult, type VoiceProbeResult } from "@nyxos/shared";
import { paths } from "../config.js";

export interface VoiceDeps {
  /** PATH der Brücke. */
  path: string;
  /** Ordner mit den Whisper-Modellen; Standard `~/.nyxos/models/whisper`. */
  modelsDir?: string;
  /** Nur für Tests: feste Modell-Kandidaten statt der Standard-Orte. */
  modelCandidates?: string[];
  timeoutMs?: number;
}

const EXT: Record<VoiceBridgeRequest["mime"], string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav" };
const DEFAULT_TIMEOUT_MS = 60_000;

export function defaultModelCandidates(modelsDir = paths().whisperModels): string[] {
  return ["ggml-small.bin", "ggml-base.bin"].map((f) => join(modelsDir, f));
}

function findOnPath(tool: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, tool);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // weiter suchen
    }
  }
  return null;
}

function findModel(deps: VoiceDeps): string | null {
  for (const p of deps.modelCandidates ?? defaultModelCandidates(deps.modelsDir)) {
    try {
      if (existsSync(p) && statSync(p).size > 1_000_000) return p;
    } catch {
      // weiter suchen
    }
  }
  return null;
}

type Tools = { ok: true; whisper: string; ffmpeg: string; model: string } | { ok: false; result: VoiceProbeResult & { ok: false } };

function tools(deps: VoiceDeps): Tools {
  const whisper = findOnPath("whisper-cli", deps.path);
  if (!whisper) return { ok: false, result: { ok: false, reason: "whisper_missing", detail: t("whisper-cli nicht im PATH der Brücke") } };
  const ffmpeg = findOnPath("ffmpeg", deps.path);
  if (!ffmpeg) return { ok: false, result: { ok: false, reason: "ffmpeg_missing", detail: t("ffmpeg nicht im PATH der Brücke") } };
  const model = findModel(deps);
  if (!model) return { ok: false, result: { ok: false, reason: "model_missing", detail: t("kein ggml-small.bin/ggml-base.bin in {dir}", { dir: deps.modelsDir ?? paths().whisperModels }) } };
  return { ok: true, whisper, ffmpeg, model };
}

export function probeVoice(deps: VoiceDeps): VoiceProbeResult {
  const found = tools(deps);
  return found.ok ? { ok: true, model: basename(found.model) } : found.result;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    proc.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function transcribe(req: VoiceBridgeRequest, deps: VoiceDeps): Promise<VoiceBridgeResult> {
  const found = tools(deps);
  if (!found.ok) return { outcome: "unavailable", reason: found.result.reason, detail: found.result.detail };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dir = await mkdtemp(join(tmpdir(), "nyxos-voice-"));
  const started = performance.now();
  try {
    const input = join(dir, `in.${EXT[req.mime]}`);
    const wav = join(dir, "out.wav");
    await writeFile(input, Buffer.from(req.audioB64, "base64"));
    const conv = await run(found.ffmpeg, ["-nostdin", "-y", "-i", input, "-ac", "1", "-ar", "16000", "-f", "wav", wav], timeoutMs);
    if (conv.code !== 0) throw new Error(t("Aufnahme ließ sich nicht umwandeln (ffmpeg {code}): {error}", { code: conv.code ?? "?", error: conv.stderr.slice(-400) }));
    // Bei „auto“ erkennt Whisper die Sprache selbst; ein Hinweis-Satz würde sie in seine Sprache ziehen.
    const hint = req.language === "auto" ? [] : ["--prompt", voiceInitialPrompt(req.language)];
    const w = await run(found.whisper, ["-m", found.model, "-l", req.language, "-nt", "-np", "-f", wav, ...hint], timeoutMs);
    if (w.code !== 0) throw new Error(t("Erkennung fehlgeschlagen (whisper-cli {code}): {error}", { code: w.code ?? "?", error: w.stderr.slice(-400) }));
    const text = w.stdout.replace(/\s+/g, " ").trim();
    return { outcome: "done", text, tookMs: Math.round(performance.now() - started), model: basename(found.model) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
