// Finder mit großen Ordnern und Gehirn-Ansicht (schmal, Drehpunkt, Helligkeit).
// 1. Finder: große Ordner (~/Downloads, 1.753 Einträge) — Liste zeigt erst 200 Zeilen und lädt beim
//    Scrollen nach; Vorschaubilder höchstens 3 gleichzeitig (sonst belegen sie alle 6 Verbindungen des
//    Browsers, und die nächste Ordner-Liste wartet dahinter).
// 2. Gehirn bei 390 px: Kopf kurz, Hilfe-Leiste einzeilig und waagrecht scrollbar, Tasten hinter „?“.
// 3. Gehirn: Drehpunkt = Mitte der Wolke (robust), Impulse hell in Knotenfarbe, Riesen-Knoten nur mit den
//    nächsten Kanten statt Strahlenkranz, Auswahl hebt Nachbarn hervor, Schwenken sanfter.
import type { FinderEntry } from "@nyxos/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconsView, ListView } from "../src/features/finder/views";
import { Thumb, __thumbSlotsForTests } from "../src/features/finder/FileIcon";
import { PROGRESSIVE_STEP } from "../src/features/finder/progressive";
import { Graph3DHelp } from "../src/features/brain/Graph3DHelp";
import { statsLine } from "../src/features/brain/headline";
import { hopGain, planPulse, PULSE_MAX_HOPS, PULSE_SOURCE_CAP } from "../src/features/brain/pulse";
import { animatePos, motionParams, NODE_GLOW_FRAGMENT, NODE_CORE_FRAGMENT, PULSE_HEAD_FRAGMENT, PULSE_LINE_FRAGMENT, PULSE_LINE_MAX_ALPHA, pulseHeadAlpha, SELECT_REST_ALPHA, unanimatePos } from "../src/features/brain/shaders3d";
import { robustBounds, viewShiftFor } from "../src/features/brain/fitArea";
import { LOOK_PER_PX, ROTATE_PER_PX, TRACKPAD_ROTATE_PER_PX } from "../src/features/brain/cameraInput";
import { INERTIA_DECAY, MAX_FLING, ROTATE_SMOOTH_RATE } from "../src/features/brain/cameraRig";

afterEach(() => {
  vi.unstubAllGlobals();
});

const entry = (i: number, over: Partial<FinderEntry> = {}): FinderEntry => ({
  name: `datei-${i}.pdf`,
  rel: `datei-${i}.pdf`,
  kind: "text",
  isDir: false,
  size: 100 + i,
  mtimeMs: 1_700_000_000_000 + i,
  children: null,
  hidden: false,
  secret: false,
  link: false,
  ...over,
});

describe("Finder: große Ordner stehen sofort", () => {
  const many = Array.from({ length: 1753 }, (_, i) => entry(i));

  it("Liste: erst höchstens 200 Zeilen, der Rest kommt über „Weitere anzeigen“ / beim Scrollen", () => {
    render(<ListView root="downloads" entries={many} selected={null} onSelect={() => {}} onOpen={() => {}} sort={{ by: "name", dir: "asc" }} onSort={() => {}} />);
    expect(PROGRESSIVE_STEP).toBeLessThanOrEqual(200);
    expect(screen.getAllByRole("row")).toHaveLength(PROGRESSIVE_STEP + 1); // + Kopfzeile
    fireEvent.click(screen.getByRole("button", { name: /weitere/i }));
    expect(screen.getAllByRole("row")).toHaveLength(2 * PROGRESSIVE_STEP + 1);
  });

  it("Symbole: ebenso; eine gewählte Datei weiter hinten wird trotzdem gezeigt", () => {
    render(<IconsView root="downloads" entries={many} selected="datei-900.pdf" onSelect={() => {}} onOpen={() => {}} />);
    const shown = screen.getAllByRole("option");
    expect(shown.length).toBeLessThan(1753);
    expect(shown.some((o) => o.getAttribute("data-rel") === "datei-900.pdf")).toBe(true);
  });

  it("Vorschaubilder: höchstens 3 laden gleichzeitig, das nächste startet nach dem Laden", () => {
    const imgs = Array.from({ length: 10 }, (_, i) => entry(i, { name: `b${i}.png`, rel: `b${i}.png`, kind: "image" }));
    const { container } = render(
      <div>
        {imgs.map((e) => (
          <Thumb key={e.rel} root="downloads" entry={e} size={64} />
        ))}
      </div>,
    );
    const loading = () => container.querySelectorAll("img[src]");
    expect(loading()).toHaveLength(3);
    expect(__thumbSlotsForTests().running).toBe(3);
    act(() => {
      fireEvent.load(loading()[0] as Element);
    });
    expect(loading()).toHaveLength(4); // eins fertig (bleibt stehen), eins neu gestartet
    expect(__thumbSlotsForTests().running).toBe(3);
  });
});

describe("Gehirn bei 390 px", () => {
  it("Hilfe-Leiste bei schmal: Tasten eingeklappt hinter „?“ (schmal bricht sie um statt abzuschneiden)", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
    render(<Graph3DHelp control="orbit" onControlChange={() => {}} onFit={() => {}} />);
    const bar = screen.getByTestId("brain-3d-bar");
    // Breit: eine Zeile + waagrecht scrollbar (narrow-layout-and-tool-names.test.tsx); schmal: umbrechen, nichts ragt rechts hinaus.
    expect(bar.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(screen.queryByTestId("brain-3d-keys")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /tastenhilfe zeigen/i }));
    expect(screen.getByTestId("brain-3d-keys")).toBeTruthy();
  });

  it("Kopfzeile: kurz genug für 390 px, die ganze Aufzählung bleibt im Titel", () => {
    const s = statsLine({ note: 520, session: 180, library: 90, project: 13, task: 30 } as Record<string, number>);
    expect(s.short.length).toBeLessThanOrEqual(28);
    expect(s.full).toContain("·");
  });
});

describe("Gehirn: Drehpunkt in der Mitte der Wolke", () => {
  it("robuste Mitte: ein Ausreißer zieht den Drehpunkt nicht zur Seite", () => {
    const pos: number[] = [];
    for (let i = 0; i < 200; i++) pos.push(Math.sin(i) * 50 + 100, Math.cos(i) * 50 - 20, Math.sin(i * 3) * 50 + 5);
    pos.push(5000, 0, 0); // Ausreißer
    const b = robustBounds(Float32Array.from(pos), new Uint8Array(201));
    expect(b).not.toBeNull();
    expect(Math.abs((b?.c[0] ?? 0) - 100)).toBeLessThan(10);
    expect(Math.abs((b?.c[1] ?? 0) + 20)).toBeLessThan(10);
    expect(b?.r ?? 0).toBeLessThan(200); // nicht bis zum Ausreißer ausgezoomt
  });

  it("die freie Fläche wird per Bild-Versatz getroffen, nicht über ein verschobenes Drehziel", () => {
    expect(viewShiftFor({ left: 300, right: 1000, top: 0, bottom: 800 }, 1000, 800)).toEqual({ x: -150, y: 0 });
    expect(viewShiftFor(null, 1000, 800)).toEqual({ x: 0, y: 0 });
  });

  it("Atmen und Wiegen um die Mitte der Wolke (die Mitte selbst bleibt stehen)", () => {
    const m = { ...motionParams(1, false), drift: 0, center: [100, -20, 5] as [number, number, number] };
    for (const t of [0.5, 3, 9]) {
      const p = animatePos([100, -20, 5], 0, t, m);
      expect(p[0]).toBeCloseTo(100, 6);
      expect(p[1]).toBeCloseTo(-20, 6);
      expect(p[2]).toBeCloseTo(5, 6);
      const q = animatePos([140, 10, -30], 0.3, t, { ...m, drift: 14 });
      const back = unanimatePos(q, 0.3, t, { ...m, drift: 14 });
      expect(back[0]).toBeCloseTo(140, 4);
      expect(back[2]).toBeCloseTo(-30, 4);
    }
  });

  it("Schwenken sanfter und langsamer (~60 %), längeres Nachgleiten", () => {
    expect(ROTATE_PER_PX).toBeLessThanOrEqual(0.0016);
    expect(LOOK_PER_PX).toBeLessThanOrEqual(0.0014);
    expect(TRACKPAD_ROTATE_PER_PX).toBeLessThanOrEqual(0.00105);
    expect(ROTATE_SMOOTH_RATE).toBeLessThanOrEqual(5);
    expect(INERTIA_DECAY).toBeLessThanOrEqual(1.8);
    expect(MAX_FLING).toBeLessThanOrEqual(1.5);
  });
});

describe("Gehirn: hell und klar, Impuls in Knotenfarbe, kein Strahlenkranz", () => {
  it("Riesen-Knoten (527 Kanten): erste Kette nur die nächsten Kanten, aber voll hell; 4 Ketten × 0,5", () => {
    const n = 528;
    const S = Array.from({ length: 527 }, () => 0);
    const T = Array.from({ length: 527 }, (_, i) => i + 1);
    const adj: number[][] = Array.from({ length: n }, () => []);
    S.forEach((s, e) => {
      adj[s]?.push(e);
      adj[T[e] ?? 0]?.push(e);
    });
    // Abstand = Nummer: die nächsten sind 1…PULSE_SOURCE_CAP
    const plan = planPulse({ adj, linkS: Uint32Array.from(S), linkT: Uint32Array.from(T), hidden: new Uint8Array(n), start: 0, rank: (_e, _a, b) => b });
    expect(PULSE_SOURCE_CAP).toBeLessThanOrEqual(60);
    expect(plan.edges).toHaveLength(PULSE_SOURCE_CAP);
    expect(Math.max(...plan.edges.map((e) => e.to))).toBe(PULSE_SOURCE_CAP);
    expect(plan.edges.every((e) => e.gain === 1)).toBe(true); // nicht abgedunkelt
    expect(plan.hop.size).toBe(PULSE_SOURCE_CAP + 1); // nur erreichte Knoten hellen auf
    expect(PULSE_MAX_HOPS).toBe(4);
    expect([1, 2, 3, 4].map(hopGain)).toEqual([1, 0.2, 0.08, 0.03]); // 2. Blitz 20 % des ersten
  });

  it("Impulse gut sichtbar und in Knotenfarbe (kein Mischen zu Weiß)", () => {
    expect(PULSE_LINE_MAX_ALPHA).toBeGreaterThanOrEqual(0.7);
    expect(pulseHeadAlpha(0.5, 1)).toBeGreaterThanOrEqual(0.85);
    for (const src of [PULSE_LINE_FRAGMENT, PULSE_HEAD_FRAGMENT, NODE_GLOW_FRAGMENT, NODE_CORE_FRAGMENT]) expect(src).not.toMatch(/vec3\(1\.0\)\s*,/);
  });

  it("Auswahl: der Rest wird nur leicht abgedunkelt, nicht fast unsichtbar", () => {
    expect(SELECT_REST_ALPHA).toBeGreaterThanOrEqual(0.35);
    expect(SELECT_REST_ALPHA).toBeLessThan(1);
  });
});
