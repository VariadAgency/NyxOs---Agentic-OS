// Eine still gestorbene `/live`-Verbindung (Tunnel, Schlaf) merkt der Browser nicht – Nyx-Befehle kamen
// dann nie an. Der Server pingt jetzt; bleibt es still, verbindet das Fenster neu. Pings lösen kein Neuladen aus.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_SILENCE_MS, useLiveSocket } from "../src/hooks/useLiveSocket";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = 0;
  /** Tote TCP-Verbindung: der Browser wartet auf den Schließ-Handschlag, `onclose` kommt (lange) nicht. */
  static hangOnClose = false;
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close(): void {
    this.closed++;
    if (FakeWebSocket.hangOnClose) {
      this.readyState = 2;
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
}

describe("useLiveSocket: Herzschlag", () => {
  const RealWebSocket = globalThis.WebSocket;
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.hangOnClose = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("WebSocket", RealWebSocket);
  });

  function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLiveSocket(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    return spy;
  }

  it("Ping lädt nichts neu", async () => {
    const spy = mount();
    const ws = FakeWebSocket.instances[0];
    act(() => ws?.open());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    spy.mockClear();
    for (let i = 0; i < 3; i++) act(() => ws?.onmessage?.({ data: JSON.stringify({ type: "ping" }) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("nach einem Ping und dann langer Stille: schließen und neu verbinden (genau eine neue Verbindung)", async () => {
    mount();
    const ws = FakeWebSocket.instances[0];
    act(() => ws?.open());
    act(() => ws?.onmessage?.({ data: JSON.stringify({ type: "ping" }) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_SILENCE_MS + 20_000);
    });
    expect(ws?.closed).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("tote Verbindung, deren Schließen hängt (kein onclose) → trotzdem sofort neu verbinden", async () => {
    FakeWebSocket.hangOnClose = true;
    mount();
    const ws = FakeWebSocket.instances[0];
    act(() => ws?.open());
    act(() => ws?.onmessage?.({ data: JSON.stringify({ type: "ping" }) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_SILENCE_MS + 20_000);
    });
    expect(ws?.closed).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // Kommt das alte `onclose` doch noch, plant es keinen zweiten Neuaufbau.
    act(() => ws?.onclose?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("ohne je einen Ping (alter Server) keine Zwangs-Neuverbindung", async () => {
    mount();
    const ws = FakeWebSocket.instances[0];
    act(() => ws?.open());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_SILENCE_MS * 2);
    });
    expect(ws?.closed).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
