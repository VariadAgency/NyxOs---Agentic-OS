// Spracheingabe: fehlende Werkzeuge ehrlich melden; mit echtem whisper.cpp + Modell (falls auf diesem
// Rechner vorhanden) ein echtes Diktat erkennen — kein Mock der Erkennung.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceBridgeRequestSchema } from "@nyxos/shared";
import { defaultModelCandidates, probeVoice, transcribe } from "../src/voice/transcribe.js";

const HOMEBREW = "/opt/homebrew/bin";
const SAMPLE = "/opt/homebrew/share/whisper-cpp/jfk.wav";
const REPO_MODELS = join(import.meta.dirname, "..", "..", "..", ".models", "whisper");
const MODEL = [...defaultModelCandidates(), join(REPO_MODELS, "ggml-base.bin")].find((p) => existsSync(p));

describe("Spracheingabe (Brücke)", () => {
  it("meldet fehlendes whisper-cli / ffmpeg / Modell mit Grund statt zu werfen", () => {
    const empty = mkdtempSync(join(tmpdir(), "leer-"));
    expect(probeVoice({ path: empty, modelCandidates: [] })).toMatchObject({ ok: false, reason: "whisper_missing" });
    const onlyWhisper = mkdtempSync(join(tmpdir(), "nur-whisper-"));
    writeFileSync(join(onlyWhisper, "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
    expect(probeVoice({ path: onlyWhisper, modelCandidates: [] })).toMatchObject({ ok: false, reason: "ffmpeg_missing" });
    writeFileSync(join(onlyWhisper, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });
    expect(probeVoice({ path: onlyWhisper, modelCandidates: [join(empty, "ggml-small.bin")] })).toMatchObject({ ok: false, reason: "model_missing" });
  });

  it("„auto“ lässt Whisper die Sprache selbst erkennen (ohne deutschen Hinweis-Satz)", async () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-whisper-"));
    writeFileSync(join(bin, "ffmpeg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "whisper-cli"), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    writeFileSync(join(bin, "ggml-small.bin"), Buffer.alloc(1_000_001));
    const deps = { path: bin, modelCandidates: [join(bin, "ggml-small.bin")] };
    expect(VoiceBridgeRequestSchema.safeParse({ audioB64: "AA==", mime: "audio/wav", language: "auto" }).success).toBe(true);
    const auto = await transcribe({ audioB64: "AA==", mime: "audio/wav", language: "auto" }, deps);
    const de = await transcribe({ audioB64: "AA==", mime: "audio/wav", language: "de" }, deps);
    expect(auto.outcome === "done" && auto.text).toMatch(/-l auto/);
    expect(auto.outcome === "done" && auto.text).not.toMatch(/--prompt/);
    expect(de.outcome === "done" && de.text).toMatch(/-l de .*--prompt/);
  });

  it.skipIf(!existsSync(join(HOMEBREW, "whisper-cli")) || !existsSync(join(HOMEBREW, "ffmpeg")) || !MODEL || !existsSync(SAMPLE))(
    "erkennt ein echtes Diktat mit whisper.cpp auf diesem Rechner",
    async () => {
      const deps = { path: HOMEBREW, modelCandidates: [MODEL ?? ""] };
      expect(probeVoice(deps)).toMatchObject({ ok: true });
      const audioB64 = readFileSync(SAMPLE).toString("base64");
      const res = await transcribe({ audioB64, mime: "audio/wav", language: "en" }, deps);
      expect(res.outcome).toBe("done");
      if (res.outcome === "done") {
        expect(res.text.toLowerCase()).toMatch(/ask not what your country can do for you/);
        expect(res.tookMs).toBeLessThan(30_000);
      }
    },
    60_000,
  );
});
