// Gemeinsame Diagramm-Bausteine — Achsen-Lücken, Tooltip per Maus/Tastatur, reduzierte Bewegung.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AreaChart, BarChart, Donut, Heatmap, StatCard, daySpan, fillDays, heatLevel, levelByThresholds, niceTicks, quartileThresholds, tickIndices, trendView } from "../src/components/charts";
import { resetCountUpMemory } from "../src/components/charts/StatCard";

function mockReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: reduced && q.includes("reduce"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  window.matchMedia = globalThis.matchMedia;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetCountUpMemory();
});

describe("scale: Achsen ohne Zeitverzerrung", () => {
  it("füllt fehlende Tage mit 0, statt sie zu überspringen", () => {
    const rows = [
      { day: "2026-09-10", v: 5 },
      { day: "2026-09-13", v: 2 },
    ];
    const filled = fillDays(rows, "2026-09-10", "2026-09-14", (day) => ({ day, v: 0 }));
    expect(filled.map((r) => r.day)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"]);
    expect(filled.map((r) => r.v)).toEqual([5, 0, 0, 2, 0]);
  });

  it("überquert Monatsgrenzen lückenlos", () => {
    expect(daySpan("2026-08-30", "2026-09-02")).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });

  it("X-Beschriftung: höchstens n Marken, erster und letzter Tag immer dabei", () => {
    const idx = tickIndices(30, 8);
    expect(idx.length).toBeLessThanOrEqual(8);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(29);
    expect(tickIndices(5, 8)).toEqual([0, 1, 2, 3, 4]);
  });

  it("Y-Achse: runde Werte, oberster ≥ Maximum", () => {
    expect(niceTicks(87, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it("Trend gegen Null-Basis oder > 500 % zeigt die absolute Änderung", () => {
    expect(trendView(62, 0)).toEqual({ text: "+62", direction: "up" });
    expect(trendView(65, 3)).toEqual({ text: "+62", direction: "up" });
    expect(trendView(12, 10)).toEqual({ text: "20 %", direction: "up" });
    expect(trendView(5, 10)).toEqual({ text: "50 %", direction: "down" });
    expect(trendView(4, 4).direction).toBe("flat");
  });

  it("Heatmap-Stufen: 0 nur für nichts; Quartile verteilen schiefe Daten auf alle Stufen", () => {
    expect([0, 1, 30, 60, 100].map((v) => heatLevel(v, 100))).toEqual([0, 1, 2, 3, 4]);
    const skewed = [1, 2, 3, 4, 5, 6, 7, 1000];
    const t = quartileThresholds(skewed);
    const levels = skewed.map((v) => levelByThresholds(v, t));
    expect(new Set(levels)).toEqual(new Set([1, 2, 3, 4]));
    expect(levelByThresholds(0, t)).toBe(0);
  });
});

const AREA = [
  { x: "2026-09-20", values: { claude: 100, codex: 20 } },
  { x: "2026-09-21", values: { claude: 0, codex: 0 } },
  { x: "2026-09-22", values: { claude: 300, codex: 50 } },
];
const SERIES = [
  { key: "claude", label: "Claude", color: "var(--a-acc)" },
  { key: "codex", label: "Codex", color: "var(--a-acc2)" },
];

describe("AreaChart", () => {
  it("Tastatur: Fokus zeigt den letzten Tag, Pfeiltaste wandert, EIN Tooltip nennt alle Reihen + Summe", () => {
    mockReducedMotion(true);
    const onSelect = vi.fn();
    render(<AreaChart data={AREA} series={SERIES} stacked ariaLabel="Tokens je Tag" formatValue={String} formatTick={(x) => x.slice(8)} formatTooltipX={(x) => `Tag ${x}`} onSelect={onSelect} initialWidth={600} />);
    const chart = screen.getByRole("group", { name: /Tokens je Tag/ });
    fireEvent.focus(chart);
    const tip = screen.getByRole("status");
    expect(tip).toHaveTextContent("Tag 2026-09-22");
    expect(tip).toHaveTextContent("Claude300");
    expect(tip).toHaveTextContent("Codex50");
    expect(tip).toHaveTextContent("Summe350");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("Tag 2026-09-21");
    expect(screen.getByRole("status")).toHaveTextContent("Summe0");
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("2026-09-21");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Legende ab 2 Reihen, keine Legende bei einer Reihe; Tabelle als Alternative", () => {
    mockReducedMotion(true);
    const { rerender } = render(<AreaChart data={AREA} series={SERIES} ariaLabel="A" formatValue={String} formatTick={String} formatTooltipX={String} initialWidth={600} />);
    expect(screen.getByRole("list", { name: "Legende" })).toBeInTheDocument();
    expect(document.querySelectorAll("table tbody tr")).toHaveLength(3);
    rerender(<AreaChart data={AREA} series={SERIES.slice(0, 1)} ariaLabel="A" formatValue={String} formatTick={String} formatTooltipX={String} initialWidth={600} />);
    expect(screen.queryByRole("list", { name: "Legende" })).toBeNull();
  });

  it("reduzierte Bewegung: sofort voll eingezeichnet (Clip = volle Breite)", () => {
    mockReducedMotion(true);
    render(<AreaChart data={AREA} series={SERIES} ariaLabel="A" formatValue={String} formatTick={String} formatTooltipX={String} initialWidth={600} />);
    const clip = document.querySelector("clipPath rect");
    expect(Number(clip?.getAttribute("width"))).toBeGreaterThanOrEqual(600 - 1);
  });

  it("ohne reduzierte Bewegung: startet bei 0 und zeichnet ein", () => {
    mockReducedMotion(false);
    let rafCb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<AreaChart data={AREA} series={SERIES} ariaLabel="A" formatValue={String} formatTick={String} formatTooltipX={String} initialWidth={600} />);
    const before = Number(document.querySelector("clipPath rect")?.getAttribute("width"));
    expect(before).toBeLessThan(100);
    act(() => rafCb?.(performance.now() + 10_000));
    const after = Number(document.querySelector("clipPath rect")?.getAttribute("width"));
    expect(after).toBeGreaterThan(590);
  });
});

describe("BarChart", () => {
  it("heutiger Balken trägt das Wert-Etikett, Hover zeigt Tooltip des Balkens", () => {
    mockReducedMotion(true);
    const data = [
      { x: "2026-09-23", value: 3 },
      { x: "2026-09-24", value: 0 },
      { x: "2026-09-25", value: 7 },
    ];
    render(<BarChart data={data} unit="Commits" ariaLabel="Commits je Tag" formatTick={(x) => x.slice(8)} formatTooltipX={(x) => `Tag ${x}`} initialWidth={300} />);
    const svg = document.querySelector("[data-chart='bar'] svg");
    expect(svg?.textContent).toContain("7");
    fireEvent.pointerEnter(document.querySelector("[data-bar='2026-09-23']") as Element);
    expect(screen.getByRole("status")).toHaveTextContent("Tag 2026-09-23");
    expect(screen.getByRole("status")).toHaveTextContent("Commits3");
  });
});

describe("Donut + Heatmap", () => {
  it("Donut: Mitte-Zahl, Pfeiltaste zeigt Segment-Anteil", () => {
    mockReducedMotion(true);
    render(
      <Donut
        segments={[
          { key: "a", label: "Modell A", value: 75, color: "var(--a-acc)" },
          { key: "b", label: "Modell B", value: 25, color: "var(--a-acc2)" },
        ]}
        center={{ value: "100", label: "Tokens" }}
        ariaLabel="Anteile"
      />,
    );
    expect(screen.getByText("100")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("group", { name: "Anteile" }), { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("75 %");
    expect(screen.getByRole("status")).toHaveTextContent("Modell A");
  });

  it("Heatmap: Tastatur wandert in 2D, Tooltip nennt Zelle", () => {
    const values = [
      [0, 5],
      [10, 0],
    ];
    render(<Heatmap rowLabels={["Mo", "Di"]} colCount={2} colLabel={String} values={values} cellTitle={(r, c) => `Z${r}-${c}`} formatValue={String} ariaLabel="Aktivität" />);
    const grid = screen.getByRole("group", { name: /Aktivität/ });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(screen.getByRole("status")).toHaveTextContent("Z1-0");
    expect(screen.getByRole("status")).toHaveTextContent("Tokens10");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("Z1-1");
  });
});

describe("StatCard", () => {
  it("reduzierte Bewegung: zeigt sofort den Endwert (kein Hochzählen)", () => {
    mockReducedMotion(true);
    render(
      <MemoryRouter>
        <StatCard id="t1" label="Commits" value={42} format={String} href="/git" />
      </MemoryRouter>,
    );
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Commits").closest("a")).toHaveAttribute("href", "/git");
  });

  it("zählt nur bei der ERSTEN Anzeige hoch, beim zweiten Einbau steht der Wert sofort", () => {
    mockReducedMotion(false);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const first = render(<StatCard id="t2" label="X" value={100} format={(n) => String(Math.round(n))} />);
    expect(screen.getByText("0")).toBeInTheDocument();
    act(() => frames.at(-1)?.(performance.now() + 10_000));
    expect(screen.getByText("100")).toBeInTheDocument();
    first.unmount();
    render(<StatCard id="t2" label="X" value={100} format={(n) => String(Math.round(n))} />);
    expect(screen.getByText("100")).toBeInTheDocument();
  });
});
