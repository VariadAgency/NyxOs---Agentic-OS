// Nyx versteht und spricht Deutsch UND Englisch, mit zwei getrennten Stimmen: Erkennung ohne festes „de“
// (Sprache kommt mit), Korrekturen nur auf deutschen Text, `voiceEn` + `language` gehen an den Dienst, der Status
// nennt die Sprache je Stimme und die englische Standard-/Ersatzstimme, der Stream sagt, welche Stimmen sprachen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NyxVoiceStatus } from "@nyxos/shared";
import { guessVoiceLanguage, NyxVoiceSpeakRequestSchema } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { buildNyxSystemPrompt, languageRule } from "../src/nyx/prompt.js";
import type { NyxVoiceBackend, NyxVoiceRawStatus } from "../src/nyx/voice-backend.js";
import { adaptNyxVoiceBackend } from "../src/telegram/voice.js";
import type { RpcOutcome } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NO_LOCAL = { binPath: "/gibt/es/nicht", modelPath: "" };
const jsonPost = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const audioPost = (body: Uint8Array, type = "audio/webm;codecs=opus") => ({ method: "POST", headers: { "content-type": type }, body });

function voicePart(id: string, label: string, engine: string, language?: string) {
  return { id, state: "ready", ready: true, bytesDone: 1, bytesTotal: 1, error: null, loadMs: 10, license: "x", label, engine, rtf: 0.3, streaming: engine === "pocket", ...(language ? { language } : {}) };
}

function rawStatus(): NyxVoiceRawStatus {
  const de = voicePart("pocket-juergen", "Jürgen (natürlich)", "pocket", "de");
  const en = voicePart("pocket-en-george", "George (natürlich, englisch)", "pocket", "en");
  const enFb = voicePart("en_US-ljspeech-high", "Linda (klar, englisch)", "piper", "en");
  const old = voicePart("de_DE-thorsten-medium", "Thorsten (schnell)", "piper"); // alter Dienst ohne `language`
  return {
    stt: { ...voicePart("parakeet-tdt-0.6b-v3-int8", "", ""), model: "parakeet-tdt-0.6b-v3-int8", language: "auto" },
    tts: { ...de, voice: de.id, voices: [de, en, enFb, old], preferred: de.id, fallback: old.id, voiceEn: en.id, preferredEn: en.id, fallbackEn: enFb.id },
    threads: 4,
    uptimeS: 5,
  };
}

function fakeBackend(transcript: { text: string; language: string } = { text: "Nyx, the build is Boilt", language: "en" }) {
  const calls: { kind: string; req?: unknown; opts?: unknown }[] = [];
  const backend: NyxVoiceBackend = {
    status: async () => rawStatus(),
    transcribe: async (_audio, opts) => {
      calls.push({ kind: "transcribe", opts });
      return { ...transcript, ms: 5, audioSeconds: 1, model: "parakeet-tdt-0.6b-v3-int8" };
    },
    speak: async (req) => {
      calls.push({ kind: "speak", req });
      return { audio: new Uint8Array([1]), contentType: "audio/wav", voice: "pocket-juergen", ms: 1, audioSeconds: 1 };
    },
    async speakStream(req) {
      calls.push({ kind: "stream", req });
      return { body: new Blob([new Uint8Array(44)]).stream(), voice: "pocket-juergen", voices: ["pocket-juergen", "pocket-en-george"], sampleRate: 24_000, fallback: false };
    },
  };
  return { backend, calls };
}

describe("Erkennung: Deutsch und Englisch", () => {
  it("ohne Angabe wird keine Sprache erzwungen (auto) und die erkannte Sprache kommt mit", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1, 2])));
    expect(res.status).toBe(200);
    expect(calls[0]?.opts).toEqual({ mime: "audio/webm", language: "auto" });
    const body = (await res.json()) as { text: string; language: string };
    expect(body.language).toBe("en");
    // Englischer Text: nur der Name wird korrigiert („Nicks“ → Nyx), „Boilt“ → Build gilt nur für Deutsch:
    expect(body.text).toBe("Nyx, the build is Boilt");
  });

  it("deutscher Text wird weiter korrigiert", async () => {
    const { backend } = fakeBackend({ text: "Nücks, wie weit ist der Boilt?", language: "de" });
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const body = (await (await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1])))).json()) as { text: string; language: string };
    expect(body).toMatchObject({ text: "Nyx, wie weit ist der Build?", language: "de" });
  });

  it("alter Dienst meldet immer „de“/„auto“ → Sprache aus dem Text geschätzt", async () => {
    const { backend } = fakeBackend({ text: "what is the status of the build", language: "auto" });
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const body = (await (await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1])))).json()) as { language: string };
    expect(body.language).toBe("en");
  });

  it("Rückfall Brücke: Sprache aus dem Text, Korrektur nur für Deutsch", async () => {
    const hub = {
      online: true,
      supports: (cap: string) => cap === "voice",
      rpc: async (method: string): Promise<RpcOutcome> => {
        if (method === "voice_probe") return { ok: true, result: { ok: true, model: "ggml-small.bin" } };
        if (method === "transcribe") return { ok: true, result: { outcome: "done", text: "Nyx, can you check the session?", tookMs: 700, model: "ggml-small.bin" } };
        return { ok: false, error: "unbekannt" };
      },
      status: () => ({ online: true, machineId: null, since: null }),
    };
    const { app } = await setup({ bridgeHub: hub as never, voice: { nyx: null, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1, 2])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; language: string; engine: string };
    expect(body.engine).toBe("mac");
    expect(body.language).toBe("en");
    expect(body.text).toBe("Nyx, can you check the session?");
  });

  it("Rückfall Brücke: neue Brücke bekommt „auto“, alte weiter den Hinweis Deutsch", async () => {
    for (const caps of [["voice", "voice_auto"], ["voice"]]) {
      const sent: unknown[] = [];
      const hub = {
        online: true,
        supports: (cap: string) => caps.includes(cap),
        rpc: async (method: string, params: unknown): Promise<RpcOutcome> => {
          if (method === "voice_probe") return { ok: true, result: { ok: true, model: "ggml-small.bin" } };
          if (method === "transcribe") {
            sent.push((params as { language: string }).language);
            return { ok: true, result: { outcome: "done", text: "what is the status", tookMs: 700, model: "ggml-small.bin" } };
          }
          return { ok: false, error: "unbekannt" };
        },
        status: () => ({ online: true, machineId: null, since: null }),
      };
      const { app } = await setup({ bridgeHub: hub as never, voice: { nyx: null, whisperConfig: NO_LOCAL } });
      const res = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1, 2])));
      expect(res.status).toBe(200);
      expect(sent).toEqual([caps.includes("voice_auto") ? "auto" : "de"]);
    }
  });

  it("Telegram: Sprachnachricht ohne feste Sprache, erkannte Sprache kommt mit", async () => {
    const seen: unknown[] = [];
    const voice = adaptNyxVoiceBackend({
      status: async () => ({ stt: { ready: true }, tts: { ready: true } }),
      transcribe: async (_a, opts) => {
        seen.push(opts);
        return { text: "can you check the build", language: "en" };
      },
      speak: async () => ({ audio: new Uint8Array(), contentType: "audio/ogg", audioSeconds: 0 }),
    });
    expect(await voice.transcribe(new Uint8Array([1]), "audio/ogg")).toEqual({ text: "can you check the build", language: "en" });
    expect(seen).toEqual([{ mime: "audio/ogg", language: "auto" }]);
  });

  it("guessVoiceLanguage: Fachwörter bleiben deutsch", () => {
    expect(guessVoiceLanguage("Der Build ist fertig, der Commit ist gepusht.")).toBe("de");
    expect(guessVoiceLanguage("Deploy läuft.")).toBe("de");
    expect(guessVoiceLanguage("Mach bitte einen Commit.")).toBe("de");
    expect(guessVoiceLanguage("Can you check the session?")).toBe("en");
    expect(guessVoiceLanguage("Commit and push, please.")).toBe("en");
    expect(guessVoiceLanguage("Okay.")).toBe("de");
    expect(guessVoiceLanguage("Okay.", "en")).toBe("en");
  });

  it("guessVoiceLanguage: gleiche Stichproben wie text_lang.py", () => {
    // „check“ ist ein deutsches Fachwort und kippt allein nichts.
    expect(guessVoiceLanguage("Der Build ist grün, der Deploy läuft, check mal die Session.")).toBe("de");
    expect(guessVoiceLanguage("Check: Server ok.", "en")).toBe("en");
    expect(guessVoiceLanguage("Check: Server ok.")).toBe("de");
    for (const t of ["Yes.", "OK, let's go.", "Good morning.", "Perfect.", "Sorry!", "Great, thanks.", "Sure.", "Don’t worry."]) {
      expect(guessVoiceLanguage(t), t).toBe("en");
    }
    for (const t of ["Alles klar.", "Perfekt.", "Verstanden.", "Erledigt."]) expect(guessVoiceLanguage(t, "en"), t).toBe("de");
    expect(guessVoiceLanguage("Build failed at 14:30.")).toBe("en");
    expect(guessVoiceLanguage("Der Build ist um 14:30 fertig.", "en")).toBe("de");
  });
});

describe("Sprachausgabe mit zwei Stimmen", () => {
  it("voiceEn + language gehen an den Dienst (mit und ohne Stream)", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const req = { text: "Alles klar. The build is green.", voice: "pocket-juergen", voiceEn: "pocket-en-george", language: "auto" };
    expect((await app.request("/api/nyx/voice/speak?format=wav", jsonPost(req))).status).toBe(200);
    const res = await app.request("/api/nyx/voice/speak?stream=1", jsonPost(req));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-nyx-voice")).toBe("pocket-juergen");
    expect(res.headers.get("x-nyx-voices")).toBe("pocket-juergen,pocket-en-george");
    // dazu die Sprache der App (entscheidet nur bei Texten ohne erkennbare Sprache).
    expect(calls.map((c) => c.req)).toEqual([{ ...req, defaultLanguage: "de" }, { ...req, defaultLanguage: "de" }]);
  });

  it("falsche Sprache oder englische Stimme mit falschem Namen → 400 mit Satz, Dienst nie gefragt", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const r1 = await app.request("/api/nyx/voice/speak", jsonPost({ text: "Hi", language: "fr" }));
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: string }).error).toMatch(/Sprache/);
    const r2 = await app.request("/api/nyx/voice/speak", jsonPost({ text: "Hi", voiceEn: "../etc" }));
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toMatch(/Stimme/);
    expect(calls).toHaveLength(0);
    expect(NyxVoiceSpeakRequestSchema.safeParse({ text: "x", language: "en" }).success).toBe(true);
  });

  it("Status: Sprache je Stimme (alter Dienst ohne Angabe = Deutsch), englische Standard- und Ersatzstimme", async () => {
    const { backend } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const body = (await (await app.request("/api/nyx/voice/status")).json()) as NyxVoiceStatus;
    expect(body.tts.voiceInfo?.map((v) => [v.id, v.language])).toEqual([
      ["pocket-juergen", "de"],
      ["pocket-en-george", "en"],
      ["en_US-ljspeech-high", "en"],
      ["de_DE-thorsten-medium", "de"],
    ]);
    expect(body.tts).toMatchObject({ voiceEn: "pocket-en-george", preferredEn: "pocket-en-george", fallbackEn: "en_US-ljspeech-high" });
  });
});

describe("Betrieb", () => {
  it("Compose: NYX_TTS_DEFAULT_EN neben NYX_TTS_DEFAULT, NYX_LANGUAGE nicht mehr fest „de“", () => {
    const compose = read("infra/docker-compose.yml");
    expect(compose).toContain("NYX_TTS_DEFAULT_EN: ${NYX_TTS_DEFAULT_EN:-}");
    expect(compose).toContain("NYX_LANGUAGE: ${NYX_LANGUAGE:-auto}");
    expect(compose).not.toMatch(/NYX_LANGUAGE: de\b/);
  });

  it("NOTICE nennt die englischen Stimmen mit Lizenz", () => {
    const notice = read("NOTICE");
    expect(notice).toMatch(/pocket-en-george[\s\S]*CC-BY-4\.0/);
    expect(notice).toMatch(/en_US-ljspeech-high[\s\S]*(gemeinfrei|public domain)/i);
  });

  it("Nyx-Kern: antwortet in der Sprache, in der Alex ihn anspricht (Standard Deutsch)", () => {
    const prompt = buildNyxSystemPrompt({ memoryBlock: "", tools: [], channel: "voice" });
    expect(prompt).toContain(languageRule());
    expect(languageRule()).toMatch(/Sprache, in der der Nutzer dich anspricht/);
    expect(languageRule("en")).toMatch(/Answer in English/);
    expect(languageRule()).toMatch(/Standard ist Deutsch/);
    expect(buildNyxSystemPrompt({ memoryBlock: "", tools: [], channel: "web" })).toContain(languageRule());
  });
});
