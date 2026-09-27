// Nutzung → „Verlauf pro Tag“: Claude- UND Codex-Linie sind immer beide zu sehen.
// Ursache vorher: gestapelt (Codex-Linie = Claude + Codex) und die Linien in umgekehrter Reihenfolge
// gezeichnet – wo Codex klein oder 0 war, lag die Codex-Linie genau unter der Claude-Linie.
import { fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageView } from "../src/features/usage/UsageView";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const today = new Date();
const dayAgo = (n: number) => new Date(today.getTime() - n * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
const row = (day: string, tool: "claude" | "codex", totalTokens: number) => ({ day, tool, model: tool === "claude" ? "claude-opus-5" : "gpt-5-codex", project: "myproject", totalTokens, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 });
// Realistische Daten: Claude jeden Tag viel, Codex nur an einzelnen Tagen und kleiner.
const DAYS = [row(dayAgo(3), "claude", 600_000_000), row(dayAgo(3), "codex", 70_000_000), row(dayAgo(2), "claude", 200_000_000), row(dayAgo(1), "claude", 300_000_000), row(dayAgo(0), "claude", 900_000_000)];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/usage/daily")) return jsonResponse({ days: DAYS });
      if (url.startsWith("/api/usage/models")) return jsonResponse({ models: [] });
      if (url.startsWith("/api/usage/sessions")) return jsonResponse({ sessions: [] });
      if (url.startsWith("/api/usage/hourly")) return jsonResponse({ cells: [] });
      if (url.startsWith("/api/usage/window")) return jsonResponse({ windows: [] });
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
}

async function renderVerlauf(): Promise<HTMLElement> {
  stub();
  renderWithClient(
    <MemoryRouter initialEntries={["/usage?range=7d"]}>
      <UsageView />
    </MemoryRouter>,
  );
  await screen.findByText("Verlauf pro Tag");
  const chart = await vi.waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-chart='area']");
    if (!el) throw new Error("noch kein Diagramm");
    return el;
  });
  return chart;
}

const lines = (chart: HTMLElement) => [...chart.querySelectorAll<SVGPathElement>("path[data-role='line']")];

describe("beide Linien immer sichtbar", () => {
  // Claude (orange) liegt OBEN – zuletzt gezeichnet.
  it("Claude-Linie und -Fläche liegen über Codex (zuletzt gezeichnet), alle Linien über allen Flächen", async () => {
    const chart = await renderVerlauf();
    const ls = lines(chart);
    expect(ls.map((l) => l.dataset.series)).toEqual(["codex", "claude"]);
    const all = [...chart.querySelectorAll("path")];
    const areas = all.filter((p) => p.dataset.role === "area").map((p) => p.dataset.series);
    expect(areas).toEqual(["codex", "claude"]);
    const lastArea = Math.max(...all.map((p, i) => (p.dataset.role === "area" ? i : -1)));
    expect(all.indexOf(ls[0] as SVGPathElement)).toBeGreaterThan(lastArea);
    expect(ls[1]?.getAttribute("stroke")).toBe("var(--a-claude)");
    expect(ls[0]?.getAttribute("stroke")).toBe("var(--a-codex)");
  });

  it("Legende und Tooltip nennen Claude weiterhin zuerst; der Claude-Punkt liegt oben", async () => {
    const chart = await renderVerlauf();
    const legend = within(chart.parentElement as HTMLElement).getByRole("list", { name: "Legende" });
    expect(within(legend).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Claude", "Codex"]);
    fireEvent.focus(chart);
    expect(screen.getByRole("status").textContent ?? "").toMatch(/Claude[\s\S]*Codex/);
    const points = [...chart.querySelectorAll<SVGCircleElement>("circle[data-role='point']")].map((c) => c.dataset.series);
    expect(points).toEqual(["codex", "claude"]);
  });

  it("jede Linie zeigt ihren eigenen Wert (nicht gestapelt): Codex 0 liegt unten, Claude oben", async () => {
    const chart = await renderVerlauf();
    fireEvent.focus(chart); // letzter Tag aktiv: Claude 900 Mio., Codex 0
    const dot = (k: string) => Number(chart.querySelector(`circle[data-series='${k}'][data-role='point']`)?.getAttribute("cy"));
    expect(dot("codex")).toBeGreaterThan(dot("claude"));
    // Tooltip nennt beide Werte.
    expect(screen.getByRole("status")).toHaveTextContent(/Codex\s*0/);
  });

  it("Legende: Claude ausblenden → Codex füllt die Skala; die letzte sichtbare Linie bleibt", async () => {
    const chart = await renderVerlauf();
    const legend = within(chart.parentElement as HTMLElement).getByRole("list", { name: "Legende" });
    const claude = within(legend).getByRole("button", { name: "Claude" });
    expect(claude).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(claude);
    expect(claude).toHaveAttribute("aria-pressed", "false");
    expect(lines(chart).map((l) => l.dataset.series)).toEqual(["codex"]);
    const codex = within(legend).getByRole("button", { name: "Codex" });
    expect(codex).toBeDisabled();
    fireEvent.click(claude);
    expect(lines(chart).map((l) => l.dataset.series)).toEqual(["codex", "claude"]);
  });

  // Codex ausgeblendet, dann Filter „nur Codex“ → vorher leeres Diagramm ohne Legende (kein Weg zurück).
  it("ausgeblendete Reihe + Werkzeug-Filter auf genau diese Reihe → Linie trotzdem sichtbar", async () => {
    const chart = await renderVerlauf();
    const legend = within(chart.parentElement as HTMLElement).getByRole("list", { name: "Legende" });
    fireEvent.click(within(legend).getByRole("button", { name: "Codex" }));
    expect(lines(chart).map((l) => l.dataset.series)).toEqual(["claude"]);
    fireEvent.click(within(screen.getByRole("group", { name: "Werkzeug" })).getByRole("button", { name: "Codex" }));
    await vi.waitFor(() => {
      const c = document.querySelector<HTMLElement>("[data-chart='area']");
      expect(c && lines(c).map((l) => l.dataset.series)).toEqual(["codex"]);
    });
  });

  it("Untertitel sagt, was man sieht (nicht mehr „gestapelt“)", async () => {
    await renderVerlauf();
    expect(screen.queryByText(/gestapelt/)).toBeNull();
    expect(screen.getByText(/je eine eigene Linie/)).toBeInTheDocument();
  });
});
