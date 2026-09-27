import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageView } from "../src/features/usage/UsageView";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const DAYS = [
  { day: "2026-08-19", tool: "claude", model: "claude-opus-5", project: "myproject", totalTokens: 82_697_857, inputTokens: 472, outputTokens: 178_041, cacheReadTokens: 81_677_137, cacheCreationTokens: 842_207, cost: 53.71 },
];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/usage/daily")) return jsonResponse({ days: DAYS });
      if (url.startsWith("/api/usage/models")) return jsonResponse({ models: [{ model: "claude-opus-5", tool: "claude", totalTokens: 82_697_857, cost: 53.71 }] });
      if (url.startsWith("/api/usage/sessions")) return jsonResponse({ sessions: [{ id: "claude:s1", tool: "claude", title: "Teure Session", model: "claude-opus-5", totalTokens: 1000, cost: 12.3 }] });
      if (url.startsWith("/api/usage/hourly")) return jsonResponse({ cells: [{ dow: 3, hour: 14, tokens: 5000 }] });
      if (url.startsWith("/api/usage/window"))
        return jsonResponse({
          windows: [
            { tool: "claude", tokens5h: 2_000_000, tokens7d: 50_000_000, peak5h: 8_000_000, peak7d: 100_000_000, hourly24: new Array(24).fill(0), reported: { fiveHourPct: null, weekPct: null, limitReached: true, limitType: "five_hour", resetsAt: "2099-01-01T13:30:00.000Z" } },
            { tool: "codex", tokens5h: 0, tokens7d: 0, peak5h: 0, peak7d: 0, hourly24: new Array(24).fill(0), reported: { fiveHourPct: 42, weekPct: null, limitReached: false, limitType: null, resetsAt: null } },
          ],
        });
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
}

describe("UsageView", () => {
  it("zeigt Kennzahlen und öffnet die Modell-Großansicht per Klick", async () => {
    stub();
    renderWithClient(
      <MemoryRouter initialEntries={["/usage"]}>
        <UsageView />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Nutzung")).toBeInTheDocument();
    expect(await screen.findByText("claude-opus-5")).toBeInTheDocument();

    fireEvent.click(screen.getByText("claude-opus-5"));
    expect(await screen.findByTestId("usage-detail")).toBeInTheDocument();
  });

  it("Fenster als Ringe: Codex-Prozent vom Anbieter, Claude relativ zur eigenen Spitze + „Limit erreicht“", async () => {
    stub();
    renderWithClient(
      <MemoryRouter initialEntries={["/usage"]}>
        <UsageView />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("group", { name: "Codex, 5-Stunden-Fenster: 42 Prozent" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Claude Max, 5-Stunden-Fenster: 25 Prozent" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Codex, Woche: keine Angabe" })).toBeInTheDocument();
    expect(screen.getByText(/Limit erreicht · frei ab/)).toBeInTheDocument();
    expect(screen.getByText(/Das echte Limit nennt Anthropic nicht/)).toBeInTheDocument();
    // Kein Entwickler-Text mehr (`quotaLimits`, five_hour, Quelle: …).
    expect(screen.queryByText(/quotaLimits|five_hour|Quelle:/)).toBeNull();
  });

  it("Verlauf: Tage ohne Daten stehen als 0 auf der Achse (keine Zeitverzerrung), Teuerste Sessions als Link", async () => {
    stub();
    renderWithClient(
      <MemoryRouter initialEntries={["/usage?range=all"]}>
        <UsageView />
      </MemoryRouter>,
    );
    await screen.findByText("Verlauf pro Tag");
    const table = document.querySelector("[data-chart='area']")?.parentElement?.querySelector("table");
    const rows = table?.querySelectorAll("tbody tr") ?? [];
    // 19.08. bis heute lückenlos → deutlich mehr als der eine Tag mit Daten.
    expect(rows.length).toBeGreaterThan(20);
    const link = (await screen.findByText("Teure Session")).closest("a");
    expect(link).toHaveAttribute("href", "/sessions/_/_/s1");
  });
});
