// Die lila Aura ist das NyxOS-Logo – lebendig überall, wo man Nyx nutzen kann, und als Web-App-Symbol.
//   • NyxAura rendert (Größe 14–64, Zustand), „Bewegung reduzieren“ → still
//   • gemeinsamer Pegel (levelBus) → CSS-Variable --nyx-lvl an jedem Logo (Anstieg schnell, Abklingen langsam, Schleife stoppt)
//   • Einsatzstellen: Wortmarke, Nyx-Leiste, ⌘K (Eingabe + „Nyx fragen“), Zentrum, Nyx-Tab, Chat
//   • index.html + Manifest verweisen auf echte Dateien, kein „Z“ mehr
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NyxAura } from "../src/components/brand/NyxAura";
import { CommandPalette } from "../src/components/CommandPalette";
import { Sidebar } from "../src/components/Sidebar";
import { NyxBar, type NyxBarProps } from "../src/features/nyx/bar/NyxBar";
import { usePushToTalk } from "../src/features/nyx/bar/usePushToTalk";
import { LEVEL_ATTACK_MS, nyxLevelFrame, nyxLevelSnapshot, reportNyxLevel } from "../src/features/nyx/voice/levelBus";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

const WEB = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query.includes("reduce"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NyxAura – das Logo", () => {
  it("rendert Kern, zwei Ringe und Hof; Größe wird auf 14–64 px begrenzt", () => {
    const { container } = render(
      <>
        <NyxAura size={8} />
        <NyxAura size={40} state="speaking" label="NyxOS" />
        <NyxAura size={200} />
      </>,
    );
    const [small, mid, big] = Array.from(container.querySelectorAll<SVGSVGElement>("svg.nyx-mark"));
    expect(small?.getAttribute("width")).toBe("14");
    expect(big?.getAttribute("width")).toBe("64");
    expect(mid?.getAttribute("data-state")).toBe("speaking");
    expect(mid?.getAttribute("role")).toBe("img");
    expect(mid?.getAttribute("aria-label")).toBe("NyxOS");
    expect(small?.getAttribute("aria-hidden")).toBe("true");
    for (const cls of ["nyx-mark__halo", "nyx-mark__outer", "nyx-mark__inner", "nyx-mark__wobble", "nyx-mark__core"]) {
      expect(mid?.querySelector(`.${cls}`), cls).not.toBeNull();
    }
    // Satelliten nur ab 24 px (bei 14 px wären sie nur Rauschen).
    expect(small?.querySelector(".nyx-mark__sats")).toBeNull();
    expect(mid?.querySelectorAll(".nyx-mark__sat").length).toBeGreaterThan(0);
    // Jede Instanz hat eigene Verlaufs-IDs (viele Logos auf einer Seite).
    const ids = Array.from(container.querySelectorAll("radialGradient")).map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lebt normalerweise (data-motion=live) und steht bei „Bewegung reduzieren“ still", () => {
    stubReducedMotion(false);
    const { unmount } = render(<NyxAura />);
    expect(screen.getByTestId("nyx-aura").getAttribute("data-motion")).toBe("live");
    unmount();
    stubReducedMotion(true);
    render(<NyxAura />);
    expect(screen.getByTestId("nyx-aura").getAttribute("data-motion")).toBe("still");
    const css = read("src/components/brand/nyxAura.css");
    // Eigenbewegung nur ohne Reduzierung, und „still“ schaltet jede Animation und jede Pegel-Bewegung ab.
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)[\s\S]*\[data-motion="live"\] \.nyx-mark__core/);
    expect(css).toMatch(/\.nyx-mark\[data-motion="still"\] \*,[\s\S]*?animation: none !important/);
    expect(css).toMatch(/\[data-motion="still"\] \.nyx-mark__lvl-core \{\s*transform: none/);
    // Farben nur aus Tokens – keine festen Hex-Werte im Logo-CSS.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toMatch(/var\(--a-nyx\)/);
  });
});

describe("Gemeinsamer Pegel → --nyx-lvl", () => {
  let raf: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  it("Sprechen hebt den Pegel schnell an allen Logos, Stille lässt ihn langsam abklingen, dann ruht die Schleife", () => {
    const { container } = render(
      <>
        <NyxAura />
        <NyxAura size={32} />
      </>,
    );
    const logos = Array.from(container.querySelectorAll<SVGSVGElement>("svg.nyx-mark"));
    const lvl = (el: SVGSVGElement | undefined) => Number(el?.style.getPropertyValue("--nyx-lvl"));
    expect(lvl(logos[0])).toBe(0);
    // Ohne Quelle keine Schleife (CSS-Ruhe-Animation reicht).
    expect(nyxLevelSnapshot().running).toBe(false);
    expect(raf).not.toHaveBeenCalled();

    let level = 1;
    const off = reportNyxLevel(() => level);
    expect(raf).toHaveBeenCalledTimes(1);
    let t = 1000;
    act(() => {
      for (let i = 0; i < 3; i++) nyxLevelFrame((t += LEVEL_ATTACK_MS / 2));
    });
    // Nach ~40 ms Anstieg über 90 % – an BEIDEN Logos (eine Schleife für alle).
    expect(lvl(logos[0])).toBeGreaterThan(0.9);
    expect(lvl(logos[1])).toBe(lvl(logos[0]));
    expect(Number(logos[0]?.style.getPropertyValue("--nyx-rot"))).toBeGreaterThan(0);

    // Leise → Abklingen ist langsamer als der Anstieg.
    level = 0;
    act(() => nyxLevelFrame((t += LEVEL_ATTACK_MS)));
    expect(lvl(logos[0])).toBeGreaterThan(0.4);

    off();
    act(() => {
      for (let i = 0; i < 40; i++) nyxLevelFrame((t += 50));
    });
    expect(lvl(logos[0])).toBe(0);
    expect(nyxLevelSnapshot()).toMatchObject({ level: 0, running: false, sources: 0 });
  });

  it("eine kaputte Quelle hält das Logo nicht an; der lauteste Pegel zählt", () => {
    const { container } = render(<NyxAura />);
    const el = container.querySelector<SVGSVGElement>("svg.nyx-mark");
    const offBad = reportNyxLevel(() => {
      throw new Error("kaputt");
    });
    const offQuiet = reportNyxLevel(() => 0.2);
    const offLoud = reportNyxLevel(() => 0.8);
    let t = 5000;
    act(() => {
      for (let i = 0; i < 10; i++) nyxLevelFrame((t += 30));
    });
    expect(Number(el?.style.getPropertyValue("--nyx-lvl"))).toBeCloseTo(0.8, 1);
    offBad();
    offQuiet();
    offLoud();
    act(() => {
      for (let i = 0; i < 40; i++) nyxLevelFrame((t += 50));
    });
    expect(nyxLevelSnapshot()).toMatchObject({ level: 0, running: false, sources: 0 });
  });

  // Ein Mikrofon, das sich nicht abmeldet, ließe die Schleife ewig laufen (Logo „zittert“ ohne Ton).
  it("Halten in der Leiste: Mikro meldet sich beim Loslassen UND beim Verschwinden der Leiste (Unmount) ab", async () => {
    const track = { stop: vi.fn() };
    class FakeRecorder {
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      static isTypeSupported = () => true;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
    const logo = render(<NyxAura />);

    // 1) Halten → angemeldet; Loslassen → abgemeldet, Schleife klingt aus und ruht.
    const a = renderHook(() => usePushToTalk());
    await act(async () => {
      await a.result.current.start();
    });
    expect(nyxLevelSnapshot().sources).toBe(1);
    await act(async () => {
      await a.result.current.stop();
    });
    expect(nyxLevelSnapshot().sources).toBe(0);
    expect(track.stop).toHaveBeenCalled();

    // 2) Halten und die Leiste verschwindet mitten im Satz (Seitenwechsel) → trotzdem abgemeldet.
    const b = renderHook(() => usePushToTalk());
    await act(async () => {
      await b.result.current.start();
    });
    expect(nyxLevelSnapshot().sources).toBe(1);
    b.unmount();
    expect(nyxLevelSnapshot().sources).toBe(0);
    let t = 9000;
    act(() => {
      for (let i = 0; i < 40; i++) nyxLevelFrame((t += 50));
    });
    expect(nyxLevelSnapshot()).toMatchObject({ level: 0, running: false });
    a.unmount();
    logo.unmount();
    expect(nyxLevelSnapshot().targets).toBe(0);
  });
});

const STATUS = {
  settings: {},
  engine: { kind: "claude-cli", state: "ready", available: true, reason: null, model: "haiku" },
  reserve: { configured: false, baseUrl: null, model: null },
  today: { day: "2026-09-26", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, budgetUsd: 2 },
  queue: { running: 0, waiting: 0 },
  lastRundgang: null,
};

function barProps(over: Partial<NyxBarProps> = {}): NyxBarProps {
  return {
    open: false,
    onToggle: () => {},
    status: STATUS as unknown as NyxBarProps["status"],
    busy: false,
    badge: null,
    visual: "idle",
    toolName: null,
    talking: false,
    level: () => 0,
    cursorOut: false,
    onHoldStart: () => {},
    onHoldEnd: () => {},
    onHoldCancel: () => {},
    buttonRef: null,
    ...over,
  };
}

describe("Einsatzstellen – überall, wo man Nyx nutzen kann", () => {
  it("Wortmarke oben links: Aura vor „NYX OS“ (statt Punkt), und am Nyx-Eintrag der Navigation", () => {
    stubFetchRoutes({});
    renderWithClient(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const logo = screen.getByRole("link", { name: /NyxOS – zum Überblick/ });
    expect(logo).toHaveTextContent("NYX OS");
    expect(within(logo).getByTestId("nyx-aura")).toBeInTheDocument();
    expect(logo.querySelector(".bg-a-nyx")).toBeNull();
    const nyxNav = screen.getByRole("link", { name: "Nyx" });
    expect(within(nyxNav).getByTestId("nyx-aura")).toBeInTheDocument();
  });

  it("Nyx-Leiste: Aura statt Netz-Symbol, Zustand wird durchgereicht (Halten = hört zu, antwortet = denkt)", () => {
    const { rerender } = render(<NyxBar {...barProps({ visual: "speaking" })} />);
    const aura = () => within(screen.getByTestId("nyx-bar")).getByTestId("nyx-aura");
    expect(aura().getAttribute("data-state")).toBe("speaking");
    expect(screen.getByTestId("nyx-bar").querySelector("canvas")).toBeNull();
    rerender(<NyxBar {...barProps({ talking: true })} />);
    expect(aura().getAttribute("data-state")).toBe("listening");
    rerender(<NyxBar {...barProps({ busy: true })} />);
    expect(aura().getAttribute("data-state")).toBe("thinking");
  });

  it("⌘K: Aura im Eingabefeld (statt Lupe) und vor „Nyx fragen“", async () => {
    stubFetchRoutes({ sessions: () => jsonResponse({ sessions: [] }) });
    renderWithClient(
      <MemoryRouter>
        <CommandPalette open onOpenChange={() => {}} />
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByPlaceholderText(/Suche alles oder frag Nyx/);
    expect(input.parentElement?.querySelector("[data-testid='nyx-aura']")).not.toBeNull();
    expect(input.parentElement?.textContent).not.toContain("⌕");
    fireEvent.change(input, { target: { value: "Wie spät" } });
    const ask = await within(dialog).findByTestId("palette-ask-nyx");
    expect(within(ask).getByTestId("nyx-aura")).toBeInTheDocument();
    expect(ask.textContent).not.toContain("◎");
  });

  it("Zentrum-Kopf, Nyx-Tab-Kopf und Chat nutzen die Aura; das Netz-Symbol ist aus Leiste und Zentrum raus", () => {
    const panel = read("src/features/haiku/HaikuPanel.tsx");
    expect(panel).toMatch(/<NyxAura state=\{visual !== "idle"/);
    expect(panel).not.toMatch(/<NeuralNet/);
    expect(read("src/features/nyx/bar/NyxBar.tsx")).not.toMatch(/<NeuralNet/);
    const tab = read("src/features/nyx/tab/NyxTab.tsx");
    expect(tab).toMatch(/<NyxAura size=\{26\} state=\{state\} \/>\s*<h1 className="nyx-wordmark">/);
    // Pegel des Tabs geht ins gemeinsame Logo (Mikro wach, Stimme beim Sprechen).
    expect(tab).toMatch(/reportNyxLevel\(/);
    expect(read("src/features/nyx/tab/panels/ChatPanel.tsx")).toMatch(/<NyxAura size=\{18\} state="thinking"/);
    // Halten in der Leiste, Dauer-Zuhören, Diktat melden ihren Pegel.
    expect(read("src/features/nyx/bar/usePushToTalk.ts")).toMatch(/recording \? reportNyxLevel\(level\)/);
    expect(read("src/features/nyx/useNyxVoiceLoop.ts")).toMatch(/soundOn \? reportNyxLevel\(level\)/);
    expect(read("src/features/voice/useVoiceRecorder.ts")).toMatch(/status === "recording" \? reportNyxLevel/);
  });
});

describe("Web-App-Symbol (Dock/Home-Bildschirm) statt „Z“", () => {
  const html = read("index.html");
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as { name: string; short_name: string; background_color: string; theme_color: string; icons: { src: string; purpose?: string }[] };

  it("index.html verweist auf Favicon, Apple-Symbol und Manifest – alle Dateien existieren", () => {
    const hrefs = Array.from(html.matchAll(/<link [^>]*rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)).map((m) => m[1] ?? "");
    expect(hrefs).toEqual(expect.arrayContaining(["/favicon.svg", "/apple-touch-icon.png", "/manifest.webmanifest"]));
    for (const h of hrefs) expect(existsSync(join(WEB, "public", h)), h).toBe(true);
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon.svg"/);
    expect(html).toMatch(/<meta name="theme-color" content="#000000"/);
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="NyxOS"/);
  });

  it("Manifest: NyxOS, schwarz, Symbole existieren und sind echte PNG/SVG, eins davon „maskable“", () => {
    expect(manifest).toMatchObject({ name: "NyxOS", short_name: "NyxOS", background_color: "#000000", theme_color: "#000000" });
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      const file = join(WEB, "public", icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const head = readFileSync(file).subarray(0, 8);
      if (icon.src.endsWith(".png")) expect(head.toString("hex")).toBe("89504e470d0a1a0a");
      else expect(readFileSync(file, "utf8")).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    }
    const svg = read("public/favicon.svg");
    // Die Aura (Ringe + Kern), kein Buchstabe.
    expect(svg).not.toMatch(/<text/);
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
