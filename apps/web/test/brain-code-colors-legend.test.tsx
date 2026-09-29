// Gehirn: Code-Notizen nach Unterordner bzw. Bibliothek eingefärbt, kräftige
// Palette ohne Grau/Weiß (Kontrast + Abstand je Familie geprüft), Legende mit Familien + Zustand,
// Löschen eigener Ansichten per Tastatur, Einpassen um überlagernde Kacheln herum.
import type { GraphLink, GraphNode } from "@nyxos/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_SUBS,
  colorKeyOf,
  DEFAULT_COLORS,
  FAMILY_LEAVES,
  familyOf,
  hexToRgb,
  LIB_SUBS,
  libGroup,
  noteCategory,
  SHARED_COLOR_PAIRS,
  type ColorKey,
} from "../src/features/brain/colors";
import { freeArea } from "../src/features/brain/fitArea";
import { computeView } from "../src/features/brain/filter";
import { groupVisibility, Legend, toggleGroup } from "../src/features/brain/Legend";
import { defaultSettings, type BrainSettings } from "../src/features/brain/settings";
import { ViewBar } from "../src/features/brain/ViewBar";
import { applyPreset, saveView } from "../src/features/brain/views";

const note = (path: string | null, over: Partial<GraphNode> = {}): GraphNode => ({
  id: `note:${path ?? "?x"}`,
  type: "note",
  label: path ?? "x",
  group: path?.includes("/") ? (path.split("/")[0] ?? "") : "(Wurzel)",
  degree: 1,
  ref: { kind: "note", path },
  ...over,
});

// --- Farbmathe (CIELAB, CIEDE2000, WCAG-Kontrast, HSL-Helligkeit) --------------------------------
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function lab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => lin(v / 255)) as [number, number, number];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function de2000([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const rad = Math.PI / 180;
  const [l1, l2, A1, A2, B1, B2] = [L1 ?? 0, L2 ?? 0, a1 ?? 0, a2 ?? 0, b1 ?? 0, b2 ?? 0];
  const Cm = (Math.hypot(A1, B1) + Math.hypot(A2, B2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = A1 * (1 + G);
  const a2p = A2 * (1 + G);
  const C1p = Math.hypot(a1p, B1);
  const C2p = Math.hypot(a2p, B2);
  const h = (bb: number, aa: number) => {
    const v = Math.atan2(bb, aa) / rad;
    return v < 0 ? v + 360 : v;
  };
  const h1p = h(B1, a1p);
  const h2p = h(B2, a2p);
  let dh = h2p - h1p;
  if (C1p * C2p === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * rad) / 2);
  const Lm = (l1 + l2) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hm += h1p + h2p < 360 ? 360 : -360;
    hm /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTh = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cmp;
  const SH = 1 + 0.015 * Cmp * T;
  const RT = -Math.sin(2 * dTh * rad) * RC;
  const dC = C2p - C1p;
  return Math.sqrt(((l2 - l1) / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => lin(v / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

describe("Code-Notizen nach Unterordner bzw. Bibliothek", () => {
  it("eigener Code bekommt die Farbe seines Unterordners (aus dem echten Vault: Views, ViewModels, Models, Services, Backend)", () => {
    const cases: Array<[string, ColorKey]> = [
      ["02 Code/Views/EventDetailView.md", "note.code.views"],
      ["02 Code/ViewModels/FeedViewModel.md", "note.code.viewmodels"],
      ["02 Code/Models/Event.md", "note.code.models"],
      ["02 Code/Services/APIClient.md", "note.code.services"],
      ["02 Code/Backend/AuthController.md", "note.code.backend"],
      ["02 Code/AppState.md", "note.code.weitere"],
      ["02 Code/Irgendwas/Neu.md", "note.code.weitere"],
    ];
    for (const [path, key] of cases) expect([path, colorKeyOf(note(path))]).toEqual([path, key]);
    expect(noteCategory(note("02 Code/Views/EventDetailView.md"))).toBe("code");
  });

  it("Code aus Fremd-Bibliotheken (Swift-Pakete) ist eine eigene Familie, nach Paket-Art eingefärbt", () => {
    const lib = (pkg: string) => note(`02 Code/Views/X-${pkg}.md`, { lib: pkg });
    expect(noteCategory(lib("swift-nio"))).toBe("bibliothek");
    const cases: Array<[string, ColorKey]> = [
      ["swift-nio", "note.bibliothek.netz"],
      ["swift-nio-http2", "note.bibliothek.netz"],
      ["async-http-client", "note.bibliothek.netz"],
      ["vapor", "note.bibliothek.server"],
      ["fluent-kit", "note.bibliothek.server"],
      ["postgres-nio", "note.bibliothek.server"],
      ["RediStack", "note.bibliothek.server"],
      ["swift-crypto", "note.bibliothek.sicherheit"],
      ["swift-nio-ssl", "note.bibliothek.sicherheit"],
      ["jwt-kit", "note.bibliothek.sicherheit"],
      ["swift-collections", "note.bibliothek.daten"],
      ["swift-async-algorithms", "note.bibliothek.daten"],
      ["swift-log", "note.bibliothek.werkzeuge"],
      ["swift-configuration", "note.bibliothek.werkzeuge"],
    ];
    for (const [pkg, key] of cases) expect([pkg, colorKeyOf(lib(pkg))]).toEqual([pkg, key]);
    expect(libGroup("irgendein-paket")).toBe("werkzeuge");
  });

  it("Familie ↔ Untergruppe", () => {
    expect(familyOf("note.code.views")).toBe("note.code");
    expect(familyOf("note.bibliothek.netz")).toBe("note.bibliothek");
    expect(familyOf("note.planung")).toBe("note.planung");
    expect(familyOf("session")).toBe("session");
    expect(FAMILY_LEAVES["note.code"]).toEqual(CODE_SUBS.map((s) => `note.code.${s}`));
    expect(FAMILY_LEAVES["note.bibliothek"]).toEqual(LIB_SUBS.map((s) => `note.bibliothek.${s}`));
  });

  it("Farb-Zwischenspeicher merkt Änderungen am Knoten (Delta bringt die Bibliothek nach)", () => {
    const n = note("02 Code/Views/_BTree.md");
    expect(colorKeyOf(n)).toBe("note.code.views");
    Object.assign(n, { lib: "swift-collections" });
    expect(colorKeyOf(n)).toBe("note.bibliothek.daten");
  });
});

describe("Palette kräftig, ohne Grau/Weiß, unterscheidbar", () => {
  const bg = luminance("#050505");

  it("jede Gruppenfarbe ist kräftig: Buntheit ≥ 40, nicht fast weiß (HSL-Helligkeit ≤ 72 %), Kontrast ≥ 4,5 : 1", () => {
    const bad: string[] = [];
    for (const [key, hex] of Object.entries(DEFAULT_COLORS)) {
      const [, a, b] = lab(hex);
      const chroma = Math.hypot(a, b);
      const contrast = (luminance(hex) + 0.05) / (bg + 0.05);
      const { l } = hsl(hex);
      if (chroma < 40 || l > 0.72 || contrast < 4.5) bad.push(`${key} ${hex} C${chroma.toFixed(0)} L${(l * 100).toFixed(0)}% K${contrast.toFixed(1)}`);
    }
    expect(bad).toEqual([]);
    // die blassen Vorgaben aus Paket E sind weg
    const values = Object.values(DEFAULT_COLORS);
    for (const pale of ["#fff3b0", "#d9f99d", "#fed7aa"]) expect(values).not.toContain(pale);
  });

  it("Familien klar abgesetzt (ΔE2000 ≥ 9), Töne innerhalb einer Familie verwandt, aber unterscheidbar (ΔE2000 ≥ 6)", () => {
    const shared = new Set(SHARED_COLOR_PAIRS.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
    const keys = Object.keys(DEFAULT_COLORS) as ColorKey[];
    const tooClose: string[] = [];
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i] as ColorKey;
        const b = keys[j] as ColorKey;
        if (shared.has(`${a}|${b}`)) continue;
        const same = familyOf(a) === familyOf(b);
        const d = de2000(lab(DEFAULT_COLORS[a]), lab(DEFAULT_COLORS[b]));
        if (d < (same ? 6 : 9)) tooClose.push(`${a}/${b} ${d.toFixed(1)}`);
      }
    expect(tooClose).toEqual([]);
  });

  it("eigener Code = verwandte Blautöne; Bibliotheken (⅔ aller Notizen) je Art ein klar anderer Farbton, nie blau", () => {
    for (const k of FAMILY_LEAVES["note.code"]) {
      const { h } = hsl(DEFAULT_COLORS[k]);
      expect({ k, blau: h >= 195 && h <= 245 }).toEqual({ k, blau: true });
    }
    const libs = FAMILY_LEAVES["note.bibliothek"];
    for (const k of libs) {
      const { h } = hsl(DEFAULT_COLORS[k]);
      expect({ k, nichtBlau: h < 190 || h > 250 }).toEqual({ k, nichtBlau: true });
    }
    // Sonst wirkt die Masse wieder einfarbig (erst blau, mit einer Grün-Familie dann grün): Arten weit auseinander.
    for (let i = 0; i < libs.length; i++)
      for (let j = i + 1; j < libs.length; j++) {
        const d = de2000(lab(DEFAULT_COLORS[libs[i] as ColorKey]), lab(DEFAULT_COLORS[libs[j] as ColorKey]));
        expect({ pair: `${libs[i]}/${libs[j]}`, weit: d >= 20 }).toEqual({ pair: `${libs[i]}/${libs[j]}`, weit: true });
      }
  });
});

// --- Filter je Untergruppe + Ansichten ----------------------------------------------------------
describe("Untergruppen filtern", () => {
  const nodes: GraphNode[] = [note("02 Code/Views/A.md"), note("02 Code/Views/B.md", { lib: "swift-nio" }), note("02 Code/Models/C.md"), note("04 Planung/P.md")];
  const links: GraphLink[] = [];
  const visible = (s: BrainSettings) => {
    const v = computeView(nodes, links, s);
    return nodes.filter((n) => !v.hidden.has(n.id)).map((n) => n.id);
  };

  it("eine Untergruppe lässt sich einzeln ausblenden bzw. ausgrauen", () => {
    const s = defaultSettings();
    expect(visible({ ...s, subGroups: { "note.code.views": "hide" } })).toEqual(["note:02 Code/Views/B.md", "note:02 Code/Models/C.md", "note:04 Planung/P.md"]);
    const dim = computeView(nodes, links, { ...s, subGroups: { "note.bibliothek.netz": "dim" } });
    expect([...dim.dimmed]).toEqual(["note:02 Code/Views/B.md"]);
  });

  it("„Nur Code“ zeigt eigenen Code und Bibliotheken, „Planung/Obsidian“ keins von beiden", () => {
    expect(visible(applyPreset(defaultSettings(), "code"))).toEqual(["note:02 Code/Views/A.md", "note:02 Code/Views/B.md", "note:02 Code/Models/C.md"]);
    expect(visible(applyPreset(defaultSettings(), "planung"))).toEqual(["note:04 Planung/P.md"]);
  });

  it("eigene Ansichten merken Untergruppen", () => {
    const s = saveView({ ...defaultSettings(), subGroups: { "note.code.models": "hide" } }, "Ohne Models");
    expect(s.savedViews[0]?.filters.subGroups).toEqual({ "note.code.models": "hide" });
  });
});

// --- Fremd-Code tritt zurück ------------------------------------------------------------
// Bibliotheken sind ⅔ aller Punkte und ihre Töne liegen zwangsläufig nah an anderen Familien (grün ≈
// Commits/Daten, pink ≈ Nicht erstellt, orange ≈ Aufgaben …). Standardmäßig ausgegraut (bleiben bunt,
// nur blass), damit jede kräftige Farbe eindeutig eine eigene Kategorie ist.
describe("Bibliotheken standardmäßig ausgegraut", () => {
  const nodes: GraphNode[] = [note("02 Code/Views/A.md"), note("02 Code/Views/B.md", { lib: "swift-nio" }), note("04 Planung/P.md")];
  const dimmed = (s: BrainSettings) => [...computeView(nodes, [], s).dimmed];

  it("Vorgabe, „Alles“ und Session-Gehirn: Bibliotheken ausgegraut, eigener Code und Planung kräftig; „Nur Code“ zeigt sie voll", () => {
    expect(defaultSettings().noteGroups.bibliothek).toBe("dim");
    expect(dimmed(defaultSettings())).toEqual(["note:02 Code/Views/B.md"]);
    expect(dimmed(applyPreset(defaultSettings(), "all"))).toEqual(["note:02 Code/Views/B.md"]);
    expect(dimmed(applyPreset(defaultSettings(), "code"))).toEqual([]);
  });

  it("Legende: ausgegraute Familie ist beschriftet; Klick zeigt sie voll (nicht ausblenden), nächster Klick blendet aus", async () => {
    const counts: Partial<Record<ColorKey, number>> = { "note.bibliothek.netz": 923, "note.code.views": 372 };
    function H() {
      const [s, setS] = useState(defaultSettings());
      return (
        <>
          <Legend defaultOpen settings={s} counts={counts} onToggle={(k) => setS(toggleGroup(s, k))} />
          <output data-testid="state">{s.noteGroups.bibliothek}</output>
        </>
      );
    }
    render(<H />);
    const fam = screen.getByTestId("legend-family-note.bibliothek");
    expect(fam).toHaveTextContent("ausgegraut");
    const btn = within(fam).getByRole("button", { name: /^Bibliotheken\s*\d/ });
    expect(btn).toHaveAttribute("title", "Voll zeigen");
    await userEvent.click(btn);
    expect(screen.getByTestId("state").textContent).toBe("show");
    await userEvent.click(within(screen.getByTestId("legend-family-note.bibliothek")).getByRole("button", { name: /^Bibliotheken\s*\d/ }));
    expect(screen.getByTestId("state").textContent).toBe("hide");
  });
});

// --- Legende -----------------------------------------------------------------------------------
describe("Legende: Familien, aufklappbar, mit Zustand", () => {
  const counts: Partial<Record<ColorKey, number>> = { session: 86, "note.code.views": 372, "note.code.models": 31, "note.bibliothek.netz": 923, "note.bibliothek.server": 1038, "note.planung": 46 };

  function Harness({ initial }: { initial: BrainSettings }) {
    const [s, setS] = useState(initial);
    return (
      <>
        <Legend defaultOpen settings={s} counts={counts} onToggle={(k) => setS(toggleGroup(s, k))} />
        <output data-testid="state">{JSON.stringify({ noteGroups: s.noteGroups, subGroups: s.subGroups, groups: s.groups })}</output>
      </>
    );
  }

  it("zeigt Familien mit Summe; Code und Bibliotheken klappen in ihre Unterordner auf", async () => {
    render(<Harness initial={defaultSettings()} />);
    const legend = screen.getByTestId("brain-legend");
    const code = within(legend).getByTestId("legend-family-note.code");
    expect(code).toHaveTextContent("Eigener Code");
    expect(code).toHaveTextContent("403");
    expect(within(legend).getByTestId("legend-family-note.bibliothek")).toHaveTextContent("1961");
    expect(within(legend).queryByTestId("legend-leaf-note.code.views")).toBeNull();
    await userEvent.click(within(code).getByRole("button", { name: "Eigener Code aufklappen" }));
    const leaf = within(legend).getByTestId("legend-leaf-note.code.views");
    expect(leaf).toHaveTextContent("Views");
    expect(leaf).toHaveTextContent("372");
    expect(leaf.querySelector("[data-color]")?.getAttribute("data-color")).toBe(DEFAULT_COLORS["note.code.views"]);
  });

  it("zeigt, welche Gruppen ausgegraut oder ausgeblendet sind", () => {
    const s = { ...defaultSettings(), groups: { ...defaultSettings().groups, session: "dim" as const }, noteGroups: { ...defaultSettings().noteGroups, planung: "hide" as const } };
    render(<Harness initial={s} />);
    const legend = screen.getByTestId("brain-legend");
    expect(within(legend).getByTestId("legend-family-session")).toHaveTextContent("ausgegraut");
    expect(within(legend).getByTestId("legend-family-note.planung")).toHaveTextContent("ausgeblendet");
    expect(within(legend).getByTestId("legend-family-note.code")).not.toHaveTextContent(/ausgegraut|ausgeblendet/);
    expect(groupVisibility(s, "note.planung")).toBe("hide");
    expect(groupVisibility(s, "session")).toBe("dim");
  });

  it("Klick auf eine Untergruppe blendet nur sie aus (Zustand sichtbar), erneut ein", async () => {
    const d = defaultSettings();
    render(<Harness initial={{ ...d, noteGroups: { ...d.noteGroups, bibliothek: "show" } }} />);
    const legend = screen.getByTestId("brain-legend");
    await userEvent.click(within(legend).getByRole("button", { name: "Bibliotheken aufklappen" }));
    const leaf = within(legend).getByTestId("legend-leaf-note.bibliothek.netz");
    await userEvent.click(within(leaf).getByRole("button", { name: /Netzwerk/ }));
    expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}").subGroups).toEqual({ "note.bibliothek.netz": "hide" });
    expect(within(legend).getByTestId("legend-leaf-note.bibliothek.netz")).toHaveTextContent("ausgeblendet");
    // Familie teilweise aus → Hinweis an der Familie
    expect(within(legend).getByTestId("legend-family-note.bibliothek")).toHaveTextContent("teils aus");
    await userEvent.click(within(within(legend).getByTestId("legend-leaf-note.bibliothek.netz")).getByRole("button", { name: /Netzwerk/ }));
    expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}").subGroups).toEqual({ "note.bibliothek.netz": "show" });
  });
});

// --- Eigene Ansicht löschen: auch per Tastatur/Touch ------------------------------------------
describe("Löschen eigener Ansichten ohne Hover erreichbar", () => {
  it("der Löschen-Knopf ist sichtbar (kein display:none) und per Tab + Enter bedienbar", async () => {
    const onChange = vi.fn();
    const s = saveView(defaultSettings(), "Meins");
    render(<ViewBar settings={s} onChange={onChange} baustellen={[]} focusLabel={null} />);
    const del = screen.getByRole("button", { name: "Ansicht „Meins“ löschen" });
    expect(del.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    screen.getByRole("tab", { name: /Meins/ }).focus();
    await userEvent.tab();
    expect(del).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].savedViews).toEqual([]);
  });
});

// --- Einpassen um überlagernde Kacheln -------------------------------------------------------
describe("Einpassen berücksichtigt Kacheln", () => {
  it("größte freie Fläche neben Seitenblatt/Legende links und Steuerung rechts", () => {
    const area = freeArea(1440, 900, [
      { left: 16, top: 16, right: 700, bottom: 110 }, // Kopf + Ansichten
      { left: 16, top: 120, right: 336, bottom: 700 }, // Seitenblatt
      { left: 16, top: 760, right: 560, bottom: 884 }, // Legende
      { left: 1112, top: 16, right: 1424, bottom: 820 }, // Steuerung
    ]);
    expect(area).not.toBeNull();
    if (!area) return;
    // frei: rechts vom Seitenblatt, links von der Steuerung
    expect(area.left).toBeGreaterThanOrEqual(336);
    expect(area.right).toBeLessThanOrEqual(1112);
    expect(area.bottom - area.top).toBeGreaterThan(500);
  });

  it("ohne Kacheln die ganze Fläche; zu wenig Platz (schmales Fenster) → null = normales Einpassen", () => {
    expect(freeArea(800, 600, [])).toEqual({ left: 0, top: 0, right: 800, bottom: 600 });
    expect(freeArea(400, 600, [{ left: 0, top: 0, right: 380, bottom: 600 }])).toBeNull();
  });
});
