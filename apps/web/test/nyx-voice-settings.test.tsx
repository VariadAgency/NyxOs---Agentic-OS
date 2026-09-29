// Einstellungen → Nyx → Stimme: eigene Stimmen je Sprache mit Hörprobe, ElevenLabs-Schlüssel (nur „gesetzt ✓“),
// Stimmen-Liste von ElevenLabs, Aussprache-Wörterbuch speichern.
import type { NyxVoiceSettings } from "@nyxos/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NyxVoiceSettings as NyxVoiceSettingsSection } from "../src/features/settings/nyx/NyxVoiceSettings";
import { __primeAuthForTests, __resetAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => __primeAuthForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  __resetAuthForTests();
});

const base: NyxVoiceSettings = {
  provider: "local",
  elevenlabs: { keySet: false, last4: null, voiceId: null, voiceName: null, model: "eleven_multilingual_v2" },
  lexicon: [{ word: "Kanban", say: "Kahnbahn" }],
  updatedAt: null,
};

const status = {
  stt: { ready: true, state: "ready", progress: null, bytesTotal: null, model: "parakeet", language: "auto" },
  tts: {
    ready: true,
    state: "ready",
    progress: null,
    bytesTotal: null,
    voice: "pocket-juergen",
    voiceEn: "pocket-en-george",
    voices: ["pocket-juergen", "pocket-en-george"],
    importable: [
      { id: "pocket-juergen", label: "Jürgen (natürlich)", language: "de", engine: "pocket", license: "CC-BY-4.0", sizeBytes: 225_000_000, installed: true },
      { id: "de_DE-thorsten-low", label: "Thorsten (echte deutsche Stimme, klein)", language: "de", engine: "piper", license: "Datensatz CC0 (Thorsten-Voice)", sizeBytes: 67_101_576, installed: false },
    ],
    voiceInfo: [
      { id: "pocket-juergen", label: "Jürgen (natürlich)", ready: true, state: "ready", engine: "pocket", streaming: true, rtf: 0.4, language: "de" },
      { id: "pocket-en-george", label: "George (natürlich, englisch)", ready: true, state: "ready", engine: "pocket", streaming: true, rtf: 0.4, language: "en" },
    ],
  },
  sentence: "Bereit.",
  fix: null,
};

function stub(settings: NyxVoiceSettings = base) {
  let current = settings;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/nyx/voice/settings" && method === "GET") return jsonResponse(current);
    if (url === "/api/nyx/voice/settings" && method === "PUT") {
      current = { ...current, ...(JSON.parse(String(init?.body)) as Partial<NyxVoiceSettings>) };
      return jsonResponse(current);
    }
    if (url === "/api/nyx/voice/elevenlabs/key" && method === "PUT") {
      current = { ...current, elevenlabs: { ...current.elevenlabs, keySet: true, last4: "WXYZ" } };
      return jsonResponse(current);
    }
    if (url === "/api/nyx/voice/elevenlabs/voices") return jsonResponse({ voices: [{ id: "v2Zb", name: "Zora", category: "premade", description: "female · german", previewUrl: null }] });
    if (url === "/api/nyx/voice/status") return jsonResponse(status);
    if (url === "/api/nyx/voice/import") return jsonResponse({ id: "de_DE-thorsten-low", added: true, state: "downloading" });
    if (url === "/api/nyx/voice/elevenlabs/clone") return jsonResponse({ id: "neuKlon1", name: "Alex" });
    if (url.startsWith("/api/nyx/voice/speak")) return Promise.resolve(new Response(new Uint8Array(60), { status: 200, headers: { "x-nyx-voice": "pocket-juergen" } }));
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (m: ReturnType<typeof stub>, url: string, method: string) => m.mock.calls.filter(([u, i]) => String(u).startsWith(url) && (i?.method ?? "GET") === method);

describe("Stimme in den Nyx-Einstellungen", () => {
  it("zeigt eigene Stimmen je Sprache mit Hörprobe; Hörprobe spricht lokal mit genau dieser Stimme", async () => {
    const m = stub();
    renderWithClient(<NyxVoiceSettingsSection />);
    const row = (await screen.findByText("Jürgen (natürlich)")).closest("li");
    expect(row).not.toBeNull();
    expect(screen.getByText("George (natürlich, englisch)")).toBeInTheDocument();
    // jsdom spielt keinen Ton ab – geprüft wird die Anfrage.
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Hörprobe" }));
    await waitFor(() => expect(calls(m, "/api/nyx/voice/speak?stream=1", "POST")).toHaveLength(1));
    const body = JSON.parse(String(calls(m, "/api/nyx/voice/speak", "POST")[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ provider: "local", voice: "pocket-juergen", language: "de" });
  });

  it("ElevenLabs-Schlüssel: nach dem Speichern nur „gesetzt ✓ …WXYZ“, Feld wieder leer, Stimmen-Liste erscheint", async () => {
    const m = stub();
    renderWithClient(<NyxVoiceSettingsSection />);
    const input = await screen.findByLabelText("ElevenLabs-API-Schlüssel");
    fireEvent.change(input, { target: { value: "sk_test_geheim_WXYZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Prüfen und speichern" }));
    expect(await screen.findByText("Schlüssel gesetzt ✓")).toBeInTheDocument();
    expect(screen.getByText("…WXYZ")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(document.body.textContent).not.toContain("sk_test_geheim");
    expect(await screen.findByText("Zora")).toBeInTheDocument();
    fireEvent.click(within(screen.getByText("Zora").closest("li") as HTMLElement).getByRole("radio"));
    await waitFor(() => expect(calls(m, "/api/nyx/voice/settings", "PUT")).toHaveLength(1));
    expect(JSON.parse(String(calls(m, "/api/nyx/voice/settings", "PUT")[0]?.[1]?.body))).toEqual({ elevenlabsVoiceId: "v2Zb", elevenlabsVoiceName: "Zora" });
  });

  // Absicherung – heute schon grün, weil TanStack Query gleiche Inhalte wiederverwendet (structural sharing);
  // der Vergleich nach Inhalt im Editor hält es auch ohne das.
  it("eine andere Speicherung (Anbieter) löscht ungespeicherte Aussprache-Eingaben nicht", async () => {
    stub();
    renderWithClient(<NyxVoiceSettingsSection />);
    fireEvent.change(await screen.findByLabelText("Aussprache 1"), { target: { value: "Kaan-Baan" } });
    fireEvent.click(screen.getByRole("radio", { name: "Eigene Stimme" }));
    await waitFor(() => expect(screen.getByText("Noch nicht gespeichert")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText("Aussprache 1")).toHaveValue("Kaan-Baan");
  });

  it("Aussprache: Wort hinzufügen und speichern schickt die ganze Liste (leere Zeilen nicht)", async () => {
    const m = stub();
    renderWithClient(<NyxVoiceSettingsSection />);
    expect(await screen.findByDisplayValue("Kanban")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Wort hinzufügen" }));
    fireEvent.change(screen.getByLabelText("Wort 2"), { target: { value: "Session" } });
    fireEvent.change(screen.getByLabelText("Aussprache 2"), { target: { value: "Säschn" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Wort hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Aussprache speichern" }));
    await waitFor(() => expect(calls(m, "/api/nyx/voice/settings", "PUT")).toHaveLength(1));
    expect(JSON.parse(String(calls(m, "/api/nyx/voice/settings", "PUT")[0]?.[1]?.body))).toEqual({
      lexicon: [
        { word: "Kanban", say: "Kahnbahn" },
        { word: "Session", say: "Säschn" },
      ],
    });
  });

  it("Stimme importieren: nur nicht installierte Katalog-Stimmen, Knopf schickt die Kennung; fremde Adresse bleibt gesperrt", async () => {
    const m = stub();
    renderWithClient(<NyxVoiceSettingsSection />);
    const row = (await screen.findByText("Thorsten (echte deutsche Stimme, klein)")).closest("li") as HTMLElement;
    expect(within(row).getByText(/CC0/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Importieren" }));
    await waitFor(() => expect(calls(m, "/api/nyx/voice/import", "POST")).toHaveLength(1));
    expect(JSON.parse(String(calls(m, "/api/nyx/voice/import", "POST")[0]?.[1]?.body))).toEqual({ id: "de_DE-thorsten-low" });
    expect(await screen.findByText(/wird geladen/)).toBeInTheDocument();
    const input = screen.getByLabelText("Adresse eines Piper-Stimmen-Pakets");
    fireEvent.change(input, { target: { value: "https://evil.example/vits-piper-de_DE-x-low.tar.bz2" } });
    expect(screen.getByRole("button", { name: "Paket importieren" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-thorsten-low.tar.bz2" } });
    expect(screen.getByRole("button", { name: "Paket importieren" })).toBeEnabled();
  });

  it("ElevenLabs-Klon: erst mit Name, Datei und Bestätigung; danach ist die neue Stimme gewählt", async () => {
    const m = stub({ ...base, elevenlabs: { ...base.elevenlabs, keySet: true, last4: "WXYZ" } });
    renderWithClient(<NyxVoiceSettingsSection />);
    const form = await screen.findByRole("form", { name: "Eigene Stimme bei ElevenLabs anlegen" });
    const submit = within(form).getByRole("button", { name: "Stimme anlegen" });
    fireEvent.change(within(form).getByLabelText("Name der neuen Stimme"), { target: { value: "Alex" } });
    fireEvent.change(within(form).getByLabelText("Hörprobe (WAV oder MP3)"), { target: { files: [new File([new Uint8Array([1, 2])], "probe.wav", { type: "audio/wav" })] } });
    expect(submit).toBeDisabled();
    fireEvent.click(within(form).getByRole("checkbox"));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(calls(m, "/api/nyx/voice/elevenlabs/clone", "POST")).toHaveLength(1));
    const sent = calls(m, "/api/nyx/voice/elevenlabs/clone", "POST")[0]?.[1]?.body as FormData;
    expect(sent.get("name")).toBe("Alex");
    expect(sent.get("consent")).toBe("1");
    await waitFor(() => expect(calls(m, "/api/nyx/voice/settings", "PUT")).toHaveLength(1));
    expect(JSON.parse(String(calls(m, "/api/nyx/voice/settings", "PUT")[0]?.[1]?.body))).toEqual({ elevenlabsVoiceId: "neuKlon1", elevenlabsVoiceName: "Alex" });
  });
});
