// Nyx-Tab: Seitenleiste bleibt sichtbar, mehr Datenpunkte per Kabel um den leuchtenden Kern verknüpft,
// Schwenken des Netzes weicher und langsamer.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphResponse } from "@nyxos/shared";
import { App } from "../src/App";
import { buildNetModel, MAX_NET_NODES, SYNAPSES } from "../src/features/nyx/tab/netModel";
import { layoutNet } from "../src/features/nyx/tab/net3d/layout3d";
import { DRAG_PITCH_PER_PX, DRAG_YAW_PER_PX, dragVelocity, glide, GLIDE_KEEP_PER_S, WHEEL_PITCH, WHEEL_YAW } from "../src/features/nyx/tab/net3d/motion";
import { EDGE_WEIGHT, visualFor } from "../src/features/nyx/tab/net3d/visual";
import { NyxTab } from "../src/features/nyx/tab/NyxTab";
import { emitNyxLive } from "../src/lib/liveBus";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => {
  localStorage.clear();
  __primeAuthForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/graph")) return jsonResponse({ version: 1, nodes: [], links: [], stats: { nodes: 0, links: 0, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } });
      if (url.startsWith("/api/haiku/tools")) return jsonResponse({ tools: [{ name: "git_lage", description: "Git-Lage" }] });
      if (url.startsWith("/api/nyx/live")) return jsonResponse({ state: { state: "idle", at: new Date(0).toISOString() }, tasks: [] });
      if (url.startsWith("/api/nyx/files")) return jsonResponse({ files: [] });
      if (url.startsWith("/health")) return jsonResponse({ ok: true });
      if (url.startsWith("/api/machines")) return jsonResponse([]);
      return jsonResponse({}, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function graphOf(sessions: number, tasks: number, notes: number): GraphResponse {
  const nodes = [
    ...Array.from({ length: sessions }, (_, i) => ({ id: `session:claude:s${i}`, type: "session" as const, label: `Session ${i}`, degree: 1, ts: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), ref: { kind: "session" as const, id: `s${i}` } })),
    ...Array.from({ length: tasks }, (_, i) => ({ id: `task:${i}`, type: "task" as const, label: `Auftrag ${i}`, degree: i % 7, ref: { kind: "note" as const, path: `t${i}.md` } })),
    ...Array.from({ length: notes }, (_, i) => ({ id: `note:${i}`, type: "note" as const, label: `Notiz ${i}`, degree: i % 4, ref: { kind: "note" as const, path: `n${i}.md` } })),
  ];
  const links = nodes.slice(1).map((n, i) => ({ source: nodes[i]?.id ?? "", target: n.id, kind: "ref" }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test-Graph, nur die Felder, die das Netz liest
  return { version: 1, nodes, links, stats: { nodes: nodes.length, links: links.length, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } } as any;
}

describe("Seitenleiste im Nyx-Tab", () => {
  it("/nyx zeigt die Seitenleiste; die Kopfzeile bleibt weg (Nyx steht groß im Tab)", async () => {
    renderWithClient(
      <MemoryRouter initialEntries={["/nyx"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("img", { name: /Nyx ruht/ })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Hauptmenü" })).toBeInTheDocument();
    expect(screen.queryByTestId("topbar")).toBeNull();
    // Kein zweiter Weg hinaus neben der Seitenleiste.
    expect(screen.queryByRole("button", { name: /Zurück/ })).toBeNull();
  });

  it("schmal: der Tab hat selbst den Menü-Knopf (☰), der die Seitenleiste öffnet", async () => {
    renderWithClient(
      <MemoryRouter initialEntries={["/nyx"]}>
        <App />
      </MemoryRouter>,
    );
    const menu = await screen.findByRole("button", { name: "Menü öffnen" });
    expect(menu).toHaveAttribute("aria-controls", "app-sidebar");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Hauptmenü" })).toHaveAttribute("data-open", "true"));
    // Esc schließt das Menü – und verlässt dabei NICHT den Tab.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Hauptmenü" })).toHaveAttribute("data-open", "false"));
    expect(screen.getByRole("img", { name: /Nyx ruht/ })).toBeInTheDocument();
  });

  it("Esc stoppt Nyx und verlässt den Tab nie (auch nicht, wenn Nyx gerade fertig wurde)", async () => {
    renderWithClient(
      <MemoryRouter initialEntries={["/nyx"]}>
        <Routes>
          <Route path="/nyx" element={<NyxTab />} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
    const net = await screen.findByRole("img", { name: /Nyx ruht/ });
    act(() => emitNyxLive({ type: "nyx.state", state: "thinking", at: new Date().toISOString() }));
    await waitFor(() => expect(net).toHaveAttribute("data-state", "thinking"));
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => emitNyxLive({ type: "nyx.state", state: "idle", at: new Date().toISOString() }));
    await waitFor(() => expect(net).toHaveAttribute("data-state", "idle"));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("where")).toHaveTextContent("/nyx");
  });
});

describe("mehr Datenpunkte um den Kern", () => {
  it("Synapsen-Wolke um den Kern: jede hängt mit einem Kabel am Kern, unbeschriftet", () => {
    const m = buildNetModel(null, ["git_lage"]);
    const syn = m.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.kind === "synapse");
    expect(syn.length).toBe(SYNAPSES);
    expect(SYNAPSES).toBeGreaterThanOrEqual(30);
    for (const { n, i } of syn) {
      expect(n.label).toBe("");
      expect(m.edges.some((e) => e.a === 0 && e.b === i && e.kind === "spoke")).toBe(true);
    }
  });

  it("echte Dinge (jüngste Sessions, Aufträge, Notizen) kreisen nah am Kern und sind per Kabel verbunden", () => {
    const m = buildNetModel(graphOf(20, 10, 6), ["git_lage"]);
    const orbit = m.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.orbit);
    expect(orbit.length).toBeGreaterThanOrEqual(8);
    expect(orbit.length).toBeLessThanOrEqual(14);
    for (const { n, i } of orbit) {
      expect(n.kind).toBe("entity");
      expect(m.edges.some((e) => e.a === 0 && e.b === i && e.kind === "spoke")).toBe(true);
    }
    const types = new Set(orbit.map(({ n }) => n.type));
    expect(types.has("session")).toBe(true);
    expect(types.has("task")).toBe(true);
    // Die jüngste Session ist dabei.
    expect(orbit.some(({ n }) => n.id === "session:claude:s19")).toBe(true);
  });

  it("Layout: Synapsen dicht am Kern, Umlauf-Dinge zwischen Werkzeugen und Außenhülle", () => {
    const m = buildNetModel(graphOf(30, 14, 10), ["git_lage", "sessions_suchen", "ideen_suchen", "eintrag_suchen"]);
    const l = layoutNet(m);
    const avg = (pred: (i: number) => boolean) => {
      const xs = m.nodes.map((_, i) => i).filter(pred).map((i) => l.radius[i] ?? 0);
      return xs.reduce((s, x) => s + x, 0) / xs.length;
    };
    const syn = avg((i) => m.nodes[i]?.kind === "synapse");
    const orbit = avg((i) => !!m.nodes[i]?.orbit);
    const outer = avg((i) => m.nodes[i]?.kind === "entity" && !m.nodes[i]?.orbit);
    expect(syn).toBeLessThan(orbit * 0.7);
    expect(orbit).toBeLessThan(outer * 0.85);
    for (const v of l.positions) expect(Number.isFinite(v)).toBe(true);
  });

  it("Knotenzahl bleibt gedeckelt – auch bei riesigem Gehirn und vielen Werkzeugen", () => {
    const tools = Array.from({ length: 120 }, (_, i) => `werkzeug_${i}`);
    const m = buildNetModel(graphOf(400, 400, 400), tools);
    expect(m.nodes.length).toBeLessThanOrEqual(MAX_NET_NODES);
    expect(m.nodes.filter((n) => n.kind === "synapse").length).toBeGreaterThan(0);
  });

  it("Kabel zum Kern leuchten deutlich stärker als Querverbindungen", () => {
    expect(EDGE_WEIGHT.spoke).toBeGreaterThanOrEqual(EDGE_WEIGHT.link * 1.6);
    expect(EDGE_WEIGHT.core).toBeGreaterThanOrEqual(EDGE_WEIGHT.spoke);
    expect(EDGE_WEIGHT.link).toBeGreaterThanOrEqual(1);
  });
});

describe("Schwenken smoother und langsamer", () => {
  it("Ziehen und Trackpad drehen mit ~60 % der bisherigen Empfindlichkeit", () => {
    expect(DRAG_YAW_PER_PX / 0.0022).toBeCloseTo(0.6, 1);
    expect(DRAG_PITCH_PER_PX / 0.0016).toBeCloseTo(0.6, 1);
    expect(WHEEL_YAW / 0.0045).toBeCloseTo(0.6, 1);
    expect(WHEEL_PITCH / 0.0035).toBeCloseTo(0.6, 1);
  });

  it("längeres, weiches Nachgleiten (bisher blieben nach 0,5 s nur 20 % Schwung)", () => {
    expect(glide(1, 0.5)).toBeGreaterThan(0.4);
    expect(glide(1, 3)).toBeLessThan(0.05);
    expect(GLIDE_KEEP_PER_S).toBeLessThan(1);
    // In kleinen und großen Schritten gleich (bildraten-unabhängig).
    let a = 1;
    for (let i = 0; i < 60; i++) a = glide(a, 1 / 60);
    expect(a).toBeCloseTo(glide(1, 1), 5);
  });

  it("Zieh-Tempo folgt weich und hängt nicht an der Bildrate", () => {
    // 600 px/s gezogen, einmal mit 60 und einmal mit 120 Bildern je Sekunde, 0,3 s lang.
    const run = (fps: number) => {
      let v = 0;
      const dt = 1 / fps;
      for (let i = 0; i < 0.3 * fps; i++) v = dragVelocity(v, 600 * dt, DRAG_YAW_PER_PX, dt);
      return v;
    };
    expect(run(60)).toBeCloseTo(run(120), 2);
    // Kein Sprung: das erste Bild erreicht nur einen Teil des Ziel-Tempos.
    expect(dragVelocity(0, 10, DRAG_YAW_PER_PX, 1 / 60)).toBeLessThan(10 * 60 * DRAG_YAW_PER_PX * 0.5);
  });

  it("Eigenrotation langsamer, reduced-motion bleibt still", () => {
    expect(visualFor("idle").spin).toBeLessThanOrEqual(0.034);
    expect(visualFor("idle").spin).toBeGreaterThan(0);
    expect(visualFor("thinking").spin).toBeLessThanOrEqual(0.085);
    expect(visualFor("thinking", true).spin).toBeLessThan(visualFor("thinking").spin * 0.3);
  });
});
