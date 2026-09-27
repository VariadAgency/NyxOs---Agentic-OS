import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NightSettingsPanel } from "../src/features/night/NightSettingsPanel";
import { PushSettingsPanel } from "../src/features/push/PushSettingsPanel";
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

describe("PushSettingsPanel", () => {
  it("lädt Einstellungen (ohne Thema) und schickt eine Test-Mitteilung", async () => {
    let testSent = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/push/settings" && !init?.method) {
          return jsonResponse({
            quietStart: "22:00",
            quietEnd: "08:00",
            bundleWindowSeconds: 120,
            waitingAfterSeconds: 120,
            publicBaseUrl: "http://127.0.0.1:47801",
            enabledKinds: { session_waiting: true, session_crashed: true, build_red: true, night_run_done: true, deploy_failed: true, approval_needed: true },
          });
        }
        if (url === "/api/push/test") {
          testSent = true;
          return jsonResponse({
            results: [
              { channel: "mac", ok: true, detail: "An den Rechner geschickt." },
              { channel: "browser", ok: false, detail: "Kein NyxOS-Fenster offen." },
              { channel: "ntfy", ok: false, skipped: true, detail: "Ausgeschaltet." },
            ],
          });
        }
        return Promise.reject(new Error(`unerwartete URL ${url}`));
      }),
    );

    renderWithClient(<PushSettingsPanel />);
    await waitFor(() => expect(screen.getByText("Session wartet auf dich")).toBeInTheDocument());
    expect(screen.queryByText(/nyxos-/)).not.toBeInTheDocument(); // Thema nie sichtbar

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Test-Mitteilung senden" }));
    await waitFor(() => expect(testSent).toBe(true));
    // je Weg ✓/✗/– mit Grund statt eines pauschalen „Gesendet.“
    const results = await screen.findByTestId("push-test-results");
    expect(within(results).getByText("An den Rechner geschickt.")).toBeInTheDocument();
    expect(within(results).getByText("Kein NyxOS-Fenster offen.")).toBeInTheDocument();
    expect(within(results).getByText("✓")).toBeInTheDocument();
    expect(within(results).getByText("✗")).toBeInTheDocument();
    expect(within(results).getByText("–")).toBeInTheDocument();
  });

  it("stürzt nicht ab, wenn die Test-Antwort keine Liste enthält (älterer Server)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/push/settings" && !init?.method) {
          return jsonResponse({ quietStart: "22:00", quietEnd: "08:00", bundleWindowSeconds: 120, waitingAfterSeconds: 120, publicBaseUrl: "", enabledKinds: {} });
        }
        if (url === "/api/push/test") return jsonResponse({ sent: true });
        return Promise.reject(new Error(`unerwartete URL ${url}`));
      }),
    );
    renderWithClient(<PushSettingsPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Test-Mitteilung senden" }));
    await screen.findByText(/keine Rückmeldung je Weg/);
  });
});
