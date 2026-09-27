// Der Nyx-Tab muss erfahren, ob ein Gedanke schon gestreamt war (`retract`) – nur dann verwirft
// seine Stimme, was noch klingt. Sonst schnitte jeder Gedanke der 2. Runde die Zwischenmeldung ab.
import type { HaikuStreamEvent } from "@nyxos/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/features/haiku/haikuApi", () => ({
  fetchThreads: async () => [],
  fetchThread: async () => ({ messages: [] }),
  streamHaikuChat: async (_b: unknown, on: (ev: HaikuStreamEvent) => void) => {
    on({ type: "delta", text: "Langer Entwurf …" });
    on({ type: "thought", text: "Langer Entwurf …", retract: true });
    on({ type: "filler", text: "Ich schau mal." });
    on({ type: "thought", text: "Zweite Runde." });
    on({ type: "delta", text: "Antwort." });
    on({ type: "done", messageId: 7, text: "Antwort.", speak: "Antwort.", sources: [], estimate: false, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 } });
  },
}));
vi.mock("../src/features/nyx/tab/nyxTabApi", () => ({ saveInterrupted: async () => {} }));

import { useNyxConversation } from "../src/features/nyx/tab/useNyxConversation";

describe("Nyx-Tab: Gedanken mit retract", () => {
  it("onThought meldet, ob der Gedanke schon gestreamt war", async () => {
    const { result } = renderHook(() => useNyxConversation());
    const thoughts: [string, boolean][] = [];
    const fillers: string[] = [];
    await act(async () => {
      await result.current.ask("Was war zuletzt?", "voice", { onThought: (t, r) => thoughts.push([t, r]), onFiller: (f) => fillers.push(f) });
    });
    expect(thoughts).toEqual([
      ["Langer Entwurf …", true],
      ["Zweite Runde.", false],
    ]);
    expect(fillers).toEqual(["Ich schau mal."]);
  });
});
