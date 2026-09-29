// 2D-Graph wie Obsidian: force-graph (Canvas, MIT) zeichnet, die Simulation rechnet im Web-Worker.
//
// Aufteilung: force-graph liefert Zoom/Pan/Ziehen/Treffer-Erkennung (Schatten-Canvas) und zeichnet
// die Kanten gebündelt je Farbe. Knoten und Beschriftungen zeichnen wir selbst in EINEM Durchgang
// (gebündelt je Farbe, nur im sichtbaren Ausschnitt) — das hält 6.000 Knoten flüssig. Die eigene
// Simulation von force-graph ist abgeschaltet (keine Kräfte, Abkühlung 0), damit Filter oder
// Hover NIE die Physik neu anstoßen.
import ForceGraph from "force-graph";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { mix, nodeColor, rgba, TOKENS } from "./colors";
import { EDGE_NEUTRAL, EDGE_WIDTH_PX, edgeAlpha, edgeNeutralMix, FAR_DESATURATE, glowAmount, lod2d, MIN_CORE_RADIUS_PX, nodeImportance, nodeWorldRadius, SHIMMER_PERIOD_S, type Lod } from "./lod";
import { endpointId, linkHidden, splitLinks, type GraphView } from "./filter";
import type { Rect } from "./fitArea";
import { physicsKey } from "./forces";
import type { LiveGraph, SimLink, SimNode } from "./graphData";
import { loadPositions, savePositions } from "./positions";
import type { BrainSettings } from "./settings";
import { createSimHost } from "./simHost";
import type { FromWorker, ToWorker } from "./simulation";

export interface GraphCanvasHandle {
  focusNode(id: string, zoom?: number): void;
  zoomToFit(ms?: number): void;
}

export interface GraphCanvasProps {
  graph: LiveGraph;
  /** Wird erhöht, wenn sich Knoten/Kanten-Listen geändert haben (Laden oder Delta). */
  structureVersion: number;
  view: GraphView;
  settings: BrainSettings;
  selectedId: string | null;
  /** Lokaler Graph: Mittelpunkt hervorheben. */
  centerId?: string | null;
  /** localStorage-Schlüssel für gemerkte Positionen (nur der große Graph). */
  persistKey?: string;
  /** Klick zoomt zum Knoten (großer Graph) — im lokalen Graphen nicht. */
  zoomOnClick?: boolean;
  compact?: boolean;
  onSelect(node: SimNode | null): void;
  onOpen(node: SimNode): void;
  /** Leistungswerte/Test-Helfer für Messungen (Playwright) unter `window[exposePerf]`. */
  exposePerf?: "__brainPerf" | "__localGraphPerf";
  /** Freie Fläche neben überlagernden Kacheln (Pixel relativ zum Graphen) — Einpassen zielt
   * dorthin statt auf die ganze Fläche. null = ganze Fläche. */
  fitArea?: () => Rect | null;
}

/** `shimmerSeed` (0–1): fester Zufallswert je Faden für den wandernden Lichtstreifen. */
type RenderLink = SimLink & { source: SimNode; target: SimNode; shimmerSeed?: number };

const HOVER_MS = 150;
const DOUBLE_CLICK_MS = 320;
const MAX_LABELS = 350;
const MAX_HOVER_LABELS = 36;

export function nodeRadius(n: { degree: number }, size: number): number {
  // Wie Obsidian: kleine Grundgröße + Wurzel aus dem Grad. Knotenpunkte gedeckelt (vorher (2 + √Grad)
  // ohne Deckel — ein Knoten mit 400 Verbindungen hatte nah ~90 px Radius und verdeckte Dutzende Nachbarn).
  return nodeWorldRadius(n.degree, size);
}

/**
 * Einpassen in eine freie Teilfläche: wie `zoomToFit`, aber das Sichtbare landet mittig in
 * `area` (z. B. rechts vom Seitenblatt, links der Steuerung) statt unter den Kacheln.
 */
function fitInto(fg: ForceGraph<SimNode, RenderLink>, ms: number, pad: number, filter: (n: SimNode) => boolean, area: Rect | null): void {
  if (!area) {
    fg.zoomToFit(ms, pad, filter);
    return;
  }
  const bbox = fg.getGraphBbox(filter);
  if (!bbox) return;
  const w = Math.max(1, area.right - area.left - 2 * pad);
  const h = Math.max(1, area.bottom - area.top - 2 * pad);
  const bw = Math.max(1, bbox.x[1] - bbox.x[0]);
  const bh = Math.max(1, bbox.y[1] - bbox.y[0]);
  const k = Math.max(fg.minZoom(), Math.min(fg.maxZoom(), Math.min(w / bw, h / bh)));
  // Mitte der freien Fläche gegenüber der Bildmitte (Bildschirm-Pixel) → in Graph-Einheiten verschieben.
  const dx = (area.left + area.right) / 2 - fg.width() / 2;
  const dy = (area.top + area.bottom) / 2 - fg.height() / 2;
  fg.centerAt((bbox.x[0] + bbox.x[1]) / 2 - dx / k, (bbox.y[0] + bbox.y[1]) / 2 - dy / k, ms);
  fg.zoom(k, ms);
}

/**
 * Schein um größere Punkte nur als enger Rand (CSS-px) mit dieser Deckkraft — vorher ein weicher Hof
 * bis 2,3 × Radius (16 %) um jeden Punkt plus `shadowBlur = 9 / k` um die Knotenpunkte (von weitem bis
 * ~90 px Unschärfe!).
 */
const GLOW_RING_PX = 1.5;
const GLOW_RING_ALPHA = 0.28;
/** Entsättigung unwichtiger Punkte von weitem (Anteil von FAR_DESATURATE). */
const FAR_DESATURATE_2D = FAR_DESATURATE * 0.5;
/** Neutrales Grau, zu dem die Fadenfarben gemischt werden (gleich wie im 3D). */
const EDGE_NEUTRAL_HEX = `#${EDGE_NEUTRAL.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
/** Nah: zarter Schein unter den Fäden (zusätzliche Breite in CSS-px, Anteil der Deckkraft). */
const EDGE_GLOW_WIDTH_PX = 2.5;
const EDGE_GLOW_ALPHA_2D = 0.3;
/** Schimmer: nur ein Teil der Fäden trägt gerade einen Lichtstreifen (Anteil, Länge je Faden). */
const SHIMMER_SHARE = 0.3;
const SHIMMER_LEN = 0.14;
/** Für den Schimmer in Ruhe höchstens so oft neu zeichnen (ms) — schont den Rechner. */
const SHIMMER_FRAME_MS = 50;
/** Höchstzahl Lichtstreifen je Farbe und Bild (fester Puffer, kein Speicher je Bild). */
const SHIMMER_MAX = 4096;
/** Pfeilspitzen erst ab dieser Größe auf dem Bildschirm (px) und in Stücken dieser Länge gefüllt. */
const ARROW_MIN_SCREEN_PX = 2;
const ARROW_BATCH = 512;

/** Fester Zufallswert 0–1 aus einem Text (FNV-1a). */
function seed01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Textbreiten gemerkt (bei 100 px gemessen, linear skaliert) — `measureText` je Bild für 350
 * Beschriftungen kostet sonst beim Zoomen spürbar. */
const widthCache = new Map<string, number>();
function textWidth(ctx: CanvasRenderingContext2D, text: string, px: number): number {
  let w = widthCache.get(text);
  if (w === undefined) {
    const font = ctx.font;
    ctx.font = `100px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`;
    w = ctx.measureText(text).width;
    ctx.font = font;
    if (widthCache.size > 20_000) widthCache.clear();
    widthCache.set(text, w);
  }
  return (w * px) / 100;
}

interface HoverState {
  node: SimNode | null;
  set: Set<string>;
  links: Set<RenderLink>;
  t: number;
  target: 0 | 1;
}

interface PerfState {
  frames: number;
  simTicks: number;
  paintMs: number[];
  simTickMs: number;
  alpha: number;
}

export interface BrainPerfHandle {
      nodes: number;
      links: number;
      visible: number;
      alpha: number;
      simTickMs: number;
      simTicks: number;
      paintMsAvg: number;
      measure(ms: number): Promise<{ fps: number; paintMsAvg: number; paintMsP95: number; frames: number }>;
      /** Bildschirm-Koordinaten eines Knotens (relativ zum Canvas) — für Hover-/Klick-Tests. */
      screenPos(id: string): { x: number; y: number } | null;
      /** IDs der sichtbaren Knoten mit den meisten Verbindungen. */
      topNodes(n: number, type?: string): string[];
      firstStableMs: number | null;
      /** Renderstufe, Faden-Deckkraft und gemessene Überdeckung (Nachweis in Tests/Bildern). */
      lod(): Lod & { edgeAlpha: number; overlap: number; zoom: number };
}

declare global {
  interface Window {
    __brainPerf?: BrainPerfHandle;
    __localGraphPerf?: BrainPerfHandle;
  }
}

function makeSimTransport(onMessage: (m: FromWorker) => void): { post(m: ToWorker, transfer?: Transferable[]): void; close(): void } {
  if (typeof Worker !== "undefined") {
    try {
      const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
      return { post: (m, transfer = []) => w.postMessage(m, transfer), close: () => w.terminate() };
    } catch {
      // Rückfall unten
    }
  }
  const handle = createSimHost((m) => onMessage(m));
  return { post: (m) => handle(m), close: () => handle({ type: "stop" }) };
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(props, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraph<SimNode, RenderLink> | null>(null);
  const simRef = useRef<ReturnType<typeof makeSimTransport> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const nodesRef = useRef<SimNode[]>([]);
  const indexRef = useRef(new Map<string, number>());
  const adjacencyRef = useRef(new Map<string, RenderLink[]>());
  const linksRef = useRef<RenderLink[]>([]);
  const visLinksRef = useRef<{ base: RenderLink[]; dim: RenderLink[] }>({ base: [], dim: [] });
  /** Knoten nach Grad sortiert, einmal je Datenstand berechnet (nicht je Bild) — der Glow-Pass
   * braucht davon nur die ersten paar Treffer, nie eine komplette Neusortierung pro Frame. */
  const byDegreeRef = useRef<SimNode[]>([]);
  const genRef = useRef(0);
  const hoverRef = useRef<HoverState>({ node: null, set: new Set(), links: new Set(), t: 0, target: 0 });
  const activeRef = useRef({ sim: false, anim: false, measure: false });
  const perfRef = useRef<PerfState>({ frames: 0, simTicks: 0, paintMs: [], simTickMs: 0, alpha: 0 });
  const lastClickRef = useRef<{ id: string; t: number } | null>(null);
  const fittedRef = useRef(false);
  /** Wurde schon gezoomt/gezogen? Dann nie mehr automatisch einpassen. */
  const userMovedRef = useRef(false);
  const startRef = useRef(0);
  const firstStableRef = useRef<number | null>(null);
  const paletteRef = useRef({ alpha: 0.2, neutral: 0.5, near: 0, hi: "" });
  /** Renderstufe (aus der Bildgröße eines kleinen Knotens), Fäden je Farbe, gemessene Überdeckung. */
  const lodRef = useRef<Lod>(lod2d(2));
  const linkBucketsRef = useRef<Array<{ color: string; base: RenderLink[]; dim: RenderLink[] }>>([]);
  const overlapRef = useRef(0);
  const shimmerBufRef = useRef(new Float32Array(SHIMMER_MAX * 4));
  const paintStartRef = useRef(0);

  // --- Neuzeichnen nur, wenn nötig (Simulation läuft, Hover-Übergang, Messung) -------------------
  const syncRedraw = () => {
    const fg = fgRef.current;
    if (!fg) return;
    const a = activeRef.current;
    fg.autoPauseRedraw(!(a.sim || a.anim || a.measure));
  };
  const requestRedraw = () => {
    const fg = fgRef.current;
    if (fg) fg.zoom(fg.zoom()); // setzt intern „needsRedraw"
  };

  useImperativeHandle(ref, () => ({
    focusNode(id, zoom = 2.4) {
      const fg = fgRef.current;
      const n = nodesRef.current[indexRef.current.get(id) ?? -1];
      if (!fg || !n || n.x === undefined || n.y === undefined) return;
      fg.centerAt(n.x, n.y, 600);
      fg.zoom(Math.max(fg.zoom(), zoom), 600);
    },
    zoomToFit(ms = 500) {
      // Form steht noch nicht (frisch ohne gemerkte Positionen): einpassen, sobald sie steht.
      if (firstStableRef.current === null && activeRef.current.sim) {
        fittedRef.current = false;
        return;
      }
      const fg = fgRef.current;
      if (fg) fitInto(fg, ms, 48, (n) => !propsRef.current.view.hidden.has(n.id), propsRef.current.fitArea?.() ?? null);
    },
  }));

  // --- Einmalig: force-graph + Worker aufsetzen ---------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const sim = makeSimTransport((m) => {
      if (m.gen !== genRef.current) return;
      const fg = fgRef.current;
      if (m.type === "settled") {
        activeRef.current.sim = false;
        if (fg && !userMovedRef.current) fitInto(fg, 700, propsRef.current.compact ? 24 : 56, (n) => !propsRef.current.view.hidden.has(n.id), propsRef.current.fitArea?.() ?? null);
        syncRedraw();
        requestRedraw();
        if (propsRef.current.persistKey) savePositions(propsRef.current.persistKey, nodesRef.current);
        return;
      }
      const nodes = nodesRef.current;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n || (n.fx !== undefined && n.fx !== null)) continue; // gerade gezogen: Hauptthread führt
        n.x = m.xs[i] ?? n.x;
        n.y = m.ys[i] ?? n.y;
      }
      perfRef.current.simTickMs = perfRef.current.simTickMs * 0.9 + m.tickMs * 0.1;
      perfRef.current.simTicks += 1;
      perfRef.current.alpha = m.alpha;
      if (!activeRef.current.sim) {
        activeRef.current.sim = true;
        syncRedraw();
      }
      if (fg && !fittedRef.current && (m.alpha < 0.35 || (nodes.length < 400 && m.tickMs > 0))) {
        fittedRef.current = true;
        fitInto(fg, firstStableRef.current === null && !propsRef.current.persistKey ? 0 : 400, propsRef.current.compact ? 24 : 56, (n) => !propsRef.current.view.hidden.has(n.id), propsRef.current.fitArea?.() ?? null);
      }
      if (firstStableRef.current === null && m.alpha < 0.35) firstStableRef.current = Math.round(performance.now() - startRef.current);
    });
    simRef.current = sim;

    const fg = new ForceGraph<SimNode, RenderLink>(el)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .nodeRelSize(1)
      .nodeVal((n) => nodeRadius(n, propsRef.current.settings.nodeSize) ** 2)
      .nodeCanvasObjectMode(() => "replace")
      .nodeCanvasObject(() => undefined)
      .nodeVisibility((n) => !propsRef.current.view.hidden.has(n.id))
      // Kanten zeichnen wir selbst (paintLinks): force-graph gruppiert sonst je Bild alle ~23.000
      // Kanten neu nach Farbe/Breite und fragt Sichtbarkeit dreimal je Kante ab (Profil).
      .linkVisibility(() => false)
      .d3Force("charge", null)
      .d3Force("center", null)
      .d3Force("link", null)
      .cooldownTicks(0)
      .minZoom(0.03)
      .maxZoom(14)
      .enableNodeDrag(true)
      .autoPauseRedraw(true)
      .onNodeHover((node) => setHover(node && !propsRef.current.view.hidden.has(node.id) ? node : null))
      .onNodeClick((node) => {
        const now = performance.now();
        const last = lastClickRef.current;
        lastClickRef.current = { id: node.id, t: now };
        if (last && last.id === node.id && now - last.t < DOUBLE_CLICK_MS) {
          propsRef.current.onOpen(node);
          return;
        }
        propsRef.current.onSelect(node);
        if (propsRef.current.zoomOnClick && node.x !== undefined && node.y !== undefined) {
          fg.centerAt(node.x, node.y, 600);
          fg.zoom(Math.max(fg.zoom(), 2.2), 600);
        }
      })
      .onBackgroundClick(() => propsRef.current.onSelect(null))
      .onNodeDrag((node) => {
        const i = indexRef.current.get(node.id);
        if (i !== undefined && node.fx != null && node.fy != null) sim.post({ type: "drag", index: i, x: node.fx, y: node.fy });
      })
      .onNodeDragEnd((node) => {
        const i = indexRef.current.get(node.id);
        node.fx = undefined;
        node.fy = undefined;
        if (i !== undefined) sim.post({ type: "dragEnd", index: i });
      })
      .onRenderFramePre((ctx, k) => {
        paintStartRef.current = performance.now();
        const h = hoverRef.current;
        // Renderstufe aus der Bildgröße eines kleinen Knotens; Faden-Deckkraft je Stufe, gedämpft nach
        // der im letzten Bild gemessenen Überdeckung, nie unter der Untergrenze. Hover bleibt kräftig (bis 0.95).
        const lod = lod2d(nodeRadius({ degree: 1 }, propsRef.current.settings.nodeSize) * k);
        lodRef.current = lod;
        paletteRef.current = { alpha: edgeAlpha(lod, overlapRef.current), neutral: edgeNeutralMix(lod), near: lod.near, hi: rgba(TOKENS.acc, 0.35 + 0.6 * h.t) };
        paintLinks(ctx, k);
      })
      .onRenderFramePost((ctx, k) => {
        paintNodes(ctx, k);
        const perf = perfRef.current;
        perf.frames += 1;
        perf.paintMs.push(performance.now() - paintStartRef.current);
        if (perf.paintMs.length > 240) perf.paintMs.splice(0, perf.paintMs.length - 240);
      });
    fgRef.current = fg;

    const markMoved = () => {
      userMovedRef.current = true;
    };
    el.addEventListener("wheel", markMoved, { passive: true });
    el.addEventListener("pointerdown", markMoved);

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) fg.width(r.width).height(r.height);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", markMoved);
      el.removeEventListener("pointerdown", markMoved);
      if (propsRef.current.persistKey && nodesRef.current.length > 0) savePositions(propsRef.current.persistKey, nodesRef.current);
      sim.post({ type: "stop" });
      sim.close();
      fg._destructor();
      fgRef.current = null;
      const key = propsRef.current.exposePerf;
      if (key) window[key] = undefined;
    };
  }, []);

  // --- Schimmer der Fäden — in Ruhe gedrosselt neu zeichnen ---------------------------------
  // Nur wenn sichtbar (2D aktiv, Tab im Vordergrund) und Bewegung erlaubt; läuft ohnehin ein Neuzeichnen
  // (Simulation, Hover, Messung), wird nichts zusätzlich bestellt.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < SHIMMER_FRAME_MS) return;
      last = t;
      const el = containerRef.current;
      const a = activeRef.current;
      if (!el || document.hidden || a.sim || a.anim || a.measure || el.getClientRects().length === 0 || !shimmerOn()) return;
      requestRedraw();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- Hover mit weichem Übergang (150 ms) -------------------------------------------------------
  function setHover(node: SimNode | null) {
    const h = hoverRef.current;
    if (node) {
      const set = new Set<string>([node.id]);
      const links = new Set<RenderLink>();
      for (const l of adjacencyRef.current.get(node.id) ?? []) {
        if (linkHidden(propsRef.current.view, l)) continue;
        links.add(l);
        set.add(l.source.id);
        set.add(l.target.id);
      }
      if (h.node && h.node.id !== node.id) h.t = Math.min(h.t, 0.35); // direkter Wechsel: kurz neu einblenden
      h.node = node;
      h.set = set;
      h.links = links;
      h.target = 1;
    } else {
      h.target = 0;
    }
    startHoverAnimation();
  }

  function startHoverAnimation() {
    if (activeRef.current.anim) return;
    activeRef.current.anim = true;
    syncRedraw();
    let last = performance.now();
    const step = (now: number) => {
      const h = hoverRef.current;
      const dt = (now - last) / HOVER_MS;
      last = now;
      h.t = h.target === 1 ? Math.min(1, h.t + dt) : Math.max(0, h.t - dt);
      if ((h.target === 1 && h.t >= 1) || (h.target === 0 && h.t <= 0)) {
        if (h.target === 0) {
          h.node = null;
          h.set = new Set();
          h.links = new Set();
        }
        activeRef.current.anim = false;
        syncRedraw();
        requestRedraw();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // --- Kanten: gebündelt (ein Pfad je Farbe), nur im sichtbaren Ausschnitt -----------------------
  // Fäden sichtbar, auch rausgezoomt: vorher grau mit 0,06–0,12 bei
  // ½ px Breite — von weitem nur ein grauer Dunst. Jetzt: feste Bildschirm-Breite (0,75 px), Deckkraft
  // je Renderstufe mit Untergrenze, gedämpft nach der gemessenen Überdeckung (kein heller Nebel), Farbe
  // der Gruppe ein gutes Stück Richtung Grau, nah ein zarter Schein und ein wandernder Lichtstreifen.
  function paintLinks(ctx: CanvasRenderingContext2D, k: number) {
    const { settings } = propsRef.current;
    const h = hoverRef.current;
    const p = paletteRef.current;
    const m = ctx.getTransform();
    const x0 = -m.e / m.a;
    const y0 = -m.f / m.d;
    const x1 = (ctx.canvas.width - m.e) / m.a;
    const y1 = (ctx.canvas.height - m.f) / m.d;
    const hoverOn = h.node !== null && h.t > 0;
    const arrowLen = 3.5;
    // Pfeilspitzen erst, wenn sie auf dem Bildschirm sichtbar sind — weit herausgezoomt wären es
    // ~23.000 Punkt-große Dreiecke in einem Pfad, und deren Füllen kostete ~1 s je Bild.
    const arrows = settings.arrows && arrowLen * k >= ARROW_MIN_SCREEN_PX;
    const shimmerPhase = shimmerOn() ? performance.now() / 1000 / SHIMMER_PERIOD_S : -1;
    const buf = shimmerBufRef.current;
    // Gemessene Überdeckung (für das nächste Bild): Länge aller gezeichneten Fäden × Breite / Fläche.
    let lenSum = 0;
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    const stroke = (list: RenderLink[], color: string, width: number, skip?: Set<RenderLink>, shimmerColor?: string, measure = false) => {
      if (list.length === 0) return;
      ctx.beginPath();
      const heads: RenderLink[] = [];
      let sn = 0;
      for (const l of list) {
        if (skip?.has(l)) continue;
        const a = l.source;
        const b = l.target;
        const ax = a.x;
        const ay = a.y;
        const bx = b.x;
        const by = b.y;
        if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;
        if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (ay < y0 && by < y0) || (ay > y1 && by > y1)) continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        if (arrows) heads.push(l);
        if (measure) {
          lenSum += Math.abs(bx - ax) + Math.abs(by - ay);
          if (ax < bx0) bx0 = ax;
          if (ax > bx1) bx1 = ax;
          if (ay < by0) by0 = ay;
          if (ay > by1) by1 = ay;
        }
        if (shimmerColor) {
          // Schimmer: ein kurzer heller Abschnitt wandert den Faden entlang (nur ein Teil der Fäden).
          const seed = l.shimmerSeed ?? 1;
          if (shimmerPhase >= 0 && seed < SHIMMER_SHARE && sn + 4 <= buf.length) {
            const pos = ((shimmerPhase + seed * 7.31) % 1) * 1.4 - 0.2;
            const s0 = Math.max(0, pos - SHIMMER_LEN / 2);
            const s1 = Math.min(1, pos + SHIMMER_LEN / 2);
            if (s1 > s0) {
              buf[sn++] = ax + (bx - ax) * s0;
              buf[sn++] = ay + (by - ay) * s0;
              buf[sn++] = ax + (bx - ax) * s1;
              buf[sn++] = ay + (by - ay) * s1;
            }
          }
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width / k;
      ctx.stroke();
      if (shimmerColor && sn > 0) {
        ctx.beginPath();
        for (let i = 0; i < sn; i += 4) {
          ctx.moveTo(buf[i] ?? 0, buf[i + 1] ?? 0);
          ctx.lineTo(buf[i + 2] ?? 0, buf[i + 3] ?? 0);
        }
        ctx.strokeStyle = shimmerColor;
        ctx.stroke();
      }
      if (heads.length === 0) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      let inPath = 0;
      for (const l of heads) {
        // Große Pfade in Stücken füllen (ein Riesen-Pfad ist für den Rasterer viel teurer).
        if (inPath >= ARROW_BATCH) {
          ctx.fill();
          ctx.beginPath();
          inPath = 0;
        }
        inPath += 1;
        const ax = l.source.x ?? 0;
        const ay = l.source.y ?? 0;
        const bx = l.target.x ?? 0;
        const by = l.target.y ?? 0;
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        const r = nodeRadius(l.target, settings.nodeSize);
        const tx = bx - ux * r;
        const ty = by - uy * r;
        const bxh = tx - ux * arrowLen;
        const byh = ty - uy * arrowLen;
        ctx.moveTo(tx, ty);
        ctx.lineTo(bxh - uy * arrowLen * 0.4, byh + ux * arrowLen * 0.4);
        ctx.lineTo(bxh + uy * arrowLen * 0.4, byh - ux * arrowLen * 0.4);
        ctx.closePath();
      }
      ctx.fill();
    };
    const width = EDGE_WIDTH_PX * Math.max(0.2, settings.linkWidth);
    const fade = hoverOn ? 1 - 0.8 * h.t : 1;
    const nearGlow = hoverOn ? 0 : p.near;
    for (const bucket of linkBucketsRef.current) {
      const color = mix(bucket.color, EDGE_NEUTRAL_HEX, p.neutral);
      // Nah: zarter Schein unter dem Faden (breiter, sehr blass).
      if (nearGlow > 0.05) stroke(bucket.base, rgba(color, p.alpha * EDGE_GLOW_ALPHA_2D * nearGlow), width + EDGE_GLOW_WIDTH_PX, h.links);
      stroke(bucket.dim, rgba(color, p.alpha * 0.35 * fade), width, hoverOn ? h.links : undefined, undefined, !hoverOn);
      stroke(bucket.base, rgba(color, p.alpha * fade), width, hoverOn ? h.links : undefined, hoverOn ? undefined : rgba(mix(color, TOKENS.ink, 0.5), Math.min(1, p.alpha * 2.4)), !hoverOn);
    }
    if (hoverOn) stroke([...h.links], p.hi, settings.linkWidth * 1.2);
    else if (lenSum > 0 && bx1 > bx0) {
      // Fläche der gezeichneten Wolke (Ellipse in der Box, auf den Ausschnitt begrenzt), in Bildschirm-px.
      const w = (Math.min(bx1, x1) - Math.max(bx0, x0)) * k;
      const hh = (Math.min(by1, y1) - Math.max(by0, y0)) * k;
      const area = Math.max(1, (Math.PI / 4) * Math.max(1, w) * Math.max(1, hh));
      // Summe |dx|+|dy| überschätzt die Länge um ~27 % im Mittel → × 0,79.
      overlapRef.current = (lenSum * 0.79 * k * width) / area;
    }
  }

  /** Sichtbare Kanten (nach Filter), einmal je Filter-/Daten-/Farbstand statt je Bild berechnet — und
   * je Farbe gebündelt: Farbe des wichtigeren Endes (mehr Verbindungen), also der Farbe seines Clusters. */
  function refreshVisibleLinks() {
    const { view, settings } = propsRef.current;
    const split = splitLinks(view, linksRef.current);
    visLinksRef.current = split;
    const byColor = new Map<string, { color: string; base: RenderLink[]; dim: RenderLink[] }>();
    const put = (l: RenderLink, dim: boolean) => {
      const hub = l.source.degree >= l.target.degree ? l.source : l.target;
      const color = nodeColor(hub, settings.colorByType, settings.colors);
      let b = byColor.get(color);
      if (!b) {
        b = { color, base: [], dim: [] };
        byColor.set(color, b);
      }
      (dim ? b.dim : b.base).push(l);
    };
    for (const l of split.base) put(l, false);
    for (const l of split.dim) put(l, true);
    linkBucketsRef.current = [...byColor.values()];
  }

  /** Schimmer nur, wenn sich etwas bewegen darf (Schweben an, System nicht auf „Bewegung reduzieren“). */
  function shimmerOn(): boolean {
    if ((propsRef.current.settings.forces.drift ?? 0) <= 0) return false;
    return !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // --- Knoten + Beschriftungen in einem Durchgang zeichnen ---------------------------------------
  function paintNodes(ctx: CanvasRenderingContext2D, k: number) {
    const { view, settings, selectedId, centerId, compact } = propsRef.current;
    const h = hoverRef.current;
    const ease = h.t * h.t * (3 - 2 * h.t);
    const hoverOn = h.node !== null && ease > 0;
    const lod = lodRef.current;
    const m = ctx.getTransform();
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const x0 = -m.e / m.a;
    const y0 = -m.f / m.d;
    const x1 = (cw - m.e) / m.a;
    const y1 = (ch - m.f) / m.d;
    // Punkte nie kleiner als 2 px Durchmesser (vorher 1,3 px — von weitem verschwanden sie).
    const minR = MIN_CORE_RADIUS_PX / k;
    const buckets = new Map<string, SimNode[]>();
    const glows = new Map<string, SimNode[]>();

    for (const n of nodesRef.current) {
      if (view.hidden.has(n.id) || n.x === undefined || n.y === undefined) continue;
      const r = Math.max(minR, nodeRadius(n, settings.nodeSize));
      if (n.x + r < x0 || n.x - r > x1 || n.y + r < y0 || n.y - r > y1) continue;
      const base = nodeColor(n, settings.colorByType, settings.colors);
      let color = base;
      // Nicht erstellte Notizen blasser (wie Obsidian), ausgegraute Gruppen deutlich zurück.
      let alpha = view.dimmed.has(n.id) ? 0.2 : n.state === "unresolved" ? 0.6 : 1;
      // Von weitem werden unwichtige Punkte leicht entsättigt — die Knotenpunkte tragen die Farbe, die
      // Masse wird ruhiger. In 2D nur halb so stark wie im 3D und ohne Abdunkeln (fast alles ist „unwichtig“,
      // sonst verlöre der ganze Graph an Kontrast).
      const minor = lod.far * (1 - nodeImportance(n.degree));
      if (minor > 0.03) color = mix(base, TOKENS.idle, FAR_DESATURATE_2D * minor);
      if (hoverOn) {
        if (n.id === h.node?.id) color = mix(base, TOKENS.ink, 0.4 * ease);
        else if (h.set.has(n.id)) color = mix(base, TOKENS.ink, 0.25 * ease);
        else alpha *= 1 - 0.8 * ease;
      }
      const key = rgba(color, alpha);
      const list = buckets.get(key);
      if (list) list.push(n);
      else buckets.set(key, [n]);
      // Statt eines weichen Hofs (2,3 × Radius, 16 %) nur ein enger Schein von höchstens 1,5 px um
      // größere Punkte, von weitem aus (eine Outline mit niedriger Deckkraft bringt nichts).
      const g = settings.glow && alpha > 0.3 ? glowAmount(lod, r * k) : 0;
      if (g > 0.05) {
        const gk = rgba(color, alpha * GLOW_RING_ALPHA * g);
        const gl = glows.get(gk);
        if (gl) gl.push(n);
        else glows.set(gk, [n]);
      }
    }

    const ring = GLOW_RING_PX / k;
    for (const [fill, list] of glows) {
      ctx.beginPath();
      for (const n of list) {
        const r = Math.max(minR, nodeRadius(n, settings.nodeSize)) + ring;
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = fill;
      ctx.fill();
    }

    for (const [fill, list] of buckets) {
      ctx.beginPath();
      for (const n of list) {
        const r = Math.max(minR, nodeRadius(n, settings.nodeSize));
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = fill;
      ctx.fill();
    }

    // Ringe: Auswahl, Mittelpunkt (lokaler Graph), Suchtreffer
    const ringAt = (n: SimNode | undefined, color: string, width: number) => {
      if (!n || n.x === undefined || n.y === undefined || view.hidden.has(n.id)) return;
      const r = Math.max(minR, nodeRadius(n, settings.nodeSize)) + 2.5 / k;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = width / k;
      ctx.stroke();
    };
    const byId = (id: string | null | undefined) => (id ? nodesRef.current[indexRef.current.get(id) ?? -1] : undefined);
    if (view.matches && view.matches.size <= 600) for (const id of view.matches) ringAt(byId(id), rgba(TOKENS.acc, 0.75), 1.2);
    ringAt(byId(centerId), TOKENS.acc, 1.6);
    ringAt(byId(selectedId), TOKENS.ink, 1.6);

    // Beschriftungen: ab Zoom-Schwelle (weich eingeblendet), bei Hover für die Nachbarschaft.
    const zoomAlpha = Math.max(0, Math.min(1, (k - settings.labelZoom) / (settings.labelZoom * 0.5)));
    const fontPx = compact ? 10 : 11.5;
    ctx.font = `${fontPx / k}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // Beschriftungen ohne Überlappung (gierig nach Wichtigkeit: Hover-Knoten, Auswahl, Nachbarn,
    // dann nach Grad). Kollisionsprüfung in Weltkoordinaten, Rechtecke je Bild neu.
    const placed: Array<[number, number, number, number]> = [];
    const done = new Set<string>();
    const lineH = (fontPx + 2) / k;
    const drawLabel = (n: SimNode, alpha: number) => {
      if (done.has(n.id) || alpha <= 0.02 || n.x === undefined || n.y === undefined) return;
      const r = Math.max(minR, nodeRadius(n, settings.nodeSize));
      const text = n.label.length > 42 ? `${n.label.slice(0, 40)}…` : n.label;
      const w = textWidth(ctx, text, fontPx / k);
      const x0l = n.x - w / 2;
      const y0l = n.y + r + 2 / k;
      for (const [px, py, pw, ph] of placed) if (x0l < px + pw && x0l + w > px && y0l < py + ph && y0l + lineH > py) return;
      placed.push([x0l, y0l, w, lineH]);
      done.add(n.id);
      ctx.fillStyle = rgba(TOKENS.ink, alpha);
      ctx.fillText(text, n.x, y0l);
    };
    const hoverNode = hoverOn ? byId(h.node?.id) : undefined;
    if (hoverNode) drawLabel(hoverNode, Math.max(ease, zoomAlpha * 0.82));
    const sel = byId(selectedId);
    if (sel && !view.hidden.has(sel.id)) drawLabel(sel, 1);
    if (hoverOn) {
      // Bei Knotenpunkten mit Hunderten Nachbarn nur die wichtigsten beschriften (sonst Textbrei).
      const neighbours = [...h.set]
        .map((id) => byId(id))
        .filter((n): n is SimNode => n !== undefined && !view.hidden.has(n.id))
        .sort((a, b) => b.degree - a.degree)
        .slice(0, MAX_HOVER_LABELS);
      for (const n of neighbours) drawLabel(n, Math.max(ease * 0.9, zoomAlpha * 0.82));
    }
    if (zoomAlpha > 0) {
      // Nach Grad vorsortiert (einmal je Datenstand) statt je Bild alle sichtbaren Knoten zu sortieren.
      let tried = 0;
      for (const n of byDegreeRef.current) {
        if (tried >= MAX_LABELS) break;
        if (view.hidden.has(n.id) || n.x === undefined || n.y === undefined) continue;
        if (n.x < x0 || n.x > x1 || n.y < y0 || n.y > y1) continue;
        tried += 1;
        let a = zoomAlpha * (view.dimmed.has(n.id) ? 0.3 : 0.82);
        if (hoverOn && !h.set.has(n.id)) a *= 1 - 0.85 * ease;
        drawLabel(n, a);
      }
    }
  }

  // --- Datenstand geändert: Simulation neu füttern (Positionen bleiben) --------------------------
  useEffect(() => {
    const fg = fgRef.current;
    const sim = simRef.current;
    if (!fg || !sim) return;
    const { graph, persistKey, settings } = propsRef.current;
    const nodes = graph.nodes;
    const index = new Map<string, number>();
    nodes.forEach((n, i) => index.set(n.id, i));
    const cached = persistKey && nodesRef.current.length === 0 ? loadPositions(persistKey) : null;
    let known = 0;
    const xs = new Float32Array(nodes.length);
    const ys = new Float32Array(nodes.length);
    const degree = new Uint32Array(nodes.length);
    nodes.forEach((n, i) => {
      if ((n.x === undefined || n.y === undefined) && cached) {
        const p = cached.get(n.id);
        if (p) [n.x, n.y] = p;
      }
      const has = n.x !== undefined && n.y !== undefined && Number.isFinite(n.x) && Number.isFinite(n.y);
      if (has) known += 1;
      xs[i] = has ? (n.x as number) : Number.NaN;
      ys[i] = has ? (n.y as number) : Number.NaN;
      degree[i] = n.degree;
    });

    const renderLinks: RenderLink[] = [];
    const adjacency = new Map<string, RenderLink[]>();
    for (const l of graph.links) {
      const s = nodes[index.get(endpointId(l.source)) ?? -1];
      const t = nodes[index.get(endpointId(l.target)) ?? -1];
      if (!s || !t) continue;
      const rl = Object.assign(l, { source: s, target: t, shimmerSeed: seed01(`${s.id}|${t.id}`) }) as RenderLink;
      renderLinks.push(rl);
      for (const id of [s.id, t.id]) {
        const list = adjacency.get(id);
        if (list) list.push(rl);
        else adjacency.set(id, [rl]);
      }
    }
    const src = new Uint32Array(renderLinks.length);
    const dst = new Uint32Array(renderLinks.length);
    const weight = new Float32Array(renderLinks.length);
    renderLinks.forEach((l, i) => {
      src[i] = index.get(l.source.id) ?? 0;
      dst[i] = index.get(l.target.id) ?? 0;
      weight[i] = l.weight;
    });

    const firstLoad = nodesRef.current.length === 0;
    nodesRef.current = nodes;
    indexRef.current = index;
    adjacencyRef.current = adjacency;
    linksRef.current = renderLinks;
    refreshVisibleLinks();
    byDegreeRef.current = [...nodes].sort((a, b) => b.degree - a.degree);
    hoverRef.current = { node: null, set: new Set(), links: new Set(), t: 0, target: 0 };
    genRef.current += 1;
    if (firstLoad) {
      startRef.current = performance.now();
      firstStableRef.current = null;
    }
    const share = nodes.length === 0 ? 1 : known / nodes.length;
    // Großer Graph: nur beim ersten Laden einpassen. Lokaler Graph: bei jedem neuen Stand (Tiefe).
    fittedRef.current = !firstLoad && !propsRef.current.compact;
    if (propsRef.current.compact) userMovedRef.current = false;
    // force-graph bekommt keine Kanten: es rechnet und zeichnet sie nicht (das machen Worker bzw.
    // paintLinks) — sonst liefe es je Bild noch dreimal über ~23.000 Kanten.
    fg.graphData({ nodes, links: [] });
    // Bekannte Form: nur sanft nachjustieren. Neu: kurz im Worker vorrechnen, dann weich ausschwingen.
    // Live-Delta (neue Session o. Ä.): kaum anstoßen, damit nicht das ganze Gehirn wackelt.
    const alpha = share > 0.9 ? (firstLoad ? 0.12 : 0.06) : share > 0.3 ? 0.5 : 1;
    const warmupMs = share > 0.9 ? 0 : Math.min(700, 80 + nodes.length * 0.12);
    sim.post({ type: "init", gen: genRef.current, xs, ys, degree, src, dst, weight, forces: settings.forces, alpha, warmupMs }, [xs.buffer, ys.buffer, degree.buffer, src.buffer, dst.buffer, weight.buffer]);
    activeRef.current.sim = true;
    syncRedraw();
  }, [props.structureVersion]);

  // --- Einstellungen, die force-graph selbst betreffen --------------------------------------------
  useEffect(() => {
    requestRedraw();
  }, [props.settings.arrows]);

  // Beim ersten Rendern schickt `init` die Kräfte schon mit — nicht zusätzlich anheizen.
  // „Schweben“ (nur 3D) gehört nicht zur Physik und weckt 2D nicht.
  const forcesSeenRef = useRef(false);
  const forcesKey = physicsKey(props.settings.forces);
  useEffect(() => {
    if (!forcesSeenRef.current) {
      forcesSeenRef.current = true;
      return;
    }
    simRef.current?.post({ type: "forces", forces: propsRef.current.settings.forces });
    activeRef.current.sim = true;
    syncRedraw();
  }, [forcesKey]);

  // Sichtbarkeit/Größe/Farben: nur neu zeichnen (keine Simulation).
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.nodeVal(fg.nodeVal()); // Treffer-Radius neu (Knotengröße)
    refreshVisibleLinks();
    requestRedraw();
  }, [props.view, props.settings.nodeSize, props.settings.linkWidth, props.settings.colorByType, props.settings.colors, props.settings.glow, props.settings.labelZoom, props.selectedId, props.centerId]);

  // --- Messwerte für Playwright ------------------------------------------------------------------
  useEffect(() => {
    const key = props.exposePerf;
    if (!key) return;
    const perf = perfRef.current;
    window[key] = {
      get nodes() {
        return nodesRef.current.length;
      },
      get links() {
        return linksRef.current.length;
      },
      get visible() {
        return propsRef.current.view.visibleCount;
      },
      get alpha() {
        return perf.alpha;
      },
      get simTickMs() {
        return perf.simTickMs;
      },
      get simTicks() {
        return perf.simTicks;
      },
      get paintMsAvg() {
        return perf.paintMs.length ? perf.paintMs.reduce((a, b) => a + b, 0) / perf.paintMs.length : 0;
      },
      get firstStableMs() {
        return firstStableRef.current;
      },
      lod() {
        return { ...lodRef.current, edgeAlpha: paletteRef.current.alpha, overlap: overlapRef.current, zoom: fgRef.current?.zoom() ?? 1 };
      },
      screenPos(id: string) {
        const fg = fgRef.current;
        const n = nodesRef.current[indexRef.current.get(id) ?? -1];
        if (!fg || !n || n.x === undefined || n.y === undefined) return null;
        return fg.graph2ScreenCoords(n.x, n.y);
      },
      topNodes(count: number, type?: string) {
        return nodesRef.current
          .filter((n) => !propsRef.current.view.hidden.has(n.id) && (!type || n.type === type))
          .sort((a, b) => b.degree - a.degree)
          .slice(0, count)
          .map((n) => n.id);
      },
      async measure(ms: number) {
        activeRef.current.measure = true;
        syncRedraw();
        const startFrames = perf.frames;
        perf.paintMs = [];
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, ms));
        const frames = perf.frames - startFrames;
        const dur = performance.now() - t0;
        activeRef.current.measure = false;
        syncRedraw();
        const sorted = [...perf.paintMs].sort((a, b) => a - b);
        const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
        return { fps: Math.round((frames / dur) * 1000 * 10) / 10, paintMsAvg: Math.round(avg * 100) / 100, paintMsP95: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 100) / 100, frames };
      },
    };
  }, [props.exposePerf]);

  return <div ref={containerRef} className="absolute inset-0" data-testid="graph-canvas" />;
});
