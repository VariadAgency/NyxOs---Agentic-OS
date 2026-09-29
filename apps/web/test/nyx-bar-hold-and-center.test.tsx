// Halten sauber abbrechen (weg, Fenster verlassen, Esc), Mikrofon wirklich frei, Zentrum modal
// mit Fokus-Falle und Fokus-Rückgabe, „Briefing vorlesen“ öffnet /briefing?vorlesen=1, keine türkisen Festwerte.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { COMPANION_KEY } from "../src/features/nyx/companionSettings";
import { HOLD_MS, LEAVE_PX } from "../src/features/nyx/bar/NyxBar";
import { renderWithClient } from "./helpers";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const STATUS = {
  settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
  engine: { kind: "claude-cli", state: "ready", available: true, reason: null, model: "haiku" },
  reserve: { configured: false, baseUrl: null, model: null },
  today: { day: "2026-09-25", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, budgetUsd: 2 },
  queue: { running: 0, waiting: 0 },
  lastRundgang: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
const called = (u: string) => fetchMock.mock.calls.some((c) => c[0] === u);

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function renderBar() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/overview"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <button type="button">Vorher fokussiert</button>
              <Where />
            </>
          }
        />
      </Routes>
      <HaikuRoot />
    </MemoryRouter>,
  );
}
const bar = () => screen.getByRole("button", { name: /^Nyx öffnen/ });
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Mikrofon-Attrappe; `gate` hält getUserMedia fest, bis der Test es freigibt (Erlaubnis-Dialog). */
function fakeMic(opts: { gate?: boolean; noStopEvent?: boolean } = {}) {
  const stopTrack = vi.fn();
  let open: (() => void) | null = null;
  const getUserMedia = vi.fn(async () => {
    if (opts.gate) await new Promise<void>((r) => (open = r));
    return { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  });
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
      if (!opts.noStopEvent) setTimeout(() => this.onstop?.(), 0);
    }
  }
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  return { getUserMedia, stopTrack, release: () => (open as (() => void) | null)?.() };
}

async function startHold() {
  fireEvent.pointerDown(bar(), { button: 0, pointerId: 1 });
  await wait(HOLD_MS + 60);
}

beforeEach(() => {
  localStorage.setItem(COMPANION_KEY, JSON.stringify({ listening: false, speak: false }));
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/auth/status") return json({ signedIn: true, csrf: "x" });
    if (url === "/api/haiku/status") return json(STATUS);
    if (url === "/api/haiku/threads") return json({ threads: [] });
    if (url === "/api/nyx/voice/transcribe") return json({ text: "Hallo", language: "de", ms: 1 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
  localStorage.clear();
  sessionStorage.clear();
});

describe("Halten vs. Klick", () => {
  it("weit weggezogen während des Haltens: Aufnahme verworfen, Mikrofon frei, kein Klick aufs Zentrum", async () => {
    const mic = fakeMic();
    renderBar();
    vi.spyOn(bar(), "getBoundingClientRect").mockReturnValue({ left: 100, right: 300, top: 10, bottom: 40, width: 200, height: 30, x: 100, y: 10, toJSON: () => ({}) });
    await startHold();
    await waitFor(() => expect(bar()).toHaveAttribute("data-phase", "talking"));
    await wait(420);
    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 200, clientY: 40 + LEAVE_PX + 30 });
    await waitFor(() => expect(bar()).not.toHaveAttribute("data-phase", "talking"));
    expect(mic.stopTrack).toHaveBeenCalled();
    fireEvent.pointerUp(bar(), { pointerId: 1 });
    fireEvent.click(bar());
    await wait(50);
    expect(called("/api/nyx/voice/transcribe")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Nyx" })).toBeNull();
    expect(screen.getByTestId("nyx-caption")).toHaveTextContent("Abgebrochen");
  });

  it("Fenster verliert den Fokus während des Haltens (⌥ Leertaste): Mikrofon zu, nichts gesendet", async () => {
    const mic = fakeMic();
    renderBar();
    fireEvent.keyDown(document, { key: " ", code: "Space", altKey: true });
    await waitFor(() => expect(bar()).toHaveAttribute("data-phase", "talking"));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mic.stopTrack).toHaveBeenCalled());
    fireEvent.keyUp(document, { key: " ", code: "Space" });
    await wait(50);
    expect(called("/api/nyx/voice/transcribe")).toBe(false);
  });

  it("Esc während des Haltens bricht nur das Halten ab (Zentrum/Feld bleiben unberührt)", async () => {
    const mic = fakeMic();
    renderBar();
    await startHold();
    await waitFor(() => expect(bar()).toHaveAttribute("data-phase", "talking"));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(mic.stopTrack).toHaveBeenCalled());
    fireEvent.pointerUp(bar(), { pointerId: 1 });
    await wait(50);
    expect(called("/api/nyx/voice/transcribe")).toBe(false);
    expect(screen.getByTestId("nyx-caption")).toBeInTheDocument();
  });

  it("losgelassen, bevor das Mikrofon offen war: es wird danach sofort wieder geschlossen", async () => {
    const mic = fakeMic({ gate: true });
    renderBar();
    await startHold();
    fireEvent.pointerUp(bar(), { pointerId: 1 });
    await wait(20);
    await act(async () => mic.release());
    await waitFor(() => expect(mic.stopTrack).toHaveBeenCalled());
    expect(bar()).not.toHaveAttribute("data-phase", "talking");
    expect(called("/api/nyx/voice/transcribe")).toBe(false);
  });

  it("Recorder meldet kein „stop“ (Safari): Mikrofon wird trotzdem freigegeben und der Satz geht raus", async () => {
    const mic = fakeMic({ noStopEvent: true });
    renderBar();
    await startHold();
    await wait(420);
    fireEvent.pointerUp(bar(), { pointerId: 1 });
    await waitFor(() => expect(mic.stopTrack).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(called("/api/nyx/voice/transcribe")).toBe(true));
  });
});

describe("Nyx-Zentrum", () => {
  it("nicht modal (kein aria-modal, beschriftet), Tab darf hinaus in die Seite, Esc gibt den Fokus dorthin zurück, wo er vorher war", async () => {
    renderBar();
    const before = screen.getByRole("button", { name: "Vorher fokussiert" });
    before.focus();
    fireEvent.keyDown(document, { key: "j", metaKey: true });
    const center = await screen.findByRole("dialog", { name: "Nyx" });
    await waitFor(() => expect(center).toHaveAttribute("data-state", "open"));
    expect(center).not.toHaveAttribute("aria-modal", "true");
    // Keine Fokus-Falle: Tab am Ende wird nicht an den Anfang zurückgerissen.
    const focusables = [...center.querySelectorAll<HTMLElement>("button,textarea,input,a[href]")].filter((el) => !el.hasAttribute("disabled"));
    const last = focusables[focusables.length - 1] as HTMLElement;
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(center).toHaveAttribute("data-state", "closed"));
    await waitFor(() => expect(document.activeElement).toBe(before));
  });

  it("„Briefing vorlesen“ öffnet /briefing?vorlesen=1 (kein Chat an Nyx)", async () => {
    renderBar();
    fireEvent.click(bar());
    const center = await screen.findByRole("dialog", { name: "Nyx" });
    fireEvent.click(within(center).getByRole("button", { name: /Briefing vorlesen/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/briefing?vorlesen=1"));
    expect(called("/api/haiku/chat")).toBe(false);
    await waitFor(() => expect(center).toHaveAttribute("data-state", "closed"));
  });

  it("Kacheln: Symbol-Kreis voll in der Kategorie-Farbe (nicht blass getönt, nicht grau)", async () => {
    renderBar();
    fireEvent.click(bar());
    const center = await screen.findByRole("dialog", { name: "Nyx" });
    const tiles = within(center).getAllByRole("button").filter((b) => b.classList.contains("nyx-tile"));
    expect(tiles.length).toBeGreaterThanOrEqual(5);
    for (const t of tiles) {
      const chip = t.firstElementChild as HTMLElement;
      expect(chip.className).not.toMatch(/\/15\b|bg-a-p3|text-a-mut/);
    }
  });
});

describe("Farben nur aus Tokens", () => {
  const files = [
    "src/features/nyx/bar/NyxBar.tsx",
    "src/features/nyx/bar/NyxCaption.tsx",
    "src/features/nyx/bar/NyxQuickTiles.tsx",
    "src/features/nyx/bar/useBarCursor.tsx",
    "src/features/haiku/HaikuPanel.tsx",
    "src/features/haiku/PlanCards.tsx",
    "src/features/haiku/ui.tsx",
    "src/features/nyx/nyx.css",
  ];
  it.each(files)("%s: keine türkis-/blaustichigen Festwerte, kein text-a-dim", (f) => {
    const src = readFileSync(resolve(__dirname, "..", f), "utf8");
    expect(src).not.toMatch(/#1E4146|#1E4E53|#13262A|#0E1319|#04181B|#1D1405|#C9D2DD|rgba\(\s*(4|10|12),\s*(6|8|16),\s*(12|22|26)/i);
    expect(src).not.toMatch(/text-a-dim/);
  });
});
