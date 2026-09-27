// Gehirn-Feinschliff: „Steuerung“ waagrecht + 2D/3D immer da, Klick fliegt
// wieder zum Punkt, scharfe Punkte (weißer Kern, farbiger Kern, Fade), zwei Finger drehen nur die Kugel,
// weniger Feuerwerk (2. Blitz 20 % des ersten).
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { classifyWheel, rotationPivot, wheelAction, type WheelMemory } from "../src/features/brain/cameraInput";
import { OrbitRig } from "../src/features/brain/cameraRig";
import { ControlPanel } from "../src/features/brain/ControlPanel";
import { hopGain, planPulse, PULSE_HOP_EDGE_CAP, PULSE_SOURCE_CAP } from "../src/features/brain/pulse";
import { defaultSettings, type BrainSettings } from "../src/features/brain/settings";
import { focusDistance, MIN_CORE_PX, NODE_CORE_FRAGMENT, NODE_GLOW_FRAGMENT, NODE_VERTEX, PICK_MIN_PX, pickRadiusPx } from "../src/features/brain/shaders3d";

type W = Parameters<typeof classifyWheel>[0];
const ev = (o: Partial<W>): W => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, altKey: false, wheelDeltaX: undefined, wheelDeltaY: undefined, ...o });

describe("weniger Feuerwerk: jede Kette deutlich dunkler", () => {
  it("2. Blitz = 20 % des ersten, dann weiter abgestuft", () => {
    const g = [1, 2, 3, 4].map(hopGain);
    expect(g[0]).toBe(1);
    expect(g[1]).toBeCloseTo(0.2, 9);
    expect(g[2]).toBeLessThanOrEqual(0.08 + 1e-9);
    expect(g[3]).toBeLessThanOrEqual(0.03 + 1e-9);
    for (let h = 2; h <= 4; h++) expect(g[h - 1] ?? 1).toBeLessThan(g[h - 2] ?? 0);
  });
  it("weniger gleichzeitige Impulse", () => {
    expect(PULSE_SOURCE_CAP).toBeLessThanOrEqual(40);
    expect(PULSE_HOP_EDGE_CAP[1]).toBeLessThanOrEqual(60);
    expect(PULSE_HOP_EDGE_CAP[2]).toBeLessThanOrEqual(30);
    expect(PULSE_HOP_EDGE_CAP[3]).toBeLessThanOrEqual(15);
    // Stern mit 200 Nachbarn, jeder mit 5 Blättern: gesamt deutlich unter den alten ~400 Impulsen
    const S: number[] = [];
    const T: number[] = [];
    let next = 201;
    for (let a = 1; a <= 200; a++) {
      S.push(0);
      T.push(a);
      for (let k = 0; k < 5; k++) {
        S.push(a);
        T.push(next++);
      }
    }
    const adj: number[][] = Array.from({ length: next }, () => []);
    S.forEach((s, e) => {
      adj[s]?.push(e);
      adj[T[e] ?? 0]?.push(e);
    });
    const plan = planPulse({ adj, linkS: Uint32Array.from(S), linkT: Uint32Array.from(T), hidden: new Uint8Array(next), start: 0, rank: (_e, _a, b) => b });
    expect(plan.edges.length).toBeLessThanOrEqual(PULSE_SOURCE_CAP + 60);
  });
});

describe("zwei Finger drehen nur die Kugel", () => {
  it("Trackpad mit Shift dreht auch (nie schwenken)", () => {
    expect(wheelAction("trackpad", ev({ deltaX: 4, deltaY: -2, shiftKey: true }), "orbit", 800).type).toBe("rotate");
  });
  it("seitliches Wischen zählt immer als Trackpad, auch wenn die Geste davor als Rad erkannt wurde", () => {
    const mem: WheelMemory = { kind: null, at: -1e9 };
    expect(classifyWheel(ev({ deltaY: 100, wheelDeltaY: -120 }), mem, 1000)).toBe("wheel");
    expect(classifyWheel(ev({ deltaX: 6, deltaY: 0 }), mem, 1050)).toBe("trackpad");
  });
  it("waagrechtes Rad-Ereignis zoomt nicht (sonst bewegt sich die Kamera beim Seitwärts-Wischen)", () => {
    expect(wheelAction("wheel", ev({ deltaX: 40, deltaY: 0 }), "orbit", 800).type).toBe("rotate");
  });
  it("Drehpunkt: Mitte der Wolke; nur ganz nah am angeflogenen Punkt dreht es um ihn", () => {
    expect(rotationPivot({ focused: false, camToFocus: 50, focusDist: 60 })).toBe("center");
    expect(rotationPivot({ focused: true, camToFocus: 70, focusDist: 60 })).toBe("node");
    expect(rotationPivot({ focused: true, camToFocus: 400, focusDist: 60 })).toBe("center");
  });
  it("Drehen um einen Drehpunkt neben dem Blickziel: Abstand Kamera–Drehpunkt bleibt, keine Verschiebung", () => {
    const rig = new OrbitRig({ minRadius: 1, maxRadius: 1e5 });
    const cam = new PerspectiveCamera(50, 1.5, 1, 1e5);
    const pivot = new Vector3(0, 0, 0);
    // Blickziel neben der Mitte (z. B. nach Zoom zum Mauszeiger)
    rig.jumpTo(new Vector3(120, 30, 500), new Vector3(120, 30, 0));
    rig.apply(cam);
    const d0 = cam.position.distanceTo(pivot);
    const t0 = rig.target.distanceTo(pivot);
    for (let k = 0; k < 20; k++) rig.rotate(0.03, 0.01, pivot);
    for (let k = 0; k < 400; k++) rig.update(1 / 60);
    rig.apply(cam);
    expect(cam.position.distanceTo(pivot)).toBeCloseTo(d0, 0);
    expect(rig.target.distanceTo(pivot)).toBeCloseTo(t0, 0);
    // tatsächlich gedreht (nicht stehen geblieben)
    expect(cam.position.distanceTo(new Vector3(120, 30, 500))).toBeGreaterThan(50);
  });
});

describe("Klick fliegt zum Punkt", () => {
  it("Einzelklick auf einen Knoten wählt aus UND fliegt hin (nicht nur Doppelklick)", () => {
    const src = readFileSync(join(__dirname, "../src/features/brain/scene3d.ts"), "utf8");
    const up = src.slice(src.indexOf("const onPointerUp"), src.indexOf("const onDblClick"));
    expect(up).toMatch(/cb\.onSelect\(node\)/);
    expect(up).toMatch(/focusNode\(node\.id\)/);
  });
  it("Abstand beim Anfliegen: Nachbarn bleiben im Bild, nah genug für den Punkt", () => {
    const half = (25 * Math.PI) / 180;
    const d = focusDistance({ neighborRadius: 100, coreRadius: 4, halfFov: half });
    expect(d * Math.tan(half)).toBeGreaterThanOrEqual(100);
    expect(d).toBeLessThan(400);
    // Knoten ohne Nachbarn: nah ran, aber nicht in ihn hinein
    const lone = focusDistance({ neighborRadius: 0, coreRadius: 4, halfFov: half });
    expect(lone).toBeGreaterThan(4 * 5);
    expect(lone).toBeLessThan(120);
  });
});

describe("scharfe Punkte, sicher anklickbar", () => {
  it("Treffer-Radius mindestens 8 px und nie kleiner als der sichtbare Kern", () => {
    expect(PICK_MIN_PX).toBeGreaterThanOrEqual(8);
    expect(pickRadiusPx(0.5)).toBeGreaterThanOrEqual(8);
    expect(pickRadiusPx(MIN_CORE_PX)).toBeGreaterThanOrEqual(8);
    expect(pickRadiusPx(30)).toBeGreaterThanOrEqual(30);
  });
  // Der weiße Punkt in der Mitte ist bewusst weg — s. brain-render-sharpness.test.tsx.
  it("Shader: farbiger Kern voll deckend (ohne weißen Mittelpunkt), Kanten in Geräte-Pixeln (scharf bei jedem Zoom)", () => {
    expect(NODE_VERTEX).toMatch(/vHalfPx/);
    for (const src of [NODE_GLOW_FRAGMENT, NODE_CORE_FRAGMENT]) {
      expect(src).toMatch(/vHalfPx/);
      expect(src).not.toMatch(/whiteR|CORE_WHITE/);
    }
    // keine Unschärfe über einen Bruchteil des Sprites mehr: Kante über ~1 Geräte-Pixel
    expect(NODE_GLOW_FRAGMENT).toMatch(/coreR - 0\.5, coreR \+ 0\.5/);
  });
});

describe("Steuerung waagrecht, 2D/3D immer sichtbar", () => {
  function Harness() {
    const [s, setS] = useState<BrainSettings>({ ...defaultSettings(), panelOpen: false, mode: "3d" });
    return (
      <>
        <ControlPanel settings={s} onChange={setS} counts={{}} colorCounts={{}} visibleCount={0} totalCount={0} onFit={() => {}} />
        <span data-testid="mode">{s.mode}</span>
      </>
    );
  }
  it("Griff ist waagrecht (kein vertikaler Text) und 2D/3D ist zugeklappt bedienbar", () => {
    render(<Harness />);
    const handle = screen.getByRole("button", { name: "Steuerung öffnen" });
    expect(handle.innerHTML).not.toMatch(/writing-mode|vertical/);
    expect(handle.textContent).toContain("Steuerung");
    const group = screen.getByRole("radiogroup", { name: "Ansicht" });
    expect(group.closest("[inert]")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "2D" }));
    expect(screen.getByTestId("mode").textContent).toBe("2d");
    // Auch bei offener Leiste bleibt der Umschalter da
    fireEvent.click(handle);
    expect(screen.getByRole("radiogroup", { name: "Ansicht" }).closest("[inert]")).toBeNull();
  });
});
