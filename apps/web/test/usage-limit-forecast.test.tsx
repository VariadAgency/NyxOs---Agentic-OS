// „Limit-Wecker“ auf /usage: eine Zeile je Fenster unter den Ringen — „Bei diesem Tempo voll um …, Reset
// erst …“ bzw. ehrlich, wenn der Anbieter nichts meldet.
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

const reported = { fiveHourPct: null, weekPct: null, limitReached: false, limitType: null, resetsAt: null };
const WINDOWS = [
  { tool: "claude", tokens5h: 900, tokens7d: 5000, peak5h: 1000, peak7d: 9000, hourly24: [], reported },
  { tool: "codex", tokens5h: 0, tokens7d: 0, peak5h: 0, peak7d: 0, hourly24: [], reported },
];
const FORECAST = [
  { tool: "claude", window: "5h", pct: 90, resetsAt: "2026-09-25T21:00:00.000Z", hitsLimitAt: "2026-09-25T20:35:00.000Z", unusedAtReset: 0, pacePctPerMin: 0.4, basis: "reported", line: "Bei diesem Tempo voll um 22:35 (in ~25 Min) · Reset erst 23:00" },
  { tool: "claude", window: "week", pct: null, resetsAt: null, hitsLimitAt: null, unusedAtReset: null, pacePctPerMin: null, basis: null, line: "Woche: Claude nennt keinen Wochen-Füllstand, darum keine Hochrechnung." },
  { tool: "codex", window: "5h", pct: null, resetsAt: null, hitsLimitAt: null, unusedAtReset: null, pacePctPerMin: null, basis: null, line: "5 Std: Codex meldet gerade keinen Füllstand, darum keine Hochrechnung." },
];

describe("Limit-Wecker auf /usage", () => {
  it("zeigt die Hochrechnung unter dem Fenster, hervorgehoben wenn es vor dem Reset voll wird", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/usage/window")) return jsonResponse({ windows: WINDOWS, forecast: FORECAST });
        if (url.startsWith("/api/usage/settings")) return jsonResponse({ defaultRange: "30", goalScope: "all", goalMonthTokens: null, goalWeekTokens: null, warnWindowPct: null, warnDailyTokens: null });
        if (url.startsWith("/api/usage/goals")) return jsonResponse({ scope: "all", week: null, month: null, warnings: { daily: null, window: null } });
        if (url.startsWith("/api/usage/daily")) return jsonResponse({ days: [] });
        if (url.startsWith("/api/usage/models")) return jsonResponse({ models: [] });
        if (url.startsWith("/api/usage/hourly")) return jsonResponse({ cells: [] });
        if (url.startsWith("/api/usage/sessions")) return jsonResponse({ sessions: [] });
        return Promise.reject(new Error(`nicht Teil dieses Tests: ${url}`));
      }),
    );
    const { container } = renderWithClient(
      <MemoryRouter initialEntries={["/usage"]}>
        <UsageView />
      </MemoryRouter>,
    );
    const line = await screen.findByText("Bei diesem Tempo voll um 22:35 (in ~25 Min) · Reset erst 23:00");
    const claude = container.querySelector<HTMLElement>('[data-window="claude"]');
    expect(claude).not.toBeNull();
    expect(within(claude as HTMLElement).getByText(/keinen Wochen-Füllstand/)).toBeInTheDocument();
    expect(line.closest("[data-forecast]")?.getAttribute("data-forecast")).toBe("voll");
    const codex = container.querySelector<HTMLElement>('[data-window="codex"]');
    expect(within(codex as HTMLElement).getByText(/Codex meldet gerade keinen Füllstand/)).toBeInTheDocument();
  });
});
