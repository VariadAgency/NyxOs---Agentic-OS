// Stimme auf dem Server: `POST /api/nyx/voice/transcribe`, `POST /api/nyx/voice/speak`,
// `GET /api/nyx/voice/status` gegen einen nachgebauten Stimmen-Dienst (kein Netz, keine Modelle).
// Geprüft: Vertrag (Felder, Formate), Anmeldung + CSRF, 25-MB-Grenze, einfache deutsche Sätze statt
// Technik-Meldungen, Brücke als Rückfall, und dass `/api/voice/*` jetzt zuerst den Server nimmt.
import type { NyxVoiceStatus } from "@nyxos/shared";
import { fixNyxName, fixNyxNameEn, fixTranscript, fixTranscriptFor, NYX_VOICE_MAX_AUDIO_BYTES, splitSpeakable } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { NyxVoiceBackendError, type NyxVoiceBackend, type NyxVoiceRawStatus } from "../src/nyx/voice-backend.js";
import type { RpcOutcome } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type PartOverrides = { state?: string; bytesDone?: number; bytesTotal?: number; error?: string | null };

function rawStatus(stt: PartOverrides = {}, tts: PartOverrides = {}): NyxVoiceRawStatus {
  const part = (id: string, o: PartOverrides, size: number) => ({
    id,
    state: o.state ?? "ready",
    ready: (o.state ?? "ready") === "ready",
    bytesDone: o.bytesDone ?? size,
    bytesTotal: o.bytesTotal ?? size,
    error: o.error ?? null,
    loadMs: 900,
    license: "x",
  });
  const voice = part("de_DE-thorsten-high", tts, 115_591_546);
  return {
    stt: { ...part("parakeet-tdt-0.6b-v3-int8", stt, 487_170_055), model: "parakeet-tdt-0.6b-v3-int8", language: "de" },
    tts: { ...voice, voice: "de_DE-thorsten-high", voices: [voice, part("de_DE-thorsten-medium", {}, 67_214_254)] },
    threads: 3,
    uptimeS: 12,
  };
}

type Call = { kind: "transcribe" | "speak"; args: unknown[] };

function fakeBackend(opts: { status?: NyxVoiceRawStatus | "offline"; transcribeError?: NyxVoiceBackendError; speakError?: NyxVoiceBackendError } = {}) {
  const calls: Call[] = [];
  const status = opts.status ?? rawStatus();
  const backend: NyxVoiceBackend = {
    async status() {
      if (status === "offline") throw new NyxVoiceBackendError("offline", 503, "getaddrinfo ENOTFOUND nyx-voice");
      return status;
    },
    async transcribe(audio, o) {
      calls.push({ kind: "transcribe", args: [audio, o] });
      if (status === "offline") throw new NyxVoiceBackendError("offline", 503, "ECONNREFUSED");
      if (opts.transcribeError) throw opts.transcribeError;
      if (!status.stt.ready) throw new NyxVoiceBackendError(status.stt.state === "error" ? "error" : "loading", 503, "lädt");
      return { text: "Starte die NyxOS", language: o.language, ms: 412, audioSeconds: 5, model: "parakeet-tdt-0.6b-v3-int8" };
    },
    async speak(req, format) {
      calls.push({ kind: "speak", args: [req, format] });
      if (status === "offline") throw new NyxVoiceBackendError("offline", 503, "ECONNREFUSED");
      if (opts.speakError) throw opts.speakError;
      if (!status.tts.ready) throw new NyxVoiceBackendError("loading", 503, "lädt");
      const audio = format === "wav" ? new TextEncoder().encode("RIFF....WAVE") : new TextEncoder().encode("OggS....");
      return { audio, contentType: format === "wav" ? "audio/wav" : "audio/ogg", voice: req.voice ?? "de_DE-thorsten-high", ms: 380, audioSeconds: 2.1 };
    },
  };
  return { backend, calls };
}

function fakeHub(opts: { online: boolean; caps?: string[]; text?: string }) {
  const calls: string[] = [];
  return {
    calls,
    hub: {
      online: opts.online,
      supports: (cap: string) => (opts.caps ?? []).includes(cap),
      rpc: async (method: string): Promise<RpcOutcome> => {
        calls.push(method);
        if (method === "voice_probe") return { ok: true, result: { ok: true, model: "ggml-small.bin" } };
        if (method === "transcribe") return { ok: true, result: { outcome: "done", text: opts.text ?? "vom Mac", tookMs: 700, model: "ggml-small.bin" } };
        return { ok: false, error: "unbekannt" };
      },
      status: () => ({ online: opts.online, machineId: null, since: null }),
    },
  };
}

const NO_LOCAL = { binPath: "/gibt/es/nicht", modelPath: "" };
const TECH = /ENOTFOUND|ECONNREFUSED|getaddrinfo|fetch failed|nyx-voice:8090|stack|undefined/;
const audioPost = (body: Uint8Array, type = "audio/webm;codecs=opus") => ({ method: "POST", headers: { "content-type": type }, body });
const jsonPost = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET /api/nyx/voice/status", () => {
  it("bereit → Vertrag {stt:{model,ready}, tts:{voice,ready}} + Satz", async () => {
    const { backend } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as NyxVoiceStatus;
    expect(body.stt).toMatchObject({ model: "parakeet-tdt-0.6b-v3-int8", ready: true, state: "ready" });
    expect(body.tts).toMatchObject({ voice: "de_DE-thorsten-high", ready: true, voices: ["de_DE-thorsten-high", "de_DE-thorsten-medium"] });
    expect(body.sentence).toMatch(/Stimme bereit/);
    expect(body.fix).toBeNull();
  });

  it("lädt noch → sagt, wie groß das Modell ist und wie weit es ist", async () => {
    const { backend } = fakeBackend({ status: rawStatus({ state: "downloading", bytesDone: 243_585_027, bytesTotal: 487_170_055 }) });
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const body = (await (await app.request("/api/nyx/voice/status")).json()) as NyxVoiceStatus;
    expect(body.stt).toMatchObject({ ready: false, state: "downloading", progress: 50 });
    expect(body.sentence).toBe("Stimme startet noch – lädt Modell (0,5 GB) … 50 %");
  });

  it("Dienst nicht erreichbar → 200 mit ehrlichem Satz + Befehl, keine Technik-Meldung", async () => {
    const { backend } = fakeBackend({ status: "offline" });
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as NyxVoiceStatus;
    expect(body.stt).toMatchObject({ ready: false, state: "offline", model: null });
    expect(body.tts).toMatchObject({ ready: false, state: "offline" });
    expect(body.sentence).toMatch(/Die Stimme läuft gerade nicht/);
    expect(body.fix).toMatch(/docker compose --profile voice up -d/);
    expect(JSON.stringify(body)).not.toMatch(TECH);
  });

  it("ohne Stimmen-Dienst (nicht eingerichtet) → nicht_eingerichtet, kein Absturz", async () => {
    const { app } = await setup({ voice: { nyx: null, whisperConfig: NO_LOCAL } });
    const body = (await (await app.request("/api/nyx/voice/status")).json()) as NyxVoiceStatus;
    expect(body.stt.state).toBe("not_configured");
    expect(body.sentence).toMatch(/nicht eingerichtet/);
  });
});

describe("POST /api/nyx/voice/transcribe", () => {
  it("Audio (webm) geht roh an den Dienst → {text, language, ms}", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const audio = new Uint8Array([1, 2, 3, 4]);
    const res = await app.request("/api/nyx/voice/transcribe", audioPost(audio));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "Starte die NyxOS", language: "de", ms: 412, audioSeconds: 5, engine: "server", model: "parakeet-tdt-0.6b-v3-int8" });
    expect(calls[0]?.kind).toBe("transcribe");
    expect([...(calls[0]?.args[0] as Uint8Array)]).toEqual([1, 2, 3, 4]);
    expect(calls[0]?.args[1]).toEqual({ mime: "audio/webm", language: "auto" }); // keine feste Sprache
  });

  it("Telegram-Sprachnachricht (audio/ogg) und ?language=en werden durchgereicht", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/transcribe?language=en", audioPost(new Uint8Array([9]), "audio/ogg"));
    expect(res.status).toBe(200);
    expect(calls[0]?.args[1]).toEqual({ mime: "audio/ogg", language: "en" });
  });

  it("ohne Anmeldung 401, mit falschem CSRF-Schlüssel 403 — der Dienst wird nie gefragt", async () => {
    const { backend, calls } = fakeBackend();
    const anon = await setup({ signedIn: false, voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    expect((await anon.app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1])))).status).toBe(401);
    const signed = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await signed.app.request("/api/nyx/voice/transcribe", { method: "POST", headers: { "content-type": "audio/webm", "x-nyxos-csrf": "falsch" }, body: new Uint8Array([1]) });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("mehr als 25 MB → 413 mit Satz; leer → 400", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const big = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array(NYX_VOICE_MAX_AUDIO_BYTES + 1)));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/zu lang/);
    const empty = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array(0)));
    expect(empty.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("Modell lädt noch, Brücke getrennt → 503 „Stimme startet noch – lädt Modell (0,5 GB) …“", async () => {
    const { backend } = fakeBackend({ status: rawStatus({ state: "downloading", bytesDone: 48_717_005, bytesTotal: 487_170_055 }) });
    const { hub } = fakeHub({ online: false });
    const { app } = await setup({ bridgeHub: hub as never, voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1])));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("Stimme startet noch – lädt Modell (0,5 GB) … 10 %");
    expect(body.reason).toBe("loading");
  });

  it("Server-Stimme weg, Brücke bereit → Rückfall auf den Rechner (engine mac)", async () => {
    const { backend } = fakeBackend({ status: "offline" });
    const { hub, calls } = fakeHub({ online: true, caps: ["voice"], text: "vom Mac erkannt" });
    const { app } = await setup({ bridgeHub: hub as never, voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1, 2])));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "vom Mac erkannt", engine: "mac", language: "de" });
    expect(calls).toContain("transcribe");
  });

  it("unlesbare Aufnahme → 422 mit einfachem Satz", async () => {
    const { backend } = fakeBackend({ transcribeError: new NyxVoiceBackendError("bad_audio", 422, "Invalid data found when processing input") });
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1])));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Aufnahme ließ sich nicht lesen/);
    expect(body.error).not.toMatch(/Invalid data/);
  });
});

describe("POST /api/nyx/voice/speak", () => {
  it("Standard: audio/ogg (Opus); ?format=wav → audio/wav; Stimme + Tempo gehen durch", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const ogg = await app.request("/api/nyx/voice/speak", jsonPost({ text: "Alles klar." }));
    expect(ogg.status).toBe(200);
    expect(ogg.headers.get("content-type")).toBe("audio/ogg");
    expect(ogg.headers.get("x-nyx-voice-ms")).toBe("380");
    expect(new TextDecoder().decode(await ogg.arrayBuffer())).toMatch(/^OggS/);
    const wav = await app.request("/api/nyx/voice/speak?format=wav", jsonPost({ text: "Hallo.", voice: "de_DE-thorsten-medium", speed: 1.2 }));
    expect(wav.headers.get("content-type")).toBe("audio/wav");
    expect(calls.map((c) => c.args)).toEqual([
      [{ text: "Alles klar.", defaultLanguage: "de" }, "ogg"],
      [{ text: "Hallo.", voice: "de_DE-thorsten-medium", speed: 1.2, defaultLanguage: "de" }, "wav"],
    ]);
  });

  it("leerer/zu langer Text, fremde Stimme, falsches Tempo → 400 mit Satz, Dienst nie gefragt", async () => {
    const { backend, calls } = fakeBackend();
    const { app } = await setup({ voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    for (const body of [{ text: "  " }, { text: "x".repeat(2001) }, { text: "Hi", voice: "../../etc" }, { text: "Hi", speed: 9 }, {}]) {
      const res = await app.request("/api/nyx/voice/speak", jsonPost(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/Text|Stimme|Tempo/);
    }
    expect(calls).toEqual([]);
  });

  it("ohne Anmeldung 401", async () => {
    const { backend } = fakeBackend();
    const { app } = await setup({ signedIn: false, voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    expect((await app.request("/api/nyx/voice/speak", jsonPost({ text: "Hi" }))).status).toBe(401);
  });

  it("Stimme lädt noch → 503 mit Satz; Dienst weg → 503 „läuft gerade nicht“", async () => {
    const loading = fakeBackend({ status: rawStatus({}, { state: "loading" }) });
    const a = await setup({ voice: { nyx: loading.backend, whisperConfig: NO_LOCAL } });
    const r1 = await a.app.request("/api/nyx/voice/speak", jsonPost({ text: "Hi" }));
    expect(r1.status).toBe(503);
    expect(((await r1.json()) as { error: string }).error).toMatch(/Stimme startet noch/);
    const off = fakeBackend({ status: "offline" });
    const b = await setup({ voice: { nyx: off.backend, whisperConfig: NO_LOCAL } });
    const r2 = await b.app.request("/api/nyx/voice/speak", jsonPost({ text: "Hi" }));
    expect(r2.status).toBe(503);
    const body = (await r2.json()) as { error: string; fix: string };
    expect(body.error).toMatch(/läuft gerade nicht/);
    expect(JSON.stringify(body)).not.toMatch(TECH);
  });
});

describe("bisheriges Diktat (/api/voice/*) nimmt zuerst den Server", () => {
  it("Server-Stimme bereit → Diktat läuft auf dem Server, auch wenn der Rechner bereit wäre", async () => {
    const { backend, calls } = fakeBackend();
    const { hub, calls: macCalls } = fakeHub({ online: true, caps: ["voice"] });
    const { app } = await setup({ bridgeHub: hub as never, voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    const health = await app.request("/api/voice/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, engine: "server", model: "parakeet-tdt-0.6b-v3-int8" });
    const res = await app.request("/api/voice/transcribe?target=haiku&audioSeconds=2", audioPost(new Uint8Array([1])));
    expect(await res.json()).toMatchObject({ text: "Starte die NyxOS", engine: "server", target: "haiku", audioSeconds: 2 });
    expect(calls.map((c) => c.kind)).toEqual(["transcribe"]);
    expect(macCalls).not.toContain("transcribe");
  });

  it("Server-Stimme lädt noch → Mac übernimmt (Rückfall)", async () => {
    const { backend } = fakeBackend({ status: rawStatus({ state: "loading" }) });
    const { hub } = fakeHub({ online: true, caps: ["voice"] });
    const { app } = await setup({ bridgeHub: hub as never, voice: { nyx: backend, whisperConfig: NO_LOCAL } });
    expect(await (await app.request("/api/voice/health")).json()).toMatchObject({ ok: true, engine: "mac" });
  });
});

describe("splitSpeakable (satzweise sprechen, erster Satz kurz)", () => {
  it("teilt an Satzenden, der erste Teil ist kurz, nichts geht verloren", () => {
    const text = "Alles klar. Ich starte jetzt die Session für Shop im Ordner App. Danach prüfe ich den Build und melde mich, sobald er grün ist!";
    const parts = splitSpeakable(text);
    expect(parts[0]).toBe("Alles klar.");
    expect(parts.join(" ")).toBe(text);
    expect(parts.every((p) => p.length <= 240)).toBe(true);
  });

  it("sehr lange Sätze ohne Punkt werden an Kommas bzw. Leerzeichen geteilt", () => {
    const text = `${"wort ".repeat(120).trim()}`;
    const parts = splitSpeakable(text);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 240)).toBe(true);
    expect(parts.join(" ")).toBe(text);
  });
});

describe("der Name „Nyx“ (Modelle hören „Nücks“)", () => {
  it("Nücks/Nüks/Nüx/Nicks → Nyx, aber „nix“ und Wörter, die nur so anfangen, bleiben", () => {
    expect(fixNyxName("Hey Nücks, wie viele Aufträge gibt es?")).toBe("Hey Nyx, wie viele Aufträge gibt es?");
    expect(fixNyxName("Nüks. Nüx! Frag Nicks")).toBe("Nyx. Nyx! Frag Nyx");
    expect(fixNyxName("Das macht nix, Nückseite")).toBe("Das macht nix, Nückseite");
    // English: "Nix" only when Nyx is addressed – the Nix package manager stays.
    expect(fixNyxNameEn("Hello, I am Nix. The tests are green.")).toBe("Hello, I am Nyx. The tests are green.");
    expect(fixNyxNameEn("Hey Nix, what is waiting for me?")).toBe("Hey Nyx, what is waiting for me?");
    expect(fixNyxNameEn("Nix, how many sessions run?")).toBe("Nyx, how many sessions run?");
    expect(fixNyxNameEn("Ask Nicks about it")).toBe("Ask Nyx about it");
    expect(fixNyxNameEn("Install it with Nix and home-manager.")).toBe("Install it with Nix and home-manager.");
    expect(fixTranscriptFor("Hey Nücks", "de")).toBe("Hey Nyx");
    expect(fixTranscriptFor("Hey Nix", "en")).toBe("Hey Nyx");
  });

  it("gilt für jede Erkennung über die API (Server und Mac)", async () => {
    const { backend } = fakeBackend();
    const hacked: NyxVoiceBackend = { ...backend, transcribe: async (a, o) => ({ ...(await backend.transcribe(a, o)), text: "Hey Nücks, starte den Build." }) };
    const { app } = await setup({ voice: { nyx: hacked, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1])));
    expect(((await res.json()) as { text: string }).text).toBe("Hey Nyx, starte den Build.");
    const old = await app.request("/api/voice/transcribe", audioPost(new Uint8Array([1])));
    expect(((await old.json()) as { text: string }).text).toBe("Hey Nyx, starte den Build.");
    const mac = fakeHub({ online: true, caps: ["voice"], text: "Nüx, bist du da?" });
    const off = fakeBackend({ status: "offline" });
    const t = await setup({ bridgeHub: mac.hub as never, voice: { nyx: off.backend, whisperConfig: NO_LOCAL } });
    expect(((await (await t.app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1])))).json()) as { text: string }).text).toBe("Nyx, bist du da?");
  });
});

// Fachwörter, die die Erkennung verhört – nur sichere Korrekturen (fester Zusammenhang), Rest bleibt.
describe("Fachwörter in der Erkennung", () => {
  it("„Boilt/Boot/Bild auf den Markt“ → „Build auf dem Mac“, aber nur in genau dieser Wendung", () => {
    expect(fixTranscript("Mach mal einen Boilt auf den Markt.")).toBe("Mach mal einen Build auf dem Mac.");
    expect(fixTranscript("Starte den Boot auf dem Mac")).toBe("Starte den Build auf dem Mac");
    expect(fixTranscript("Bild auf dem Mäc, bitte")).toBe("Build auf dem Mac, bitte");
    expect(fixTranscript("Ist der Boilt grün?")).toBe("Ist der Build grün?");
    // echte Wörter ohne die Wendung bleiben
    expect(fixTranscript("Zeig mir das Bild vom Simulator.")).toBe("Zeig mir das Bild vom Simulator.");
    expect(fixTranscript("Das Boot liegt am Markt.")).toBe("Das Boot liegt am Markt.");
    expect(fixTranscript("Bild auf dem Tisch")).toBe("Bild auf dem Tisch");
  });

  it("Nyx-Name wird korrigiert, fremde Wörter bleiben", () => {
    expect(fixTranscript("Hey Nücks, öffne die Sessions.")).toBe("Hey Nyx, öffne die Sessions.");
    expect(fixTranscript("Der Club verbindet Connect-Leute")).toBe("Der Club verbindet Connect-Leute");
  });

  it("gilt für jede Erkennung über die API", async () => {
    const { backend } = fakeBackend();
    const hacked: NyxVoiceBackend = { ...backend, transcribe: async (a, o) => ({ ...(await backend.transcribe(a, o)), text: "Mach einen Boilt auf den Markt für die App." }) };
    const { app } = await setup({ voice: { nyx: hacked, whisperConfig: NO_LOCAL } });
    const res = await app.request("/api/nyx/voice/transcribe", audioPost(new Uint8Array([1])));
    expect(((await res.json()) as { text: string }).text).toBe("Mach einen Build auf dem Mac für die App.");
    const old = await app.request("/api/voice/transcribe", audioPost(new Uint8Array([1])));
    expect(((await old.json()) as { text: string }).text).toBe("Mach einen Build auf dem Mac für die App.");
  });
});
