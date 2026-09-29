// Sprechen statt tippen — Erkennung über whisper.cpp (`whisper-cli`, Homebrew-Formel
// `whisper-cpp`). Läuft lokal auf dem Rechner über die Brücke (schnell, wenn online) oder als Fallback
// auf dem Server (`server`-Engine unten) — beide rufen dasselbe Binary/Modell auf, nur der Prozess
// unterscheidet sich (Brücke vs. Server-Container). Gemessen (P8-Bericht): `ggml-small.bin`
// (deutsch/mehrsprachig, ~488 MB) erkennt die Fachwörter aus `voiceInitialPrompt` klar besser
// als `ggml-base.bin` (148 MB) bei weiter < 1 s Laufzeit je ~10–15 s Clip (Metal-Backend, warm) —
// deshalb Standard `small`, `base` bleibt über `WHISPER_MODEL` wählbar (schwächere Server-Hardware).
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { VoiceEngine, VoiceTranscribeResult } from "@nyxos/shared";
import { getLang, t, voiceInitialPrompt } from "@nyxos/shared";

export interface WhisperConfig {
  /** Pfad zum `whisper-cli`-Binary. Default: Homebrew-Standardpfad (Apple Silicon). */
  binPath: string;
  /** Pfad zum ggml-Modell (`.bin`). Muss vorhanden sein — `probeWhisper` prüft das beim Start. */
  modelPath: string;
  /** Zusätzliches Vokabular als Anfangs-Prompt ("Fachwörter über Anfangs-Prompt"); ohne Angabe passend zur Sprache. */
  initialPrompt?: string;
}

export function whisperConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhisperConfig {
  return {
    binPath: env.WHISPER_BIN ?? "/opt/homebrew/bin/whisper-cli",
    modelPath: env.WHISPER_MODEL_PATH ?? "",
    ...(env.WHISPER_PROMPT ? { initialPrompt: env.WHISPER_PROMPT } : {}),
  };
}

/** Prüft, ob Binary + Modell erreichbar sind (für `/health`-artige Vorabprüfung und Tests). */
export async function probeWhisper(cfg: WhisperConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    await access(cfg.binPath);
  } catch {
    return { ok: false, error: t("whisper-cli nicht gefunden unter {binPath}", { binPath: cfg.binPath }) };
  }
  if (!cfg.modelPath) return { ok: false, error: t("Kein WHISPER_MODEL_PATH gesetzt") };
  try {
    await access(cfg.modelPath);
  } catch {
    return { ok: false, error: t("Modell nicht gefunden unter {modelPath}", { modelPath: cfg.modelPath }) };
  }
  return { ok: true };
}

export interface TranscribeOptions {
  /** Sprache (ISO-639-1), Standard = Sprache der App. */
  language?: string;
  /** Grobe Dauer des Clips in Sekunden (für `audioSeconds` in der Antwort) — vom Aufrufer bekannt
   * (MediaRecorder-Dauer), muss nicht aus der Audiodatei selbst berechnet werden. */
  audioSeconds?: number;
  engine?: VoiceEngine;
}

export class WhisperError extends Error {}

/**
 * Transkribiert eine WAV-Datei (16 kHz mono PCM — die einzige Form, die whisper.cpp ohne eigenen
 * Decoder zuverlässig liest; der Aufrufer wandelt Browser-Audio vorher um, s. `routes/voice.ts`).
 */
export function transcribeFile(cfg: WhisperConfig, wavPath: string, opts: TranscribeOptions = {}): Promise<VoiceTranscribeResult> {
  const started = performance.now();
  const language = opts.language ?? getLang();
  const args = ["-m", cfg.modelPath, "-l", language, "-nt", "-np", "-f", wavPath];
  // „auto“: Whisper erkennt selbst – ein Hinweis-Satz würde es in seine Sprache ziehen.
  const prompt = cfg.initialPrompt ?? (language === "auto" ? null : voiceInitialPrompt(language));
  if (prompt) args.push("--prompt", prompt);
  return new Promise((resolve, reject) => {
    const proc = spawn(cfg.binPath, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    proc.on("error", (err) => reject(new WhisperError(err.message)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new WhisperError(t("whisper-cli beendete mit Code {code}: {slice}", { code, slice: stderr.slice(-2000) })));
        return;
      }
      resolve({
        text: stdout.trim(),
        engine: opts.engine ?? "server",
        tookMs: Math.round(performance.now() - started),
        audioSeconds: opts.audioSeconds ?? 0,
      });
    });
  });
}
