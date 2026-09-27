// Gehirn scharf (vorher rausgezoomt extrem schwammig, zu bunt, Fäden unsichtbar, weißer Punkt in
// jedem Punkt): Renderstufen, kleine scharfe Punkte mit engem Schein, ruhigere
// Palette, Fäden bei jedem Zoom sichtbar, in 2D keine Höfe und keine Überlappung.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLORS, hexToRgb } from "../src/features/brain/colors";
import { nodeRadius } from "../src/features/brain/GraphCanvas";
import {
  clampCoreRadiusPx,
  EDGE_ALPHA,
  EDGE_ALPHA_FLOOR,
  edgeAlpha,
  edgeOverlap,
  edgeWidthDevicePx,
  farTone,
  GLOW_SPAN,
  glowAmount,
  LOD2D,
  lod2d,
  LOD3D,
  lod3d,
  MIN_CORE_RADIUS_PX,
  NODE_MAX,
  nodeImportance,
  nodeWorldRadius,
  orientationLabels,
} from "../src/features/brain/lod";
import { EDGE_FRAGMENT, EDGE_VERTEX, MIN_CORE_PX, minSpritePx, NODE_CORE_FRAGMENT, NODE_GLOW_FRAGMENT, NODE_VERTEX } from "../src/features/brain/shaders3d";
import { buildSimulation, collideRadius, COLLIDE_PAD, type WNode } from "../src/features/brain/simulation";
import { DEFAULT_FORCES } from "../src/features/brain/forces";

const src = (f: string) => readFileSync(join(__dirname, "../src/features/brain", f), "utf8");

// OKLCH (Björn Ottosson) für die Palette
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function oklch(hex: string): { L: number; C: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => lin(v / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb) };
}
const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => lin(v / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("Renderstufen (LOD)", () => {
  it("3D: Stufe nach Bildgröße der Wolke — ganz klein fern, eingepasst mitte, drinnen nah", () => {
    expect(lod3d(0.15).level).toBe("far");
    expect(lod3d(0.15).far).toBe(1);
    expect(lod3d(0.85)).toEqual({ far: 0, near: 0, level: "mid" }); // „Alles einpassen“
    expect(lod3d(5).level).toBe("near");
    expect(lod3d(5).near).toBe(1);
    expect(lod3d(Number.NaN).level).toBe("mid"); // kaputte Werte: nie „fern“
  });
  it("Übergänge weich (kein Umspringen): benachbarte Werte ändern die Stufe nur wenig", () => {
    for (const [lod, t] of [
      [lod3d, LOD3D],
      [lod2d, LOD2D],
    ] as const) {
      let prev = lod(t.farFull * 0.5);
      for (let x = t.farFull * 0.5; x < t.nearFull * 1.5; x += 0.01) {
        const cur = lod(x);
        expect(Math.abs(cur.far - prev.far)).toBeLessThan(0.05);
        expect(Math.abs(cur.near - prev.near)).toBeLessThan(0.05);
        expect(cur.far).toBeLessThanOrEqual(prev.far + 1e-9); // näher ran = nie ferner
        prev = cur;
      }
    }
  });
  it("2D: Stufe nach Bildgröße eines kleinen Knotens", () => {
    expect(lod2d(0.3).level).toBe("far");
    expect(lod2d(2).level).toBe("mid");
    expect(lod2d(10).level).toBe("near");
  });
  it("fern: kein Schein; mitte/nah: Schein erst ab einer Kerngröße, nur wenn eingeschaltet", () => {
    expect(glowAmount(lod3d(0.1), 20)).toBe(0);
    expect(glowAmount(lod3d(0.85), 0.9)).toBe(0); // winzige Punkte bleiben scharf
    expect(glowAmount(lod3d(0.85), 6)).toBe(1);
    expect(glowAmount(lod3d(0.85), 6, false)).toBe(0);
  });
  it("fern: höchstens ein paar Orientierungs-Beschriftungen, ganz fern keine (kein Stapel auf dem Knäuel)", () => {
    expect(orientationLabels(lod3d(0.1))).toBe(0);
    expect(orientationLabels(lod3d(0.85))).toBeGreaterThan(0);
    expect(orientationLabels(lod3d(0.85))).toBeLessThanOrEqual(8);
  });
});

describe("Punkte: klein, scharf, ohne weißen Mittelpunkt", () => {
  it("Mindestgröße auf dem Bildschirm: nie unter 2 px Durchmesser, nicht aufgebläht (vorher 2,4 px Radius)", () => {
    expect(MIN_CORE_PX).toBe(MIN_CORE_RADIUS_PX);
    expect(MIN_CORE_RADIUS_PX * 2).toBeGreaterThanOrEqual(1.5);
    expect(MIN_CORE_RADIUS_PX * 2).toBeLessThanOrEqual(2.2);
    expect(clampCoreRadiusPx(0.1)).toBe(MIN_CORE_RADIUS_PX);
    expect(clampCoreRadiusPx(Number.NaN)).toBe(MIN_CORE_RADIUS_PX);
    expect(clampCoreRadiusPx(7)).toBe(7);
    // Sprite-Mindestgröße hält genau den Kern-Radius ein (bei DPR 2, Schein-Anteil 1/GLOW_SPAN)
    expect((minSpritePx(1 / GLOW_SPAN, 2) / 2) * (1 / GLOW_SPAN)).toBeCloseTo(MIN_CORE_RADIUS_PX * 2, 6);
  });
  it("Knotenpunkte gedeckelt: ein Knoten mit 400 Verbindungen höchstens ~5× so groß wie ein Blatt (vorher 7×, ohne Deckel)", () => {
    const leaf = nodeWorldRadius(1, 1);
    expect(nodeWorldRadius(400, 1)).toBe(NODE_MAX);
    expect(nodeWorldRadius(5000, 1)).toBe(NODE_MAX);
    expect(NODE_MAX / leaf).toBeLessThanOrEqual(4);
    expect(nodeWorldRadius(25, 1)).toBeGreaterThan(leaf); // Wichtigkeit bleibt sichtbar
    expect(nodeWorldRadius(25, 2)).toBeCloseTo(2 * nodeWorldRadius(25, 1), 6); // Regler „Knotengröße“ wirkt
  });
  it("2D nutzt dieselbe Größenregel (vorher (2 + √Grad) ohne Deckel: Hub ~90 px nah)", () => {
    expect(nodeRadius({ degree: 400 }, 1)).toBe(NODE_MAX);
    expect(nodeRadius({ degree: 400 }, 1)).toBeLessThan(2 + Math.sqrt(400));
  });
  it("Schein eng: höchstens 1,6 × Kern (vorher 2,6)", () => {
    expect(GLOW_SPAN).toBeLessThanOrEqual(1.6);
    expect(src("scene3d.ts")).not.toMatch(/settings\.glow \? 2\.6/);
  });
  it("Shader: kein weißer Mittelpunkt mehr, Kern mit Kante über ~1 Geräte-Pixel, Schein je Stufe", () => {
    for (const s of [NODE_GLOW_FRAGMENT, NODE_CORE_FRAGMENT]) {
      expect(s).not.toMatch(/CORE_WHITE|whiteR|vec3\(1\.0, 1\.0, 1\.0\)/);
      expect(s).toMatch(/coreR - 0\.5, coreR \+ 0\.5/);
    }
    expect(NODE_VERTEX).toMatch(/uniform float uFar;/);
    expect(NODE_VERTEX).toMatch(/vGlow = uGlow \* \(1\.0 - uFar\)/);
    expect(NODE_VERTEX).toMatch(/attribute float iImp;/);
  });
  it("fern: unwichtige Punkte entsättigt und etwas dunkler, wichtige unverändert; nah: alles unverändert", () => {
    const c: [number, number, number] = [0.9, 0.3, 0.5];
    expect(farTone(c, 1, 1)).toEqual(c);
    expect(farTone(c, 0, 0)).toEqual(c);
    const minor = farTone(c, 0, 1);
    const spread = (x: readonly number[]) => Math.max(...x) - Math.min(...x);
    expect(spread(minor)).toBeLessThan(spread(c));
    expect(Math.max(...minor)).toBeLessThan(0.9);
    expect(nodeImportance(1)).toBe(0);
    expect(nodeImportance(200)).toBe(1);
  });
});

describe("ruhigere Palette mit Kontrast", () => {
  it("keine schreienden Neons: OKLCH-Buntheit ≤ 0,185 (vorher bis 0,30), Helligkeit in einem engen Band", () => {
    const bad: string[] = [];
    for (const [k, hex] of Object.entries(DEFAULT_COLORS)) {
      const { L, C } = oklch(hex);
      if (C > 0.185 || L < 0.65 || L > 0.87) bad.push(`${k} ${hex} L${L.toFixed(2)} C${C.toFixed(3)}`);
    }
    expect(bad).toEqual([]);
    for (const neon of ["#fa30f3", "#eb0aa0", "#bd3afa", "#25d126", "#f01e62"]) expect(Object.values(DEFAULT_COLORS)).not.toContain(neon);
  });
  it("klar vom Schwarz getrennt: Mindest-Helligkeit (Kontrast ≥ 5,5 : 1 zum Grund, vorher kleinster Wert 4,9)", () => {
    const bg = luminance("#050505");
    for (const [k, hex] of Object.entries(DEFAULT_COLORS)) expect({ k, ok: (luminance(hex) + 0.05) / (bg + 0.05) >= 5.5 }).toEqual({ k, ok: true });
  });
});

describe("Fäden bei jedem Zoom sichtbar", () => {
  it("Deckkraft nie unter der Untergrenze — auch ganz fern und bei riesiger Überdeckung", () => {
    expect(EDGE_ALPHA_FLOOR).toBeGreaterThanOrEqual(0.05);
    for (const x of [0.05, 0.3, 0.85, 3, 10]) for (const ov of [0, 1, 5, 50, 1e6]) expect(edgeAlpha(lod3d(x), ov)).toBeGreaterThanOrEqual(EDGE_ALPHA_FLOOR);
    // wenig Überdeckung: volle Grund-Deckkraft der Stufe
    expect(edgeAlpha(lod3d(0.1), 0)).toBeCloseTo(EDGE_ALPHA.far, 6);
    expect(edgeAlpha(lod3d(5), 0)).toBeCloseTo(EDGE_ALPHA.near, 6);
    // viel Überdeckung: gedämpft (kein heller Nebel über den Punkten)
    expect(edgeAlpha(lod3d(0.85), 10)).toBeLessThan(edgeAlpha(lod3d(0.85), 0));
  });
  it("Überdeckung: mehr Fäden bzw. kleinere Wolke = mehr Überdeckung; leere Wolke = 0", () => {
    expect(edgeOverlap(20000, 0.75, 400)).toBeGreaterThan(edgeOverlap(2000, 0.75, 400));
    expect(edgeOverlap(20000, 0.75, 100)).toBeGreaterThan(edgeOverlap(20000, 0.75, 400));
    expect(edgeOverlap(0, 0.75, 400)).toBe(0);
    expect(edgeOverlap(100, 0.75, 0)).toBe(0);
  });
  it("feste Bildschirm-Breite, mindestens 1 Geräte-Pixel", () => {
    expect(edgeWidthDevicePx(1, 1)).toBeGreaterThanOrEqual(1);
    expect(edgeWidthDevicePx(0.01, 2)).toBeGreaterThanOrEqual(1);
    expect(edgeWidthDevicePx(1, 2)).toBeCloseTo(1.5, 6);
  });
  it("3D: Fäden als Bänder aus der Positions-Textur (keine gl.LINES mit 1 Geräte-Pixel), Farbe Richtung Grau, Schimmer", () => {
    expect(EDGE_VERTEX).toMatch(/texelFetch\(uPos/);
    expect(EDGE_VERTEX).toMatch(/uWidth \* 0\.5 \+ uFeather/);
    expect(EDGE_VERTEX).toMatch(/uNear/); // Enden hinter der Kamera werden abgeschnitten
    expect(EDGE_FRAGMENT).toMatch(/mix\(vColor, NEUTRAL, uNeutral\)/);
    expect(EDGE_FRAGMENT).toMatch(/uShimmer/);
    const s = src("scene3d.ts");
    expect(s).not.toMatch(/new LineSegments\(new BufferGeometry\(\), linesMat\)/);
    expect(s).toMatch(/edgeAlpha\(lod, overlap\)/);
  });
});

describe("2D: keine Höfe, kein Weichzeichnen, keine Überlappung", () => {
  it("kein weicher Hof (2,3 × Radius) und kein shadowBlur mehr — nur ein enger Rand", () => {
    const s = src("GraphCanvas.tsx");
    expect(s).not.toMatch(/HALO_SCALE/);
    expect(s).not.toMatch(/ctx\.shadowBlur/);
    expect(s).toMatch(/GLOW_RING_PX = 1\.5/);
    expect(s).toMatch(/edgeAlpha\(lod, overlapRef\.current\)/);
    expect(s).not.toMatch(/rgba\(TOKENS\.mut, baseAlpha/); // vorher graue Fäden mit 0,06–0,12
  });
  it("Physik mit Kollision: jeder Knoten hält seinen Radius + Rand frei", () => {
    expect(collideRadius(400)).toBe(NODE_MAX + COLLIDE_PAD);
    const nodes: WNode[] = Array.from({ length: 40 }, (_, i) => ({ orphan: false, degree: i === 0 ? 400 : 1, x: (i % 7) * 0.1, y: Math.floor(i / 7) * 0.1 }));
    const sim = buildSimulation(nodes, [], DEFAULT_FORCES);
    expect(sim.force("collide")).toBeTruthy();
    sim.alpha(1);
    for (let i = 0; i < 300; i++) sim.tick();
    // Der große Knoten überlappt keinen anderen mehr (kleine Toleranz für die weiche Kraft).
    const hub = nodes[0] as WNode;
    for (const n of nodes.slice(1)) {
      const d = Math.hypot((n.x ?? 0) - (hub.x ?? 0), (n.y ?? 0) - (hub.y ?? 0));
      expect(d).toBeGreaterThan(nodeWorldRadius(400, 1) + nodeWorldRadius(1, 1) - 0.5);
    }
  });
});
