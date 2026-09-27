// Sprache über die Brücke: `GET /api/voice/health` war 503 („whisper-cli nicht gefunden“ im Server-Container).
// Entscheidung: Erkennung auf dem Rechner über die Brücke. Hier mit einer nachgebauten Brücke geprüft:
// Gesundheit mit Satz + Schritt, Audio geht als Base64 an die Brücke, Audio-Upload scheitert nicht mehr
// an der JSON-Pflicht (415), braucht aber weiter Anmeldung + CSRF.
import type { VoiceHealth } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import type { RpcOutcome } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type Call = { method: string; params: unknown };

function fakeHub(opts: { online: boolean; caps?: string[]; probe?: unknown; transcribe?: unknown }) {
  const calls: Call[] = [];
  const hub = {
    online: opts.online,
    supports: (cap: string) => (opts.caps ?? []).includes(cap),
    rpc: async (method: string, params: unknown): Promise<RpcOutcome> => {
      calls.push({ method, params });
      if (method === "voice_probe") return { ok: true, result: opts.probe };
      if (method === "transcribe") return { ok: true, result: opts.transcribe };
      return { ok: false, error: "unbekannt" };
    },
    status: () => ({ online: opts.online, machineId: null, since: null }),
  };
  return { hub, calls };
}

// Kein lokales whisper (wie im Server-Container): leerer Modellpfad.
const NO_LOCAL = { whisperConfig: { binPath: "/gibt/es/nicht", modelPath: "" } };

describe("Sprache über die Brücke", () => {
  it("Brücke getrennt → 503 mit einfachem Satz und Schritt (keine Technik-Meldung)", async () => {
    const { hub } = fakeHub({ online: false });
    const { app } = await setup({ bridgeHub: hub as never, voice: NO_LOCAL });
    const res = await app.request("/api/voice/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as VoiceHealth;
    expect(body).toMatchObject({ ok: false, engine: null, reason: "bridge_offline" });
    expect(body.sentence).toMatch(/Brücke ist gerade nicht verbunden/);
    expect(body.sentence).not.toMatch(/whisper-cli|nicht gefunden|ENOENT/);
  });

  it("alte Brücke ohne Sprache → sagt, dass die Brücke aktualisiert werden muss", async () => {
    const { hub } = fakeHub({ online: true, caps: ["run_build"] });
    const { app } = await setup({ bridgeHub: hub as never, voice: NO_LOCAL });
    const body = (await (await app.request("/api/voice/health")).json()) as VoiceHealth;
    expect(body.reason).toBe("bridge_outdated");
    expect(body.fix).toMatch(/nyxos update/);
  });

  it("Mac ohne Modell → genauer Befehl zum Laden", async () => {
    const { hub } = fakeHub({ online: true, caps: ["voice"], probe: { ok: false, reason: "model_missing", detail: "x" } });
    const { app } = await setup({ bridgeHub: hub as never, voice: NO_LOCAL });
    const body = (await (await app.request("/api/voice/health")).json()) as VoiceHealth;
    expect(body.reason).toBe("model_missing");
    expect(body.fix).toMatch(/ggml-small\.bin/);
  });

  it("Mac bereit → 200, Erkennung läuft auf dem Rechner; Audio (audio/webm) kommt durch, als Base64 an die Brücke", async () => {
    const { hub, calls } = fakeHub({ online: true, caps: ["run_build", "voice"], probe: { ok: true, model: "ggml-small.bin" }, transcribe: { outcome: "done", text: "Starte die NyxOS", tookMs: 420, model: "ggml-small.bin" } });
    const { app } = await setup({ bridgeHub: hub as never, voice: NO_LOCAL });
    const health = await app.request("/api/voice/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, engine: "mac", model: "ggml-small.bin" });

    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await app.request("/api/voice/transcribe?target=haiku&audioSeconds=2.5", { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: audio });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "Starte die NyxOS", engine: "mac", tookMs: 420, audioSeconds: 2.5, target: "haiku" });
    const call = calls.find((c) => c.method === "transcribe");
    expect(call?.params).toEqual({ audioB64: Buffer.from(audio).toString("base64"), mime: "audio/webm", language: "de" });
  });

  it("ohne Anmeldung kein Diktat (401), auch wenn die Brücke bereit ist", async () => {
    const { hub } = fakeHub({ online: true, caps: ["voice"], probe: { ok: true, model: "m" }, transcribe: { outcome: "done", text: "x", tookMs: 1, model: "m" } });
    const { app } = await setup({ signedIn: false, bridgeHub: hub as never, voice: NO_LOCAL });
    const res = await app.request("/api/voice/transcribe", { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([1]) });
    expect(res.status).toBe(401);
  });
});
