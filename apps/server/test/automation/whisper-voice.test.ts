// Sprechen statt tippen. Echter Lauf gegen das installierte whisper.cpp (`brew install
// whisper-cpp`) + ein lokal geladenes ggml-Modell (s. `.models/whisper/`, gitignored) — kein Mock,
// weil genau die Erkennungsqualität/-geschwindigkeit der Fachwörter geprüft wird.
// Fehlen Binary/Modell (z. B. auf einer anderen Maschine ohne die lokale Installation), überspringt
// der Testlauf automatisch statt rot zu werden — `probeWhisper` ist genau dafür da.
import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegBinFromEnv, toWav16kMono } from "../../src/voice/convert.js";
import { probeWhisper, transcribeFile, whisperConfigFromEnv } from "../../src/voice/whisper.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
// `small` statt `base`: gemessen (Fachwort-Erkennung deutlich besser, < 1 s Laufzeit egal welches Modell).
const MODEL_SMALL = join(REPO_ROOT, ".models/whisper/ggml-small.bin");
const PROBE_DIR = join(REPO_ROOT, ".probe/voice");

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("voice/whisper (echtes whisper.cpp, wenn lokal vorhanden)", () => {
  it("probeWhisper meldet fehlendes Modell klar", async () => {
    const result = await probeWhisper({ binPath: "/pfad/gibt/es/nicht", modelPath: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nicht gefunden");
  });

  it("erkennt 5 deutsche Test-Diktate mit Fachwörtern in < 10 s je Clip", async () => {
    const cfg = whisperConfigFromEnv({ ...process.env, WHISPER_MODEL_PATH: MODEL_SMALL });
    const probe = await probeWhisper(cfg);
    if (!probe.ok || !(await exists(PROBE_DIR))) {
      console.warn(`whisper.cpp/Modell lokal nicht vorhanden (${probe.error ?? "kein .probe/voice"}) — Test übersprungen.`);
      return;
    }
    const dictations = [
      { file: "d1.wav", mustContain: ["Worktree", "NyxOS", "Opus", "Haiku"] },
      { file: "d2.wav", mustContain: ["Backend", "Datenbank", "Pull Request", "Haiku", "Sitzung"] },
      { file: "d3.wav", mustContain: ["Terminal", "Codex", "Sonnet", "Deploy", "Produktion"] },
      { file: "d4.wav", mustContain: ["Frontend", "Shop", "Worktree", "Haiku", "NyxOS"] },
      { file: "d5.wav", mustContain: ["Deploy", "Datenbank", "Sitzung", "Terminal", "Codex"] },
    ];
    const rows: Array<{ file: string; tookMs: number; hits: number; total: number; text: string }> = [];
    for (const d of dictations) {
      const wavPath = join(PROBE_DIR, d.file);
      const result = await transcribeFile(cfg, wavPath, { audioSeconds: 10 });
      expect(result.tookMs).toBeLessThan(10_000);
      const hits = d.mustContain.filter((w) => result.text.includes(w)).length;
      rows.push({ file: d.file, tookMs: result.tookMs, hits, total: d.mustContain.length, text: result.text });
      // mindestens 3 von 5 Fachwörtern je Diktat (reale TTS-Testclips, kein Live-Mikrofon).
      expect(hits).toBeGreaterThanOrEqual(Math.ceil(d.mustContain.length * 0.6));
    }
    console.table(rows.map((r) => ({ Datei: r.file, "ms": r.tookMs, Treffer: `${r.hits}/${r.total}`, Text: r.text })));
  });
});

describe("voice/convert (ffmpeg)", () => {
  it("wandelt eine WAV-Datei erneut nach 16-kHz-Mono-WAV um (Rundweg-Test ohne Browser-Codec)", async () => {
    const ffmpegBin = ffmpegBinFromEnv();
    if (!(await exists(ffmpegBin)) || !(await exists(join(PROBE_DIR, "d1.wav")))) {
      console.warn("ffmpeg oder Testdatei nicht vorhanden — Test übersprungen.");
      return;
    }
    const out = join(PROBE_DIR, "convert-test-out.wav");
    await toWav16kMono(ffmpegBin, join(PROBE_DIR, "d1.wav"), out);
    expect(await exists(out)).toBe(true);
  });
});
