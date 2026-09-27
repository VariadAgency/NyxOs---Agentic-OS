// Gehirn 3D: Steuerung (Trackpad/Maus unter macOS), große Knoten nah sichtbar, Legende, Physik-Regler
// wirken im Worker, Lichtimpulse nach Klick. Reine Funktionen — ohne WebGL prüfbar.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PerspectiveCamera, Vector3 } from "three";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { classifyWheel, keyAction, MAX_ZOOM_STEP, normalizeWheel, pointerAction, wheelAction, type WheelMemory } from "../src/features/brain/cameraInput";
import { OrbitRig } from "../src/features/brain/cameraRig";
import { Legend, toggleGroup } from "../src/features/brain/Legend";
import { planPulse, PULSE_STEP_S } from "../src/features/brain/pulse";
import { physicsKey } from "../src/features/brain/forces";
import { defaultSettings, DEFAULT_FORCES, loadSettings, type BrainSettings } from "../src/features/brain/settings";
import { driftOffset, NEAR_ALPHA, spriteLook, type SpriteUniforms } from "../src/features/brain/shaders3d";
import { applyForces3d, buildSim3d, createSim3dHost, forceParams3d, type FromSim3d, type N3 } from "../src/features/brain/sim3d";

// --- Steuerung: Rad/Trackpad/Kneifen unterscheiden ------------------------------------------------
type W = Parameters<typeof classifyWheel>[0];
const ev = (o: Partial<W>): W => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, altKey: false, wheelDeltaX: undefined, wheelDeltaY: undefined, ...o });

describe("Trackpad, Maus-Rad und Kneifen werden erkannt", () => {
  it("Chrome/Safari am Mac: Trackpad (wheelDelta = −3 × delta) ist Trackpad, Maus-Rad ist Rad, Kneifen = ctrlKey", () => {
    const mem: WheelMemory = { kind: null, at: -1e9 };
    expect(classifyWheel(ev({ deltaY: 3, wheelDeltaY: -9 }), mem, 0)).toBe("trackpad");
    const mem2: WheelMemory = { kind: null, at: -1e9 };
    expect(classifyWheel(ev({ deltaY: 100, wheelDeltaY: -120 }), mem2, 0)).toBe("wheel");
    const mem3: WheelMemory = { kind: null, at: -1e9 };
    expect(classifyWheel(ev({ deltaY: -4.2, ctrlKey: true }), mem3, 0)).toBe("pinch");
  });
  it("Maus-Raste am Mac (Chrome/Firefox: Vielfaches von 4,000244 px) ist Rad, auch wenn wheelDelta −3× passt", () => {
    expect(classifyWheel(ev({ deltaY: 4.000244140625 * 3, wheelDeltaY: -3 * 4.000244140625 * 3 }), { kind: null, at: -1e9 }, 0)).toBe("wheel");
  });
  it("Firefox-Maus (Zeilen) ist Rad; seitliches Wischen ist Trackpad", () => {
    expect(classifyWheel(ev({ deltaY: 3, deltaMode: 1 }), { kind: null, at: -1e9 }, 0)).toBe("wheel");
    expect(classifyWheel(ev({ deltaX: 5, deltaY: 1 }), { kind: null, at: -1e9 }, 0)).toBe("trackpad");
  });
  it("innerhalb einer Geste bleibt die Art (Nachschwingen des Trackpads wird nicht plötzlich zum Rad)", () => {
    const mem: WheelMemory = { kind: null, at: -1e9 };
    expect(classifyWheel(ev({ deltaY: 2, wheelDeltaY: -6 }), mem, 1000)).toBe("trackpad");
    // Schwung-Ereignis mit rundem Wert, 30 ms später: bleibt Trackpad
    expect(classifyWheel(ev({ deltaY: 40 }), mem, 1030)).toBe("trackpad");
    // lange Pause → neue Geste
    expect(classifyWheel(ev({ deltaY: 100, wheelDeltaY: -120 }), mem, 3000)).toBe("wheel");
  });
  it("Zeilen/Seiten werden in Pixel umgerechnet", () => {
    expect(normalizeWheel(ev({ deltaY: 3, deltaMode: 1 }), 800)).toEqual({ dx: 0, dy: 48 });
    expect(normalizeWheel(ev({ deltaY: 1, deltaMode: 2 }), 800)).toEqual({ dx: 0, dy: 800 });
  });
  it("Umkreisen: zwei Finger drehen (auch mit Shift); Kneifen/Rad zoomen (sanft, ohne Sprung)", () => {
    expect(wheelAction("trackpad", ev({ deltaX: 4, deltaY: -2 }), "orbit", 800).type).toBe("rotate");
    // Zwei Finger drehen immer nur die Kugel — auch mit Shift (vorher: schwenken)
    expect(wheelAction("trackpad", ev({ deltaX: 4, deltaY: -2, shiftKey: true }), "orbit", 800).type).toBe("rotate");
    const pinch = wheelAction("pinch", ev({ deltaY: -6, ctrlKey: true }), "orbit", 800);
    expect(pinch.type).toBe("zoom");
    if (pinch.type === "zoom") expect(pinch.factor).toBeLessThan(1); // Finger auseinander = näher ran
    const wheel = wheelAction("wheel", ev({ deltaY: 100 }), "orbit", 800);
    expect(wheel.type).toBe("zoom");
    if (wheel.type === "zoom") expect(wheel.factor).toBeGreaterThan(1);
    // Riesiger Einzelwert (z. B. Rad mit Beschleunigung) → gedeckelter Schritt, kein Sprung
    const huge = wheelAction("wheel", ev({ deltaY: 5000 }), "orbit", 800);
    if (huge.type === "zoom") expect(Math.abs(Math.log(huge.factor))).toBeLessThanOrEqual(MAX_ZOOM_STEP + 1e-9);
  });
  it("Fliegen: zwei Finger schauen um, Kneifen/Rad fliegt vor/zurück", () => {
    expect(wheelAction("trackpad", ev({ deltaX: 4 }), "fly", 800).type).toBe("look");
    expect(wheelAction("wheel", ev({ deltaY: -100 }), "fly", 800).type).toBe("move");
  });
  it("Maus: links drehen, rechts oder Shift+links schwenken", () => {
    expect(pointerAction(0, false, "orbit")).toBe("rotate");
    expect(pointerAction(0, true, "orbit")).toBe("pan");
    expect(pointerAction(2, false, "orbit")).toBe("pan");
    expect(pointerAction(1, false, "orbit")).toBe("pan");
    expect(pointerAction(0, false, "fly")).toBe("look");
  });
  it("Tasten: F zeigt alles, V schaltet Fliegen um, WASD bewegen", () => {
    expect(keyAction("f")).toBe("fit");
    expect(keyAction("F")).toBe("fit");
    expect(keyAction("v")).toBe("toggleFly");
    expect(keyAction("w")).toBe("move");
    expect(keyAction("x")).toBeNull();
  });
});

// --- Kamera-Rig: Trägheit, Dämpfung, Zoom zum Mauspunkt --------------------------------------------
function makeRig() {
  const cam = new PerspectiveCamera(50, 1.6, 1, 1e6);
  const rig = new OrbitRig({ minRadius: 5, maxRadius: 50_000 });
  rig.jumpTo(new Vector3(0, 0, 1000), new Vector3(0, 0, 0));
  rig.apply(cam);
  return { cam, rig };
}

describe("Kamera-Rig", () => {
  it("drehen folgt weich (kein Sprung im ersten Bild) und kommt ganz an", () => {
    const { cam, rig } = makeRig();
    const p0 = cam.position.clone();
    rig.rotate(0.6, 0);
    rig.update(1 / 60);
    rig.apply(cam);
    const step1 = cam.position.distanceTo(p0);
    expect(step1).toBeGreaterThan(0);
    // erstes Bild bewegt nur einen Teil des Wegs (geglättet), nicht den ganzen Sprung
    const full = 2 * 1000 * Math.sin(0.3);
    expect(step1).toBeLessThan(full * 0.5);
    // Drehen gleitet weicher (ROTATE_SMOOTH_RATE 4,5) — nach 3 s ist es sicher angekommen.
    for (let i = 0; i < 180; i++) rig.update(1 / 60);
    rig.apply(cam);
    expect(cam.position.distanceTo(new Vector3(0, 0, 0))).toBeCloseTo(1000, 0);
    expect(rig.moving()).toBe(false);
  });
  it("Schwung nach dem Loslassen: dreht weiter und läuft sanft aus", () => {
    const { cam, rig } = makeRig();
    rig.fling(2.0, 0); // rad/s
    const angles: number[] = [];
    for (let i = 0; i < 180; i++) {
      rig.update(1 / 60);
      rig.apply(cam);
      angles.push(Math.atan2(cam.position.x, cam.position.z));
    }
    const d = angles.slice(1).map((a, i) => Math.abs(a - (angles[i] ?? 0)));
    expect(d[5] ?? 0).toBeGreaterThan(0.005); // bewegt sich noch
    expect(d[170] ?? 1).toBeLessThan((d[5] ?? 0) * 0.1); // läuft aus
    expect(Math.max(...d)).toBeLessThan(0.06); // nie ruckartig
    for (let i = 0; i < 240; i++) rig.update(1 / 60);
    expect(rig.moving()).toBe(false);
  });
  it("Zoom zum Mauspunkt: der Punkt unter der Maus bleibt auf dem Bildschirm stehen", () => {
    const { cam, rig } = makeRig();
    const anchor = new Vector3(200, 120, 0);
    const before = anchor.clone().project(cam);
    rig.zoom(0.5, anchor);
    for (let i = 0; i < 90; i++) {
      rig.update(1 / 60);
      rig.apply(cam);
      const now = anchor.clone().project(cam);
      expect(now.x).toBeCloseTo(before.x, 4);
      expect(now.y).toBeCloseTo(before.y, 4);
    }
    expect(cam.position.distanceTo(rig.target)).toBeCloseTo(500, 0);
  });
  it("Zoom bleibt in Grenzen", () => {
    const { rig } = makeRig();
    for (let i = 0; i < 100; i++) rig.zoom(0.5, null);
    for (let i = 0; i < 300; i++) rig.update(1 / 60);
    expect(rig.radius()).toBeGreaterThanOrEqual(5);
  });
  it("Schwenken verschiebt Ziel und Kamera gemeinsam (Blickrichtung bleibt)", () => {
    const { cam, rig } = makeRig();
    const dir0 = cam.getWorldDirection(new Vector3());
    rig.pan(100, 0, cam, 800);
    for (let i = 0; i < 120; i++) rig.update(1 / 60);
    rig.apply(cam);
    expect(rig.target.x).toBeLessThan(-10); // Inhalt folgt der Maus → Ziel wandert entgegen
    expect(cam.getWorldDirection(new Vector3()).dot(dir0)).toBeGreaterThan(0.9999);
  });
});

// --- Große Knoten nah: Größe + Deckkraft ---------------------------------------------------------
const U: SpriteUniforms = { scale: 1930, minPx: 4.8, dpr: 2 };

describe("Große Knoten bleiben nah kräftig sichtbar", () => {
  it("Punktgröße wächst nah ungebremst weiter (keine 360-px-Deckelung)", () => {
    const far = spriteLook({ sizeWorld: 70, depth: 2000, alpha: 1 }, U);
    const near = spriteLook({ sizeWorld: 70, depth: 60, alpha: 1 }, U);
    expect(near.diameterPx).toBeGreaterThan(1500);
    expect(near.diameterPx / far.diameterPx).toBeCloseTo(2000 / 60, 0);
  });
  it("ausgegraute (blasse) Knoten werden beim Heranfliegen kräftig — groß wie klein", () => {
    const bigNear = spriteLook({ sizeWorld: 70, depth: 120, alpha: 0.14 }, U);
    const smallNear = spriteLook({ sizeWorld: 8, depth: 14, alpha: 0.14 }, U);
    expect(bigNear.alpha).toBeGreaterThanOrEqual(NEAR_ALPHA - 1e-6);
    expect(smallNear.alpha).toBeGreaterThanOrEqual(NEAR_ALPHA - 1e-6);
  });
  it("von weitem bleibt das Bild wie bisher (Design unverändert)", () => {
    const farDim = spriteLook({ sizeWorld: 12, depth: 1500, alpha: 0.14 }, U);
    expect(farDim.alpha).toBeCloseTo(0.14, 2);
    const hidden = spriteLook({ sizeWorld: 70, depth: 50, alpha: 0 }, U);
    expect(hidden.alpha).toBe(0); // Ausgeblendetes bleibt weg
  });
  it("Deckkraft hängt nur an der Bildgröße, nicht daran, wie groß der Knoten in der Welt ist", () => {
    const big = spriteLook({ sizeWorld: 80, depth: 800, alpha: 0.5 }, U);
    const small = spriteLook({ sizeWorld: 10, depth: 100, alpha: 0.5 }, U);
    expect(big.diameterPx).toBeCloseTo(small.diameterPx, 3);
    expect(big.alpha).toBeCloseTo(small.alpha, 6);
  });
});

describe("Eigenbewegung (Schweben)", () => {
  it("bleibt in der Amplitude und ist 0, wenn ausgeschaltet", () => {
    for (let t = 0; t < 30; t += 0.7) {
      const [x, y, z] = driftOffset(0.37, t, 5);
      expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(5 * Math.sqrt(3) + 1e-9);
    }
    expect(driftOffset(0.37, 12, 0)).toEqual([0, 0, 0]);
    const a = driftOffset(0.37, 1, 5);
    const b = driftOffset(0.37, 4, 5);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.5); // bewegt sich sichtbar
  });
});

// --- Physik: Regler kommen im Worker an -----------------------------------------------------------
function ring(n: number): { nodes: N3[]; links: Array<{ source: N3; target: N3; weight: number }> } {
  const nodes: N3[] = Array.from({ length: n }, (_, i) => ({ index: i, orphan: false, x: Math.cos(i) * 50, y: Math.sin(i) * 50, z: (i % 3) * 10 }));
  const links = nodes.map((s, i) => ({ source: s, target: nodes[(i + 1) % n] as N3, weight: 1 }));
  return { nodes, links };
}
const meanLink = (links: Array<{ source: N3; target: N3 }>) =>
  links.reduce((a, l) => a + Math.hypot((l.source.x ?? 0) - (l.target.x ?? 0), (l.source.y ?? 0) - (l.target.y ?? 0), (l.source.z ?? 0) - (l.target.z ?? 0)), 0) / links.length;

describe("Physik-Regler wirken in 3D", () => {
  it("Vorgabe-Regler ergeben die bisherigen 3D-Werte (Aussehen bleibt)", () => {
    const p = forceParams3d(DEFAULT_FORCES);
    expect(p.charge).toBeCloseTo(-55, 5);
    expect(p.linkDistance).toBeCloseTo(26, 5);
    expect(p.center).toBeCloseTo(0.035, 5);
    expect(p.linkScale).toBe(1);
  });
  it("Verbindungsabstand ändern → Kanten werden nachweisbar länger", () => {
    const { nodes, links } = ring(40);
    const sim = buildSim3d(nodes, links, DEFAULT_FORCES);
    sim.alpha(1);
    sim.tick(300);
    const before = meanLink(links);
    applyForces3d(sim, { ...DEFAULT_FORCES, distance: 480 });
    sim.alpha(1);
    sim.tick(300);
    expect(meanLink(links)).toBeGreaterThan(before * 1.8);
  });
  it("Worker: Nachricht „forces“ weckt die ruhende Simulation wieder auf (es bewegt sich)", async () => {
    const out: FromSim3d[] = [];
    const host = createSim3dHost((m) => out.push(m));
    const n = 30;
    const pos = new Float32Array(n * 3).map((_, i) => Math.sin(i) * 60);
    const src = Uint32Array.from({ length: n }, (_, i) => i);
    const dst = Uint32Array.from({ length: n }, (_, i) => (i + 1) % n);
    host({ type: "init", gen: 1, pos, degree: new Uint32Array(n).fill(2), src, dst, weight: new Float32Array(n).fill(1), alpha: 0.005, warmupMs: 0, forces: DEFAULT_FORCES });
    await waitFor(() => expect(out.some((m) => m.type === "settled")).toBe(true));
    out.length = 0;
    host({ type: "forces", forces: { ...DEFAULT_FORCES, repel: 20 } });
    await waitFor(() => expect(out.filter((m) => m.type === "positions").length).toBeGreaterThan(3));
    const first = out.find((m) => m.type === "positions");
    expect(first && first.type === "positions" ? first.alpha : 0).toBeGreaterThanOrEqual(0.5);
    host({ type: "stop" });
  });
  it("nur „Schweben“ ändern weckt die Physik nicht (kein Sprung, 2D rechnet nicht mit)", () => {
    expect(physicsKey({ ...DEFAULT_FORCES, drift: 0.9 })).toBe(physicsKey(DEFAULT_FORCES));
    expect(physicsKey({ ...DEFAULT_FORCES, repel: 3 })).not.toBe(physicsKey(DEFAULT_FORCES));
  });
  it("Einstellungen: neuer Regler „Schweben“ hat eine Vorgabe, alte gespeicherte Stände bekommen sie", () => {
    expect(defaultSettings().forces.drift).toBeGreaterThan(0);
    const old = { getItem: () => JSON.stringify({ forces: { center: 0.2, repel: 3, link: 1, distance: 100 } }) };
    expect(loadSettings(old).forces.drift).toBe(DEFAULT_FORCES.drift);
  });
});

// Verdrahtung Regler → Szene → Worker: Graph3D reicht jede Regler-Änderung an die Szene weiter.
const sceneMock = vi.hoisted(() => ({
  setForces: vi.fn(),
  setData: vi.fn(),
  setLook: vi.fn(),
  setControl: vi.fn(),
  setActive: vi.fn(),
  fit: vi.fn(),
  focusNode: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../src/features/brain/scene3d", () => ({ createScene3D: () => sceneMock }));

describe("Verdrahtung Regler → 3D-Szene", () => {
  it("Graph3D gibt die Kräfte beim Start und bei jeder Änderung an die Szene", async () => {
    const { default: Graph3D } = await import("../src/features/brain/Graph3D");
    const view = { hidden: new Set<string>(), dimmed: new Set<string>(), visibleCount: 0 } as unknown as Parameters<typeof Graph3D>[0]["view"];
    const graph = { nodes: [], links: [] } as unknown as Parameters<typeof Graph3D>[0]["graph"];
    const base = defaultSettings();
    const props = { graph, structureVersion: 1, view, selectedId: null, active: true, onSelect: () => {}, onOpen: () => {}, onControlChange: () => {} };
    const { rerender } = render(<Graph3D {...props} settings={base} />);
    expect(sceneMock.setForces).toHaveBeenCalledWith(base.forces);
    const next: BrainSettings = { ...base, forces: { ...base.forces, repel: 15 } };
    rerender(<Graph3D {...props} settings={next} />);
    expect(sceneMock.setForces).toHaveBeenLastCalledWith(next.forces);
  });
});

// --- Lichtimpulse: Welle nach Abstand (Hops) ------------------------------------------------------
describe("Klick: Welle über die Verbindungen", () => {
  // 0 — 1 — 2 — 3, dazu 0 — 4, 4 — 1 (Querkante gleicher Stufe), 5 ausgeblendet an 0
  const linkS = Uint32Array.from([0, 1, 2, 0, 4, 0]);
  const linkT = Uint32Array.from([1, 2, 3, 4, 1, 5]);
  const adj: number[][] = [[0, 3, 5], [0, 1, 4], [1, 2], [2], [3, 4], [5]];
  const hidden = Uint8Array.from([0, 0, 0, 0, 0, 1]);
  it("Stufen nach Abstand, Impulse laufen vom Klick weg, Ausgeblendetes bleibt dunkel", () => {
    const plan = planPulse({ adj, linkS, linkT, hidden, start: 0, maxHops: 3, maxEdges: 100 });
    expect(plan.hop.get(0)).toBe(0);
    expect(plan.hop.get(1)).toBe(1);
    expect(plan.hop.get(4)).toBe(1);
    expect(plan.hop.get(2)).toBe(2);
    expect(plan.hop.get(3)).toBe(3);
    expect(plan.hop.has(5)).toBe(false);
    const e12 = plan.edges.find((e) => e.from === 1 && e.to === 2);
    expect(e12?.delay).toBeCloseTo(PULSE_STEP_S, 6);
    expect(plan.edges.every((e) => (plan.hop.get(e.to) ?? 0) === (plan.hop.get(e.from) ?? 0) + 1)).toBe(true);
  });
  it("gedeckelt (60 fps bleiben): höchstens maxEdges Impulse", () => {
    const plan = planPulse({ adj, linkS, linkT, hidden, start: 0, maxHops: 3, maxEdges: 2 });
    expect(plan.edges.length).toBe(2);
  });
});

// --- Legende: eingeklappt, klappt auf ------------------------------------------------------------
describe("Legende", () => {
  it("ist standardmäßig eingeklappt und klappt per Klick auf", async () => {
    function Harness() {
      const [s, setS] = useState<BrainSettings>(defaultSettings());
      return <Legend settings={s} counts={{ session: 3, "note.code.views": 4 }} onToggle={(k) => setS(toggleGroup(s, k))} />;
    }
    render(<Harness />);
    const legend = screen.getByTestId("brain-legend");
    const toggle = within(legend).getByRole("button", { name: /Legende/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(legend).toHaveAttribute("data-open", "0");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(legend).toHaveAttribute("data-open", "1");
    expect(within(legend).getByTestId("legend-family-session")).toBeVisible();
  });
});
