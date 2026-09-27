// Nutzung — Vergleiche, Ziele mit Hochrechnung, Einstellungen (Blatt „Nutzung einstellen“).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageView } from "../src/features/usage/UsageView";
import { formatTokenInput, formatTokensCompact, parseTokenAmount } from "../src/features/usage/format";
import { __primeAuthForTests, __resetAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => __primeAuthForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  __resetAuthForTests();
});

describe("Zahlen: einheitlich Mio./Mrd., Eingabe wie gesprochen", () => {
  it("formatiert Tokens einheitlich", () => {
    // Intl setzt ein geschütztes Leerzeichen vor „Mio.“/„Mrd.“ (bricht nie um) — für den Vergleich normalisiert.
    const f = (n: number) => formatTokensCompact(n).replace(/\u00a0/g, " ");
    expect(f(1234)).toBe("1.234");
    expect(f(999_999)).toBe("999.999");
    expect(f(1_500_000)).toBe("1,5 Mio.");
    expect(f(10_000_000_000)).toBe("10 Mrd.");
  });

  it.each([
    ["10 Mrd.", 10_000_000_000],
    ["10 mrd", 10_000_000_000],
    ["1,5 Mrd", 1_500_000_000],
    ["500 Mio.", 500_000_000],
    ["2 Milliarden", 2_000_000_000],
    ["10.000.000.000", 10_000_000_000],
    ["750000", 750_000],
    ["12 Tsd.", 12_000],
  ])("liest „%s“", (input, expected) => {
    expect(parseTokenAmount(input)).toBe(expected);
  });

  it("Eingabefeld: kurz, wo es verlustfrei geht, sonst die volle Zahl", () => {
    expect(parseTokenAmount(formatTokenInput(10_000_000_000))).toBe(10_000_000_000);
    expect(parseTokenAmount(formatTokenInput(1_500_000_000))).toBe(1_500_000_000);
    expect(parseTokenAmount(formatTokenInput(1_234_567_890))).toBe(1_234_567_890);
  });

  it.each(["", "abc", "-5", "0", "10 Äpfel"])("lehnt „%s“ ab", (input) => {
    expect(parseTokenAmount(input)).toBeNull();
  });
});

const series7 = { currentDays: ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"], previousDays: ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"], current: [4e9, 3e9, 2e9, 1e9, 5e8, null, null], previous: [1e9, 1e9, 1e9, 1e9, 1e9, 2e9, 2e9] };
const tools = (claude: number, codex: number) => [
  { tool: "claude", tokens: claude, previousTokens: claude / 2, deltaPct: 100, cost: 1234.5, costComplete: true, activeDays: 5, share: (claude / (claude + codex)) * 100, topModel: "claude-opus-5" },
  { tool: "codex", tokens: codex, previousTokens: codex * 2, deltaPct: -50, cost: 12, costComplete: false, activeDays: 2, share: (codex / (claude + codex)) * 100, topModel: "gpt-6" },
];
const COMPARE = {
  now: "2026-09-25T10:00:00.000Z",
  week: {
    kind: "week",
    current: { fromDay: "2026-09-21", toDay: "2026-09-25", tokens: 10.5e9, byTool: { claude: 9.5e9, codex: 1e9 } },
    previous: { fromDay: "2026-09-14", toDay: "2026-09-18", tokens: 5e9, byTool: { claude: 4.75e9, codex: 2e9 } },
    previousFull: { fromDay: "2026-09-14", toDay: "2026-09-20", tokens: 9e9, byTool: { claude: 8e9, codex: 1e9 } },
    deltaPct: 110,
    series: series7,
    tools: tools(9.5e9, 1e9),
    totalDays: 7,
  },
  month: {
    kind: "month",
    current: { fromDay: "2026-09-01", toDay: "2026-09-25", tokens: 40e9, byTool: { claude: 36e9, codex: 4e9 } },
    previous: { fromDay: "2026-08-01", toDay: "2026-08-25", tokens: 50e9, byTool: { claude: 45e9, codex: 5e9 } },
    previousFull: { fromDay: "2026-08-01", toDay: "2026-08-31", tokens: 60e9, byTool: { claude: 54e9, codex: 6e9 } },
    deltaPct: -20,
    series: { currentDays: [], previousDays: [], current: [], previous: [] },
    tools: tools(36e9, 4e9),
    totalDays: 30,
  },
};

function stub(over: { settings?: Record<string, unknown>; goals?: Record<string, unknown> } = {}) {
  const settings = { defaultRange: "30", goalScope: "all", goalMonthTokens: null, goalWeekTokens: null, warnWindowPct: null, warnDailyTokens: null, ...over.settings };
  const goals = { scope: "all", week: null, month: null, warnings: { daily: null, window: null }, ...over.goals };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/usage/settings") && init?.method === "PATCH") return jsonResponse({ ...settings, ...(JSON.parse(String(init.body)) as object) });
    if (url.startsWith("/api/usage/settings")) return jsonResponse(settings);
    if (url.startsWith("/api/usage/goals")) return jsonResponse(goals);
    if (url.startsWith("/api/usage/compare")) return jsonResponse(COMPARE);
    if (url.startsWith("/api/usage/model-trend"))
      return jsonResponse({ weeks: ["2026-09-07", "2026-09-14", "2026-09-21"], models: [{ model: "claude-opus-5", tool: "claude", tokens: [1e9, 2e9, 3e9], total: 6e9 }, { model: "gpt-6", tool: "codex", tokens: [0, 1e9, 1e9], total: 2e9 }] });
    if (url.startsWith("/api/usage/baustellen"))
      return jsonResponse({ items: [{ slug: "heatmap", label: "Heatmap", art: "coding", tokens: 3e9, claude: 2e9, codex: 1e9, sessions: 4 }, { slug: "nyxos", label: "NyxOS", art: "audit", tokens: 1e9, claude: 1e9, codex: 0, sessions: 1 }], ohneBaustelle: 5e8, andere: 7e9 });
    if (url.startsWith("/api/usage/daily")) return jsonResponse({ days: [] });
    if (url.startsWith("/api/usage/models")) return jsonResponse({ models: [] });
    if (url.startsWith("/api/usage/sessions")) return jsonResponse({ sessions: [] });
    if (url.startsWith("/api/usage/hourly")) return jsonResponse({ cells: [] });
    if (url.startsWith("/api/usage/window")) return jsonResponse({ windows: [] });
    return Promise.reject(new Error(`unerwartete URL ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderUsage(path = "/usage") {
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <UsageView />
    </MemoryRouter>,
  );
}

describe("UsageView · Vergleiche", () => {
  it("Woche für Woche mit Trend-Chip gegen den gleichen Stand der Vorwoche, umschaltbar auf Monat", async () => {
    stub();
    renderUsage();
    const panel = await screen.findByRole("region", { name: "Zeitraum im Vergleich" });
    expect(within(panel).getByText("10,5 Mrd.")).toBeInTheDocument();
    expect(within(panel).getByText("110 %")).toBeInTheDocument();
    expect(within(panel).getByText(/Vorwoche bis zum gleichen Stand: 5 Mrd\./)).toBeInTheDocument();
    expect(within(panel).getByText(/ganze Vorwoche: 9 Mrd\./)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Monat" }));
    expect(within(panel).getByText("40 Mrd.")).toBeInTheDocument();
    expect(within(panel).getByText("20 %")).toBeInTheDocument();
  });

  it("Claude und Codex gegenübergestellt (Anteil, Tokens, Top-Modell)", async () => {
    stub();
    renderUsage();
    const panel = await screen.findByRole("region", { name: "Claude und Codex" });
    expect(within(panel).getByText("claude-opus-5")).toBeInTheDocument();
    expect(within(panel).getByText("gpt-6")).toBeInTheDocument();
    expect(within(panel).getByText("9,5 Mrd.")).toBeInTheDocument();
    expect(within(panel).getByText(/90 %/)).toBeInTheDocument();
  });

  it("pro Baustelle: klickbar zur Baustelle, fremde Projekte nur als Summe", async () => {
    stub();
    renderUsage();
    const panel = await screen.findByRole("region", { name: "Nach Baustelle" });
    expect(within(panel).getByRole("link", { name: /Heatmap/ })).toHaveAttribute("href", "/sessions/coding/heatmap");
    expect(within(panel).getByText(/andere Projekte 7 Mrd\./)).toBeInTheDocument();
  });

  it("Modelle im Verlauf: Anteil je Woche", async () => {
    stub();
    renderUsage();
    expect(await screen.findByRole("region", { name: "Modelle im Verlauf" })).toBeInTheDocument();
  });
});

describe("UsageView · Ziele und Einstellungen", () => {
  it("Standard-Zeitraum aus den Einstellungen, wenn die Adresse keinen nennt", async () => {
    const fetchMock = stub({ settings: { defaultRange: "7" } });
    renderUsage();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/usage/daily?range=7"))).toBe(true));
    // Auch Modelle und Heatmap warten auf den Standard — kein kurzer Zwischenstand mit 30 Tagen.
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/usage/models?range=7"))).toBe(true));
    expect(fetchMock.mock.calls.filter(([u]) => /range=30/.test(String(u))).map(([u]) => String(u))).toEqual([]);
  });

  it("Monatsziel mit Fortschritt und ehrlicher Hochrechnung", async () => {
    stub({
      goals: {
        month: { kind: "month", fromDay: "2026-09-01", lastDay: "2026-09-30", target: 10e9, soFar: 4e9, pct: 40, pacePerDay: 3e8, remainingDays: 15, projected: 8.5e9, onTrack: false, neededPerDay: 4e8, reachDay: null },
      },
    });
    renderUsage();
    const panel = await screen.findByRole("region", { name: "Ziele" });
    expect(within(panel).getByText(/4 Mrd\. von 10 Mrd\./)).toBeInTheDocument();
    expect(within(panel).getByText(/schaffst du bis 30\.09\. eher nicht/)).toBeInTheDocument();
    expect(within(panel).getByText(/ca\. 8,5 Mrd\./)).toBeInTheDocument();
    expect(within(panel).getByText(/400 Mio\. je Tag/)).toBeInTheDocument();
  });

  it("Blatt „Nutzung einstellen“: Ziel wie gesprochen eingeben, gespeichert mit Anmeldung", async () => {
    const fetchMock = stub();
    renderUsage();
    fireEvent.click(await screen.findByRole("button", { name: "Nutzung einstellen" }));
    const sheet = await screen.findByRole("region", { name: "Nutzung einstellen" });
    fireEvent.change(within(sheet).getByLabelText("Ziel je Monat"), { target: { value: "10 Mrd." } });
    fireEvent.change(within(sheet).getByLabelText("Warnen ab Anteil am 5-Std-Fenster (%)"), { target: { value: "80" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Speichern" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/usage/settings" && i?.method === "PATCH");
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
      expect(body.goalMonthTokens).toBe(10_000_000_000);
      expect(body.warnWindowPct).toBe(80);
      expect(new Headers(call?.[1]?.headers).get("x-nyxos-csrf")).toBe("test-csrf");
    });
    expect(await within(sheet).findByText("Gespeichert.")).toBeInTheDocument();
  });

  it("ungültige Eingabe: klare Meldung, nichts gespeichert", async () => {
    const fetchMock = stub();
    renderUsage();
    fireEvent.click(await screen.findByRole("button", { name: "Nutzung einstellen" }));
    const sheet = await screen.findByRole("region", { name: "Nutzung einstellen" });
    fireEvent.change(within(sheet).getByLabelText("Ziel je Monat"), { target: { value: "ganz viel" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Speichern" }));
    expect(await within(sheet).findByText(/Ziel je Monat: bitte eine Zahl/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(false);
  });
});
