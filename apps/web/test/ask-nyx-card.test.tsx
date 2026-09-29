// Die Antwort-Karte von „Nyx fragen“ (unten rechts, z. B. Überblick → „Wartet auf dich“) blieb
// stehen, bis man „Schließen“ drückte, und mehrere Fragen stapelten sich. Jetzt: eine neue Frage ersetzt die alte Karte,
// und eine fertige Karte schließt sich nach einer Minute von selbst (nicht, solange Nyx spricht oder der Zeiger darauf ist).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HaikuChatRequest, HaikuStreamEvent } from "@nyxos/shared";

const calls: HaikuChatRequest[] = [];
const said: string[] = [];

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
  reportNyxLevel: () => () => {},
}));

import { AskNyxButton } from "../src/components/nyx/AskNyxButton";
import { ASK_NYX_AUTO_CLOSE_MS, clearAskNyxCache } from "../src/components/nyx/useAskNyx";

function renderTwo() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/overview"]}>
        <div data-testid="a">
          <AskNyxButton question="Was ist bei A los?" facts="A" inline={false} compact />
        </div>
        <div data-testid="b">
          <AskNyxButton question="Was ist bei B los?" facts="B" inline={false} compact />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  said.length = 0;
  clearAskNyxCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Nyx answer card", () => {
  it("eine neue Frage ersetzt die offene Karte – es steht immer nur eine da", async () => {
    renderTwo();
    fireEvent.click(within(screen.getByTestId("a")).getByTestId("ask-nyx"));
    await waitFor(() => expect(screen.getAllByTestId("ask-nyx-answer")).toHaveLength(1));
    fireEvent.click(within(screen.getByTestId("b")).getByTestId("ask-nyx"));
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId("ask-nyx-answer")).toHaveLength(1));
  });

  it("schließt sich eine Minute nach der Antwort von selbst – aber nicht, solange Nyx spricht oder der Zeiger darauf ist", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTwo();
    fireEvent.click(within(screen.getByTestId("a")).getByTestId("ask-nyx"));
    await waitFor(() => expect(screen.getByTestId("ask-nyx-answer")).toHaveTextContent("dieselbe"));
    // Nyx spricht noch (die Attrappe endet nie von selbst) → bleibt offen.
    await act(async () => void vi.advanceTimersByTime(ASK_NYX_AUTO_CLOSE_MS + 1000));
    expect(screen.getByTestId("ask-nyx-answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Stopp/ }));
    // Zeiger auf der Karte → hält sie offen.
    fireEvent.pointerEnter(screen.getByTestId("ask-nyx-answer"));
    await act(async () => void vi.advanceTimersByTime(ASK_NYX_AUTO_CLOSE_MS + 1000));
    expect(screen.getByTestId("ask-nyx-answer")).toBeInTheDocument();
    fireEvent.pointerLeave(screen.getByTestId("ask-nyx-answer"));
    await act(async () => void vi.advanceTimersByTime(ASK_NYX_AUTO_CLOSE_MS - 1000));
    expect(screen.getByTestId("ask-nyx-answer")).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(2000));
    expect(screen.queryByTestId("ask-nyx-answer")).not.toBeInTheDocument();
  });
});
