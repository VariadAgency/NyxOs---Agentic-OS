// Stimmen-Einstellungen: eigenes Aussprache-Wörterbuch, ElevenLabs-Schlüssel (nur „gesetzt“, nie Klartext),
// Stimmen-Liste von ElevenLabs, gestreamte Sprache über ElevenLabs mit automatischem Rückfall auf die eigene Stimme.
// ElevenLabs ist komplett nachgebaut (fetch-Attrappe), der Stimmen-Dienst ebenso — kein Netz.
import { randomBytes } from "node:crypto";
import type { NyxVoiceSpeakRequest, NyxVoiceSettings } from "@nyxos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NyxVoiceBackendError, type NyxVoiceBackend, type NyxVoiceRawStatus } from "../src/nyx/voice-backend.js";
import { setup } from "./helpers.js";

const EL_KEY = "sk_test_ELEVEN_geheim_1234567890_WXYZ";

function rawStatus(): NyxVoiceRawStatus {
  const part = { id: "pocket-juergen", state: "ready", ready: true, bytesDone: 1, bytesTotal: 1, error: null, loadMs: 1 };
  return { stt: { ...part, id: "parakeet", model: "parakeet", language: "auto" }, tts: { ...part, voice: "pocket-juergen", voices: [part] }, threads: 1, uptimeS: 1 };
}

function pcmStream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array(bytes));
      ctrl.close();
    },
  });
}

function fakeBackend() {
  const calls: { kind: string; req: NyxVoiceSpeakRequest }[] = [];
  const backend: NyxVoiceBackend = {
    status: async () => rawStatus(),
    transcribe: async () => ({ text: "x", language: "de", ms: 1, audioSeconds: 1, model: "m" }),
    async speak(req, format) {
      calls.push({ kind: "speak", req });
      return { audio: new TextEncoder().encode(format === "wav" ? "RIFFlocal" : "OggSlocal"), contentType: format === "wav" ? "audio/wav" : "audio/ogg", voice: "pocket-juergen", ms: 1, audioSeconds: 1 };
    },
    async importVoice(req) {
      calls.push({ kind: "import", req: req as unknown as NyxVoiceSpeakRequest });
      if ("id" in req && req.id === "de_DE-pavoque-low") throw new NyxVoiceBackendError("not_allowed", 400, "keine freie Lizenz");
      return { id: "id" in req ? req.id : "de_DE-thorsten-low", state: "downloading", ready: false, bytesDone: 0, bytesTotal: 1, error: null, loadMs: null, added: true };
    },
    async speakStream(req) {
      calls.push({ kind: "stream", req });
      return { body: pcmStream([...new TextEncoder().encode("RIFFlocal")]), voice: "pocket-juergen", voices: ["pocket-juergen"], sampleRate: 24000, fallback: false };
    },
  };
  return { backend, calls };
}

type ElCall = { url: string; key: string | null; body: unknown };

function fakeEleven(opts: { status?: number } = {}) {
  const calls: ElCall[] = [];
  const clones: { name: string; fileName: string; type: string; size: number }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, key: headers.get("xi-api-key"), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (headers.get("xi-api-key") !== EL_KEY) return new Response(JSON.stringify({ detail: "invalid_api_key" }), { status: 401 });
    if (opts.status && opts.status !== 200) return new Response("kaputt", { status: opts.status });
    if (url.endsWith("/v1/voices")) {
      return Response.json({
        voices: [
          { voice_id: "v2Zb", name: "Zora", category: "premade", labels: { gender: "female", accent: "german" }, preview_url: "https://x/p.mp3" },
          { voice_id: "a1Ab", name: "Anton", category: "cloned", labels: {}, preview_url: null },
          { voice_id: "bad id!", name: "Kaputt" },
        ],
      });
    }
    if (url.includes("/v1/text-to-speech/")) return new Response(pcmStream([1, 2, 3, 4, 5]), { status: 200 });
    if (url.endsWith("/v1/voices/add")) {
      const form = init?.body as FormData;
      const file = form.get("files");
      clones.push({ name: String(form.get("name")), fileName: file instanceof File ? file.name : "", type: file instanceof Blob ? file.type : "", size: file instanceof Blob ? file.size : 0 });
      return Response.json({ voice_id: "neuKlon1" });
    }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, clones };
}

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function readAll(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe("Stimmen-Einstellungen", () => {
  const prev = process.env.NYXOS_SECRETS_KEY;
  beforeEach(() => {
    process.env.NYXOS_SECRETS_KEY = randomBytes(32).toString("base64");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NYXOS_SECRETS_KEY;
    else process.env.NYXOS_SECRETS_KEY = prev;
  });

  async function make(el = fakeEleven()) {
    const voice = fakeBackend();
    const { app } = await setup({ isolated: true, voice: { nyx: voice.backend, elevenFetch: el.fetchImpl } });
    return { app, voice, el };
  }

  it("Standard: eigene Stimme, kein Schlüssel, leeres Wörterbuch", async () => {
    const { app } = await make();
    const s = (await (await app.request("/api/nyx/voice/settings")).json()) as NyxVoiceSettings;
    expect(s.provider).toBe("local");
    expect(s.elevenlabs.keySet).toBe(false);
    expect(s.elevenlabs.model).toBe("eleven_multilingual_v2");
    expect(s.lexicon).toEqual([]);
  });

  it("Wörterbuch wird gespeichert (doppelte Wörter: letztes gewinnt) und an jede Sprach-Anfrage gehängt", async () => {
    const { app, voice } = await make();
    const put = await app.request("/api/nyx/voice/settings", json("PUT", { lexicon: [{ word: "Kanban", say: "Kahnbahn" }, { word: "Nyx", say: "Nix" }, { word: "kanban", say: "Kann-Bann" }] }));
    expect(put.status).toBe(200);
    const s = (await put.json()) as NyxVoiceSettings;
    expect(s.lexicon).toEqual([{ word: "Nyx", say: "Nix" }, { word: "kanban", say: "Kann-Bann" }]);

    await app.request("/api/nyx/voice/speak?format=wav", json("POST", { text: "Das Kanban ist fertig." }));
    await app.request("/api/nyx/voice/speak?stream=1", json("POST", { text: "Hallo Nyx.", lexicon: [{ word: "Nyx", say: "Nüx" }] }));
    expect(voice.calls[0]?.req.lexicon).toEqual([{ word: "Nyx", say: "Nix" }, { word: "kanban", say: "Kann-Bann" }]);
    // Einträge der Anfrage (Hörprobe im Editor) gehen vor den gespeicherten.
    expect(voice.calls[1]?.req.lexicon).toContainEqual({ word: "Nyx", say: "Nüx" });
    expect(voice.calls[1]?.req.lexicon).not.toContainEqual({ word: "Nyx", say: "Nix" });
    // Nur Dienst-Felder gehen raus (kein provider/elevenVoice an nyx-voice).
    expect(voice.calls[1]?.req).not.toHaveProperty("provider");
  });

  it("ungültiges Wörterbuch → 400 mit einfachem Satz", async () => {
    const { app } = await make();
    const res = await app.request("/api/nyx/voice/settings", json("PUT", { lexicon: [{ word: "", say: "x" }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Aussprache-Eintrag/);
  });

  it("falscher ElevenLabs-Schlüssel wird geprüft und NICHT gespeichert", async () => {
    const { app } = await make();
    const res = await app.request("/api/nyx/voice/elevenlabs/key", json("PUT", { value: "sk_falsch_aber_lang_genug" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("unauthorized");
    const s = (await (await app.request("/api/nyx/voice/settings")).json()) as NyxVoiceSettings;
    expect(s.elevenlabs.keySet).toBe(false);
  });

  it("richtiger Schlüssel: nur „gesetzt“ + letzte 4 Zeichen zurück, nie der Klartext; Stimmen-Liste gefiltert + sortiert", async () => {
    const { app } = await make();
    const res = await app.request("/api/nyx/voice/elevenlabs/key", json("PUT", { value: EL_KEY }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(EL_KEY);
    const s = JSON.parse(text) as NyxVoiceSettings;
    expect(s.elevenlabs).toMatchObject({ keySet: true, last4: "WXYZ" });
    const all = await (await app.request("/api/nyx/voice/settings")).text();
    expect(all).not.toContain(EL_KEY);

    const voices = (await (await app.request("/api/nyx/voice/elevenlabs/voices")).json()) as { voices: { id: string; name: string; description: string | null }[] };
    expect(voices.voices.map((v) => v.id)).toEqual(["a1Ab", "v2Zb"]);
    expect(voices.voices[1]?.description).toBe("female · german");
  });

  it("Anbieter ElevenLabs ohne Schlüssel → 400", async () => {
    const { app } = await make();
    const res = await app.request("/api/nyx/voice/settings", json("PUT", { provider: "elevenlabs", elevenlabsVoiceId: "v2Zb" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("no_key");
  });

  it("ElevenLabs spricht gestreamt (WAV-Kopf + PCM, 24 kHz); Hörprobe der eigenen Stimme bleibt lokal", async () => {
    const { app, voice, el } = await make();
    await app.request("/api/nyx/voice/elevenlabs/key", json("PUT", { value: EL_KEY }));
    const put = await app.request("/api/nyx/voice/settings", json("PUT", { provider: "elevenlabs", elevenlabsVoiceId: "v2Zb", elevenlabsVoiceName: "Zora", elevenlabsModel: "eleven_flash_v2_5" }));
    expect(put.status).toBe(200);

    const res = await app.request("/api/nyx/voice/speak?stream=1", json("POST", { text: "Hallo Alex.", speed: 1.8, language: "de" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-nyx-voice")).toBe("elevenlabs:v2Zb");
    expect(res.headers.get("x-nyx-sample-rate")).toBe("24000");
    const bytes = await readAll(res);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(24000);
    // 5 Byte PCM → ganze 16-bit-Rahmen; das letzte Einzel-Byte wird zum Rahmen aufgefüllt, nie verworfen.
    expect(bytes.length).toBe(44 + 6);
    expect([...bytes.slice(44)]).toEqual([1, 2, 3, 4, 5, 0]);
    const tts = el.calls.find((c) => c.url.includes("/text-to-speech/v2Zb/stream"));
    expect(tts?.url).toContain("output_format=pcm_24000");
    expect(tts?.body).toMatchObject({ text: "Hallo Alex.", model_id: "eleven_flash_v2_5", language_code: "de", voice_settings: { speed: 1.2 } });
    expect(voice.calls.filter((c) => c.kind === "stream")).toHaveLength(0);

    const local = await app.request("/api/nyx/voice/speak?stream=1", json("POST", { text: "Probe.", provider: "local" }));
    expect(local.headers.get("x-nyx-voice")).toBe("pocket-juergen");
    expect(voice.calls.filter((c) => c.kind === "stream")).toHaveLength(1);
  });

  it("ElevenLabs-Fehler → automatisch eigene Stimme (als Ersatz markiert), Schlüssel steht nie im Protokoll", async () => {
    const lines: string[] = [];
    const voice2 = fakeBackend();
    const failing = fakeEleven({ status: 429 });
    const { app: app3 } = await setup({ isolated: true, voice: { nyx: voice2.backend, elevenFetch: failing.fetchImpl }, log: (m, x) => lines.push(`${m} ${JSON.stringify(x ?? {})}`) });
    // Schlüssel-Prüfung bei 429 schlägt fehl → Schlüssel direkt über die Geheimnis-Route setzen.
    await app3.request("/api/secrets/elevenlabs.api-key", json("PUT", { value: EL_KEY }));
    const ok = await app3.request("/api/nyx/voice/settings", json("PUT", { provider: "elevenlabs", elevenlabsVoiceId: "v2Zb" }));
    expect(ok.status).toBe(200);
    const fb = await app3.request("/api/nyx/voice/speak?stream=1", json("POST", { text: "Hallo." }));
    expect(fb.status).toBe(200);
    expect(fb.headers.get("x-nyx-voice")).toBe("pocket-juergen");
    expect(fb.headers.get("x-nyx-voice-fallback")).toBe("1");
    expect(voice2.calls.filter((c) => c.kind === "stream")).toHaveLength(1);
    expect(lines.join("\n")).toContain("nyx-voice-elevenlabs-fehler");
    expect(lines.join("\n")).not.toContain(EL_KEY);
  });

  it("Schlüssel löschen setzt den Anbieter zurück auf die eigene Stimme", async () => {
    const { app } = await make();
    await app.request("/api/nyx/voice/elevenlabs/key", json("PUT", { value: EL_KEY }));
    await app.request("/api/nyx/voice/settings", json("PUT", { provider: "elevenlabs", elevenlabsVoiceId: "v2Zb" }));
    const del = await app.request("/api/nyx/voice/elevenlabs/key", { method: "DELETE", headers: { "content-type": "application/json" } });
    const s = (await del.json()) as NyxVoiceSettings;
    expect(s.provider).toBe("local");
    expect(s.elevenlabs.keySet).toBe(false);
  });

  it("Stimme importieren: Katalog-Kennung bzw. sherpa-onnx-Adresse gehen an den Dienst; fremde Adressen nie", async () => {
    const { app, voice } = await make();
    const byId = await app.request("/api/nyx/voice/import", json("POST", { id: "de_DE-thorsten-low" }));
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ id: "de_DE-thorsten-low", added: true });
    const url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-thorsten-low.tar.bz2";
    expect((await app.request("/api/nyx/voice/import", json("POST", { url }))).status).toBe(200);
    for (const bad of ["https://evil.example/vits-piper-de_DE-x-low.tar.bz2", "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/../vits-piper-de_DE-x-low.tar.bz2"]) {
      const res = await app.request("/api/nyx/voice/import", json("POST", { url: bad }));
      expect(res.status).toBe(400);
    }
    const nc = await app.request("/api/nyx/voice/import", json("POST", { id: "de_DE-pavoque-low" }));
    expect(nc.status).toBe(400);
    expect(((await nc.json()) as { error: string }).error).toMatch(/Lizenz/);
    expect(voice.calls.filter((c) => c.kind === "import")).toHaveLength(3);
  });

  it("ElevenLabs-Klon: WAV-Probe + Name + Bestätigung → /v1/voices/add (multipart), ohne Bestätigung nicht", async () => {
    const { app, el } = await make();
    await app.request("/api/nyx/voice/elevenlabs/key", json("PUT", { value: EL_KEY }));
    const form = (consent: boolean, file = new File([new Uint8Array([82, 73, 70, 70, 1, 2])], "meine-stimme.wav", { type: "audio/wav" })) => {
      const f = new FormData();
      f.append("name", "Alex");
      f.append("file", file);
      if (consent) f.append("consent", "1");
      return { method: "POST", body: f };
    };
    const noConsent = await app.request("/api/nyx/voice/elevenlabs/clone", form(false));
    expect(noConsent.status).toBe(400);
    const wrongType = await app.request("/api/nyx/voice/elevenlabs/clone", form(true, new File([new Uint8Array([1])], "x.txt", { type: "text/plain" })));
    expect(wrongType.status).toBe(415);
    expect(el.clones).toHaveLength(0);
    const ok = await app.request("/api/nyx/voice/elevenlabs/clone", form(true));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "neuKlon1", name: "Alex" });
    expect(el.clones).toEqual([{ name: "Alex", fileName: "meine-stimme.wav", type: "audio/wav", size: 6 }]);
    expect(el.calls.find((c) => c.url.endsWith("/v1/voices/add"))?.key).toBe(EL_KEY);
  });

  it("ElevenLabs-Klon: zu große Probe → 413", async () => {
    const { app, el } = await make();
    await app.request("/api/nyx/voice/elevenlabs/key", json("PUT", { value: EL_KEY }));
    const f = new FormData();
    f.append("name", "Gross");
    f.append("consent", "1");
    f.append("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "gross.wav", { type: "audio/wav" }));
    const res = await app.request("/api/nyx/voice/elevenlabs/clone", { method: "POST", body: f });
    expect(res.status).toBe(413);
    expect(el.clones).toHaveLength(0);
  });
});
