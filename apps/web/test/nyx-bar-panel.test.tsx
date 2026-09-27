// Nyx-Leiste: Das Nyx-Feld klappt wie die Mitteilungszentrale direkt UNTER der Suchleiste auf – genau so breit
// wie die Leiste, rechtsbündig. Kein abgedunkelter/verschwommener Hintergrund, die Seite bleibt bedienbar, Scrollen
// oder Klicks daneben schließen es nicht (nur Esc, ✕ oder ein zweiter Klick auf die Leiste). Nur Push-to-talk.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { COMPANION_DEFAULTS, COMPANION_KEY, COMPANION_SCHEMA, getCompanionSettings, setCompanionSettings } from "../src/features/nyx/companionSettings";
import { HOLD_MS } from "../src/features/nyx/bar/NyxBar";
import { dropdownPlacement } from "../src/features/nyx/bar/dropdownPlacement";
import { renderWithClient } from "./helpers";

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

const STATUS = {
  settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
  engine: { kind: "claude-cli", state: "ready", available: true, reason: null, model: "haiku" },
  reserve: { configured: false, baseUrl: null, model: null },
  today: { day: "2026-09-25", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, budgetUsd: 2 },
  queue: { running: 0, waiting: 0 },
  lastRundgang: null,
};

let pageClicks = 0;
let fetchMock: ReturnType<typeof vi.fn>;

function renderBar(path = "/overview") {
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<button onClick={() => pageClicks++}>Seiten-Knopf</button>} />
      </Routes>
      <HaikuRoot />
    </MemoryRouter>,
  );
}
const bar = () => screen.getByRole("button", { name: /^Nyx öffnen/ });
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Mikrofon-Attrappe: getUserMedia + MediaRecorder, der beim Stoppen ein kleines Stück Audio liefert. */
function fakeMic() {
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream);
  class FakeRecorder {
    static isTypeSupported = (m: string) => m.startsWith("audio/webm");
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["x".repeat(2048)], { type: "audio/webm" }) });
      setTimeout(() => this.onstop?.(), 0);
    }
  }
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  return { getUserMedia, stopTrack };
}

beforeEach(() => {
  // Vorlesen aus, Dauer-Zuhören aus (kein Mikrofon ohne Gedrückthalten).
  localStorage.setItem(COMPANION_KEY, JSON.stringify({ listening: false, speak: false }));
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/auth/status") return json({ signedIn: true, csrf: "x" });
    if (url === "/api/haiku/status") return json(STATUS);
    if (url === "/api/haiku/threads") return json({ threads: [] });
    if (url === "/api/nyx/ui/reply") return json({ accepted: true });
    if (url === "/api/nyx/voice/transcribe") return json({ text: "Wie viele Sessions laufen?", language: "de", ms: 120 });
    if (url === "/api/haiku/chat")
      return ndjson([
        { type: "thread", threadId: 7 },
        { type: "delta", text: "Zwei Sessions laufen." },
        { type: "done", messageId: 1, text: "Zwei Sessions laufen.", sources: [], estimate: false, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 } },
      ]);
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
  localStorage.clear();
  sessionStorage.clear();
  pageClicks = 0;
});

const RECT = (left: number, width: number) =>
  ({ left, right: left + width, width, top: 8, bottom: 44, height: 36, x: left, y: 8, toJSON: () => ({}) }) as DOMRect;

async function openByClick() {
  vi.spyOn(bar(), "getBoundingClientRect").mockReturnValue(RECT(564, 360));
  fireEvent.pointerDown(bar(), { button: 0, pointerId: 1 });
  fireEvent.pointerUp(bar(), { pointerId: 1 });
  fireEvent.click(bar());
  const center = await screen.findByRole("dialog", { name: "Nyx" });
  await waitFor(() => expect(center).toHaveAttribute("data-state", "open"));
  return center;
}

describe("Nyx-Feld unter der Leiste", () => {
  it("kein Hintergrund (kein Abdunkeln, kein Blur), nicht modal, Seite bleibt klickbar und das Feld bleibt offen", async () => {
    renderBar();
    const center = await openByClick();
    expect(screen.queryByTestId("nyx-center-scrim")).toBeNull();
    expect(center).not.toHaveAttribute("aria-modal", "true");
    fireEvent.click(screen.getByRole("button", { name: "Seiten-Knopf" }));
    expect(pageClicks).toBe(1);
    fireEvent.scroll(window);
    fireEvent.pointerDown(document.body);
    await wait(250);
    expect(center).toHaveAttribute("data-state", "open");
  });

  it("hängt direkt unter der Leiste, genau so breit, rechtsbündig; höchstens 70 % Höhe mit eigenem Scrollen", async () => {
    renderBar();
    const center = await openByClick();
    await waitFor(() => expect(center.style.width).toBe("360px"));
    expect(center.style.left).toBe("564px");
    expect(center.style.top).toBe("52px");
    expect(center.className).toMatch(/max-h-\[70vh\]/);
  });

  it("schmale Leiste/Fenster: mindestens 320 px breit, rechtsbündig, nie über den Rand", () => {
    expect(dropdownPlacement(RECT(900, 84), 1024)).toEqual({ top: 52, left: 664, width: 320 });
    expect(dropdownPlacement(RECT(4, 84), 360)).toEqual({ top: 52, left: 8, width: 344 });
    expect(dropdownPlacement(null, 1024)).toEqual({ top: 56, left: 696, width: 320 });
  });

  it("zweiter Klick auf die Leiste schließt, Esc schließt, ✕ schließt", async () => {
    renderBar();
    const center = await openByClick();
    fireEvent.click(bar());
    await waitFor(() => expect(center).toHaveAttribute("data-state", "closed"));
    fireEvent.click(bar());
    await waitFor(() => expect(center).toHaveAttribute("data-state", "open"));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(center).toHaveAttribute("data-state", "closed"));
    fireEvent.click(bar());
    await waitFor(() => expect(center).toHaveAttribute("data-state", "open"));
    fireEvent.click(within(center).getByRole("button", { name: "Nyx schließen" }));
    await waitFor(() => expect(center).toHaveAttribute("data-state", "closed"));
  });

  it("Schnell-Aktionen: die wichtigen – ohne Dauer-Zuhören-Kachel; Eingabe hat den Fokus", async () => {
    renderBar();
    const center = await openByClick();
    const tiles = within(center).getByRole("group", { name: "Schnell-Aktionen" });
    const names = within(tiles).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Briefing vorlesen", "Neue Session", "Status", "Nyx-Tab öffnen", "Letzte Session öffnen"]);
    expect(within(center).queryByRole("button", { name: /Zuhören/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(center).getByRole("textbox", { name: "Frage an Nyx" })));
  });

  it("CSS: das Feld hat keinen Hintergrund-Blur, und es gibt keine Abdunkel-Fläche mehr", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/nyx/nyx.css"), "utf8");
    const rule = /\.nyx-center\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/\.nyx-scrim/);
  });
});

describe("nur Push-to-talk", () => {
  it("Dauer-Zuhören ist ab Werk aus", () => {
    expect(COMPANION_DEFAULTS.listening).toBe(false);
  });

  it("ein alter, nebenbei per Kachel eingeschalteter Wert „Zuhören an“ gilt einmalig als aus; bewusst neu eingeschaltet bleibt es an", () => {
    localStorage.setItem(COMPANION_KEY, JSON.stringify({ listening: true, speak: true }));
    expect(getCompanionSettings()).toEqual({ listening: false, speak: true });
    setCompanionSettings({ listening: true });
    expect(JSON.parse(localStorage.getItem(COMPANION_KEY) ?? "{}")).toMatchObject({ listening: true, schema: COMPANION_SCHEMA });
    expect(getCompanionSettings().listening).toBe(true);
  });

  it("alter Wert „Zuhören an“: auf einer normalen Seite geht das Mikrofon NICHT von selbst auf", async () => {
    const mic = fakeMic();
    localStorage.setItem(COMPANION_KEY, JSON.stringify({ listening: true, speak: false }));
    renderBar();
    await wait(40);
    expect(mic.getUserMedia).not.toHaveBeenCalled();
  });

  it("kurzer Druck öffnet das Feld, ohne das Mikrofon anzufassen", async () => {
    const mic = fakeMic();
    renderBar();
    fireEvent.pointerDown(bar(), { button: 0, pointerId: 1 });
    await wait(80);
    fireEvent.pointerUp(bar(), { pointerId: 1 });
    fireEvent.click(bar());
    const center = await screen.findByRole("dialog", { name: "Nyx" });
    await waitFor(() => expect(center).toHaveAttribute("data-state", "open"));
    expect(mic.getUserMedia).not.toHaveBeenCalled();
  });

  it("langer Druck (> 250 ms) nimmt auf, öffnet das große Feld nicht", async () => {
    const mic = fakeMic();
    renderBar();
    fireEvent.pointerDown(bar(), { button: 0, pointerId: 1 });
    await wait(HOLD_MS + 60);
    await waitFor(() => expect(mic.getUserMedia).toHaveBeenCalled());
    expect(HOLD_MS).toBeGreaterThanOrEqual(250);
    fireEvent.pointerUp(bar(), { pointerId: 1 });
    fireEvent.click(bar());
    await wait(50);
    expect(screen.queryByRole("dialog", { name: "Nyx" })).toBeNull();
  });
});
