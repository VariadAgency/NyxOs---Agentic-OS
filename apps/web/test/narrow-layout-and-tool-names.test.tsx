// Schmale Layouts, Diagramm-Beschriftungen und Werkzeug-Namen in einfachen Wörtern.
// 1. Gehirn bei 390 px: Hilfe-Leiste bricht um statt rechts abgeschnitten; beim Schmal-Werden klappt sie ein.
//    Dazu: Auswahl eines Riesen-Knotens ohne Strahlenfächer – höchstens 60 Kanten, 1/√n, Nachbarfarbe.
// 2. Nyx-Tab: wird das Fenster schmal, klappt die Chat-Leiste zu – der gemerkte Wunsch für breit bleibt.
// 3. Diagramm-Achsen in der Schrift-Skala (text-label, 11 px) statt Inline-10,5 px.
// 4. Werkzeug-Namen: einfache Wörter statt „nutzung“/„server_lage“ in Leiste, Ausgabe-Feld und Nyx-Tab.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AreaChart, BarChart } from "../src/components/charts";
import { Graph3DHelp } from "../src/features/brain/Graph3DHelp";
import { HI_MAX_EDGES, highlightColors, highlightCrowdFactor, planHighlight } from "../src/features/brain/highlight";
import { pendingText } from "../src/features/haiku/useHaikuChat";
import { phaseWord } from "../src/features/nyx/bar/NyxBar";
import { NyxCaption, type NyxCaptionProps } from "../src/features/nyx/bar/NyxCaption";
import { NyxTab, statusLine } from "../src/features/nyx/tab/NyxTab";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { emitNyxLive } from "../src/lib/liveBus";
import { jsonResponse, renderWithClient } from "./helpers";

/** matchMedia mit umschaltbarer Breite: alle `max-width`-Abfragen gelten als „schmal“, solange `narrow` wahr ist. */
function mediaStub(startNarrow: boolean) {
  let narrow = startNarrow;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() {
      return q.includes("max-width") ? narrow : false;
    },
    media: q,
    onchange: null,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  window.matchMedia = globalThis.matchMedia;
  return {
    setNarrow(v: boolean) {
      narrow = v;
      act(() => {
        for (const cb of [...listeners]) cb();
      });
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 1 · Gehirn-Hilfe bei 390 px ───
describe("Gehirn: Hilfe-Leiste bei schmal", () => {
  it("schmal: Leiste und Tastenhilfe brechen um (nichts rechts außerhalb), breit: eine Zeile", () => {
    mediaStub(true);
    render(<Graph3DHelp control="orbit" onControlChange={() => {}} onFit={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /tastenhilfe zeigen/i }));
    const bar = screen.getByTestId("brain-3d-bar");
    const keys = screen.getByTestId("brain-3d-keys");
    expect(bar.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(bar.className).not.toMatch(/whitespace-nowrap/);
    expect(keys.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(keys.className).toMatch(/basis-full/);
    // Jeder Hinweis bleibt als Ganzes zusammen („Zwei Finger: drehen“ bricht nicht mitten im Satz).
    for (const hint of Array.from(keys.children)) expect(hint.className).toMatch(/whitespace-nowrap/);
  });

  it("breit: eine Zeile, waagrecht scrollbar", () => {
    mediaStub(false);
    render(<Graph3DHelp control="orbit" onControlChange={() => {}} onFit={() => {}} />);
    const bar = screen.getByTestId("brain-3d-bar");
    expect(bar.className).toMatch(/flex-nowrap/);
    expect(bar.className).toMatch(/overflow-x-auto/);
    expect(screen.getByTestId("brain-3d-keys")).toBeTruthy();
  });

  it("Fenster wird schmal: Tastenhilfe klappt ein; wieder breit: wieder offen", () => {
    const media = mediaStub(false);
    render(<Graph3DHelp control="orbit" onControlChange={() => {}} onFit={() => {}} />);
    expect(screen.getByTestId("brain-3d-keys")).toBeTruthy();
    media.setNarrow(true);
    expect(screen.queryByTestId("brain-3d-keys")).toBeNull();
    expect(screen.getByRole("button", { name: /tastenhilfe zeigen/i })).toBeTruthy();
    media.setNarrow(false);
    expect(screen.getByTestId("brain-3d-keys")).toBeTruthy();
  });
});

// ─── 1b · Gehirn: Auswahl eines Riesen-Knotens ohne Strahlenfächer ───
describe("Gehirn: hervorgehobene Kanten eines Riesen-Knotens", () => {
  // Stern: Knoten 0 mit 300 Nachbarn; Abstand = Nummer des Nachbarn (1 ist am nächsten).
  const N = 300;
  const linkS = Uint32Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 0 : i + 1));
  const linkT = Uint32Array.from({ length: N }, (_, i) => (i % 2 === 0 ? i + 1 : 0));
  const adj: number[][] = Array.from({ length: N + 1 }, () => []);
  for (let e = 0; e < N; e++) {
    adj[linkS[e] ?? 0]?.push(e);
    adj[linkT[e] ?? 0]?.push(e);
  }
  const dist2 = (a: number, b: number) => (a - b) ** 2;

  it("höchstens 60 Kanten, die nächsten zuerst; versteckte Nachbarn zählen nicht", () => {
    const hidden = new Uint8Array(N + 1);
    hidden[1] = 1;
    const plan = planHighlight({ adj, linkS, linkT, hidden, focus: 0, dist2 });
    expect(plan.to.length).toBe(HI_MAX_EDGES);
    expect(HI_MAX_EDGES).toBeLessThanOrEqual(60);
    expect(plan.total).toBe(N - 1);
    expect(Array.from(plan.to.slice(0, 3))).toEqual([2, 3, 4]);
    expect(Math.max(...plan.to)).toBe(HI_MAX_EDGES + 1);
    expect(new Set(plan.from)).toEqual(new Set([0]));
    // Wenige Kanten: alle, ohne Sortier-Aufwand.
    expect(planHighlight({ adj, linkS, linkT, hidden, focus: 5, dist2 }).to.length).toBe(1);
  });

  it("Deckkraft sinkt mit 1/√n (bei vielen Kanten), bleibt aber sichtbar", () => {
    expect(highlightCrowdFactor(10)).toBe(1);
    const f100 = highlightCrowdFactor(100);
    expect(f100).toBeLessThan(1);
    expect(highlightCrowdFactor(25) / highlightCrowdFactor(100)).toBeCloseTo(2, 5);
    expect(highlightCrowdFactor(100_000)).toBeGreaterThan(0.2);
  });

  it("Kantenfarbe = Farbe des Nachbarn an beiden Enden (kein Weiß/Gelb vom gewählten Knoten)", () => {
    const rgb = new Float32Array([1, 1, 0.9, /* 1 */ 0.2, 0.6, 0.3, /* 2 */ 0.9, 0.3, 0.5]);
    const out = highlightColors(rgb, Uint32Array.from([2, 1]));
    expect(Array.from(out).map((v) => Math.round(v * 10) / 10)).toEqual([0.9, 0.3, 0.5, 0.9, 0.3, 0.5, 0.2, 0.6, 0.3, 0.2, 0.6, 0.3]);
  });

  it("scene3d nutzt die Begrenzung (kein Index über alle Kanten des Knotens mehr)", () => {
    const src = readFileSync(join(__dirname, "../src/features/brain/scene3d.ts"), "utf8");
    expect(src).toMatch(/planHighlight\(/);
    expect(src).toMatch(/highlightColors\(/);
    expect(src).toMatch(/highlightCrowdFactor\(/);
    expect(src).not.toMatch(/for \(const k of adj\[focusIdx\]/);
  });
});

// ─── 2 · Nyx-Tab: Leiste beim Schmal-Werden ───
function stubNyxFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/graph")) return jsonResponse({ version: 1, nodes: [], links: [], stats: { nodes: 0, links: 0, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } });
      if (url.startsWith("/api/haiku/tools")) return jsonResponse({ tools: [{ name: "git_lage", description: "Git-Lage" }, { name: "nutzung", description: "Nutzung" }] });
      if (url.startsWith("/api/nyx/live")) return jsonResponse({ state: { state: "idle", at: new Date(0).toISOString() }, tasks: [] });
      if (url.startsWith("/api/nyx/files")) return jsonResponse({ files: [] });
      if (url.startsWith("/health")) return jsonResponse({ ok: true });
      if (url.startsWith("/api/machines")) return jsonResponse([]);
      return jsonResponse({}, { status: 404 });
    }),
  );
}

function renderTab() {
  __primeAuthForTests();
  stubNyxFetch();
  return renderWithClient(
    <MemoryRouter initialEntries={["/nyx"]}>
      <Routes>
        <Route path="/nyx" element={<NyxTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

const stage = () => document.querySelector('[data-nyx="nyx-tab"]');

describe("Nyx-Tab: Chat-Leiste bei schmal", () => {
  it("breit offen → schmal: klappt zu (Netz frei), der Wunsch „offen“ bleibt gemerkt → breit: wieder offen", async () => {
    localStorage.setItem("nyx.tab.panel", "open");
    const media = mediaStub(false);
    renderTab();
    await screen.findByRole("tablist", { name: "Bereiche" });
    expect(stage()).toHaveAttribute("data-panel", "open");

    media.setNarrow(true);
    expect(stage()).toHaveAttribute("data-panel", "closed");
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(localStorage.getItem("nyx.tab.panel")).toBe("open");

    media.setNarrow(false);
    expect(stage()).toHaveAttribute("data-panel", "open");
  });

  it("schmal: Auf- und Zuklappen ändert den gemerkten Wunsch für breit nicht; Start schmal = Netz zuerst", async () => {
    localStorage.setItem("nyx.tab.panel", "open");
    const media = mediaStub(true);
    renderTab();
    await screen.findByRole("tablist", { name: "Bereiche" });
    expect(stage()).toHaveAttribute("data-panel", "closed");

    fireEvent.click(screen.getByRole("button", { name: "Leiste aufklappen" }));
    expect(stage()).toHaveAttribute("data-panel", "open");
    fireEvent.click(screen.getByRole("button", { name: "Leiste einklappen" }));
    expect(stage()).toHaveAttribute("data-panel", "closed");
    expect(localStorage.getItem("nyx.tab.panel")).toBe("open");

    media.setNarrow(false);
    expect(stage()).toHaveAttribute("data-panel", "open");
  });

  it("breit zugeklappt bleibt zu, auch über schmal hinweg", async () => {
    localStorage.setItem("nyx.tab.panel", "closed");
    const media = mediaStub(false);
    renderTab();
    await screen.findByRole("tablist", { name: "Bereiche" });
    media.setNarrow(true);
    media.setNarrow(false);
    expect(stage()).toHaveAttribute("data-panel", "closed");
  });
});

// ─── 3 · Diagramm-Achsen in der Skala ───
describe("Diagramm-Beschriftungen in der Schrift-Skala", () => {
  const svgTexts = (root: HTMLElement) => Array.from(root.querySelectorAll("svg text"));

  it("AreaChart: Achsen und Spitzenwert mit text-label, keine Inline-Größe", () => {
    mediaStub(false);
    const data = [
      { x: "2026-09-20", values: { claude: 100, codex: 20 } },
      { x: "2026-09-21", values: { claude: 0, codex: 0 } },
      { x: "2026-09-22", values: { claude: 300, codex: 50 } },
    ];
    const series = [
      { key: "claude", label: "Claude", color: "var(--a-claude)" },
      { key: "codex", label: "Codex", color: "var(--a-codex)" },
    ];
    const { container } = render(<AreaChart data={data} series={series} ariaLabel="Tokens" formatValue={String} formatTick={(x) => x.slice(8)} formatTooltipX={(x) => x} initialWidth={600} />);
    const texts = svgTexts(container);
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) {
      expect(t.getAttribute("style") ?? "").not.toMatch(/font-size/);
      expect(t.getAttribute("class") ?? "").toMatch(/(^|\s)text-label(\s|$)/);
    }
  });

  it("BarChart: Achse mit text-label, keine Inline-Größe", () => {
    mediaStub(false);
    const data = [
      { x: "2026-09-23", value: 3 },
      { x: "2026-09-24", value: 0 },
      { x: "2026-09-25", value: 7 },
    ];
    const { container } = render(<BarChart data={data} unit="Commits" ariaLabel="Commits" formatTick={(x) => x.slice(8)} formatTooltipX={(x) => x} initialWidth={300} />);
    const texts = svgTexts(container);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) {
      expect(t.getAttribute("style") ?? "").not.toMatch(/font-size/);
      expect(t.getAttribute("class") ?? "").toMatch(/(^|\s)text-label(\s|$)/);
    }
  });
});

// ─── 4 · Werkzeug-Namen ───
function captionProps(over: Partial<NyxCaptionProps> = {}): NyxCaptionProps {
  return {
    anchorRef: createRef<HTMLElement>(),
    talking: false,
    transcribing: false,
    visual: "idle" as NyxCaptionProps["visual"],
    toolName: null,
    heard: "Wie ist die Lage?",
    reply: "",
    sources: [],
    error: null,
    draft: "",
    setDraft: () => {},
    onSubmit: () => {},
    onClose: () => {},
    onOpenCenter: () => {},
    onFocusChange: () => {},
    ...over,
  };
}

describe("Werkzeug-Namen in einfachen Wörtern", () => {
  it("Leiste: „schaut in die Nutzung …“ statt „nutzt nutzung …“, unbekannt → „arbeitet …“", () => {
    expect(phaseWord("tool", "nutzung")).toBe("schaut in die Nutzung …");
    expect(phaseWord("tool", "server_lage")).toBe("prüft den Server …");
    expect(phaseWord("tool", "session_ergebnisse")).toBe("fasst eine Session zusammen …");
    expect(phaseWord("tool", "frobnicate_xyz")).toBe("arbeitet …");
    expect(phaseWord("tool", null)).toBe("arbeitet …");
  });

  it("Ausgabe-Feld: kein „Werkzeug: nutzung“", () => {
    render(
      <MemoryRouter>
        <NyxCaption {...captionProps({ visual: "tool" as NyxCaptionProps["visual"], toolName: "nutzung" })} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Schaut in die Nutzung …")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Werkzeug:|nutzung\b/);
  });

  it("Nyx-Zentrum (Tipp-Anzeige) und Statuszeile im Nyx-Tab", () => {
    expect(pendingText({ phase: "tool", tool: "server_lage" })).toBe("prüft den Server …");
    expect(pendingText({ phase: "tool", tool: "frobnicate_xyz" })).toBe("arbeitet …");
    expect(statusLine({ state: "tool", tool: "git_lage", awake: true, waking: false, continuous: false })).toBe("Schaut in Git …");
    expect(statusLine({ state: "tool", tool: "git_lage", awake: true, waking: false, continuous: false })).not.toContain("git_lage");
  });

  it("Nyx-Tab: Zustands-Chip und Aufgaben-Reiter zeigen Wörter, nie die ID", async () => {
    mediaStub(false);
    renderTab();
    await screen.findByRole("tablist", { name: "Bereiche" });
    act(() => emitNyxLive({ type: "nyx.state", state: "tool", tool: "server_lage", at: new Date().toISOString() }));
    await waitFor(() => expect(document.querySelector('[data-nyx="nyx-zustand"]')).toHaveTextContent("prüft den Server"));
    fireEvent.click(screen.getByRole("tab", { name: "Aufgaben live" }));
    const panel = await screen.findByRole("tabpanel", { name: "Aufgaben live" });
    expect(within(panel).getByText("Server")).toBeInTheDocument();
    expect(document.querySelector('[data-nyx="nyx-tab"]')?.textContent ?? "").not.toContain("server_lage");
  });
});
