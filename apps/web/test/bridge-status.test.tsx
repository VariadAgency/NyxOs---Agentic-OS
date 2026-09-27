// Brücke flackert rot/grün. Die Statuszeile zeigt den Zustand, den der Server mit
// seiner Uhr rechnet: kurze Aussetzer als „verbindet neu …" (nicht rot), echte Ausfälle mit Grund und
// Dauer, Verlauf der letzten 24 h per Klick. Die Browser-Uhr darf keine Rolle spielen (Uhren-Versatz).
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "../src/components/ConnectionStatus";
import { describeBridge } from "../src/components/BridgeStatus";
import { jsonResponse, presenceBody, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeBridge (rein)", () => {
  const serverNow = Date.parse("2026-09-25T08:45:00Z");
  const p = (over: Record<string, unknown>) => presenceBody({ serverNow: new Date(serverNow).toISOString(), ...over }) as never;

  it("verbindet neu → gelb, nie rot", () => {
    const d = describeBridge(p({ state: "reconnecting", reason: "Verbindung wird neu aufgebaut", since: "2026-09-25T08:44:40Z" }), 0, 0);
    expect(d.tone).toBe("wait");
    expect(d.text).toBe("Brücke verbindet neu …");
  });

  it("offline zeigt Grund und Dauer, gerechnet mit der Server-Uhr (Browser-Uhr 10 min vor)", () => {
    const receivedAt = serverNow + 10 * 60_000; // Browser-Uhr geht 10 min vor
    const d = describeBridge(p({ state: "offline", reason: "Tunnel zu", since: "2026-09-25T08:42:00Z" }), receivedAt, receivedAt + 25_000);
    expect(d.tone).toBe("bad");
    expect(d.text).toBe("Brücke offline");
    expect(d.detail).toBe("Tunnel zu · seit 3 min"); // 3 min laut Server + 25 s seit Abruf, Browser-Uhr egal
  });

  it("Antwort älter als 30 s (Abfrage hängt) → unbekannt statt alter Stand", () => {
    const d = describeBridge(p({ state: "online" }), 1_000, 1_000 + 31_000);
    expect(d.tone).toBe("unknown");
  });
});

describe("Statuszeile Brücke", () => {
  it("„verbindet neu …“ statt „offline“ bei kurzem Aussetzer", async () => {
    stubFetchRoutes({ health: () => jsonResponse({ ok: true }), bridgePresence: () => jsonResponse(presenceBody({ state: "reconnecting", reason: "Verbindung wird neu aufgebaut", channelOpen: false })) });
    renderWithClient(<ConnectionStatus />);
    expect(await screen.findByText("Brücke verbindet neu …")).toBeInTheDocument();
    expect(screen.queryByText(/offline/)).not.toBeInTheDocument();
  });

  it("echter Ausfall: rot mit Grund und seit wann", async () => {
    const now = Date.now();
    stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      bridgePresence: () => jsonResponse(presenceBody({ state: "offline", reason: "Dienst gestoppt", since: new Date(now - 5 * 60_000).toISOString(), serverNow: new Date(now).toISOString() })),
    });
    renderWithClient(<ConnectionStatus />);
    expect(await screen.findByText("Brücke offline")).toBeInTheDocument();
    // Die Leiste ist nur 200 px breit: Grund und Dauer stehen in einer eigenen Zeile, die umbricht statt
    // abgeschnitten zu werden (vorher: „Brücke offline · Dienst gestoppt“ + „seit …“ in einer Zeile → „Brücke offl…“).
    const detail = screen.getByText("Dienst gestoppt · seit 5 min");
    for (let el: HTMLElement | null = detail; el; el = el.parentElement) expect(el.className).not.toMatch(/\btruncate\b/);
  });

  it("Klick öffnet den Verlauf der letzten 24 h mit Dauer", async () => {
    stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      bridgeHistory: () =>
        jsonResponse({
          events: [
            { at: "2026-09-25T08:34:26Z", state: "online", reason: null, durationMs: 3_600_000 },
            { at: "2026-09-25T09:34:26Z", state: "reconnecting", reason: "Verbindung wird neu aufgebaut", durationMs: 12_000 },
            { at: "2026-09-25T09:34:38Z", state: "offline", reason: "Tunnel zu", durationMs: 185_000 },
            { at: "2026-09-25T09:37:43Z", state: "online", reason: null, durationMs: null },
          ],
        }),
    });
    renderWithClient(<ConnectionStatus />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /Brücke online/ }));
    const dialog = await screen.findByRole("dialog", { name: "Verbindung der Brücke" });
    expect(await within(dialog).findByText("kurz neu verbunden")).toBeInTheDocument();
    expect(within(dialog).getByText("offline · Tunnel zu")).toBeInTheDocument();
    expect(within(dialog).getByText("3 min 5 s")).toBeInTheDocument();
    expect(within(dialog).getByText("12 s")).toBeInTheDocument();
    expect(within(dialog).getByText("läuft")).toBeInTheDocument();
  });
});
