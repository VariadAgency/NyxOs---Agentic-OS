// Stimme schneller + natürlicher: `POST /api/nyx/voice/speak?stream=1` (Ton in Stücken, Abbruch geht
// bis zum Dienst durch), Stimmen-Auswahl im Status (Namen, Rückfall), HTTP-Anbindung, Betrieb (Compose-Grenzen
// 4 CPUs / 6 GB, Pocket TTS fest versioniert, Lizenzen in NOTICE) und das Vergleichs-Mess-Skript.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NyxVoiceStatus } from "@nyxos/shared";
import { NYX_VOICE_FALLBACK, NYX_VOICE_STREAM_HEADER_BYTES } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { HttpNyxVoiceBackend, NyxVoiceBackendError, type NyxVoiceBackend, type NyxVoiceRawStatus } from "../src/nyx/voice-backend.js";
import { setup } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NO_LOCAL = { binPath: "/gibt/es/nicht", modelPath: "" };
const jsonPost = (body: unknown, signal?: AbortSignal) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

function voicePart(id: string, label: string, engine: string, state = "ready", rtf: number | null = 0.2) {
  return { id, state, ready: state === "ready", bytesDone: 1, bytesTotal: 1, error: null, loadMs: 10, license: "x", label, engine, rtf, streaming: engine === "pocket" };
}

function rawStatus(pocketState = "ready"): NyxVoiceRawStatus {
  const pocket = voicePart("pocket-juergen", "Jürgen (natürlich)", "pocket", pocketState, pocketState === "ready" ? 0.31 : null);
  const medium = voicePart(NYX_VOICE_FALLBACK, "Thorsten (schnell)", "piper", "ready", 0.04);
  const speaking = pocketState === "ready" ? pocket : medium;
  return {
    stt: { ...voicePart("parakeet-tdt-0.6b-v3-int8", "", "", "ready"), model: "parakeet-tdt-0.6b-v3-int8", language: "de" },
    tts: { ...speaking, voice: speaking.id, voices: [pocket, medium], preferred: "pocket-juergen", fallback: NYX_VOICE_FALLBACK },
    threads: 4,
    uptimeS: 5,
  };
}

/** WAV-Kopf mit offener Länge + PCM, in `pieces` Stücken mit Pause dazwischen (wie der Dienst). */
function wavStream(pieces: number, opts: { delayMs?: number; onCancel?: () => void } = {}): ReadableStream<Uint8Array> {
  const header = new Uint8Array(NYX_VOICE_STREAM_HEADER_BYTES);
  header.set(new TextEncoder().encode("RIFF"), 0);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i === 0) ctrl.enqueue(header);
      else if (i <= pieces) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        ctrl.enqueue(new Uint8Array(480).fill(i));
      } else ctrl.close();
      i++;
    },
    cancel() {
      opts.onCancel?.();
    },
  });
}

function fakeBackend(opts: { status?: NyxVoiceRawStatus; streamError?: NyxVoiceBackendError; delayMs?: number } = {}) {
  const calls: { req: unknown; signal?: AbortSignal }[] = [];
  let cancelled = false;
  const status = opts.status ?? rawStatus();
  const backend: NyxVoiceBackend = {
    status: async () => status,
    transcribe: async () => ({ text: "", language: "de", ms: 1, audioSeconds: 0, model: "x" }),
    speak: async (req) => ({ audio: new Uint8Array([1]), contentType: "audio/ogg", voice: req.voice ?? "x", ms: 1, audioSeconds: 1 }),
    async speakStream(req, signal) {
      calls.push({ req, signal });
      if (opts.streamError) throw opts.streamError;
      const fallback = req.voice === "pocket-juergen" && status.tts.voice !== "pocket-juergen";
      return {
        body: wavStream(3, {
          delayMs: opts.delayMs,
          onCancel: () => {
            cancelled = true;
          },
        }),
        voice: fallback ? NYX_VOICE_FALLBACK : (req.voice ?? status.tts.voice),
        sampleRate: status.tts.voice === "pocket-juergen" ? 24_000 : 22_050,
        fallback,
      };
    },
  };
  return { backend, calls, wasCancelled: () => cancelled };
}

describe("POST /api/nyx/voice/speak?stream=1", () => {
  it("liefert audio/wav in Stücken: Kopf, dann PCM; Stimme + Abtastrate im Kopf der Antwort", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/speak?stream=1", jsonPost({ text: "Alles klar, ich starte die Session." }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("x-nyx-voice")).toBe("pocket-juergen");
    expect(res.headers.get("x-nyx-sample-rate")).toBe("24000");
    expect(res.headers.get("x-nyx-voice-fallback")).toBe("0");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(NYX_VOICE_STREAM_HEADER_BYTES + 3 * 480);
    expect(new TextDecoder().decode(body.slice(0, 4))).toBe("RIFF");
    expect(calls[0]?.req).toEqual({ text: "Alles klar, ich starte die Session.", defaultLanguage: "de" });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("gewünschte Stimme noch nicht bereit → Ersatzstimme spricht, Kopfzeile sagt es", async () => {
    const { backend } = fakeBackend({ status: rawStatus("loading") });
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/speak?stream=1", jsonPost({ text: "Hallo.", voice: "pocket-juergen" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-nyx-voice")).toBe(NYX_VOICE_FALLBACK);
    expect(res.headers.get("x-nyx-voice-fallback")).toBe("1");
  });

  it("der Browser bricht ab → der Strom zum Dienst wird geschlossen", async () => {
    const f = fakeBackend({ delayMs: 30 });
    const { app } = await setup({ voice: { nyx: f.backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/speak?stream=1", jsonPost({ text: "Ein langer Text." }));
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.wasCancelled()).toBe(true);
  });

  it("Fehler vor dem ersten Ton → dieselben Sätze wie ohne Streaming, nie Technik", async () => {
    const off = fakeBackend({ streamError: new NyxVoiceBackendError("offline", 503, "ECONNREFUSED nyx-voice:8090") });
    const a = await setup({ voice: { nyx: off.backend, whisperConfig: NO_LOCAL } });
    const r1 = await a.app.request("/api/nyx/voice/speak?stream=1", jsonPost({ text: "Hi" }));
    expect(r1.status).toBe(503);
    expect(JSON.stringify(await r1.json())).not.toMatch(/ECONNREFUSED|nyx-voice:8090/);
    const bad = fakeBackend({ streamError: new NyxVoiceBackendError("bad_voice", 400, "x") });
    const b = await setup({ voice: { nyx: bad.backend, whisperConfig: NO_LOCAL } });
    const r2 = await b.app.request("/api/nyx/voice/speak?stream=1", jsonPost({ text: "Hi", voice: "gibt_es_nicht" }));
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toMatch(/Stimme/);
    const c = await setup({ voice: { nyx: bad.backend, whisperConfig: NO_LOCAL } });
    expect((await c.app.request("/api/nyx/voice/speak?stream=1", jsonPost({ text: "" }))).status).toBe(400);
    expect(bad.calls).toHaveLength(1);
  });

  it("ohne Anmeldung 401", async () => {
    const { backend } = fakeBackend();
    const { app } = await setup({ signedIn: false, voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    expect((await app.request("/api/nyx/voice/speak?stream=1", jsonPost({ text: "Hi" }))).status).toBe(401);
  });
});

describe("Status: Stimmen zur Auswahl", () => {
  it("jede Stimme mit Namen, Zustand, Motor; gewünschte + Ersatzstimme", async () => {
    const { backend } = fakeBackend({ status: rawStatus("loading") });
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const body = (await (await app.request("/api/nyx/voice/status")).json()) as NyxVoiceStatus;
    expect(body.tts.voice).toBe(NYX_VOICE_FALLBACK);
    expect(body.tts.ready).toBe(true);
    expect(body.tts.preferred).toBe("pocket-juergen");
    expect(body.tts.fallback).toBe(NYX_VOICE_FALLBACK);
    expect(body.tts.voiceInfo).toEqual([
      { id: "pocket-juergen", label: "Jürgen (natürlich)", ready: false, state: "loading", engine: "pocket", streaming: true, rtf: null, language: "de" },
      { id: NYX_VOICE_FALLBACK, label: "Thorsten (schnell)", ready: true, state: "ready", engine: "piper", streaming: false, rtf: 0.04, language: "de" },
    ]);
  });
});

describe("HTTP-Anbindung (Streaming)", () => {
  it("POST /speak?stream=1, Körper fließt durch, Kopfzeilen werden gelesen, Abbruch geht an fetch", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(wavStream(2), { status: 200, headers: { "content-type": "audio/wav", "x-nyx-voice": "pocket-juergen", "x-nyx-sample-rate": "24000", "x-nyx-fallback": "0" } });
    }) as unknown as typeof fetch;
    const b = new HttpNyxVoiceBackend("http://nyx-voice:8090", fake);
    const ctrl = new AbortController();
    const out = await b.speakStream({ text: "Hallo" }, ctrl.signal);
    expect(seen[0]?.url).toBe("http://nyx-voice:8090/speak?stream=1");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ text: "Hallo" });
    expect(out).toMatchObject({ voice: "pocket-juergen", sampleRate: 24_000, fallback: false });
    expect((await new Response(out.body).arrayBuffer()).byteLength).toBe(NYX_VOICE_STREAM_HEADER_BYTES + 2 * 480);
    const signal = seen[0]?.init.signal as AbortSignal;
    ctrl.abort();
    expect(signal.aborted).toBe(true);
  });

  it("Dienst-Fehler vor dem Ton → Code, Netzfehler → offline", async () => {
    const b1 = new HttpNyxVoiceBackend("http://x", (async () => new Response(JSON.stringify({ error: "bad_voice", message: "nein" }), { status: 400 })) as unknown as typeof fetch);
    await expect(b1.speakStream({ text: "Hi" })).rejects.toMatchObject({ code: "bad_voice" });
    const b2 = new HttpNyxVoiceBackend("http://x", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(b2.speakStream({ text: "Hi" })).rejects.toMatchObject({ code: "offline" });
  });
});

describe("Betrieb", () => {
  const compose = read("infra/docker-compose.yml");
  const voice = compose.slice(compose.indexOf("  nyx-voice:"), compose.indexOf("\nvolumes:"));

  it("Grenzen höchstens 4 CPUs / 6 GB, Standard-Stimme ohne Neubau umschaltbar", () => {
    expect(voice).toMatch(/cpus: "4\.0"/);
    expect(voice).toMatch(/memory: 6g/);
    expect(voice).toMatch(/NYX_THREADS: "4"/);
    expect(voice).toMatch(/NYX_TTS_DEFAULT: \$\{NYX_TTS_DEFAULT:-\}/);
  });

  it("Pocket TTS + PyTorch-CPU fest versioniert, Gewichte nie im Abbild, Hugging Face zur Laufzeit aus", () => {
    const req = read("infra/nyx-voice/requirements-pocket.txt");
    expect(req).toMatch(/^pocket-tts==3\.3\.0$/m);
    expect(req).toMatch(/^torch==\d+\.\d+\.\d+\+cpu$/m);
    expect(req).toMatch(/^--extra-index-url https:\/\/download\.pytorch\.org\/whl\/cpu$/m);
    for (const line of req.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("--"))) expect(line).toMatch(/^[a-z0-9_.-]+==[\w.+]+$/i);
    const dockerfile = read("infra/nyx-voice/Dockerfile");
    expect(dockerfile).toMatch(/requirements-pocket\.txt/);
    expect(dockerfile).toMatch(/HF_HUB_OFFLINE=1/);
    expect(dockerfile).not.toMatch(/safetensors"|huggingface\.co/);
    const catalog = read("infra/nyx-voice/nyx_voice/catalog.py");
    expect(catalog).toMatch(/POCKET_REV = "4e1e0a3e611c51c0b4ed8174fc10f32a54644303"/);
    expect(catalog).toMatch(/pocket-tts-without-voice-cloning\/resolve\/\{POCKET_REV\}/);
    expect(catalog).not.toMatch(/"de_DE-pavoque/);
  });

  it("NOTICE nennt Pocket TTS (MIT) und die Gewichte (CC-BY-4.0) sowie die neuen Stimmen", () => {
    const notice = read("NOTICE");
    expect(notice).toMatch(/Pocket TTS/);
    expect(notice).toMatch(/Kyutai/);
    expect(notice).toMatch(/CC-BY-4\.0/);
    expect(notice).toMatch(/M-AILABS/);
  });

});

