// Nyx spricht Deutsch UND Englisch mit zwei getrennten Stimmen. Web-Seite: Einstellungen „Deutsche
// Stimme“ / „Englische Stimme“ (+ Probe hören), `voiceEn` geht bei jedem Sprechen mit, der Strom meldet alle
// benutzten Stimmen (`x-nyx-voices`).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playNyxSpeechStream, speakRequestBody } from "../src/lib/nyxSpeechStream";
import { SettingsPanel } from "../src/features/nyx/tab/panels/SettingsPanel";
import { DEFAULT_SETTINGS, NYX_SETTINGS_KEY, __resetNyxSettingsCache, saveNyxSettings } from "../src/features/nyx/tab/settings";
import { synthesize } from "../src/features/nyx/voice/serverVoice";
import { __primeAuthForTests, __resetAuthForTests } from "../src/features/terminal/authClient";
import { MemoryRouter } from "react-router";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => __primeAuthForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAuthForTests();
  localStorage.clear();
  __resetNyxSettingsCache();
});

function header(sampleRate: number): Uint8Array {
  const h = new Uint8Array(44);
  const v = new DataView(h.buffer);
  h.set(new TextEncoder().encode("RIFF"), 0);
  v.setUint32(4, 0xffffffff, true);
  h.set(new TextEncoder().encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  h.set(new TextEncoder().encode("data"), 36);
  v.setUint32(40, 0xffffffff, true);
  return h;
}

class FakeContext {
  currentTime = 1;
  destination = {};
  sources: { onended: (() => void) | null }[] = [];
  resume() {
    return Promise.resolve();
  }
  createBuffer(_ch: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const s = { buffer: null, onended: null as (() => void) | null, playbackRate: { value: 1 }, connect() {}, start() {}, stop() {} };
    this.sources.push(s);
    return s;
  }
}

describe("Körper für /speak", () => {
  it("schickt deutsche und englische Stimme + feste Sprache nur, wenn gesetzt", () => {
    expect(speakRequestBody("Hallo.", {})).toEqual({ text: "Hallo." });
    expect(speakRequestBody("Hi.", { voice: "pocket-juergen", voiceEn: "pocket-en-george", language: "en", speed: 1.2 })).toEqual({
      text: "Hi.",
      voice: "pocket-juergen",
      voiceEn: "pocket-en-george",
      language: "en",
      speed: 1.2,
    });
    // „auto“ ist der Standard des Servers – muss nicht mit
    expect(speakRequestBody("Hi.", { voiceEn: null, language: "auto" })).toEqual({ text: "Hi." });
  });

  it("gestreamt: voiceEn geht mit, x-nyx-voices nennt beide Stimmen", async () => {
    const ctx = new FakeContext();
    let seen: unknown = null;
    const rate = 24_000;
    const p = playNyxSpeechStream("Der Build ist fertig. The deploy is done.", {
      voice: "pocket-juergen",
      voiceEn: "pocket-en-george",
      context: ctx as unknown as AudioContext,
      fetchImpl: async (_url, init) => {
        seen = JSON.parse(String(init.body));
        const body = new Uint8Array(rate * 0.1 * 2);
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(header(rate));
              c.enqueue(body);
              c.close();
            },
          }),
          { headers: { "x-nyx-voice": "pocket-juergen", "x-nyx-voices": "pocket-juergen,pocket-en-george", "x-nyx-voice-fallback": "0" } },
        );
      },
    });
    const started = await p.started;
    expect(seen).toEqual({ text: "Der Build ist fertig. The deploy is done.", voice: "pocket-juergen", voiceEn: "pocket-en-george" });
    expect(started.voices).toEqual(["pocket-juergen", "pocket-en-george"]);
    p.stop();
    await p.done;
  });

  it("ganzes WAV (synthesize): voiceEn + Sprache im Körper", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response(new Blob(["x"]), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await synthesize("Hi Alex.", { voiceEn: "en_US-ljspeech-high", language: "en" });
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/nyx/voice/speak"));
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ text: "Hi Alex.", voiceEn: "en_US-ljspeech-high", language: "en" });
  });
});

describe("Einstellungen (voiceEn)", () => {
  it("Standard ohne englische Stimme; gespeicherte wird geladen, Unsinn ignoriert", () => {
    expect(DEFAULT_SETTINGS.voiceEn).toBeNull();
    saveNyxSettings({ voiceEn: "pocket-en-george" });
    __resetNyxSettingsCache();
    expect(JSON.parse(localStorage.getItem(NYX_SETTINGS_KEY) ?? "{}").voiceEn).toBe("pocket-en-george");
    localStorage.setItem(NYX_SETTINGS_KEY, JSON.stringify({ voice: "pocket-juergen", voiceEn: 42 }));
    __resetNyxSettingsCache();
    // read() läuft über den Hook-Snapshot → über saveNyxSettings({}) den aktuellen Stand holen
    const events: unknown[] = [];
    window.addEventListener("nyx:settings", (e) => events.push((e as CustomEvent).detail), { once: true });
    saveNyxSettings({});
    expect(events[0]).toMatchObject({ voice: "pocket-juergen", voiceEn: null });
  });
});

const STATUS = {
  stt: { model: "parakeet-tdt-0.6b-v3-int8", ready: true, language: "de" },
  tts: {
    voice: "pocket-juergen",
    voiceEn: "pocket-en-george",
    ready: true,
    voiceInfo: [
      { id: "pocket-juergen", label: "Jürgen (natürlich)", ready: true, state: "ready", engine: "pocket", streaming: true, rtf: 0.3, language: "de" },
      { id: "de_DE-thorsten-medium", label: "Thorsten (schnell)", ready: true, state: "ready", engine: "piper", streaming: false, rtf: 0.04, language: "de" },
      { id: "pocket-en-george", label: "George (englisch, natürlich)", ready: true, state: "ready", engine: "pocket", streaming: true, rtf: 0.3, language: "en" },
      { id: "en_US-ljspeech-high", label: "Linda (englisch, schnell)", ready: false, state: "loading", engine: "piper", streaming: false, rtf: null, language: "en" },
    ],
  },
};

function stubFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/nyx/voice/status")) return jsonResponse(STATUS);
    if (url.includes("/api/haiku/status")) return jsonResponse({ engine: { model: "Haiku", state: "ready", reason: null } });
    if (url.includes("/api/nyx/voice/speak")) return Promise.resolve(new Response(new Blob(["RIFF"], { type: "audio/wav" }), { status: 200 }));
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPanel(onChange = vi.fn(), settings = DEFAULT_SETTINGS) {
  renderWithClient(
    <MemoryRouter>
      <SettingsPanel settings={settings} onChange={onChange} />
    </MemoryRouter>,
  );
  return onChange;
}

describe("SettingsPanel: zwei Stimmen", () => {
  it("zeigt „Deutsche Stimme“ nur mit deutschen und „Englische Stimme“ nur mit englischen Stimmen", async () => {
    stubFetch();
    renderPanel();
    const de = (await screen.findByLabelText("Deutsche Stimme")) as HTMLSelectElement;
    const en = screen.getByLabelText("Englische Stimme") as HTMLSelectElement;
    await waitFor(() => expect(en.options.length).toBe(3));
    const deTexts = [...de.options].map((o) => o.textContent);
    const enTexts = [...en.options].map((o) => o.textContent);
    expect(deTexts).toEqual(["Standard des Servers (Jürgen (natürlich))", "Jürgen (natürlich)", "Thorsten (schnell)"]);
    expect(enTexts).toEqual(["Standard des Servers (George (englisch, natürlich))", "George (englisch, natürlich)", "Linda (englisch, schnell) – lädt noch"]);
  });

  it("Auswahl der englischen Stimme speichert voiceEn, nicht voice", async () => {
    stubFetch();
    const onChange = renderPanel();
    const en = (await screen.findByLabelText("Englische Stimme")) as HTMLSelectElement;
    await waitFor(() => expect(en.options.length).toBe(3));
    fireEvent.change(en, { target: { value: "pocket-en-george" } });
    expect(onChange).toHaveBeenCalledWith({ voiceEn: "pocket-en-george" });
    fireEvent.change(en, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ voiceEn: null });
  });

  it("Probe hören (englisch) schickt den englischen Satz mit language en und nur der englischen Stimme", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:probe", revokeObjectURL: () => undefined }));
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    renderPanel(vi.fn(), { ...DEFAULT_SETTINGS, voice: "de_DE-thorsten-medium", voiceEn: "pocket-en-george" });
    // Erster Knopf = deutsch, zweiter = englisch
    const buttons = await screen.findAllByRole("button", { name: "Probe hören" });
    expect(buttons).toHaveLength(2);
    fetchMock.mockClear();
    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/nyx/voice/speak"))).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/nyx/voice/speak"));
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toMatchObject({ language: "en", voiceEn: "pocket-en-george" });
    expect(body.voice).toBeUndefined();
    expect(body.text).toMatch(/I'm Nyx/);
    await waitFor(() => expect(play).toHaveBeenCalled());

    fetchMock.mockClear();
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/nyx/voice/speak"))).toBe(true));
    const deBody = JSON.parse(String(fetchMock.mock.calls.find(([u]) => String(u).includes("/api/nyx/voice/speak"))?.[1]?.body));
    expect(deBody).toMatchObject({ language: "de", voice: "de_DE-thorsten-medium" });
    expect(deBody.voiceEn).toBeUndefined();
    expect(deBody.text).toMatch(/ich bin Nyx/);
  });
});
