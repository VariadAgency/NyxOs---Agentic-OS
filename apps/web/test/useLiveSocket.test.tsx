// `/live`-Nachrichten bei dichter Aktivität bündeln (300 ms Entprellen), statt bei
// jeder einzelnen Nachricht neu anzufragen. Simuliert 50 Nachrichten in 1 s und zählt, wie oft der
// Sessions-Query dafür ungültig gemacht wird (= wie oft neu angefragt würde).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveSocket } from "../src/hooks/useLiveSocket";

interface FakeSocket {
  onopen: (() => void) | null;
  onmessage: ((evt: { data: string }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

describe("useLiveSocket: Bündeln bei dichter Aktivität", () => {
  let instances: FakeSocket[] = [];
  const RealWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    instances = [];
    class FakeWebSocket implements FakeSocket {
      onopen: (() => void) | null = null;
      onmessage: ((evt: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        instances.push(this);
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("WebSocket", RealWebSocket);
  });

  it("50 Nachrichten in 1 s ergeben höchstens 4 Refetches der Sessions-Liste", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useLiveSocket(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    const ws = instances[0];
    expect(ws).toBeTruthy();
    act(() => ws?.onopen?.());

    for (let i = 0; i < 50; i++) {
      act(() => ws?.onmessage?.({ data: JSON.stringify({ type: "session", session: { id: `s${i % 5}` } }) }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20); // 50 × 20 ms = 1 s
      });
    }
    // Letztes, noch offenes Bündel-Fenster (300 ms) auslaufen lassen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    const sessionListRefetches = invalidateSpy.mock.calls.filter(([filters]) => {
      const key = (filters as { queryKey?: unknown[] } | undefined)?.queryKey;
      return Array.isArray(key) && key[0] === "sessions";
    }).length;

    expect(sessionListRefetches).toBeGreaterThan(0); // es kam überhaupt etwas an
    expect(sessionListRefetches).toBeLessThanOrEqual(4);
  });

  it("ohne Nachrichten wird nichts entprellt-verzögert nachgeholt (kein Leerlauf-Timer bleibt hängen)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { unmount } = renderHook(() => useLiveSocket(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    const ws = instances[0];
    act(() => ws?.onopen?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(3); // sessions + categories + conflicts, kein Session-Detail (keine ID beim Verbindungsaufbau)
    unmount();
  });

  // Exponentieller Backoff (1→2→4→…→30 s) statt eines festen 2-s-Takts, und
  // höchstens EINE eigene Konsolen-Warnung je zusammenhängendem Ausfall.
  it("verdoppelt den Neuverbindungs-Abstand je Fehlschlag bis 30 s und warnt nur einmal", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useLiveSocket(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    // Erster Verbindungsversuch schlägt sofort fehl (onclose ohne vorheriges onopen).
    act(() => instances[0]?.onclose?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(instances.length).toBe(1); // 1 s noch nicht um — noch kein zweiter Versuch

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(instances.length).toBe(2); // nach 1 s: zweiter Versuch

    act(() => instances[1]?.onclose?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(instances.length).toBe(2); // 2 s (verdoppelt) noch nicht um

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(instances.length).toBe(3);

    expect(warnSpy).toHaveBeenCalledTimes(1); // trotz zwei Ausfällen nur eine Warnung
    warnSpy.mockRestore();
  });
});
