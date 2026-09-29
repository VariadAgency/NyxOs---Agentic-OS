// Nyx-Denken im Web: Gedanken eingeklappt sichtbar, nie vorgelesen; getippte Fragen werden vorgelesen
// (Zentrum-Chat meldet Zwischenmeldung + Sprechfassung an die Stimme; Nyx-Tab: „Getippte Antworten vorlesen“ Standard an).
import type { HaikuStreamEvent } from "@nyxos/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const script: HaikuStreamEvent[] = [
  { type: "thread", threadId: 7 },
  { type: "status", status: "thinking" },
  { type: "thought", text: "Ah nee, doch nicht." },
  { type: "filler", text: "Ich schau mal." },
  { type: "status", status: "tool", tool: "letzte_aktivitaet" },
  { type: "delta", text: "Die letzte Session war **Nyx-Denken**." },
  {
    type: "done",
    messageId: 1,
    text: "Die letzte Session war **Nyx-Denken**.",
    speak: "Die letzte Session war Nyx-Denken.",
    sources: [],
    estimate: false,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 },
    thoughts: ["Ah nee, doch nicht."],
  },
];

vi.mock("../src/features/haiku/haikuApi", () => ({
  fetchThread: vi.fn(),
  streamHaikuChat: vi.fn(async (_req: unknown, onEvent: (ev: HaikuStreamEvent) => void) => {
    for (const ev of script) onEvent(ev);
  }),
}));

const { useHaikuChat } = await import("../src/features/haiku/useHaikuChat");
const { NyxThoughts } = await import("../src/features/nyx/NyxThoughts");
const settings = await import("../src/features/nyx/tab/settings");

const CTX = { path: "/", tab: null, filters: {}, openSessionId: null, openEntryId: null, title: null };

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("Zentrum-Chat", () => {
  it("Gedanke landet in `thoughts`, nicht im Text; Stimme bekommt nur Zwischenmeldung und Sprechfassung", async () => {
    const onFiller = vi.fn();
    const onAnswer = vi.fn();
    const { result } = renderHook(() => useHaikuChat({ onFiller, onAnswer }), { wrapper });
    await act(async () => {
      await result.current.send("Was war die letzte Session?", CTX);
    });
    const bot = result.current.entries.at(-1);
    expect(bot?.text).toBe("Die letzte Session war **Nyx-Denken**.");
    expect(bot?.thoughts).toEqual(["Ah nee, doch nicht."]);
    expect(onFiller).toHaveBeenCalledExactlyOnceWith("Ich schau mal.");
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("Die letzte Session war Nyx-Denken.");
    expect(JSON.stringify(onAnswer.mock.calls)).not.toContain("Ah nee");
  });
});

describe("Gedanken-Anzeige", () => {
  it("eingeklappt als „Gedanken“, Inhalt erst beim Aufklappen", async () => {
    render(<NyxThoughts thoughts={["Erst Sessions prüfen.", "Dann Git."]} />);
    const box = screen.getByTestId("nyx-thoughts");
    expect(box.tagName).toBe("DETAILS");
    expect(box).not.toHaveAttribute("open");
    expect(screen.getByText(/Gedanken/)).toHaveTextContent("Gedanken (2)");
  });
  it("ohne Gedanken nichts", () => {
    const { container } = render(<NyxThoughts thoughts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Nyx-Tab: getippte Antworten vorlesen ist Standard", () => {
  beforeEach(() => {
    localStorage.clear();
    settings.__resetNyxSettingsCache();
  });
  afterEach(() => localStorage.clear());

  it("neu: an", () => {
    expect(settings.DEFAULT_SETTINGS.speakTyped).toBe(true);
    const { result } = renderHook(() => settings.useNyxSettings());
    expect(result.current[0].speakTyped).toBe(true);
  });

  it("alter Speicherstand mit `false` (alter Standard) → an; eigene Wahl „aus“ bleibt aus", async () => {
    localStorage.setItem(settings.NYX_SETTINGS_KEY, JSON.stringify({ rate: 1.1, speakTyped: false }));
    const { result } = renderHook(() => settings.useNyxSettings());
    expect(result.current[0].speakTyped).toBe(true);
    act(() => result.current[1]({ speakTyped: false }));
    settings.__resetNyxSettingsCache();
    const again = renderHook(() => settings.useNyxSettings());
    await waitFor(() => expect(again.result.current[0].speakTyped).toBe(false));
    // anderes Speichern danach behält die eigene Wahl
    act(() => again.result.current[1]({ rate: 1.2 }));
    settings.__resetNyxSettingsCache();
    expect(renderHook(() => settings.useNyxSettings()).result.current[0].speakTyped).toBe(false);
  });
});
