// Nyx-Tab: Fokus-Modus (ohne App-Leiste/Kopfzeile, Esc zurück), Zustände klar sichtbar (Netz +
// Statuszeile), Glas-Leiste mit Reitern einklappbar, Dauer-Zuhören als Schalter mit Zustand. Der Tab hängt NICHT
// am Begleiter-Kreis (den gibt es nicht mehr). Dazu die Rechenregeln des 3D-Netzes (Zustände, Wellen, Layout) ohne WebGL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { buildNetModel } from "../src/features/nyx/tab/netModel";
import { layoutNet, NET_RADIUS } from "../src/features/nyx/tab/net3d/layout3d";
import { corePulse, resolveStateColors, shouldSpawnWave, STATE_COLOR, STATE_TOKEN, visualFor, waveLift } from "../src/features/nyx/tab/net3d/visual";
import { NyxTab, statusLine } from "../src/features/nyx/tab/NyxTab";
import { __resetNyxSettingsCache, NYX_SETTINGS_KEY, readNyxSettings } from "../src/features/nyx/tab/settings";
import { emitNyxLive } from "../src/lib/liveBus";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

const STATES = ["idle", "listening", "thinking", "tool", "speaking"] as const;

beforeEach(() => {
  localStorage.clear();
  __primeAuthForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/graph")) return jsonResponse({ version: 1, nodes: [], links: [], stats: { nodes: 0, links: 0, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } });
      if (url.startsWith("/api/haiku/tools")) return jsonResponse({ tools: [{ name: "git_lage", description: "Git-Lage" }, { name: "sessions_suchen", description: "Sessions" }] });
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

function renderTab() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/nyx"]}>
      <Routes>
        <Route path="/nyx" element={<NyxTab />} />
        <Route path="/overview" element={<p>Überblick-Seite</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Netz-Rechenregeln", () => {
  it("jeder Zustand hat eigene Farbe und eigenen Klartext", () => {
    const colors = new Set(STATES.map((s) => visualFor(s).color));
    const labels = new Set(STATES.map((s) => visualFor(s).label));
    expect(colors.size).toBe(5);
    expect(labels.size).toBe(5);
    expect(visualFor("tool").color).toBe(STATE_COLOR.tool);
  });

  it("idle ist ruhig, thinking lässt viele Signale laufen", () => {
    expect(visualFor("thinking").signalShare).toBeGreaterThan(visualFor("idle").signalShare * 4);
    expect(visualFor("thinking").signalSpeed).toBeGreaterThan(visualFor("idle").signalSpeed * 2);
    expect(visualFor("idle").spin).toBeGreaterThan(0);
  });

  it("weniger Bewegung (prefers-reduced-motion): kaum Drehung, keine Wellen", () => {
    expect(visualFor("thinking", true).spin).toBeLessThan(visualFor("thinking").spin * 0.3);
    expect(shouldSpawnWave("listening", 0.8, 0.5, 5, true)).toBe(false);
  });

  it("Wellen nur beim Zuhören, im Takt des steigenden Pegels, nicht bei Stille", () => {
    expect(shouldSpawnWave("listening", 0.6, 0.4, 1)).toBe(true);
    expect(shouldSpawnWave("listening", 0.05, 0.02, 1)).toBe(false);
    expect(shouldSpawnWave("listening", 0.6, 0.4, 0.05)).toBe(false);
    expect(shouldSpawnWave("listening", 0.3, 0.7, 1)).toBe(false);
    expect(shouldSpawnWave("speaking", 0.9, 0.2, 1)).toBe(false);
  });

  it("eine Welle hebt Knoten an ihrer Front nur sanft an (kein Aufblitzen)", () => {
    const w = { born: 0, strength: 1 };
    const lifts = Array.from({ length: 40 }, (_, i) => waveLift(w, 0.8, (i / 40) * NET_RADIUS * 1.3, NET_RADIUS));
    const max = Math.max(...lifts);
    expect(max).toBeGreaterThan(0.2);
    expect(max).toBeLessThanOrEqual(0.6);
    expect(waveLift(w, 10, 1, NET_RADIUS)).toBe(0);
  });

  it("der Kern pulsiert beim Sprechen mit der Stimme", () => {
    expect(corePulse("speaking", 0, 0, 0.9)).toBeGreaterThan(corePulse("speaking", 0, 0, 0.1) + 0.3);
    expect(corePulse("idle", 0, 0, 0.9)).toBeLessThan(1.1);
  });

  it("Layout: Kern in der Mitte, Werkzeuge innen, Dinge außen, alles endlich und reproduzierbar", () => {
    const graph = {
      version: 1,
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: `task:${i}`, type: "task" as const, label: `Aufgabe ${i}`, degree: i % 5, ref: { kind: "note" as const, path: `a${i}.md` } })),
      links: Array.from({ length: 20 }, (_, i) => ({ source: `task:${i}`, target: `task:${i + 1}`, kind: "ref" })),
      stats: { nodes: 30, links: 20, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test-Graph, nur die Felder, die das Netz liest
    const model = buildNetModel(graph as any, ["git_lage", "sessions_suchen", "ideen_suchen"]);
    const a = layoutNet(model);
    const b = layoutNet(model);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(a.radius[0]).toBeCloseTo(0, 5);
    for (const v of a.positions) expect(Number.isFinite(v)).toBe(true);
    expect(Math.max(...a.radius)).toBeCloseTo(NET_RADIUS, 3);
    const tools = model.nodes.map((n, i) => (n.kind === "tool" ? (a.radius[i] ?? 0) : null)).filter((r): r is number => r !== null);
    const outer = model.nodes.map((n, i) => (n.kind === "entity" || n.kind === "neuron" ? (a.radius[i] ?? 0) : null)).filter((r): r is number => r !== null);
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(avg(tools)).toBeLessThan(avg(outer) * 0.7);
  });
});

describe("Statuszeile", () => {
  it("sagt in einfachen Worten, was Nyx gerade tut", () => {
    const base = { tool: null, awake: true, waking: false, continuous: false };
    expect(statusLine({ ...base, state: "idle", awake: false })).toMatch(/Bereit.*Knopf/);
    // Ruhig und kurz – der Leertasten-Hinweis steht im Tooltip.
    expect(statusLine({ ...base, state: "idle" })).toBe("Bereit.");
    expect(statusLine({ ...base, state: "idle", continuous: true })).toMatch(/dauerhaft/);
    expect(statusLine({ ...base, state: "listening" })).toMatch(/höre dir zu/);
    expect(statusLine({ ...base, state: "thinking" })).toMatch(/denke nach/);
    expect(statusLine({ ...base, state: "tool", tool: "git_lage" })).toBe("Schaut in Git …"); // nie die ID
    expect(statusLine({ ...base, state: "tool", tool: "git_lage", detail: "Schaue in die Commits" })).toBe("Schaue in die Commits");
    expect(statusLine({ ...base, state: "speaking" })).toMatch(/spreche/);
  });
});

describe("Nyx-Tab: Zustände, Leiste, Bedienung", () => {
  it("Server-Zustände schalten Netz, Chip und Statuszeile um", async () => {
    renderTab();
    const net = await screen.findByRole("img", { name: /Nyx ruht/ });
    const status = document.querySelector('[data-nyx="nyx-status"]') as HTMLElement;
    // Mikro zu heißt nicht „Nyx schläft“ – Nyx ist bereit, nur das Zuhören ist aus.
    expect(status.textContent).toMatch(/Bereit/);
    for (const [s, re] of [
      ["listening", /höre dir zu/],
      ["thinking", /denke nach/],
      ["speaking", /spreche/],
    ] as const) {
      act(() => emitNyxLive({ type: "nyx.state", state: s, at: new Date().toISOString() }));
      await waitFor(() => expect(net).toHaveAttribute("data-state", s));
      expect(status.textContent).toMatch(re);
      expect(document.querySelector('[data-nyx="nyx-tab"]')).toHaveAttribute("data-tone", s);
    }
    act(() => emitNyxLive({ type: "nyx.state", state: "tool", tool: "git_lage", detail: "Schaue in die Commits", at: new Date().toISOString() }));
    await waitFor(() => expect(net).toHaveAttribute("data-tool", "git_lage"));
    expect(screen.getByRole("status")).toHaveTextContent("schaut in Git"); // Wörter statt „git_lage“
    expect(status).toHaveTextContent("Schaue in die Commits");
  });

  it("rechte Leiste: sieben Reiter, einklappbar, gemerkt; eingeklappt erscheint das Schreibfeld unten", async () => {
    renderTab();
    const tabs = within(await screen.findByRole("tablist", { name: "Bereiche" })).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["Chat", "Aufgaben live", "Dateien & Links", "Bilder", "Gedächtnis", "Kontext", "Einstellungen"]);
    expect(screen.getByRole("tabpanel", { name: "Chat" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Schnell an Nyx schreiben" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Leiste einklappen" }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(localStorage.getItem("nyx.tab.panel")).toBe("closed");
    expect(document.querySelector('[data-nyx="nyx-tab"]')).toHaveAttribute("data-panel", "closed");
    expect(screen.getByRole("textbox", { name: "Schnell an Nyx schreiben" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Bilder" }));
    expect(await screen.findByRole("tabpanel", { name: "Bilder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leiste einklappen" })).toHaveAttribute("aria-expanded", "true");
    // Aktiven Reiter noch einmal anklicken → Leiste klappt wieder ein.
    fireEvent.click(screen.getByRole("tab", { name: "Bilder" }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  // Kein Kasten mit Dauer-Zuhören und Leertaste – nur noch das Mikrofonsymbol.
  it("Sprech-Leiste unten: nur der runde Mikro-Knopf – kein Dauer-Zuhören, kein Leertasten-Hinweis, keine Beschriftung", async () => {
    renderTab();
    const mic = await screen.findByRole("button", { name: "Nyx wecken" });
    expect(mic).toHaveAttribute("data-nyx", "nyx-sprechen");
    expect(screen.queryByRole("switch", { name: /Dauer-Zuhören/ })).toBeNull();
    expect(document.querySelector('[data-nyx="nyx-dock"]')).toBeNull();
    expect(document.querySelector(".nyx-dock__hint")).toBeNull();
    expect(document.querySelector(".nyx-mic__caption")).toBeNull();
    const stage = document.querySelector('[data-nyx="nyx-tab"]') as HTMLElement;
    expect(stage.textContent).not.toMatch(/Leertaste|Halten & sprechen|Dauer-Zuhören/);
    // Der Hinweis bleibt nur als Tooltip am Knopf.
    expect(mic.getAttribute("title") ?? "").toMatch(/Leertaste/);
  });

  it("ein alter „an“-Zustand von Dauer-Zuhören zählt als aus", async () => {
    localStorage.setItem(NYX_SETTINGS_KEY, JSON.stringify({ continuous: true }));
    __resetNyxSettingsCache();
    expect(readNyxSettings().continuous).toBe(false);
    renderTab();
    expect(await screen.findByRole("button", { name: "Nyx wecken" })).toBeInTheDocument();
    expect(document.querySelector('[data-nyx="nyx-status"]')?.textContent).not.toMatch(/dauerhaft/);
  });

  // Seitenleiste bleibt sichtbar – Esc stoppt nur noch Nyx und verlässt den Tab nie (nyx-tab-sidebar-and-net.test.tsx).
  it("Esc stoppt Nyx; auch im Leerlauf bleibt der Tab offen", async () => {
    renderTab();
    const net = await screen.findByRole("img", { name: /Nyx ruht/ });
    act(() => emitNyxLive({ type: "nyx.state", state: "thinking", at: new Date().toISOString() }));
    await waitFor(() => expect(net).toHaveAttribute("data-state", "thinking"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Überblick-Seite")).toBeNull();
    act(() => emitNyxLive({ type: "nyx.state", state: "idle", at: new Date().toISOString() }));
    await waitFor(() => expect(net).toHaveAttribute("data-state", "idle"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Überblick-Seite")).toBeNull();
    expect(net).toBeInTheDocument();
  });
});

describe("Fokus-Modus in der App", () => {
  it("/nyx zeigt keine Kopfzeile; die Seitenleiste bleibt", async () => {
    renderWithClient(
      <MemoryRouter initialEntries={["/nyx"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("img", { name: /Nyx ruht/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Brotkrümel" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Hauptmenü" })).toBeInTheDocument();
    expect(document.querySelector('[data-focus="true"]')).not.toBeNull();
  });
});

// ── Schwarz + knallig, 390 px, Tastatur ──

/** Farbton-Sättigung (0 … 1) und „Blaustich“ eines Hex-Werts. */
function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

describe("schwarz ohne Blaustich, knallige Zustandsfarben", () => {
  it("Zustandsfarben kommen aus den Tokens (mit POS-Rückfall) und sind kräftig", () => {
    expect(Object.keys(STATE_TOKEN).sort()).toEqual([...STATES].sort());
    // Eigene Nyx-Tokens je Zustand (--a-nyx-listen/-think/-tool/-speak).
    const tokens: Record<string, string> = { "--a-nyx-listen": "#123456", "--a-nyx": " #abcdef ", "--a-nyx-tool": "rgb(1 2 3 / .5)" };
    const c = resolveStateColors((t) => tokens[t] ?? "");
    expect(c.listening).toBe("#123456");
    expect(c.idle).toBe("#abcdef");
    // Unlesbarer Wert → Rückfall statt kaputter Farbe im Shader.
    expect(c.tool).toBe(STATE_COLOR.tool);
    for (const hex of Object.values(STATE_COLOR)) {
      const [r, g, b] = rgbOf(hex);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(0.45);
    }
  });

  it("nyxTab.css: Grund aus --a-bg, keine fest eingetragenen (bläulichen) Grautöne", () => {
    const css = readFileSync(join(__dirname, "..", "src", "features", "nyx", "tab", "nyxTab.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const stage = /\.nyx-stage \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(stage).toMatch(/background: color-mix\(in srgb, var\(--a-bg\) \d+%, black\)/);
    // Einzige Ausnahme: der Startwert der registrierten Zustandsfarbe (@property braucht einen festen Wert).
    const literals = (css.replace(/initial-value: #[0-9a-f]+;/i, "").match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? []);
    expect(literals).toEqual([]);
  });
});

describe("Handy (390 px) und Tastatur", () => {
  function stubNarrow(narrow: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: narrow && query.includes("max-width"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }

  it("schmal: Leiste startet zu, das Netz bleibt mittig (nicht um die Leistenbreite verschoben)", async () => {
    stubNarrow(true);
    renderTab();
    await screen.findByRole("img", { name: /Nyx ruht/ });
    expect(screen.queryByRole("tabpanel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Leiste aufklappen" }));
    expect(await screen.findByRole("tabpanel", { name: "Chat" })).toBeInTheDocument();
    // Leiste liegt über dem Netz: nur die Reiter-Spalte (64 px) zählt, nicht 440 + 64.
    expect((document.querySelector('[data-renderer]') as HTMLElement).style.right).toBe("64px");
    // Das Menü (☰) bleibt erreichbar.
    expect(screen.getByRole("button", { name: "Menü öffnen" })).toBeInTheDocument();
  });

  it("breit: offene Leiste schiebt das Netz in die freie Mitte", async () => {
    stubNarrow(false);
    renderTab();
    await screen.findByRole("tabpanel", { name: "Chat" });
    expect((document.querySelector('[data-renderer]') as HTMLElement).style.right).toBe("504px");
  });

  it("Esc gehört einem offenen Dialog, nicht Nyx (und verlässt nie den Tab)", async () => {
    renderTab();
    await screen.findByRole("img", { name: /Nyx ruht/ });
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    document.body.appendChild(dlg);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Überblick-Seite")).toBeNull();
    dlg.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Überblick-Seite")).toBeNull();
  });

  it("Leertaste auf einem Reiter drückt den Reiter (wird nicht als „sprechen“ abgefangen)", async () => {
    renderTab();
    const tab = await screen.findByRole("tab", { name: "Bilder" });
    tab.focus();
    // fireEvent liefert false, wenn jemand preventDefault() gerufen hat.
    expect(fireEvent.keyDown(tab, { key: " ", code: "Space" })).toBe(true);
  });
});
