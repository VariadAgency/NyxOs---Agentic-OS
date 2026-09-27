// Design-Regeln: keine zweifarbigen Kacheln (weiß und dann Verlauf), modern, übersichtlich, clean, lesbar.
// Dazu: bei 390 px blieb die Seitenleiste 200 px breit, der Inhalt bekam nur ~190 px.
//
// Die Regeln als Tests, damit sie nicht wieder wegrutschen:
//  1. Eine Kachel = eine Fläche: keine Verläufe als Hintergrund (Ausnahmen: Gehirn, echte Farbskalen,
//     Ausblend-Masken, Schachbrett hinter Bildern, Ringe/Donuts per conic-gradient).
//  2. Lesbarkeit: jede Textfarbe aus den Tokens ≥ 4,5:1 (WCAG AA) auf allen Flächen-Tokens.
//  2b. Komplett dunkel, OHNE Blautönung –
//      Grund und Grautöne neutral, Linien neutral weiß, Hauptknopf warmes Weiß mit schwarzem Text.
//  3. Schmale Bildschirme: Seitenleiste wird zum Menü (Knopf in der Kopfzeile), schließt per Esc,
//     Hintergrund-Klick und nach der Wahl eines Eintrags.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/components/Sidebar";
import { TopBar } from "../src/components/TopBar";
import { StatCard } from "../src/components/charts/StatCard";
import { closeNavDrawer } from "../src/lib/navDrawer";
import { METRIC_TONE, NAV_TONE } from "../src/lib/tones";
import { NAV_ITEMS } from "../src/nav";
import { renderWithClient } from "./helpers";

const SRC = join(__dirname, "..", "src");
const CSS = readFileSync(join(SRC, "app.css"), "utf8");

function files(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, acc);
    else if (/\.(tsx?|css)$/.test(name)) acc.push(full);
  }
  return acc;
}

// Erlaubte Verläufe – je Datei, was dort gemeint ist (alles andere ist eine zweifarbige Fläche).
const ALLOWED: [RegExp, RegExp][] = [
  [/^features\/brain\//, /./], // Gehirn bleibt, wie es ist
  [/^features\/nyx\//, /./], // Nyx-Bühne (Netz), anderer Agent verdrahtet dort
  [/^features\/context-guard\/DualRangeSlider\.tsx$/, /linear-gradient\(90deg, var\(--a-ok\) 0/], // Zonen-Skala mit harten Stopps
  [/^features\/settings\/nyx\/nyx\.css$/, /linear-gradient\(90deg, var\(--c\) 0%, var\(--c\) var\(--p\)/], // Regler-Füllstand, harte Stopps
  [/^app\.css$/, /mask-image: linear-gradient/], // Ausblend-Maske an scrollenden Tab-Zeilen
  [/^features\/haiku\/haiku\.css$/, /radial-gradient\(circle at 35% 30%/], // Kugel-Symbol des Assistenten
  [/^(features\/session-panels\/AgentTile|components\/sessions\/ChatItem)\.tsx$/, /bg-gradient-to-t/], // Text blendet unten aus („mehr“)
];

describe("Eine Kachel = eine Fläche", () => {
  it("keine Verläufe als Flächen-Hintergrund (radial/linear/bg-gradient/from-white)", () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = file.slice(SRC.length + 1);
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!/radial-gradient\(|linear-gradient\(|bg-gradient-to-|from-white\//.test(line)) return;
          if (ALLOWED.some(([f, l]) => f.test(rel) && l.test(line))) return;
          offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("gemeinsame Bauteile nutzen den Radius-Satz statt eigener Pixel-Radien", () => {
    for (const f of ["components/ui/Card.tsx", "components/ui/Tile.tsx", "components/KpiTile.tsx", "components/charts/StatCard.tsx", "components/ui/button.tsx"]) {
      expect(readFileSync(join(SRC, f), "utf8"), f).not.toMatch(/rounded-\[\d+px\]/);
    }
  });
});

// ---- Kontrast auf den Flächen-Tokens (Formel wie docs/UI.md) ----
function token(name: string): string {
  const m = CSS.match(new RegExp(`--a-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m?.[1]) throw new Error(`Token --a-${name} fehlt oder ist kein #rrggbb`);
  return m[1];
}
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}

describe("Lesbarkeit (WCAG AA auf allen Flächen)", () => {
  const SURFACES = ["bg", "p", "p2", "p3"];
  const TEXT = ["ink", "mut", "idle", "acc", "teal", "claude", "codex", "ok", "wait", "bad", "done", "conf", "gold", "violet", "indigo", "lime", "temp", "nyx"];
  for (const t of TEXT) {
    it(`--a-${t} als Text ≥ 4,5:1 auf ${SURFACES.join("/")}`, () => {
      for (const s of SURFACES) expect(ratio(token(t), token(s)), `${t} auf ${s}`).toBeGreaterThanOrEqual(4.5);
    });
  }
  it("Flächen-Ebenen steigen sichtbar an (Hintergrund < Fläche < erhöht < Bedienfläche)", () => {
    const l = SURFACES.map((s) => lum(token(s)));
    for (let i = 1; i < l.length; i++) expect(l[i] ?? 0).toBeGreaterThan(l[i - 1] ?? 0);
  });
  it("feine Linien: --a-line ist neutrales Weiß mit geringer Deckkraft (kein Schiefer-Blau)", () => {
    expect(CSS).toMatch(/--a-line:\s*rgb\(255 255 255 \/\s*0?\.0\d+\)/);
    expect(CSS).toMatch(/--a-line-strong:\s*rgb\(255 255 255 \/\s*0?\.\d+\)/);
  });
  it("Grund und Grautöne neutral – kein Blaustich (Kanäle höchstens 6 auseinander)", () => {
    for (const t of ["bg", "p", "p2", "p3", "ink", "mut", "dim", "idle", "primary", "on-primary"]) {
      const hex = token(t);
      const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(Math.max(...ch) - Math.min(...ch), `--a-${t} ${hex}`).toBeLessThanOrEqual(6);
      // Blau darf nie der stärkste Kanal eines Grautons sein.
      expect(ch[2] ?? 0, `--a-${t} ${hex}`).toBeLessThanOrEqual(Math.max(ch[0] ?? 0, ch[1] ?? 0));
    }
    expect(lum(token("bg"))).toBeLessThan(0.003); // echt schwarz
    expect(ratio(token("on-primary"), token("primary"))).toBeGreaterThanOrEqual(12);
  });
  it("keine hart codierten Schiefer-/Blaugrau-Töne mehr (außer Gehirn, Nyx, Assistent-Leiste)", () => {
    const SLATE = /(?:slate|zinc)-\d{2,3}|rgba?\(148,? ?163|#(?:0a0d12|10141b|151a23|1b212c|232a36|2c3542|34404f|131822|0e1319|12161d|171c24|13262a|1e4146)\b/i;
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (/^features\/(brain|nyx|haiku)\//.test(rel)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (SLATE.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
  it("Hauptknopf wie POS: warmes Weiß mit schwarzem Text", () => {
    expect(readFileSync(join(SRC, "components/ui/button.tsx"), "utf8")).toMatch(/primary: "[^"]*bg-a-primary[^"]*text-a-on-primary/);
  });
  it("Bewegung: reduzierte Bewegung schaltet Übergänge global ab", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,/);
  });
});

// ---- Schmale Bildschirme: Seitenleiste als Menü ----
afterEach(() => {
  act(() => closeNavDrawer());
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell(path = "/overview") {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))));
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <TopBar />
      <Sidebar />
    </MemoryRouter>,
  );
}

describe("Seitenleiste bei 390 px", () => {
  it("Kopfzeile hat einen Menü-Knopf (nur schmal sichtbar), der die Leiste öffnet und schließt", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Hauptmenü" });
    expect(nav).toHaveAttribute("data-open", "false");
    // Auf breiten Bildschirmen steht die Leiste fest, schmal ist sie weggeschoben.
    expect(nav.className).toMatch(/max-md:-translate-x-full/);
    const btn = screen.getByRole("button", { name: "Menü öffnen" });
    expect(btn.className).toMatch(/md:hidden/);
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(nav).toHaveAttribute("data-open", "true");
    expect(screen.getByRole("button", { name: "Menü öffnen" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(nav).toHaveAttribute("data-open", "false");
  });

  it("oben steht die Wortmarke „NYX OS“ statt „NyxOS“ (Link zum Überblick)", () => {
    renderShell("/sessions");
    const logo = screen.getByRole("link", { name: /NyxOS.*Überblick/ });
    expect(logo).toHaveTextContent("NYX OS");
    expect(logo).not.toHaveTextContent("NyxOS");
  });

  it("Klick auf den abgedunkelten Hintergrund oder einen Eintrag schließt das Menü", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Hauptmenü" });
    fireEvent.click(screen.getByRole("button", { name: "Menü öffnen" }));
    fireEvent.click(screen.getByTestId("nav-backdrop"));
    expect(nav).toHaveAttribute("data-open", "false");
    fireEvent.click(screen.getByRole("button", { name: "Menü öffnen" }));
    fireEvent.click(screen.getByRole("link", { name: /Sessions/ }));
    expect(nav).toHaveAttribute("data-open", "false");
  });
});

// ---- Bedeutungsfarben: „knallig und farbig wie POS“ statt alles Türkis ----
describe("Bedeutungsfarben statt einfarbig", () => {
  const OVERVIEW = ["sessions_open", "sessions_waiting", "tokens_today", "tokens_7d", "commits_7d", "uncommitted", "conflicts", "builds_red", "open_questions", "audits_critical", "max_window", "haiku_briefing"];

  it("jede Überblick-Kennzahl hat eine feste Farbe, zusammen mindestens 8 verschiedene", () => {
    for (const k of OVERVIEW) expect(METRIC_TONE[k], k).toBeDefined();
    expect(new Set(OVERVIEW.map((k) => METRIC_TONE[k])).size).toBeGreaterThanOrEqual(8);
  });

  it("Akzent ist nicht mehr Türkis (Links/Fokus in POS-Blau), Türkis bleibt eigene Bedeutungsfarbe", () => {
    expect(token("acc").toLowerCase()).not.toBe(token("teal").toLowerCase());
  });

  it("Seitenleiste: jedes Symbol hat eine Bereichsfarbe, aktive Zeile ist neutral (kein Akzent-Schleier)", () => {
    for (const item of NAV_ITEMS) expect(NAV_TONE[item.id], item.id).toBeDefined();
    expect(new Set(Object.values(NAV_TONE)).size).toBeGreaterThanOrEqual(12);
    renderShell("/sessions");
    const active = screen.getByRole("link", { name: /Sessions/ });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active.className).toMatch(/bg-a-p3/);
    expect(active.className).not.toMatch(/bg-a-acc/);
    const icon = active.querySelector("[data-tone]");
    expect(icon?.getAttribute("data-tone")).toBe("done");
    expect((icon as HTMLElement | null)?.style.color).toBe("var(--a-done)");
  });

  it("Kennzahl-Kachel: Punkt und neutraler Trend-Chip in der Kachelfarbe, gut/schlecht bleibt grün/rot", () => {
    const { container } = renderWithClient(
      <MemoryRouter>
        <StatCard id="tokens_today" label="Tokens heute" value={5} format={String} trend={{ current: 5, previous: 1, period: "ggü. gestern", upIsGood: null }} />
        <StatCard id="commits_7d" label="Commits" value={5} format={String} trend={{ current: 5, previous: 1, period: "ggü. Vorwoche", upIsGood: true }} />
      </MemoryRouter>,
    );
    const tokens = container.querySelector('[data-metric="tokens_today"]');
    expect((tokens?.querySelector("[data-tone]") as HTMLElement | null)?.style.backgroundColor).toBe("var(--a-violet)");
    expect((tokens?.querySelector("[title^='ggü. gestern']") as HTMLElement | null)?.style.color).toBe("var(--a-violet)");
    const commits = container.querySelector('[data-metric="commits_7d"]');
    expect(commits?.querySelector("[title^='ggü. Vorwoche']")?.className).toMatch(/text-a-ok/);
  });
});
