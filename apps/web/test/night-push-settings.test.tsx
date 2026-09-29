import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotifySettingsResponse } from "@nyxos/shared";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NightSettingsPanel } from "../src/features/night/NightSettingsPanel";
import { NotificationChannels } from "../src/features/notifications/NotificationChannels";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NightSettingsPanel", () => {
  it("lädt die Einstellungen und speichert eine Änderung", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/night/settings" && (!init || init.method === undefined)) {
          return jsonResponse({ window: { start: "23:00", end: "07:00" }, budget: { maxParallelOpus: 2, maxWeeklyFractionPerNight: 0.15, hardTokenLimitPerTask: 2_000_000, hardTimeLimitMinutesPerTask: 240 }, allApproved: false });
        }
        if (url === "/api/night/settings" && init?.method === "PATCH") {
          patchCalls.push(JSON.parse(String(init.body)));
          return jsonResponse({ window: { start: "22:00", end: "07:00" }, budget: { maxParallelOpus: 2, maxWeeklyFractionPerNight: 0.15, hardTokenLimitPerTask: 2_000_000, hardTimeLimitMinutesPerTask: 240 }, allApproved: false });
        }
        return Promise.reject(new Error(`unerwartete URL ${url}`));
      }),
    );

    renderWithClient(<NightSettingsPanel />);
    await waitFor(() => expect(screen.getByDisplayValue("23:00")).toBeInTheDocument());

    const user = userEvent.setup();
    const startInput = screen.getByDisplayValue("23:00");
    await user.clear(startInput);
    await user.type(startInput, "22:00");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect((patchCalls[0] as { window: { start: string } }).window.start).toBe("22:00");
  });
});

// The former push panel became part of the page "Mitteilungen" – the same checks now on the section "Wege".
const CHANNELS_DATA = { push: { channels: { mac: true, browser: true, ntfy: false } } } as unknown as NotifySettingsResponse;

function stubFetch(testBody: unknown, onTest?: () => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/telegram/status") return jsonResponse({ paired: null });
      if (url === "/api/push/test") {
        onTest?.();
        return jsonResponse(testBody);
      }
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
}

function renderChannels() {
  renderWithClient(
    <MemoryRouter>
      <NotificationChannels data={CHANNELS_DATA} save={vi.fn()} busy={false} />
    </MemoryRouter>,
  );
}

describe("Mitteilungen → Wege (früher PushSettingsPanel)", () => {
  it("schickt eine Test-Mitteilung und zeigt das Ergebnis je Weg, nie das Thema", async () => {
    let testSent = false;
    stubFetch(
      {
        results: [
          { channel: "mac", ok: true, detail: "An den Rechner geschickt." },
          { channel: "browser", ok: false, detail: "Kein NyxOS-Fenster offen." },
          { channel: "ntfy", ok: false, skipped: true, detail: "Ausgeschaltet." },
        ],
      },
      () => {
        testSent = true;
      },
    );
    renderChannels();
    expect(screen.queryByText(/nyxos-/)).not.toBeInTheDocument(); // topic never visible
    expect(screen.getByText("Rechner")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Test-Mitteilung senden" }));
    await waitFor(() => expect(testSent).toBe(true));
    // per channel ✓/✗/– with reason instead of a flat "Gesendet."
    const results = await screen.findByTestId("push-test-results");
    expect(within(results).getByText("An den Rechner geschickt.")).toBeInTheDocument();
    expect(within(results).getByText("Kein NyxOS-Fenster offen.")).toBeInTheDocument();
    expect(within(results).getByText("✓")).toBeInTheDocument();
    expect(within(results).getByText("✗")).toBeInTheDocument();
    expect(within(results).getByText("–")).toBeInTheDocument();
  });

  it("stürzt nicht ab, wenn die Test-Antwort keine Liste enthält (älterer Server)", async () => {
    stubFetch({ sent: true });
    renderChannels();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Test-Mitteilung senden" }));
    await screen.findByText(/keine Rückmeldung je Weg/);
  });
});
