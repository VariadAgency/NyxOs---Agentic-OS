// Gehirn-Feinschliff: Lichtimpuls ohne Feuerwerk,
// zwei Finger sanft umsehen, Knoten greifen und in 3D ziehen, mehr Eigenbewegung. Reine Funktionen.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ControlPanel } from "../src/features/brain/ControlPanel";
import { OVERLAY_ATTR } from "../src/features/brain/fitArea";
import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { accelCurve, pointerAction, ROTATE_PER_PX, trackpadRotation, wheelAction } from "../src/features/brain/cameraInput";
import { MAX_FLING, OrbitRig, ROTATE_SMOOTH_RATE } from "../src/features/brain/cameraRig";
import { rayPlaneHit } from "../src/features/brain/nodeDrag";
import { hopArrival, hopGain, hopTravel, planPulse, PULSE_HOP_EDGE_CAP, PULSE_MAX_HOPS } from "../src/features/brain/pulse";
import { PULSE_TRAVEL_S } from "../src/features/brain/shaders3d";
import { defaultSettings, loadSettings, type BrainSettings } from "../src/features/brain/settings";
import {
  animatePos,
  animatePosInto,
  driftOffset,
  FLASH_BRIGHTEN,
  flashEnvelope,
  flashLook,
  motionParams,
  NODE_GLOW_FRAGMENT,
  NODE_VERTEX,
  PULSE_ADDITIVE,
  PULSE_LINE_MAX_ALPHA,
  pulseHeadAlpha,
  pulseLineAlpha,
  unanimatePos,
} from "../src/features/brain/shaders3d";
import { createSim3dHost, type FromSim3d } from "../src/features/brain/sim3d";
import { DEFAULT_FORCES } from "../src/features/brain/forces";

// --- 1. Lichtimpuls ohne Feuerwerk ----------------------------------------------------------------
describe("Ankunft des Impulses hellt den Punkt nur minimal auf", () => {
  it("Aufhellen höchstens ~25 %, keine Größenänderung, blasse Knoten springen nicht auf voll", () => {
    expect(FLASH_BRIGHTEN).toBeLessThanOrEqual(0.25);
    let maxBright = 0;
    for (let t = -0.2; t < 3; t += 0.01) {
      const fl = flashEnvelope(t);
      const l = flashLook(fl, 0.14);
      maxBright = Math.max(maxBright, l.brighten);
      expect(l.sizeFactor).toBe(1);
      // vorher: `a = max(a, fl)` → ein ausgegrauter Knoten (14 %) blitzte voll deckend auf
      expect(l.alpha).toBeLessThanOrEqual(0.14 + 0.12 + 1e-9);
    }
    expect(maxBright).toBeGreaterThan(0.05); // man sieht es noch
    expect(maxBright).toBeLessThanOrEqual(0.25);
  });
  it("sanftes Ein- und Ausblenden: startet bei 0, kein Sprung, klingt ganz ab", () => {
    expect(flashEnvelope(-0.1)).toBe(0);
    expect(flashEnvelope(0)).toBe(0);
    let prev = 0;
    for (let t = 0; t < 3; t += 1 / 120) {
      const v = flashEnvelope(t);
      expect(Math.abs(v - prev)).toBeLessThan(0.06); // kein Blitz von einem Bild aufs nächste
      prev = v;
    }
    expect(flashEnvelope(2.5)).toBeLessThan(0.02);
  });
  it("Shader: Knoten wachsen beim Aufleuchten nicht und der Hof wird nicht aufgeblasen", () => {
    expect(NODE_VERTEX).not.toMatch(/iSize \* \(1\.0 \+/);
    expect(NODE_VERTEX).not.toMatch(/max\(a, fl\)/);
    expect(NODE_GLOW_FRAGMENT).not.toMatch(/max\(uGlow, vFlash\)/);
  });
  it("Impulse: dezent, gedeckelt, nicht additiv (viele Impulse summieren sich nicht zu Weiß)", () => {
    expect(PULSE_ADDITIVE).toBe(false);
    let maxLine = 0;
    let maxHead = 0;
    for (let head = -0.5; head < 3; head += 0.02) {
      for (let t = 0; t <= 1; t += 0.02) maxLine = Math.max(maxLine, pulseLineAlpha(t, head, 1));
      maxHead = Math.max(maxHead, pulseHeadAlpha(head, 1));
    }
    expect(maxLine).toBeLessThanOrEqual(PULSE_LINE_MAX_ALPHA + 1e-9);
    // Kräftig (zwischenzeitlich waren die Glasfaserblitze komplett dunkel), aber nie voll deckend; die
    // Menge begrenzt PULSE_SOURCE_CAP (nächste Kanten), nicht die Helligkeit.
    expect(PULSE_LINE_MAX_ALPHA).toBeLessThanOrEqual(0.8);
    expect(maxHead).toBeLessThanOrEqual(1);
    // kein langes Nachglühen der ganzen Faser (das wirkte wie Strahlen über den ganzen Bildschirm)
    for (let t = 0; t <= 1; t += 0.05) expect(pulseLineAlpha(t, 1.6, 1)).toBeLessThan(0.02);
    // Kopf nur unterwegs sichtbar
    expect(pulseHeadAlpha(-0.1, 1)).toBe(0);
    expect(pulseHeadAlpha(1.1, 1)).toBe(0);
  });
  it("vier Ketten, je Kette Deckkraft × 0,5 und 50 % langsamer (keine Beschleunigung)", () => {
    expect(PULSE_MAX_HOPS).toBe(4);
    expect([1, 2, 3, 4].map(hopGain)).toEqual([1, 0.2, 0.08, 0.03]); // 2. Blitz 20 % des ersten
    for (let h = 2; h <= 4; h++) expect(hopTravel(h)).toBeCloseTo(hopTravel(h - 1) * 2, 9);
    expect(hopTravel(1)).toBe(PULSE_TRAVEL_S);
    expect(hopArrival(0)).toBe(0);
    expect(hopArrival(2)).toBeCloseTo(PULSE_TRAVEL_S * (1 + 2), 9);
    expect(hopArrival(4)).toBeCloseTo(PULSE_TRAVEL_S * (1 + 2 + 4 + 8), 9);
  });
  it("Welle folgt den Faktoren: Start, Laufzeit und Stärke je Kette; tiefere Ketten gedeckelt", () => {
    // Kette 0 → 10 Nachbarn → je 30 Blätter → je 1 → je 1 (fünfte Ebene darf nicht mehr kommen)
    const S: number[] = [];
    const T: number[] = [];
    let next = 11;
    for (let a = 1; a <= 10; a++) {
      S.push(0);
      T.push(a);
      for (let k = 0; k < 30; k++) {
        const b = next++;
        S.push(a);
        T.push(b);
        const c = next++;
        S.push(b);
        T.push(c);
        const d = next++;
        S.push(c);
        T.push(d);
        S.push(d);
        T.push(next++);
      }
    }
    const n = next;
    const adj: number[][] = Array.from({ length: n }, () => []);
    S.forEach((s, e) => {
      adj[s]?.push(e);
      adj[T[e] ?? 0]?.push(e);
    });
    const plan = planPulse({ adj, linkS: Uint32Array.from(S), linkT: Uint32Array.from(T), hidden: new Uint8Array(n), start: 0 });
    for (let h = 1; h <= 4; h++) {
      const es = plan.edges.filter((e) => plan.hop.get(e.to) === h);
      expect(es.length).toBeGreaterThan(0);
      expect(es.length).toBeLessThanOrEqual(PULSE_HOP_EDGE_CAP[h - 1] ?? 0);
      for (const e of es) {
        expect(e.gain).toBe(hopGain(h));
        expect(e.travel).toBeCloseTo(hopTravel(h), 9);
        expect(e.delay).toBeCloseTo(hopArrival(h - 1), 9);
      }
    }
    expect([...plan.hop.values()].every((h) => h <= 4)).toBe(true);
    expect(plan.edges.length).toBeLessThan(10 + 3 * 160);
  });
});

// --- 2. Zwei Finger: sanft umsehen ----------------------------------------------------------------
describe("Zwei Finger auf dem Trackpad: sanft umsehen", () => {
  it("Beschleunigungs-Kurve: fein bei kleinen Bewegungen, gedeckelt bei großen (keine Sprünge)", () => {
    expect(accelCurve(0)).toBe(0);
    expect(accelCurve(1)).toBeLessThan(1); // langsam = feiner
    let prev = 0;
    for (let px = 0.5; px < 400; px += 0.5) {
      const v = accelCurve(px);
      expect(v).toBeGreaterThan(prev); // stetig steigend
      prev = v;
    }
    expect(accelCurve(5000)).toBeLessThanOrEqual(48); // Schwung-Ausreißer springen nicht
  });
  it("viel sanfter als vorher: ein typisches Wischen (30 × 8 px) dreht höchstens ~25°", () => {
    let th = 0;
    for (let i = 0; i < 30; i++) th += trackpadRotation(8, 0).dTheta;
    expect(Math.abs(th)).toBeLessThan((25 * Math.PI) / 180);
    expect(Math.abs(th)).toBeGreaterThan((6 * Math.PI) / 180); // bewegt sich aber noch spürbar
    // größtes Einzelereignis
    expect(Math.abs(trackpadRotation(400, 0).dTheta)).toBeLessThan(0.12);
  });
  it("waagrecht und senkrecht gleich stark, Richtung bleibt erhalten", () => {
    const h = trackpadRotation(10, 0);
    const v = trackpadRotation(0, 10);
    expect(Math.abs(h.dTheta)).toBeCloseTo(Math.abs(v.dPhi), 9);
    const d = trackpadRotation(6, 6);
    expect(Math.abs(d.dTheta)).toBeCloseTo(Math.abs(d.dPhi), 9);
    expect(Math.abs(h.dPhi)).toBe(0);
  });
  it("Zoom (Kneifen/Rad) bleibt, wie er war", () => {
    const pinch = wheelAction("pinch", { deltaX: 0, deltaY: -6, deltaMode: 0, ctrlKey: true, shiftKey: false, altKey: false }, "orbit", 800);
    expect(pinch.type).toBe("zoom");
    if (pinch.type === "zoom") expect(pinch.factor).toBeCloseTo(Math.exp(-6 * 0.012), 9);
  });
  it("Drehen mit der Maus im leeren Raum ist deutlich schwächer als vorher (0,0052 rad/px)", () => {
    expect(ROTATE_PER_PX).toBeLessThanOrEqual(0.003);
  });
  it("Dämpfung wie Karten-Apps: Drehung gleitet weich an (kein Sprung, kein Überschwingen)", () => {
    expect(ROTATE_SMOOTH_RATE).toBeLessThan(12);
    const cam = new PerspectiveCamera(50, 1.6, 1, 1e6);
    const rig = new OrbitRig({ minRadius: 5, maxRadius: 50_000 });
    rig.jumpTo(new Vector3(0, 0, 1000), new Vector3());
    rig.rotate(0.2, 0);
    const angles: number[] = [];
    for (let i = 0; i < 60; i++) {
      rig.update(1 / 60);
      rig.apply(cam);
      angles.push(Math.atan2(cam.position.x, cam.position.z));
    }
    expect(Math.abs(angles[0] ?? 1)).toBeLessThan(0.2 * 0.18); // erstes Bild nur ein kleiner Teil
    // Ruhiger und langsamer: nach 0,7 s fast da (vorher 0,5 s).
    expect(Math.abs(angles[41] ?? 0)).toBeGreaterThan(0.2 * 0.9);
    for (let i = 1; i < angles.length; i++) expect(Math.abs(angles[i] ?? 0)).toBeGreaterThanOrEqual(Math.abs(angles[i - 1] ?? 0) - 1e-9);
    expect(Math.max(...angles.map(Math.abs))).toBeLessThanOrEqual(0.2 + 1e-6);
  });
  it("Schwung nach dem Loslassen ist gedeckelt (kein Wegschleudern)", () => {
    expect(MAX_FLING).toBeLessThanOrEqual(2.5);
  });
});

// --- 3. Klicken-halten-ziehen = Knoten greifen ------------------------------------------------------
describe("Knoten greifen und in 3D ziehen", () => {
  it("Gesten-Zuordnung: auf einem Knoten ziehen = Knoten, im leeren Raum = drehen", () => {
    expect(pointerAction(0, false, "orbit", true)).toBe("node");
    expect(pointerAction(0, false, "fly", true)).toBe("node");
    expect(pointerAction(0, false, "orbit", false)).toBe("rotate");
    expect(pointerAction(0, true, "orbit", true)).toBe("pan"); // Shift schwenkt weiter
    expect(pointerAction(2, false, "orbit", true)).toBe("pan");
  });
  it("Ebene parallel zur Kamera: der Punkt unter der Maus liegt in der Tiefe des Knotens", () => {
    const origin = new Vector3(0, 0, 1000);
    const normal = new Vector3(0, 0, -1); // Blickrichtung
    const node = new Vector3(50, 20, 100);
    const dir = new Vector3(0.1, 0.05, -1).normalize();
    const hit = rayPlaneHit(origin, dir, node, normal);
    expect(hit).not.toBeNull();
    expect(hit?.z ?? 0).toBeCloseTo(100, 6);
    expect(hit?.x ?? 0).toBeCloseTo(90, 4);
    // Strahl parallel zur Ebene / hinter der Kamera → nichts
    expect(rayPlaneHit(origin, new Vector3(1, 0, 0), node, normal)).toBeNull();
    expect(rayPlaneHit(origin, new Vector3(0, 0, 1), node, normal)).toBeNull();
  });
  it("gezeichnete Lage ↔ Physik-Lage: Schweben/Atmen lässt sich exakt herausrechnen", () => {
    const m = motionParams(0.8, false);
    const p: [number, number, number] = [120, -40, 65];
    for (const t of [0, 3.3, 17.9]) {
      const w = animatePos(p, 0.42, t, m);
      const back = unanimatePos(w, 0.42, t, m);
      back.forEach((v, i) => expect(v).toBeCloseTo(p[i] ?? 0, 6));
    }
  });
  it("je Bild ohne neue Arrays: animatePosInto schreibt in dasselbe Ziel und rechnet wie animatePos/driftOffset", () => {
    const out: [number, number, number] = [0, 0, 0];
    const m = motionParams(0.8, false);
    for (const t of [0, 2.1, 9.7]) {
      expect(animatePosInto(out, 120, -40, 65, 0.42, t, m)).toBe(out);
      animatePos([120, -40, 65], 0.42, t, m).forEach((v, i) => expect(out[i]).toBeCloseTo(v, 9));
      // Ohne Atmen/Wiegen bleibt nur das Schweben je Knoten übrig.
      const [dx, dy, dz] = driftOffset(0.42, t, 5);
      animatePosInto(out, 1, 2, 3, 0.42, t, { drift: 5, breath: 0, sway: 0 });
      expect(out[0]).toBeCloseTo(1 + dx, 9);
      expect(out[1]).toBeCloseTo(2 + dy, 9);
      expect(out[2]).toBeCloseTo(3 + dz, 9);
    }
  });
  it("Physik: gezogener Knoten wird festgehalten, Nachbarn folgen; Loslassen gibt ihn frei", async () => {
    const out: FromSim3d[] = [];
    const host = createSim3dHost((m) => out.push(m));
    const n = 12;
    const pos = new Float32Array(n * 3).map((_, i) => Math.sin(i * 1.7) * 40);
    const src = Uint32Array.from({ length: n - 1 }, (_, i) => i);
    const dst = Uint32Array.from({ length: n - 1 }, (_, i) => i + 1);
    host({ type: "init", gen: 1, pos, degree: new Uint32Array(n).fill(2), src, dst, weight: new Float32Array(n - 1).fill(1), alpha: 0.005, warmupMs: 0, forces: DEFAULT_FORCES });
    await waitFor(() => expect(out.some((m) => m.type === "settled")).toBe(true));
    const last = () => {
      const p = [...out].reverse().find((m) => m.type === "positions");
      return p && p.type === "positions" ? p.pos : new Float32Array(n * 3);
    };
    const n1Before = [...last().slice(3, 6)];
    out.length = 0;
    host({ type: "pin", index: 0, x: 400, y: 0, z: 0 });
    await waitFor(() => expect(out.filter((m) => m.type === "positions").length).toBeGreaterThan(20), { timeout: 3000 });
    const p = last();
    expect(p[0]).toBeCloseTo(400, 3); // hängt an der Maus
    expect(Math.hypot((p[3] ?? 0) - (n1Before[0] ?? 0), (p[4] ?? 0) - (n1Before[1] ?? 0), (p[5] ?? 0) - (n1Before[2] ?? 0))).toBeGreaterThan(20); // Nachbar folgt
    expect(out.some((m) => m.type === "settled")).toBe(false); // hält wach, solange gezogen wird
    host({ type: "unpin", index: 0 });
    await waitFor(() => expect(out.some((m) => m.type === "settled")).toBe(true), { timeout: 8000 });
    const q = last();
    expect(q[0]).toBeLessThan(400); // federt zurück in die Wolke
    host({ type: "stop" });
  });
});

// --- 4. Mehr Eigenbewegung ------------------------------------------------------------------------
describe("Die ganze Masse bewegt sich mehr (Atmen/Schweben), ohne wegzudriften", () => {
  it("deutlich mehr als vorher (Schweben 0,5 × 9), aber begrenzt; mit „Bewegung reduzieren“ still", () => {
    const m = motionParams(DEFAULT_FORCES.drift, false);
    expect(m.drift).toBeGreaterThan(0.5 * 9 * 1.3);
    expect(m.breath).toBeGreaterThan(0);
    expect(m.breath).toBeLessThanOrEqual(0.04);
    expect(m.sway).toBeGreaterThan(0);
    expect(m.sway).toBeLessThanOrEqual(0.06);
    expect(motionParams(1, true)).toEqual({ drift: 0, breath: 0, sway: 0 });
    expect(motionParams(0, false)).toEqual({ drift: 0, breath: 0, sway: 0 });
  });
  it("die ganze Wolke atmet (auch weit außen), bleibt aber im Mittel an ihrem Platz", () => {
    const m = motionParams(DEFAULT_FORCES.drift, false);
    const p: [number, number, number] = [400, 0, 0];
    let maxDev = 0;
    const mean = [0, 0, 0];
    const N = 4000;
    for (let k = 0; k < N; k++) {
      const t = k * 0.05;
      const w = animatePos(p, 0.3, t, m);
      maxDev = Math.max(maxDev, Math.hypot(w[0] - p[0], w[1] - p[1], w[2] - p[2]));
      for (let c = 0; c < 3; c++) mean[c] = (mean[c] ?? 0) + (w[c] ?? 0) / N;
    }
    expect(maxDev).toBeGreaterThan(10); // sichtbar
    expect(maxDev).toBeLessThan(60); // nie weg
    expect(Math.hypot((mean[0] ?? 0) - p[0], mean[1] ?? 0, mean[2] ?? 0)).toBeLessThan(6);
  });
});

// --- Steuer-Leiste rechts: standardmäßig eingeklappt ------------------------------------------------
describe("Leiste rechts (Arten, Darstellung, Kräfte)", () => {
  it("ist beim Öffnen des Gehirns immer zu (immer zugeklappt), auch wenn sie zuletzt offen war", () => {
    expect(defaultSettings().panelOpen).toBe(false);
    const old = { getItem: () => JSON.stringify({ schema: 2, panelOpen: true }) };
    expect(loadSettings(old).panelOpen).toBe(false);
    const now = { getItem: () => JSON.stringify({ schema: defaultSettings().schema, panelOpen: true, openSections: { forces: true } }) };
    const loaded = loadSettings(now);
    expect(loaded.panelOpen).toBe(false);
    // Welche Abschnitte innen auf- oder zugeklappt sind, bleibt gemerkt.
    expect(loaded.openSections.forces).toBe(true);
  });
});

describe("Leiste ausgefahren: „Alles einpassen“ weicht ihr aus", () => {
  function Harness() {
    const [settings, setSettings] = useState<BrainSettings>(defaultSettings());
    return <ControlPanel settings={settings} onChange={setSettings} counts={{ session: 3 }} colorCounts={{}} visibleCount={3} totalCount={3} onFit={() => undefined} />;
  }
  it("zu: der Leisten-Körper ist keine Kachel und nicht bedienbar; offen: Kachel (Einpassen rechnet sie heraus)", () => {
    render(<Harness />);
    const body = screen.getByTestId("brain-panel-body");
    expect(screen.getByTestId("brain-panel").getAttribute("data-open")).toBe("0");
    expect(body.hasAttribute(OVERLAY_ATTR)).toBe(false);
    expect(body.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Steuerung öffnen" }));
    expect(screen.getByTestId("brain-panel").getAttribute("data-open")).toBe("1");
    expect(body.hasAttribute(OVERLAY_ATTR)).toBe(true);
    expect(body.hasAttribute("inert")).toBe(false);
    // schmale Bildschirme: Blatt von unten, höchstens 45 % der Höhe
    expect(body.className).toMatch(/max-sm:bottom-0/);
    expect(body.className).toMatch(/max-sm:max-h-\[45%\]/);
    // keine zweifarbige Kachel (Verlauf)
    expect(body.className).not.toMatch(/gradient/);
    fireEvent.click(screen.getByRole("button", { name: "Steuerung schließen" }));
    expect(body.hasAttribute(OVERLAY_ATTR)).toBe(false);
  });
});
