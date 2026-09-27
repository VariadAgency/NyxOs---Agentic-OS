// Einstellungen → Nyx → Stimme im lokalen Modus: EIN Knopf installiert das Stimmen-Paket, jeder Schritt ist zu sehen,
// danach der Download der Sprachmodelle; Entfernen nur mit Rückfrage. Im Server-Modus gibt es den Block nicht.
import type { NyxVoiceStatus, VoicePackStatus } from "@nyxos/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NyxVoiceSettings } from "../src/features/settings/nyx/NyxVoiceSettings";
import { __primeAuthForTests, __resetAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => __primeAuthForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  __resetAuthForTests();
});

const pack = (over: Partial<VoicePackStatus>): VoicePackStatus => ({ state: "not_installed", installed: false, step: null, progress: null, error: null, downloadBytes: 800_000_000, ffmpeg: null, ...over });
const part = (ready: boolean, progress: number | null = null) => ({ ready, state: ready ? "ready" : "downloading", progress, bytesTotal: 487_170_055 }) as const;
const voice = (sttReady: boolean, progress: number | null = null): NyxVoiceStatus => ({
  scope: "local",
  stt: { ...part(sttReady, progress), model: "parakeet-tdt-0.6b-v3-int8", language: "auto" },
  tts: { ...part(true), voice: "de_DE-thorsten-medium", voices: ["de_DE-thorsten-medium"], voiceInfo: [] },
  sentence: sttReady ? "Stimme bereit." : `Stimme startet noch – lädt Modell (0,5 GB) … ${progress ?? 0} %`,
  fix: null,
});

function stub(opts: { mode?: "local" | "server"; packs: VoicePackStatus[]; voice?: { current: NyxVoiceStatus } }) {
  const packs = [...opts.packs];
  const voiceNow = opts.voice ?? { current: voice(true) };
  const next = <T,>(list: T[]) => (list.length > 1 ? (list.shift() as T) : (list[0] as T));
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/app/info") return jsonResponse({ mode: opts.mode ?? "local", demo: false, settings: { userName: "", lang: "de" } });
    if (url === "/api/nyx/voice/pack" && method === "GET") return jsonResponse(next(packs));
    if (url === "/api/nyx/voice/pack/install" && method === "POST") return jsonResponse(pack({ state: "installing", step: "check" }), { status: 202 });
    if (url === "/api/nyx/voice/pack/remove" && method === "POST") return jsonResponse(pack({ state: "removing", installed: true }), { status: 202 });
    if (url === "/api/nyx/voice/status") return jsonResponse(voiceNow.current);
    if (url === "/api/nyx/voice/settings") return jsonResponse({ provider: "local", elevenlabs: { keySet: false, last4: null, voiceId: null, voiceName: null, model: "eleven_multilingual_v2" }, lexicon: [], updatedAt: null });
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (m: ReturnType<typeof stub>, url: string, method: string) => m.mock.calls.filter(([u, i]) => String(u) === url && (i?.method ?? "GET") === method);

describe("Stimmen-Paket in den Einstellungen (lokal)", () => {
  it("nicht installiert: ein Knopf, Größe dabei, keine leeren Stimmen-Listen; Klick startet die Installation mit Schritten", async () => {
    const m = stub({ packs: [pack({}), pack({ state: "installing", step: "python" })] });
    renderWithClient(<NyxVoiceSettings />);
    const button = await screen.findByRole("button", { name: "Stimme installieren" });
    expect(screen.getByText(/0,8 GB Download/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Eigene Stimmen")).not.toBeInTheDocument());
    fireEvent.click(button);
    await waitFor(() => expect(calls(m, "/api/nyx/voice/pack/install", "POST")).toHaveLength(1));
    // JSON-Körper + CSRF wie jede schreibende Anfrage (authFetch)
    const headers = new Headers(calls(m, "/api/nyx/voice/pack/install", "POST")[0]?.[1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-nyxos-csrf")).toBeTruthy();
    expect(await screen.findByText("Schritt 1 von 5: Speicherplatz prüfen …")).toBeInTheDocument();
    expect(await screen.findByText("Schritt 3 von 5: Python einrichten …", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("installiert: erst der Modell-Download mit Fortschritt, dann „läuft“; Entfernen nur nach Rückfrage", async () => {
    const models = { current: voice(false, 42) };
    const m = stub({ packs: [pack({ state: "running", installed: true, ffmpeg: "imageio-ffmpeg" })], voice: models });
    renderWithClient(<NyxVoiceSettings />);
    const bar = await screen.findByRole("progressbar", { name: "Sprachmodelle" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("Stimme startet noch – lädt Modell (0,5 GB) … 42 %")).toBeInTheDocument();
    models.current = voice(true);
    expect(await screen.findByText("Die Stimme läuft auf diesem Computer ✓", {}, { timeout: 4000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stimme entfernen …" }));
    expect(calls(m, "/api/nyx/voice/pack/remove", "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Ja, entfernen" }));
    await waitFor(() => expect(calls(m, "/api/nyx/voice/pack/remove", "POST")).toHaveLength(1));
  });

  it("fehlgeschlagen: der Satz vom Server und der Knopf zum erneuten Versuch", async () => {
    stub({ packs: [pack({ state: "failed", error: "Zu wenig freier Speicher – die Stimme braucht etwa 2 GB." })] });
    renderWithClient(<NyxVoiceSettings />);
    expect(await screen.findByText("Zu wenig freier Speicher – die Stimme braucht etwa 2 GB.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stimme installieren" })).toBeInTheDocument();
  });

  it("Server-Modus: kein Paket-Block, keine Anfrage danach", async () => {
    const m = stub({ mode: "server", packs: [pack({})] });
    renderWithClient(<NyxVoiceSettings />);
    expect(await screen.findByText("Eigene Stimmen")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(m, "/api/nyx/voice/pack", "GET")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Stimme installieren" })).not.toBeInTheDocument();
  });
});
