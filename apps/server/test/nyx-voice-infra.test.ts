// Stimme auf dem Server — Betrieb: Compose-Dienst `nyx-voice` (Grenzen, Netz, Volume, kein Port),
// Verbindungs-Prüfung und die HTTP-Anbindung der API an den Dienst.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionsReport } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { HttpNyxVoiceBackend, NyxVoiceBackendError, nyxVoiceBackendFromEnv } from "../src/nyx/voice-backend.js";
import { setup } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function service(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `Dienst ${name} fehlt`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[a-z]/.test(l) || /^[a-z]/.test(l));
  return rest
    .slice(0, end === -1 ? undefined : end)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}
const networksOf = (block: string) => [.../networks:\n((?:\s+- [\w-]+\n?)+)/.exec(block)?.[1]?.matchAll(/- ([\w-]+)/g) ?? []].map((m) => m[1]);

describe("Compose: nyx-voice", () => {
  const compose = read("infra/docker-compose.yml");
  const voice = service(compose, "nyx-voice");
  const api = service(compose, "api");

  it("Grenzen: höchstens 4 CPUs und 6 GB, damit andere Dienste nie leiden", () => {
    expect(voice).toMatch(/cpus: "4\.0"/);
    expect(voice).toMatch(/memory: 6g/);
    expect(voice).toMatch(/NYX_THREADS: "4"/);
  });

  it("kein Host-Port, nur das eigene Netz nyxos-voice (das nur die API teilt)", () => {
    expect(voice).not.toMatch(/^\s+ports:/m);
    expect(voice).not.toMatch(/network_mode/);
    expect(networksOf(voice)).toEqual(["voice"]);
    expect(networksOf(api)).toContain("voice");
    for (const other of ["agent", "ntfy", "dozzle", "socket-proxy"]) expect(networksOf(service(compose, other)), other).not.toContain("voice");
    expect(compose).toMatch(/ {2}voice:\n {4}name: nyxos-voice\n/);
    expect(api).toMatch(/NYXOS_NYX_VOICE_URL: http:\/\/nyx-voice:8090/);
  });

  it("Modelle im Volume, nie im Abbild; Container schreibgeschützt, ohne Rechte, eigenes Profil", () => {
    expect(voice).toMatch(/- nyxos-nyx-voice-models:\/models/);
    expect(compose).toMatch(/ {2}nyxos-nyx-voice-models:\n {4}name: nyxos-nyx-voice-models/);
    expect(voice).toMatch(/profiles: \["voice"\]/);
    expect(voice).toMatch(/read_only: true/);
    expect(voice).toMatch(/cap_drop:\n\s+- ALL/);
    expect(voice).toMatch(/no-new-privileges:true/);
    expect(voice).not.toMatch(/docker\.sock|env_file/);
    const dockerfile = read("infra/nyx-voice/Dockerfile");
    expect(dockerfile).not.toMatch(/\.onnx|\.tar\.bz2|releases\/download/);
    expect(dockerfile).toMatch(/^FROM python:\d+\.\d+\.\d+-slim-bookworm$/m);
    expect(dockerfile).toMatch(/^USER nyx$/m);
    expect(dockerfile).toMatch(/python -m unittest discover -s tests/);
  });

  it("Lizenzen sauber: sherpa-onnx fest versioniert, kein piper1-gpl, jedes Modell mit Prüfsumme", () => {
    const req = read("infra/nyx-voice/requirements.txt");
    expect(req).toMatch(/^sherpa-onnx==\d+\.\d+\.\d+$/m);
    expect(req).not.toMatch(/piper/i);
    const catalog = read("infra/nyx-voice/nyx_voice/catalog.py");
    const urls = [...catalog.matchAll(/url=f"\{RELEASES\}\/[^"]+"/g)];
    const shas = [...catalog.matchAll(/sha256="([0-9a-f]{64})"/g)];
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(shas.length).toBe(urls.length);
    expect(read("NOTICE")).toMatch(/sherpa-onnx/);
  });
});

describe("Verbindungs-Prüfung", () => {
  const ready = { stt: { id: "p", state: "ready", ready: true, bytesDone: 1, bytesTotal: 1, error: null, loadMs: 1, model: "parakeet-tdt-0.6b-v3-int8", language: "de" }, tts: { id: "t", state: "ready", ready: true, bytesDone: 1, bytesTotal: 1, error: null, loadMs: 1, voice: "de_DE-thorsten-high", voices: [] }, threads: 3, uptimeS: 1 };
  const fetchWith = (body: unknown) => (async (url: string) => (String(url).endsWith("/health") ? new Response(JSON.stringify(body), { status: 200 }) : Promise.reject(new TypeError("fetch failed")))) as unknown as typeof fetch;
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  async function check(env: Record<string, string>, fetchImpl: typeof fetch) {
    const t = await setup({ connections: { overrides: { fetch: fetchImpl, env: { PATH: "/nirgends", ...env }, findBin: () => null, worker: null } } });
    const r = (await (await t.app.request("/api/connections?fresh=1")).json()) as ConnectionsReport;
    const c = r.checks.find((x) => x.id === "nyx-voice");
    if (!c) throw new Error("Prüfung nyx-voice fehlt");
    return c;
  }

  it("bereit → ok mit Modell + Stimme", async () => {
    const c = await check({ NYXOS_NYX_VOICE_URL: "http://nyx-voice:8090" }, fetchWith(ready));
    expect(c).toMatchObject({ state: "ok", group: "betrieb" });
    expect(c.result).toMatch(/parakeet.*thorsten/);
  });

  it("lädt noch → Warnung mit Fortschritt, nicht rot", async () => {
    const c = await check({ NYXOS_NYX_VOICE_URL: "http://nyx-voice:8090" }, fetchWith({ ...ready, stt: { ...ready.stt, state: "downloading", ready: false, bytesDone: 50, bytesTotal: 100 } }));
    expect(c.state).toBe("warn");
    expect(c.cause).toMatch(/lädt Modell/);
  });

  it("Dienst weg → rot mit fertigem Befehl; nicht eingerichtet → Warnung", async () => {
    const off = await check({ NYXOS_NYX_VOICE_URL: "http://nyx-voice:8090" }, offline);
    expect(off).toMatchObject({ state: "fail", command: "docker compose --profile voice up -d" });
    expect(off.cause).not.toMatch(/fetch failed|ECONN/);
    const none = await check({}, offline);
    expect(none.state).toBe("warn");
    expect(none.cause).toMatch(/nicht eingerichtet/);
  });

});

describe("HTTP-Anbindung an den Dienst", () => {
  it("nur mit NYXOS_NYX_VOICE_URL eingerichtet", () => {
    expect(nyxVoiceBackendFromEnv({})).toBeNull();
    expect(nyxVoiceBackendFromEnv({ NYXOS_NYX_VOICE_URL: "http://nyx-voice:8090" })).toBeInstanceOf(HttpNyxVoiceBackend);
  });

  it("Fehler des Dienstes kommen als Code an, Netzfehler als „offline“; Audio + Kopfzeilen gehen durch", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.includes("/transcribe")) return new Response(JSON.stringify({ error: "loading", message: "lädt" }), { status: 503 });
      if (url.includes("/speak")) return new Response(new Uint8Array([79, 103, 103, 83]), { status: 200, headers: { "content-type": "audio/ogg", "x-nyx-voice": "de_DE-thorsten-high", "x-nyx-ms": "321", "x-nyx-audio-seconds": "1.5" } });
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const b = new HttpNyxVoiceBackend("http://nyx-voice:8090/", fake);
    await expect(b.transcribe(new Uint8Array([1]), { mime: "audio/ogg", language: "de" })).rejects.toMatchObject({ code: "loading", status: 503 });
    expect(seen[0]?.url).toBe("http://nyx-voice:8090/transcribe?language=de");
    expect((seen[0]?.init.headers as Record<string, string>)["content-type"]).toBe("audio/ogg");
    const s = await b.speak({ text: "Hi" }, "ogg");
    expect(s).toMatchObject({ contentType: "audio/ogg", voice: "de_DE-thorsten-high", ms: 321, audioSeconds: 1.5 });
    expect([...s.audio]).toEqual([79, 103, 103, 83]);
    expect(seen[1]?.url).toBe("http://nyx-voice:8090/speak?format=ogg");
    const err = await b.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NyxVoiceBackendError);
    expect((err as NyxVoiceBackendError).code).toBe("offline");
  });
});
