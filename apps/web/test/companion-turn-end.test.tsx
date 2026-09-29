// Beim Dauer-Zuhören wartete der Begleiter immer 6 s, bevor er ausführte – die Schleife
// meldete „Mikro offen“ statt „Nutzer spricht gerade“ an den Satz-Zusammensetzer. Jetzt zählt der Sprach-Zustand der
// Stille-Erkennung: ist der Nutzer fertig, geht ein ganzer Satz sofort los (Ziel: ≤ 1,5 s nach Sprach-Ende).
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VadHandlers } from "../src/features/nyx/voice/vad";

const vad = vi.hoisted(() => ({ handlers: null as VadHandlers | null, speaking: false }));

vi.mock("../src/features/nyx/voice/vad", () => ({
  startVad: async (h: VadHandlers) => {
    vad.handlers = h;
    return { stop: () => {}, setGuard: () => {}, level: () => 0, speaking: () => vad.speaking };
  },
}));
vi.mock("../src/features/nyx/voice/serverVoice", () => ({
  transcribe: async () => ({ text: "Öffne die zuletzt geöffnete Session." }),
}));

import { useNyxVoiceLoop } from "../src/features/nyx/useNyxVoiceLoop";

const CONTEXT = { path: "/", tab: null, filters: {}, openSessionId: null, openEntryId: null };

describe("Begleiter: Satz-Ende beim Dauer-Zuhören", () => {
  it("Nutzer hat aufgehört zu sprechen → der Befehl geht sofort los, nicht erst nach 6 s", async () => {
    const intercept = vi.fn(() => true);
    renderHook(() => useNyxVoiceLoop({ listening: true, context: () => CONTEXT, intercept }));
    await waitFor(() => expect(vad.handlers).not.toBeNull());
    vad.speaking = false;
    const t0 = performance.now();
    act(() => vad.handlers?.onSegment(new Blob([new Uint8Array([1])], { type: "audio/webm" }), 1200));
    await waitFor(() => expect(intercept).toHaveBeenCalledWith("Öffne die zuletzt geöffnete Session."), { timeout: 1500 });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("spricht der Nutzer noch weiter, wartet der Zusammensetzer (Satz nicht zerschneiden)", async () => {
    const intercept = vi.fn(() => true);
    renderHook(() => useNyxVoiceLoop({ listening: true, context: () => CONTEXT, intercept }));
    await waitFor(() => expect(vad.handlers).not.toBeNull());
    vad.speaking = true;
    act(() => vad.handlers?.onSegment(new Blob([new Uint8Array([1])], { type: "audio/webm" }), 1200));
    await new Promise((r) => setTimeout(r, 400));
    expect(intercept).not.toHaveBeenCalled();
  });
});
