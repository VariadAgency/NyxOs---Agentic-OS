// /usage zeigt echte Claude-Werte „von Anthropic“ mit Reset-Zeiten; eine Schätzung aus Token-Summen bleibt
// als „Schätzung“ grau und wird nie als „voll“ hervorgehoben.
import { screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageView } from "../src/features/usage/UsageView";
import { __primeAuthForTests, __resetAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => __primeAuthForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  __resetAuthForTests();
});

const base = { tool: "claude", tokens5h: 900, tokens7d: 5000, peak5h: 1000, peak7d: 9000, hourly24: [] };
const codex = { tool: "codex", tokens5h: 0, tokens7d: 0, peak5h: 0, peak7d: 0, hourly24: [], reported: { fiveHourPct: null, weekPct: null, limitReached: false, limitType: null, resetsAt: null } };

function stub(windows: unknown[], forecast: unknown[], official?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/usage/window")) return jsonResponse({ windows, forecast, ...(official ? { official } : {}) });
      if (url.startsWith("/api/usage/settings")) return jsonResponse({ defaultRange: "30", goalScope: "all", goalMonthTokens: null, goalWeekTokens: null, warnWindowPct: null, warnDailyTokens: null });
      if (url.startsWith("/api/usage/goals")) return jsonResponse({ scope: "all", week: null, month: null, warnings: { daily: null, window: null } });
      if (url.startsWith("/api/usage/daily")) return jsonResponse({ days: [] });
      if (url.startsWith("/api/usage/models")) return jsonResponse({ models: [] });
      if (url.startsWith("/api/usage/hourly")) return jsonResponse({ cells: [] });
      if (url.startsWith("/api/usage/sessions")) return jsonResponse({ sessions: [] });
      return Promise.reject(new Error(`nicht Teil dieses Tests: ${url}`));
    }),
  );
  return renderWithClient(
    <MemoryRouter initialEntries={["/usage"]}>
      <UsageView />
    </MemoryRouter>,
  );
}

describe("echte Limits auf /usage", () => {
  it("Claude mit Werten von Anthropic: Kennzeichnung, Stand und Reset-Zeiten", async () => {
    const reported = { fiveHourPct: 5, weekPct: 29, limitReached: false, limitType: null, resetsAt: "2026-09-26T18:30:00.000Z", weekResetsAt: "2026-10-02T17:00:00.000Z", source: "anthropic", fetchedAt: "2026-09-26T14:03:00.000Z" };
    const forecast = [{ tool: "claude", window: "5h", pct: 5, resetsAt: "2026-09-26T18:30:00.000Z", hitsLimitAt: null, unusedAtReset: 95, pacePctPerMin: null, basis: "reported", line: "Sitzung 5 % belegt · Reset 20:30 (von Anthropic)" }];
    const { container } = stub([{ ...base, reported }, codex], forecast);
    await screen.findByText("Sitzung 5 % belegt · Reset 20:30 (von Anthropic)");
    const claude = container.querySelector<HTMLElement>('[data-window="claude"]') as HTMLElement;
    expect(within(claude).getByText(/^Von Anthropic · Stand/)).toBeInTheDocument();
    expect(within(claude).getByText(/Werte direkt von Anthropic · Sitzung frei ab .* · Woche neu ab/)).toBeInTheDocument();
    expect(within(claude).queryByText(/stärksten Fenster/)).toBeNull();
  });

  it("ohne echte Werte: die Hochrechnung ist als Schätzung markiert und nicht gelb hervorgehoben", async () => {
    const reported = { fiveHourPct: null, weekPct: null, limitReached: false, limitType: null, resetsAt: null };
    const forecast = [{ tool: "claude", window: "5h", pct: 90, resetsAt: "2026-09-26T19:00:00.000Z", hitsLimitAt: "2026-09-26T14:28:00.000Z", unusedAtReset: 0, pacePctPerMin: 0.4, basis: "last_limit", line: "Schätzung: Bei diesem Tempo voll um 16:28 (in ~25 Min) · Reset erst 21:00" }];
    stub([{ ...base, reported }, codex], forecast);
    const line = await screen.findByText(/^Schätzung: Bei diesem Tempo voll/);
    expect(line.closest("[data-forecast]")?.getAttribute("data-forecast")).toBe("schaetzung");
  });

  it("Werte von CodexBar: Kennzeichnung „Von CodexBar (Anthropic-Werte) · Stand …“", async () => {
    const reported = { fiveHourPct: 9, weekPct: 30, limitReached: false, limitType: null, resetsAt: "2026-09-26T18:29:59.000Z", weekResetsAt: "2026-10-02T17:59:59.000Z", source: "codexbar", fetchedAt: "2026-09-26T15:06:00.000Z" };
    const official = { fresh: true, source: "codexbar", fetchedAt: "2026-09-26T15:06:00.000Z", error: null, errorText: null, codexbarAt: "2026-09-26T15:06:00.000Z" };
    const { container } = stub([{ ...base, reported }, codex], [], official);
    const claude = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-window="claude"]');
      if (!el) throw new Error("noch nicht da");
      return el;
    });
    expect(await within(claude).findByText(/^Von CodexBar \(optional, macOS; Anthropic-Werte\) · Stand \d\d:\d\d/)).toBeInTheDocument();
    expect(within(claude).getByText(/Anthropic-Werte über CodexBar \(optional, macOS\) · Sitzung frei ab/)).toBeInTheDocument();
    expect(within(claude).queryByText(/Echte Limits nicht verfügbar/)).toBeNull();
  });

  it("keine echte Quelle aktuell: der Grund wird angezeigt statt still", async () => {
    const reported = { fiveHourPct: null, weekPct: null, limitReached: false, limitType: null, resetsAt: null, source: null, fetchedAt: null };
    const official = { fresh: false, source: null, fetchedAt: null, error: "forbidden", errorText: "Das Token darf die Nutzung nicht lesen (fehlende Berechtigung).", codexbarAt: null };
    const { container } = stub([{ ...base, reported }, codex], [], official);
    const line = await screen.findByText(/^Echte Limits nicht verfügbar: Das Token darf die Nutzung nicht lesen/);
    expect(line.closest('[data-window="claude"]')).not.toBeNull();
    expect(line.textContent).toMatch(/CodexBar \(optional, macOS\) meldet nichts/);
    expect(container.querySelector('[data-window="codex"]')?.textContent).not.toMatch(/Echte Limits nicht verfügbar/);
  });
});
