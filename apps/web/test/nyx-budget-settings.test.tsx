import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaikuSettingsPanel } from "../src/features/haiku/HaikuSettingsPanel";
import { jsonResponse, renderWithClient } from "./helpers";

const status = {
  settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90 },
  engine: { kind: "claude-cli", state: "ready", available: true, reason: null, model: "haiku" },
  reserve: { configured: false, baseUrl: null, model: null },
  today: { day: "2026-09-25", calls: 12, inputTokens: 40000, outputTokens: 3000, costUsd: 0.5, budgetUsd: 2 },
  queue: { running: 0, waiting: 0 },
  lastRundgang: null,
};

const call = {
  id: 1,
  kind: "briefing",
  engine: "claude-cli",
  model: "haiku",
  status: "ok",
  inputTokens: 12000,
  outputTokens: 800,
  cacheReadTokens: 0,
  costUsd: 0.021,
  durationMs: 8400,
  error: null,
  createdAt: "2026-09-25T05:00:00.000Z",
  endedAt: "2026-09-25T05:00:08.400Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Nyx-Einstellungen", () => {
  it("zeigt Verbrauch als Ring, sperrt die Reserve ohne Schlüssel und speichert das Budget", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/haiku/settings" && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          patches.push(body);
          return jsonResponse({ ...status, settings: { ...status.settings, ...body } });
        }
        if (url === "/api/haiku/status") return jsonResponse(status);
        if (url.startsWith("/api/haiku/calls")) return jsonResponse({ calls: [call] });
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <HaikuSettingsPanel />
      </MemoryRouter>,
    );

    const ring = await screen.findByRole("img", { name: /25 % der Tagesgrenze/ });
    expect(ring).toBeInTheDocument();
    const reserve = screen.getByRole("radio", { name: /Reserve-API/ });
    expect(reserve).toBeDisabled();
    expect(screen.getByText(/kein Schlüssel hinterlegt/)).toBeInTheDocument();

    const calls = screen.getByRole("region", { name: "Letzte Aufrufe" });
    expect(within(calls).getByText("Briefing")).toBeInTheDocument();
    expect(within(calls).getByText("8,4 s")).toBeInTheDocument();

    const budget = screen.getByLabelText("Tagesgrenze (Gegenwert in USD)");
    await user.clear(budget);
    await user.type(budget, "3");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ dailyBudgetUsd: 3 });
  });
});

describe("formatUsd (Haiku)", () => {
  // Endprüfung 25.09.: Haiku-Einstellungen zeigten „$0.066 von $1.00“ (englisch), Nutzung/Überblick „2.663 $“.
  it("schreibt Beträge deutsch wie der Rest der NyxOS", async () => {
    const { formatUsd } = await import("../src/features/haiku/ui");
    expect(formatUsd(0.066)).toBe("0,066\u00a0$");
    expect(formatUsd(1)).toBe("1,00\u00a0$");
    expect(formatUsd(0)).toBe("0,00\u00a0$");
  });
});
