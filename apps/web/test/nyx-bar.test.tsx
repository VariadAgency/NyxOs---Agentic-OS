// Nyx lebt oben in der Leiste (kein Kreis mehr).
//   Klick → Nyx-Zentrum von oben (statt Seiten-Panel) · gedrückt halten → sprechen, Loslassen → Transkription → Nyx,
//   Ausgabe-Feld unter der Leiste · `nyx.ui` → Nyx-Cursor startet aus der Leiste und fliegt zurück.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { COMPANION_KEY } from "../src/features/nyx/companionSettings";
import { NyxCompanionSettings } from "../src/features/nyx/NyxCompanionSettings";
import { HOLD_MS } from "../src/features/nyx/bar/NyxBar";
import { emitNyxLive } from "../src/lib/liveBus";
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

let fetchMock: ReturnType<typeof vi.fn>;
const chatBodies = () =>
  fetchMock.mock.calls.filter((c) => c[0] === "/api/haiku/chat").map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { message: string; channel: string });
const replies = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/nyx/ui/reply").map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);

function renderBar(path = "/overview") {
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<button data-nyx="nav:git">Git</button>} />
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
});

describe("Nyx-Leiste", () => {
  it("Leiste heißt Nyx (Netz-Symbol, kein „Haiku fragen“); es gibt keinen schwebenden Kreis mehr", async () => {
    renderBar();
    expect(bar()).toHaveTextContent(/Nyx/);
    expect(bar()).not.toHaveTextContent(/Haiku/);
    expect(bar().querySelector("[data-nyx-anchor]")).not.toBeNull();
    expect(bar()).toHaveAttribute("data-nyx", "nyx-chat");
    expect(screen.queryByTestId("nyx-companion")).toBeNull();
  });

  it("Klick öffnet das Nyx-Zentrum von oben (kein Seitenblatt) mit Kacheln; Esc schließt", async () => {
    renderBar();
    fireEvent.click(bar());
    const center = await screen.findByRole("dialog", { name: "Nyx" });
    await waitFor(() => expect(center).toHaveAttribute("data-state", "open"));
    expect(center).toHaveClass("nyx-center");
    expect(center).not.toHaveClass("cc-sheet");
    // Kein abgedunkelter Hintergrund mehr.
    expect(screen.queryByTestId("nyx-center-scrim")).toBeNull();
    const tiles = within(center).getByRole("group", { name: "Schnell-Aktionen" });
    for (const t of ["Briefing vorlesen", "Neue Session", "Status", "Nyx-Tab"]) expect(within(tiles).getByRole("button", { name: new RegExp(t) })).toBeInTheDocument();
    // Alte Funktionen bleiben: Fäden, Eingabe
    expect(within(center).getByRole("textbox", { name: "Frage an Nyx" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(center).toHaveAttribute("data-state", "closed"));
  });

  it("⌘J öffnet das Zentrum, ⌘J schließt es wieder (Klick daneben schließt NICHT – die Seite bleibt bedienbar)", async () => {
    renderBar();
    fireEvent.keyDown(document, { key: "j", metaKey: true });
    const center = await screen.findByRole("dialog", { name: "Nyx" });
    await waitFor(() => expect(center).toHaveAttribute("data-state", "open"));
    fireEvent.click(screen.getByRole("button", { name: "Git" }));
    expect(center).toHaveAttribute("data-state", "open");
    fireEvent.keyDown(document, { key: "j", metaKey: true });
    await waitFor(() => expect(center).toHaveAttribute("data-state", "closed"));
  });

  it("gedrückt halten → Mikrofon + Pegel in der Leiste; Loslassen → Transkription → Nyx (voice); Ausgabe-Feld darunter", async () => {
    const mic = fakeMic();
    renderBar();
    fireEvent.pointerDown(bar(), { button: 0, pointerId: 1 });
    await wait(HOLD_MS + 60);
    await waitFor(() => expect(bar()).toHaveAttribute("data-phase", "talking"));
    expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("nyx-bar-level")).toBeInTheDocument();
    expect(screen.getByTestId("nyx-caption")).toHaveTextContent("Ich höre zu");
    await wait(420);
    fireEvent.pointerUp(bar(), { button: 0, pointerId: 1 });
    fireEvent.click(bar()); // der Klick nach dem Loslassen öffnet NICHT das Zentrum
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/api/nyx/voice/transcribe")).toBe(true));
    await waitFor(() => expect(chatBodies()).toContainEqual(expect.objectContaining({ message: "Wie viele Sessions laufen?", channel: "voice" })));
    const caption = screen.getByTestId("nyx-caption");
    await waitFor(() => expect(within(caption).getByTestId("nyx-caption-heard")).toHaveTextContent("Wie viele Sessions laufen?"));
    await waitFor(() => expect(within(caption).getByTestId("nyx-caption-reply")).toHaveTextContent("Zwei Sessions laufen."));
    expect(mic.stopTrack).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Nyx" })).toBeNull();
    // Esc schließt das Ausgabe-Feld
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("nyx-caption")).toBeNull());
  });

  it("⌥ Leertaste halten = sprechen (wie gedrückt halten)", async () => {
    const mic = fakeMic();
    renderBar();
    fireEvent.keyDown(document, { key: " ", code: "Space", altKey: true });
    await waitFor(() => expect(bar()).toHaveAttribute("data-phase", "talking"));
    await wait(420);
    fireEvent.keyUp(document, { key: " ", code: "Space", altKey: true });
    await waitFor(() => expect(chatBodies()).toContainEqual(expect.objectContaining({ channel: "voice" })));
    expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("ohne Mikrofon: ehrlicher Hinweis im Ausgabe-Feld – Tippen geht trotzdem (channel web)", async () => {
    renderBar();
    fireEvent.pointerDown(bar(), { button: 0, pointerId: 1 });
    await wait(HOLD_MS + 60);
    fireEvent.pointerUp(bar(), { button: 0, pointerId: 1 });
    const caption = await screen.findByTestId("nyx-caption");
    await waitFor(() => expect(within(caption).getByRole("alert")).toHaveTextContent(/kann nicht zuhören/));
    const input = within(caption).getByLabelText("Nachricht an Nyx");
    fireEvent.change(input, { target: { value: "Was wartet auf mich?" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(chatBodies()).toContainEqual(expect.objectContaining({ message: "Was wartet auf mich?", channel: "web" })));
    await waitFor(() => expect(within(caption).getByTestId("nyx-caption-reply")).toHaveTextContent("Zwei Sessions laufen."));
  });

  it("`nyx.ui` vom Server: Nyx-Cursor startet aus der Leiste, klickt das Ziel, antwortet und fliegt zurück", async () => {
    renderBar();
    const target = screen.getByText("Git");
    const onClick = vi.fn();
    target.addEventListener("click", onClick);
    expect(screen.getByTestId("nyx-cursor")).toHaveAttribute("data-mode", "docked");
    act(() => emitNyxLive({ type: "nyx.ui", requestId: "req-1234567890", action: "click", target: "nav:git" }));
    await waitFor(() => expect(screen.getByTestId("nyx-cursor")).toHaveAttribute("data-mode", "out"));
    await waitFor(() => expect(onClick).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await waitFor(() => expect(replies()).toContainEqual(expect.objectContaining({ type: "nyx.ui.result", requestId: "req-1234567890", ok: true })));
    await waitFor(() => expect(screen.getByTestId("nyx-cursor")).toHaveAttribute("data-mode", "docked"), { timeout: 6000 });
  });

  it("`read_screen`: meldet Route und data-nyx-Elemente (inkl. Leiste) zurück", async () => {
    renderBar("/git");
    act(() => emitNyxLive({ type: "nyx.ui", requestId: "req-screen-0001", action: "read_screen" }));
    // Vor dem Ergebnis kommt die Empfangsbestätigung (`nyx.ui.ack`).
    await waitFor(() => expect(replies().some((r) => (r as { type: string }).type === "nyx.ui.screen")).toBe(true));
    const reply = replies().find((r) => (r as { type: string }).type === "nyx.ui.screen") as { type: string; elements: { id: string }[] };
    expect(reply.elements.map((e) => e.id)).toEqual(expect.arrayContaining(["nav:git", "nyx-chat"]));
  });
});

describe("Einstellung", () => {
  it("„Begleiter“ wird zu „Nyx in der Leiste: Zuhören an/aus“ (gemerkt)", () => {
    render(<NyxCompanionSettings />);
    expect(screen.queryByText(/Nyx-Begleiter anzeigen/)).toBeNull();
    const toggle = screen.getByLabelText(/Nyx in der Leiste: Zuhören/);
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(JSON.parse(localStorage.getItem(COMPANION_KEY) ?? "{}")).toMatchObject({ listening: true });
  });
});
