// Browser-Audio (MediaRecorder: meist `audio/webm;codecs=opus`, Safari `audio/mp4`) nach
// 16-kHz-Mono-WAV wandeln. whisper.cpp liest laut `whisper-cli --help` nur flac/mp3/ogg/wav
// zuverlässig — ffmpeg deckt alle Browser-Formate ab, bevor whisper-cli drankommt.
import { t } from "@nyxos/shared";
import { spawn } from "node:child_process";

export function ffmpegBinFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFMPEG_BIN ?? "/opt/homebrew/bin/ffmpeg";
}

export class ConvertError extends Error {}

export function toWav16kMono(ffmpegBin: string, inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, ["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-f", "wav", outputPath]);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    proc.on("error", (err) => reject(new ConvertError(err.message)));
    proc.on("close", (code) => {
      if (code !== 0) reject(new ConvertError(t("ffmpeg beendete mit Code {code}: {slice}", { code, slice: stderr.slice(-1000) })));
      else resolve();
    });
  });
}
