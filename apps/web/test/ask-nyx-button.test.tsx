// „Nyx fragen“: ein Knopf für alle Stellen. Fragt Nyx über den normalen Chat-Weg (Wegwerf-Faden, Kanal
// „voice“ = kurze, sprechbare Antwort) mit den Daten der Seite, zeigt die Antwort und liest sie vor; das Nyx-Logo
// bekommt dabei den Pegel. Gleiche Frage = gemerkte Antwort (kein zweiter Lauf).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HaikuChatRequest, HaikuStreamEvent } from "@nyxos/shared";

const calls: HaikuChatRequest[] = [];
const said: string[] = [];
const levelSources: number[] = [];

vi.mock("../src/features/haiku/haikuApi", async (orig) => ({
  ...(await orig<typeof import("../src/features/haiku/haikuApi")>()),
  streamHaikuChat: async (req: HaikuChatRequest, onEvent: (e: HaikuStreamEvent) => void) => {
    calls.push(req);
    onEvent({ type: "delta", text: "Zwei Sessions " });
    onEvent({ type: "done", messageId: 1, text: "Zwei Sessions ändern **dieselbe** Datei.", speak: "Zwei Sessions ändern dieselbe Datei.", sources: [], estimate: false, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 } });
  },
}));

vi.mock("../src/features/nyx/voice/speaker", () => ({
  createSpeaker: () => {
    let resolve: () => void = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    return {
      say: (t: string) => said.push(t),
      end: () => done,
      cancel: () => resolve(),
      level: () => 0.6,
      push: () => {},
      speakingText: () => "",
      speakingSince: () => 0,
      isSpeaking: () => true,
      duck: () => {},
    };
  },
}));

vi.mock("../src/features/nyx/voice/levelBus", async (orig) => ({
  ...(await orig<typeof import("../src/features/nyx/voice/levelBus")>()),
  reportNyxLevel: (read: () => number) => {
    levelSources.push(read());
    return () => {};
  },
}));

import { AskNyxButton } from "../src/components/nyx/AskNyxButton";
import { buildAskMessage, clearAskNyxCache } from "../src/components/nyx/useAskNyx";

function renderButton(props: { inline?: boolean } = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/conflicts"]}>
        <AskNyxButton question="Was ist los?" facts="3 Dateien, 2 Sessions" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  said.length = 0;
  levelSources.length = 0;
  clearAskNyxCache();
});
afterEach(() => vi.clearAllMocks());

describe("AskNyxButton", () => {
  it("fragt Nyx mit Frage + Daten (Wegwerf-Faden, sprechbar), zeigt die Antwort und liest sie vor", async () => {
    renderButton();
    fireEvent.click(screen.getByTestId("ask-nyx"));
    await waitFor(() => expect(screen.getByTestId("ask-nyx-answer")).toHaveTextContent("dieselbe"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.temporary).toBe(true);
    expect(calls[0]?.channel).toBe("voice");
    expect(calls[0]?.message).toContain("Was ist los?");
    expect(calls[0]?.message).toContain("3 Dateien, 2 Sessions");
    expect(calls[0]?.context.tab).toBe("conflicts");
    // vorgelesen wird die sprechbare Fassung (ohne Markdown), und das Nyx-Logo bekommt den Pegel
    expect(said).toEqual(["Zwei Sessions ändern dieselbe Datei."]);
    expect(levelSources).toEqual([0.6]);
  });

  it("gleiche Frage noch einmal: gemerkte Antwort, kein zweiter Lauf", async () => {
    const first = renderButton();
    fireEvent.click(screen.getByTestId("ask-nyx"));
    await waitFor(() => expect(screen.getByTestId("ask-nyx-answer")).toBeInTheDocument());
    first.unmount();
    renderButton();
    fireEvent.click(screen.getByTestId("ask-nyx"));
    await waitFor(() => expect(screen.getByTestId("ask-nyx-answer")).toHaveTextContent("dieselbe"));
    expect(calls).toHaveLength(1);
    expect(said).toHaveLength(2);
  });

  it("schwebende Karte (in engen Kacheln): Klick löst nicht den umgebenden Link aus, „Schließen“ räumt auf", async () => {
    const outer = vi.fn();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <div onClick={outer}>
            <AskNyxButton compact inline={false} question="Kachel?" />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("ask-nyx"));
    expect(outer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("ask-nyx-answer")).toBeInTheDocument());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Schließen" })));
    expect(screen.queryByTestId("ask-nyx-answer")).toBeNull();
  });

  it("Nachricht: Frage, Daten und die Bitte um eine kurze Zusammenfassung", () => {
    const m = buildAskMessage("  Was ist los? ", "A\nB");
    expect(m.startsWith("Was ist los?")).toBe(true);
    expect(m).toContain("A\nB");
    expect(m).toMatch(/zwei bis drei einfachen Sätzen/);
    expect(buildAskMessage("Nur Frage")).not.toContain("Seite");
  });
});
