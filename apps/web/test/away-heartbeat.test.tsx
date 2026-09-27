// Abwesenheit: Das Fenster meldet „da“ nur, solange es sichtbar ist UND der Nutzer aktiv war.
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeAuthForTests, __resetAuthForTests } from "../src/features/terminal/authClient";
import { usePresenceHeartbeat } from "../src/hooks/usePresenceHeartbeat";

describe("Abwesenheits-Herzschlag", () => {
  let beats: RequestInit[] = [];
  beforeEach(() => {
    beats = [];
    vi.useFakeTimers();
    __primeAuthForTests("csrf-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/away/heartbeat") beats.push(init ?? {});
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetAuthForTests();
  });

  it("schickt alle 30 s mit CSRF, solange aktiv – nach 2 Min ohne Eingabe nicht mehr, bei Eingabe sofort wieder", async () => {
    const { unmount } = renderHook(() => usePresenceHeartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(beats).toHaveLength(1);
    expect(new Headers(beats[0]?.headers).get("x-nyxos-csrf")).toBe("csrf-1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(beats).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // keine Eingabe → still
    const quiet = beats.length;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(beats.length).toBe(quiet);
    window.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(beats.length).toBe(quiet + 1);
    unmount();
  });
});
