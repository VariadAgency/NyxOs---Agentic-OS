// 3D-Gehirn ohne 3d-force-graph: eigener, schlanker three.js-Aufbau, damit ~6.500
// Knoten und ~23.000 Kanten flüssig laufen.
//
// - Alle Knoten sind EIN instanziertes Viereck-Objekt (vorher `Points`): runder Kern + weicher
//   Hof im Shader, ohne Größen-Deckel. Zwei Durchgänge: erst die deckenden Kerne mit Tiefe, dann der
//   durchscheinende Schein — so scheint hinter einem nahen Knoten nichts mehr durch (`shaders3d.ts`).
// - Alle Kanten sind EIN `LineSegments`-Objekt über denselben Positionen (Index) — je Simulationsschritt
//   wird nur der Positions-Puffer ausgetauscht, sonst nichts.
// - Die Physik rechnet im Web-Worker (`sim3d.worker.ts`), Positionen kommen als Float32Array. Die
//   Regler „Kräfte“ gehen per `setForces` in den Worker.
// - Treffer (Hover/Klick) und Beschriftungen per Projektion auf den Bildschirm (ein Durchlauf über
//   die Knoten), Beschriftungen nur für nahe, gewählte und Hover-Nachbarn (Detailstufen).
// - Gezeichnet wird nur, wenn sich etwas bewegt (Simulation, Kamera, Tasten, Übergang, Impuls). Das
//   Schweben (leichte Eigenbewegung) läuft im Shader und zeichnet in Ruhe nur ~30-mal je Sekunde.
// - Steuerung (`cameraInput.ts` + `cameraRig.ts`): Trackpad zwei Finger = drehen (Shift:
//   schwenken), Kneifen = Zoom zum Mauspunkt; Maus links = drehen, rechts/Shift = schwenken, Rad =
//   Zoom zum Mauspunkt; alles weich mit Schwung. Doppelklick = zum Knoten fliegen, F = alles zeigen,
//   V = Fliegen (Maus schaut, WASD/Pfeile bewegen, Q/E runter/hoch, Shift schneller).
import {
  AddEquation,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DataTexture,
  DynamicDrawUsage,
  Euler,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  Matrix4,
  Mesh,
  NearestFilter,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Sphere,
  SrcAlphaFactor,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { accelCurve, classifyWheel, keyAction, LOOK_PER_PX, MOVE_KEYS, pointerAction, ROTATE_PER_PX, rotationPivot, trackpadRotation, wheelAction, type DragAction, type WheelMemory } from "./cameraInput";
import { OrbitRig } from "./cameraRig";
import { hexToRgb, mix, nodeColor, TOKENS } from "./colors";
import { robustBounds, viewShiftFor, type Rect } from "./fitArea";
import { endpointId, type GraphView } from "./filter";
import { DEFAULT_FORCES, physicsKey, type Forces } from "./forces";
import type { SimLink, SimNode } from "./graphData";
import { rayPlaneHit } from "./nodeDrag";
import { HI_MAX_EDGES, highlightColors, highlightCrowdFactor, planHighlight } from "./highlight";
import { hopArrival, hopGain, planPulse } from "./pulse";
import type { BrainSettings } from "./settings";
import { edgeAlpha, edgeNeutralMix, edgeOverlap, edgeWidthDevicePx, GLOW_SPAN, lod3d, nodeImportance, nodeWorldRadius, orientationLabels, type Lod } from "./lod";
import {
  animatePosInto,
  EDGE_FEATHER_PX,
  EDGE_FRAGMENT,
  EDGE_VERTEX,
  focusDistance,
  minSpritePx,
  NODE_CORE_FRAGMENT,
  NODE_GLOW_FRAGMENT,
  NODE_VERTEX,
  MIN_CORE_PX,
  pickRadiusPx,
  PULSE_HEAD_FRAGMENT,
  PULSE_HEAD_VERTEX,
  PULSE_LINE_FRAGMENT,
  PULSE_LINE_VERTEX,
  PULSE_ADDITIVE,
  motionParams,
  SELECT_REST_ALPHA,
  spriteLook,
  unanimatePos,
  type Motion,
} from "./shaders3d";
import { createSim3dHost, type FromSim3d, type ToSim3d } from "./sim3d";

export type Control3D = "orbit" | "fly";

export interface Scene3DCallbacks {
  onSelect(node: SimNode | null): void;
  onOpen(node: SimNode): void;
  /** Steuerung per Taste „V" umgeschaltet. */
  onControlChange?(mode: Control3D): void;
  /** Erste Positionen sind da (Aufbau-Hinweis ausblenden). */
  onReady?(): void;
}

export interface Brain3DPerf {
  nodes: number;
  visible: number;
  simRunning: boolean;
  /** ms vom Einlesen bis zum ersten Bild mit Positionen. */
  firstFrameMs: number | null;
  control: Control3D;
  /** Zuletzt an den Worker geschickte Kräfte (Nachweis der Verdrahtung). */
  forces: Forces;
  /** Läuft gerade eine Lichtimpuls-Welle? Wie viele Impulse? */
  pulse: { active: boolean; edges: number; nodes: number };
  /** Hervorgehobene Kanten der Auswahl (höchstens 60), alle sichtbaren Kanten des Knotens, Deckkraft. */
  highlight: { edges: number; total: number; opacity: number };
  measure(ms: number): Promise<{ fps: number; frames: number; renderMsAvg: number; renderMsP95: number }>;
  screenPos(id: string): { x: number; y: number } | null;
  nodePos(id: string): [number, number, number] | null;
  /** Bild-Durchmesser (CSS-px) und Deckkraft, wie der Shader sie rechnet. */
  nodeLook(id: string): { diameterPx: number; alpha: number } | null;
  topNodes(n: number): string[];
  cameraDistance(): number;
  /** Abstand Kamera → Blickpunkt (beim Drehen gleich, beim Zoomen anders). */
  viewDistance(): number;
  /** Kamera ohne Übergang in `dist` vor einen Knoten setzen (Tests/Beweisbilder). */
  placeNear(id: string, dist: number): void;
  /** Bild-Versatz (CSS-px) jetzt und Ziel, Drehpunkt und Mitte der Wolke (Nachweis „Globus“). */
  viewShift(): { x: number; y: number; gx: number; gy: number };
  pivot(): { target: [number, number, number]; center: [number, number, number] };
  /** Aktuelle Renderstufe (fern/mitte/nah) und Deckkraft der Fäden. */
  lod(): Lod & { edgeAlpha: number };
}

declare global {
  interface Window {
    __brain3dPerf?: Brain3DPerf;
  }
}

/** Safari unter macOS meldet Kneifen als GestureEvent (nicht als Rad mit ctrlKey). */
interface GestureLike extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

export const POSITIONS_3D_KEY = "nyxos.brain.positions3d.v1";
const FOV = 50;
const CLICK_SLOP_PX = 5;
const LABEL_MIN_PX = 4.2;
const MAX_NEAR_LABELS = 42;
const MAX_HOVER_LABELS = 24;
// Deckkraft der Fäden kommt aus der Renderstufe (`edgeAlpha`, nie unter der Untergrenze); beim
// Zeigen bzw. bei einer Auswahl werden die übrigen nur anteilig zurückgenommen (nicht weg).
const LINE_FACTOR_HOVER = 0.3;
const LINE_FACTOR_SELECT = 0.55;
/** Hervorgehobene Kanten (Auswahl/Hover); Menge, 1/√n und Farbe regelt highlight.ts. */
const HI_LINE_OPACITY = 0.62;
/** Hervorgehobene Fäden etwas breiter als die übrigen (Faktor auf die Breite). */
const HI_LINE_WIDTH = 1.6;
/** Breite der Positions-Textur für die Fäden (Texel je Zeile). */
const POS_TEX_W = 256;
/** Wie oft die robuste Mitte/der Radius für die Renderstufe höchstens neu gerechnet wird (ms). */
const LOD_BOUNDS_MS = 1500;
/** Ausgegraute Gruppen (vorher 0,14 — auf Schwarz fast unsichtbar) und unaufgelöste Links. */
const DIMMED_ALPHA = 0.3;
const UNRESOLVED_ALPHA = 0.75;
/** Wie schnell Drehpunkt und Bild-Versatz nachgleiten (1/s). */
const CENTER_RATE = 2.5;
const SHIFT_RATE = 6;
/** Robuste Mitte/Radius (Median = Sortieren) höchstens so oft neu rechnen, wenn je Bild gefragt wird (ms). */
const BOUNDS_MAX_AGE_MS = 250;
/** Wie schnell die Kamera beim Aufbau dem Sichtbaren folgt (1/s). */
const FOLLOW_RATE = 3;
/** Schwung beim Loslassen nur, wenn die letzte Bewegung so frisch ist (ms). */
const FLING_WINDOW_MS = 70;
/** Fliegen per Rad/Kneifen: Anschub und Abbremsen (1/s). */
const FLY_WHEEL = 2.2;
const FLY_DAMP = 6;
/** Schweben ohne andere Bewegung: so oft zeichnen (ms) — schont den Rechner. */
const IDLE_DRIFT_MS = 33;
const NO_FLASH = -1e4;

/** Gemerkte 3D-Positionen (über Umschalten und Besuche hinweg). */
const mem3d = new Map<string, [number, number, number]>();
let mem3dLoaded = false;
function load3d(): Map<string, [number, number, number]> {
  if (mem3dLoaded) return mem3d;
  mem3dLoaded = true;
  try {
    const raw = window.localStorage.getItem(POSITIONS_3D_KEY);
    if (raw) for (const [id, p] of Object.entries(JSON.parse(raw) as Record<string, [number, number, number]>)) mem3d.set(id, p);
  } catch {
    // kaputt oder gesperrt: dann eben neu aufbauen
  }
  return mem3d;
}
function save3d(nodes: SimNode[], pos: Float32Array): void {
  const out: Record<string, [number, number, number]> = {};
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const x = pos[i * 3] ?? Number.NaN;
    const y = pos[i * 3 + 1] ?? Number.NaN;
    const z = pos[i * 3 + 2] ?? Number.NaN;
    if (!n || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const p: [number, number, number] = [Math.round(x), Math.round(y), Math.round(z)];
    mem3d.set(n.id, p);
    out[n.id] = p;
  }
  try {
    window.localStorage.setItem(POSITIONS_3D_KEY, JSON.stringify(out));
  } catch {
    // Speicher voll: nächstes Mal neu aufbauen
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function createScene3D(
  host: HTMLElement,
  labelCanvas: HTMLCanvasElement,
  cb: Scene3DCallbacks,
  opts: { exposePerf?: boolean; /** Freie Fläche neben Kacheln (Pixel) fürs Einpassen. */ fitArea?: () => Rect | null } = {},
) {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(TOKENS.bg, 1);
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";
  host.prepend(canvas);
  const lctx = labelCanvas.getContext("2d");

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 1e6);
  camera.position.set(0, 0, 1400);
  const rig = new OrbitRig({ minRadius: 4, maxRadius: 2e5 });
  rig.jumpTo(camera.position, new Vector3());

  // Gemeinsame Uniforms (Zeit + Schweben gelten für Knoten, Kanten und Impulse gleich).
  // „Bewegung reduzieren“ (System) schaltet die Eigenbewegung ganz ab.
  const reducedMotionQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  let motion: Motion = motionParams(DEFAULT_FORCES.drift, reducedMotionQuery?.matches ?? false);
  const shared = { uTime: { value: 0 }, uDrift: { value: motion.drift }, uBreath: { value: motion.breath }, uSway: { value: motion.sway }, uCenter: { value: new Vector3() } };
  /** Mitte der Wolke (robust, geglättet) — Drehpunkt, Einpassen und Atmen/Wiegen beziehen sich darauf. */
  const center = new Vector3();
  const centerGoal = new Vector3();
  let centerAt = -1;
  const centerTuple: [number, number, number] = [0, 0, 0];
  /** Drehpunkt bleibt die Mitte, bis man selbst woanders hin will (Schieben, Knoten anfliegen). */
  let centerLock = true;
  /** Bild-Versatz (CSS-px) für die freie Fläche neben den Kacheln — statt eines seitlich verschobenen Drehziels. */
  const shift2d = { x: 0, y: 0, gx: 0, gy: 0, ax: Number.NaN, ay: Number.NaN };
  /** Gemerkte robuste Mitte/Radius (s. `visibleBounds`) und feste Vektoren fürs Folgen je Bild. */
  const boundsMemo = { c: new Vector3(), r: 0 };
  let boundsAt = -Infinity;
  let boundsHas = false;
  const followP = new Vector3();
  const followG = new Vector3();
  const nodeUniforms = {
    ...shared,
    uScale: { value: 400 },
    uMinPx: { value: minSpritePx(1 / GLOW_SPAN, dpr) },
    uDpr: { value: dpr },
    uViewport: { value: new Vector2(1, 1) },
    uCore: { value: 1 / GLOW_SPAN },
    uGlow: { value: 1 },
    /** Renderstufe „fern“ (0–1), je Bild aus der Bildgröße der Wolke (`lod3d`). */
    uFar: { value: 0 },
  };
  const coreMat = new ShaderMaterial({ vertexShader: NODE_VERTEX, fragmentShader: NODE_CORE_FRAGMENT, uniforms: nodeUniforms, depthWrite: true, depthTest: true });
  const glowMat = new ShaderMaterial({ vertexShader: NODE_VERTEX, fragmentShader: NODE_GLOW_FRAGMENT, uniforms: nodeUniforms, transparent: true, depthWrite: false, depthTest: true });
  // Kanten liegen wie bisher UNTER den Knoten: ohne Tiefentest, zuerst gezeichnet (eigene Mischung,
  // damit three sie in der deckenden Liste vor den Kernen zeichnet). Normal gemischt, nie additiv —
  // viele Fäden übereinander werden nicht zu Weiß.
  const lineBlend = { transparent: false, blending: CustomBlending, blendEquation: AddEquation, blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor, depthWrite: false, depthTest: false } as const;
  // Positions-Textur (xyz + Schweben-Samen) für die Fäden — je Physik-Schritt nur ~7.000 Texel neu.
  let posTex = makePosTexture(1);
  const edgeShared = { ...shared, uPos: { value: posTex }, uTexW: { value: POS_TEX_W }, uViewport: nodeUniforms.uViewport, uNear: { value: 1 }, uShimmer: { value: motion.drift > 0 ? 1 : 0 } };
  const lineOpacity = { value: edgeAlpha({ far: 0, near: 0 }) };
  const lineWidth = { value: edgeWidthDevicePx(1, dpr) };
  const lineNeutral = { value: edgeNeutralMix({ far: 0 }) };
  const featherPx = { value: EDGE_FEATHER_PX * dpr };
  const linesMat = new ShaderMaterial({ vertexShader: EDGE_VERTEX, fragmentShader: EDGE_FRAGMENT, uniforms: { ...edgeShared, uOpacity: lineOpacity, uWidth: lineWidth, uFeather: featherPx, uNeutral: lineNeutral }, ...lineBlend });
  // Linien des gewählten Knotens nur dezent heller (vorher 0,7 fast weiß — die Linien wurden grell).
  const hiOpacity = { value: HI_LINE_OPACITY };
  const hiWidth = { value: edgeWidthDevicePx(HI_LINE_WIDTH, dpr) };
  const hiMat = new ShaderMaterial({ vertexShader: EDGE_VERTEX, fragmentShader: EDGE_FRAGMENT, uniforms: { ...edgeShared, uOpacity: hiOpacity, uWidth: hiWidth, uFeather: featherPx, uNeutral: { value: 0.15 } }, ...lineBlend });
  const pulseUniforms = { ...shared, uStart: { value: NO_FLASH }, uScale: nodeUniforms.uScale, uDpr: nodeUniforms.uDpr };
  // Normal gemischt statt additiv — viele Impulse übereinander werden nicht grell weiß.
  const pulseBlend = PULSE_ADDITIVE ? { blending: AdditiveBlending } : { blending: CustomBlending, blendEquation: AddEquation, blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor };
  const pulseLineMat = new ShaderMaterial({ vertexShader: PULSE_LINE_VERTEX, fragmentShader: PULSE_LINE_FRAGMENT, uniforms: pulseUniforms, transparent: true, ...pulseBlend, depthWrite: false, depthTest: true });
  const pulseHeadMat = new ShaderMaterial({ vertexShader: PULSE_HEAD_VERTEX, fragmentShader: PULSE_HEAD_FRAGMENT, uniforms: pulseUniforms, transparent: true, ...pulseBlend, depthWrite: false, depthTest: true });

  let quad = new InstancedBufferGeometry();
  const edgeCorners = new BufferAttribute(new Float32Array([0, -1, 1, -1, 1, 1, 0, 1]), 2);
  let edges = makeEdgeLayer(0);
  const hiEdges = makeEdgeLayer(HI_MAX_EDGES);
  const lines = new Mesh(edges.geometry, linesMat);
  const hiLines = new Mesh(hiEdges.geometry, hiMat);
  const cores = new Mesh(quad, coreMat);
  const glows = new Mesh(quad, glowMat);
  const pulseLines = new LineSegments(new BufferGeometry(), pulseLineMat);
  const pulseHeads = new Points(new BufferGeometry(), pulseHeadMat);
  for (const [o, order] of [
    [lines, 0],
    [hiLines, 1],
    [cores, 2],
    [glows, 3],
    [pulseLines, 4],
    [pulseHeads, 5],
  ] as const) {
    o.frustumCulled = false;
    o.renderOrder = order;
    scene.add(o);
  }
  pulseLines.visible = false;
  pulseHeads.visible = false;

  /** Positions-Textur für `n` Knoten (RGBA32F, Breite POS_TEX_W, nächster Nachbar — exakte Texel). */
  function makePosTexture(n: number): DataTexture {
    const h = Math.max(1, Math.ceil(n / POS_TEX_W));
    const t = new DataTexture(new Float32Array(POS_TEX_W * h * 4), POS_TEX_W, h, RGBAFormat, FloatType);
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  /** Fäden als Instanzen (je Kante: zwei Knoten-Nummern + Farbe beider Enden), Platz für `cap` Kanten. */
  function makeEdgeLayer(cap: number) {
    const c = Math.max(1, cap);
    const a = new InstancedBufferAttribute(new Float32Array(c), 1).setUsage(DynamicDrawUsage);
    const b = new InstancedBufferAttribute(new Float32Array(c), 1).setUsage(DynamicDrawUsage);
    const colA = new InstancedBufferAttribute(new Float32Array(c * 3), 3).setUsage(DynamicDrawUsage);
    const colB = new InstancedBufferAttribute(new Float32Array(c * 3), 3).setUsage(DynamicDrawUsage);
    const g = new InstancedBufferGeometry();
    g.setAttribute("corner", edgeCorners);
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute("iA", a);
    g.setAttribute("iB", b);
    g.setAttribute("iColA", colA);
    g.setAttribute("iColB", colB);
    g.instanceCount = 0;
    g.boundingSphere = new Sphere(new Vector3(), 1e7);
    const arr = { a: a.array as Float32Array, b: b.array as Float32Array, colA: colA.array as Float32Array, colB: colB.array as Float32Array };
    return {
      geometry: g,
      arr,
      /** Nach dem Füllen: `m` Kanten zeichnen und die Puffer neu hochladen. */
      commit(m: number) {
        g.instanceCount = m;
        a.needsUpdate = true;
        b.needsUpdate = true;
        colA.needsUpdate = true;
        colB.needsUpdate = true;
      },
    };
  }
  // --- Daten ---------------------------------------------------------------------------------------
  let nodes: SimNode[] = [];
  let index = new Map<string, number>();
  let linkS = new Uint32Array(0);
  let linkT = new Uint32Array(0);
  let adj: number[][] = [];
  let byDegree: number[] = [];
  let pos = new Float32Array(0);
  let seeds = new Float32Array(0);
  let lastInit = new Float32Array(0);
  // Knoten-Vierecke lesen die Positionen als Instanz-Attribut, die Fäden aus der Positions-Textur.
  let iPosAttr = new InstancedBufferAttribute(pos, 3);
  let iColAttr = new InstancedBufferAttribute(new Float32Array(0), 3);
  let sizeAttr = new InstancedBufferAttribute(new Float32Array(0), 1);
  let alphaAttr = new InstancedBufferAttribute(new Float32Array(0), 1);
  let flashAttr = new InstancedBufferAttribute(new Float32Array(0), 1);
  let flashGainAttr = new InstancedBufferAttribute(new Float32Array(0), 1);
  let impAttr = new InstancedBufferAttribute(new Float32Array(0), 1);
  /** Hervorgehobene Kanten: Fokus-Knoten → Nachbar (höchstens HI_MAX_EDGES, s. highlight.ts). */
  let hiFrom: Uint32Array = new Uint32Array(0);
  let hiTo: Uint32Array = new Uint32Array(0);
  let hiTotal = 0;
  /** Farben der hervorgehobenen Fäden (beide Enden, fester Puffer — kein Speicher je Hover). */
  const hiColors = new Float32Array(HI_MAX_EDGES * 6);
  /** Faktor auf die Faden-Deckkraft je Zustand (Zeigen/Auswahl nehmen den Rest zurück). */
  let lineFactor = 1;
  /** Aktuelle Renderstufe (je Bild aus der Bildgröße der Wolke). */
  let lod: Lod = lod3d(1);
  /** Kern-Radius je Knoten (Weltmaß) für Treffer und Beschriftung. */
  let coreR = new Float32Array(0);
  let hiddenMask = new Uint8Array(0);
  let hasPos = false;
  const corners = new BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2);

  function markPositions() {
    iPosAttr.needsUpdate = true;
    syncPosTexture();
  }

  /** Positionen (+ Schweben-Samen) in die Textur der Fäden — alle Fäden, auch die hervorgehobenen, lesen daraus. */
  function syncPosTexture() {
    const d = posTex.image.data as Float32Array;
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      d[i * 4] = pos[i * 3] ?? 0;
      d[i * 4 + 1] = pos[i * 3 + 1] ?? 0;
      d[i * 4 + 2] = pos[i * 3 + 2] ?? 0;
      d[i * 4 + 3] = seeds[i] ?? 0;
    }
    posTex.needsUpdate = true;
  }

  // --- Aussehen -------------------------------------------------------------------------------------
  let look: { view: GraphView; settings: BrainSettings; selectedId: string | null } | null = null;
  let hover = -1;
  let hoverSet = new Set<number>();
  let selected = -1;
  let forces: Forces = { ...DEFAULT_FORCES };

  // --- Laufzeit -------------------------------------------------------------------------------------
  let active = true;
  let raf = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastT = 0;
  const t0 = performance.now();
  let control: Control3D = "orbit";
  let yaw = 0;
  let pitch = 0;
  const keys = new Set<string>();
  let shift = false;
  /** Worauf die Kamera gerade schaut (Übergänge, Aufbau-Folgen, Flug-Modus). */
  const lookTarget = new Vector3();
  let tween: { t0: number; ms: number; p0: Vector3; p1: Vector3; g0: Vector3; g1: Vector3 } | null = null;
  const flyVel = new Vector3();
  let userMoved = false;
  let fitted = false;
  let simRunning = false;
  let gen = 0;
  let measuring = false;
  let pendingPick: { x: number; y: number } | null = null;
  let cssW = 1;
  let cssH = 1;
  let sceneRadius = 400;
  let firstFrameMs: number | null = null;
  let dataT0 = 0;
  let pulse: { end: number; from: Uint32Array; to: Uint32Array; nodes: number } | null = null;
  /** Knoten wird gezogen: welcher, und Abstand Griffpunkt → Knotenmitte (Weltmaß, gezeichnete Lage),
   *  und wo er in der Physik festgehalten wird. */
  let grab: { i: number; offset: Vector3; at: [number, number, number] } | null = null;
  const perf = { frames: 0, renderMs: [] as number[] };
  const tmpM = new Matrix4();
  const v1 = new Vector3();
  const v2 = new Vector3();
  const up = new Vector3(0, 1, 0);

  const now = () => (performance.now() - t0) / 1000;
  /** Bewegt sich etwas von selbst (Schweben/Atmen/Wiegen)? Dann zeichnet die Ruhe-Schleife weiter. */
  const moving = () => motion.drift > 0 || motion.breath > 0 || motion.sway > 0;
  function applyMotion() {
    motion = motionParams(forces.drift, reducedMotionQuery?.matches ?? false);
    shared.uDrift.value = motion.drift;
    shared.uBreath.value = motion.breath;
    shared.uSway.value = motion.sway;
    motion.center = centerTuple;
    // Schimmer der Fäden nur, wenn sich überhaupt etwas bewegen darf (still = still, auch bei „Bewegung reduzieren“).
    edgeShared.uShimmer.value = moving() ? 1 : 0;
  }

  /**
   * Renderstufe aus der Bildgröße der Wolke (Radius / halbe Bildhöhe) — fern: kein Schein, unwichtige
   * Punkte blasser, Fäden mit Untergrenze; nah: volle Details. Weich übergeblendet, je Bild ohne Speicher.
   */
  function updateLod() {
    const b = hasPos ? visibleBounds(LOD_BOUNDS_MS) : null;
    const r = b ? b.r : sceneRadius;
    const d = Math.max(1e-3, camera.position.distanceTo(b ? b.c : center));
    const frac = r / (d * Math.tan(((FOV / 2) * Math.PI) / 180));
    lod = lod3d(frac);
    nodeUniforms.uFar.value = lod.far;
    const overlap = edgeOverlap(edges.geometry.instanceCount, lineWidth.value / dpr, frac * cssH * 0.5);
    lineOpacity.value = edgeAlpha(lod, overlap) * lineFactor;
    lineNeutral.value = edgeNeutralMix(lod);
  }

  // --- Simulation im Worker ------------------------------------------------------------------------
  const sim = (() => {
    const onMessage = (m: FromSim3d) => {
      if (m.gen !== gen) return;
      if (m.type === "settled") {
        simRunning = false;
        save3d(nodes, pos);
        if (!userMoved) fit(700);
        request();
        return;
      }
      if (m.pos.length === pos.length) {
        pos.set(m.pos);
        // Gezogener Knoten: die Maus hat Vorrang vor einem Schritt, den der Worker noch ohne sie rechnete.
        if (grab) pos.set(grab.at, grab.i * 3);
        markPositions();
      }
      simRunning = true;
      if (!hasPos) {
        hasPos = true;
        firstFrameMs ??= Math.round(performance.now() - dataT0);
        cb.onReady?.();
      }
      if (!fitted) {
        fitted = true;
        fit(0);
      }
      request();
    };
    if (typeof Worker !== "undefined") {
      try {
        const w = new Worker(new URL("./sim3d.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent<FromSim3d>) => onMessage(e.data);
        return { post: (m: ToSim3d, t: Transferable[] = []) => w.postMessage(m, t), close: () => w.terminate() };
      } catch {
        // Rückfall unten
      }
    }
    const handle = createSim3dHost((m) => onMessage(m));
    return { post: (m: ToSim3d) => handle(m), close: () => handle({ type: "stop" }) };
  })();

  function setData(graphNodes: SimNode[], graphLinks: SimLink[]) {
    // Neue Daten = neue Simulation und neue Nummern: ein laufendes Ziehen endet hier (sonst hinge es am falschen Knoten).
    grab = null;
    if (down?.action === "node") down = null;
    const prevIndex = index;
    // Solange noch keine Positionen aus der Simulation da sind, zählen nur die echten Startwerte (NaN = unbekannt).
    const prevPos = hasPos ? pos : lastInit;
    const cache = load3d();
    const firstLoad = nodes.length === 0;
    nodes = graphNodes;
    const n = nodes.length;
    index = new Map(nodes.map((node, i) => [node.id, i]));
    pos = new Float32Array(n * 3);
    let known = 0;
    let from2d = 0;
    // Grobe Größe der 2D-Form (für den Start aus 2D, z flach gestreut).
    let spread2d = 1;
    for (const node of nodes) if (node.x !== undefined && node.y !== undefined) spread2d = Math.max(spread2d, Math.abs(node.x), Math.abs(node.y));
    const scale2d = Math.min(1, 700 / spread2d);
    nodes.forEach((node, i) => {
      const pi = prevIndex.get(node.id);
      let p: [number, number, number] | undefined;
      if (pi !== undefined) p = [prevPos[pi * 3] ?? Number.NaN, prevPos[pi * 3 + 1] ?? Number.NaN, prevPos[pi * 3 + 2] ?? Number.NaN];
      if (!p || !p.every(Number.isFinite)) p = cache.get(node.id);
      if (p && p.every(Number.isFinite)) {
        known += 1;
        pos.set(p, i * 3);
      } else if (node.x !== undefined && node.y !== undefined && Number.isFinite(node.x) && Number.isFinite(node.y)) {
        pos.set([node.x * scale2d, node.y * scale2d, ((hash(node.id) % 1000) / 1000 - 0.5) * 300], i * 3);
        from2d += 1;
      } else pos.set([Number.NaN, Number.NaN, Number.NaN], i * 3);
    });
    const src: number[] = [];
    const dst: number[] = [];
    const weight: number[] = [];
    adj = Array.from({ length: n }, () => []);
    for (const l of graphLinks) {
      const a = index.get(endpointId(l.source));
      const b = index.get(endpointId(l.target));
      if (a === undefined || b === undefined || a === b) continue;
      adj[a]?.push(src.length);
      adj[b]?.push(src.length);
      src.push(a);
      dst.push(b);
      weight.push(l.weight);
    }
    linkS = Uint32Array.from(src);
    linkT = Uint32Array.from(dst);
    byDegree = nodes.map((_, i) => i).sort((a, b) => (nodes[b]?.degree ?? 0) - (nodes[a]?.degree ?? 0));
    seeds = Float32Array.from(nodes, (node) => (hash(node.id) % 10007) / 10007);

    // Puffer neu (Größe ändert sich). Die hervorgehobenen Fäden behalten ihre (kleinen) Puffer.
    edges.geometry.dispose();
    stopPulse();
    // Worker bekommt NaN für Unbekannte (legt sie selbst an), der Puffer zum Zeichnen 0.
    const initPos = pos.slice();
    lastInit = pos.slice();
    for (let i = 0; i < n * 3; i++) if (!Number.isFinite(pos[i] ?? Number.NaN)) pos[i] = 0;
    const col = new Float32Array(n * 3);
    iPosAttr = new InstancedBufferAttribute(pos, 3).setUsage(DynamicDrawUsage);
    iColAttr = new InstancedBufferAttribute(col, 3).setUsage(DynamicDrawUsage);
    sizeAttr = new InstancedBufferAttribute(new Float32Array(n), 1).setUsage(DynamicDrawUsage);
    alphaAttr = new InstancedBufferAttribute(new Float32Array(n), 1).setUsage(DynamicDrawUsage);
    flashAttr = new InstancedBufferAttribute(new Float32Array(n).fill(NO_FLASH), 1).setUsage(DynamicDrawUsage);
    flashGainAttr = new InstancedBufferAttribute(new Float32Array(n).fill(1), 1).setUsage(DynamicDrawUsage);
    impAttr = new InstancedBufferAttribute(Float32Array.from(nodes, (node) => nodeImportance(node.degree)), 1);
    coreR = new Float32Array(n);
    hiddenMask = new Uint8Array(n);
    const huge = new Sphere(new Vector3(), 1e7); // Hülle nie aus dem wachsenden Puffer berechnen
    // Neue Größe → neue Geometrie (die alte gibt ihre GPU-Puffer frei).
    quad.dispose();
    quad = new InstancedBufferGeometry();
    quad.setAttribute("corner", corners);
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    quad.boundingSphere = huge;
    cores.geometry = quad;
    glows.geometry = quad;
    quad.setAttribute("iPos", iPosAttr);
    quad.setAttribute("iColor", iColAttr);
    quad.setAttribute("iSize", sizeAttr);
    quad.setAttribute("iAlpha", alphaAttr);
    quad.setAttribute("iSeed", new InstancedBufferAttribute(seeds, 1));
    quad.setAttribute("iFlash", flashAttr);
    quad.setAttribute("iFlashGain", flashGainAttr);
    quad.setAttribute("iImp", impAttr);
    quad.instanceCount = n;
    edges = makeEdgeLayer(linkS.length);
    lines.geometry = edges.geometry;
    posTex.dispose();
    posTex = makePosTexture(n);
    edgeShared.uPos.value = posTex; // alle Faden-Materialien teilen dieses Uniform-Objekt
    syncPosTexture();
    hiEdges.commit(0);
    hiFrom = new Uint32Array(0);
    hiTo = new Uint32Array(0);
    hover = -1;
    hoverSet = new Set();
    applyLook();

    // Simulation: bekannte Form nur sanft nachjustieren. Aus der 2D-Form sofort zeigen und live in
    // 3D aufblähen (kein Warten). Ohne jede Form kurz im Worker vorrechnen.
    const share = n === 0 ? 1 : known / n;
    const startShare = n === 0 ? 1 : (known + from2d) / n;
    const alpha = share > 0.9 ? (firstLoad ? 0.05 : 0.03) : share > 0.3 ? 0.5 : 1;
    const warmupMs = share > 0.9 || startShare > 0.9 ? 0 : Math.min(900, 120 + n * 0.12);
    gen += 1;
    dataT0 = performance.now();
    hasPos = startShare > 0.9;
    if (hasPos) {
      firstFrameMs ??= 0;
      cb.onReady?.();
      if (!fitted) {
        fitted = true;
        fit(0);
      }
    }
    simRunning = true;
    const degree = Uint32Array.from(nodes, (node) => node.degree);
    const w = Float32Array.from(weight);
    const s2 = linkS.slice();
    const t2 = linkT.slice();
    sim.post({ type: "init", gen, pos: initPos, degree, src: s2, dst: t2, weight: w, alpha, warmupMs, forces }, [initPos.buffer, degree.buffer, s2.buffer, t2.buffer, w.buffer]);
    request();
  }

  // --- Aussehen anwenden (Farben, Größen, Sichtbarkeit, Kanten) -------------------------------------
  function applyLook() {
    if (!look) return;
    const { view, settings, selectedId } = look;
    const n = nodes.length;
    selected = selectedId ? (index.get(selectedId) ?? -1) : -1;
    // Schein nur noch bis 1,6 × Kern (vorher 2,6); ohne „Leuchten“ fast nur der Kern.
    const halo = settings.glow ? GLOW_SPAN : 1.12;
    nodeUniforms.uCore.value = 1 / halo;
    // Mindestgröße gilt für den farbigen Kern (nicht das ganze Sprite samt Schein) — scharf von weitem.
    nodeUniforms.uMinPx.value = minSpritePx(1 / halo, dpr);
    nodeUniforms.uGlow.value = settings.glow ? 1 : 0;
    lineWidth.value = edgeWidthDevicePx(settings.linkWidth, dpr);
    hiWidth.value = edgeWidthDevicePx(settings.linkWidth * HI_LINE_WIDTH, dpr);
    const col = iColAttr.array as Float32Array;
    const size = sizeAttr.array as Float32Array;
    const alpha = alphaAttr.array as Float32Array;
    const hoverOn = hover >= 0;
    const selOn = selected >= 0;
    lineFactor = hoverOn ? LINE_FACTOR_HOVER : selOn ? LINE_FACTOR_SELECT : 1;
    // Sichtbarkeit kann sich hier ändern: Mitte/Radius beim nächsten Bedarf neu rechnen.
    boundsAt = -Infinity;
    const selSet = new Set<number>();
    if (selOn) {
      for (const k of adj[selected] ?? []) {
        selSet.add(linkS[k] ?? 0);
        selSet.add(linkT[k] ?? 0);
      }
    }
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      if (!node) continue;
      const hidden = view.hidden.has(node.id);
      hiddenMask[i] = hidden ? 1 : 0;
      let c = nodeColor(node, settings.colorByType, settings.colors);
      let a = hidden ? 0 : view.dimmed.has(node.id) ? DIMMED_ALPHA : node.state === "unresolved" ? UNRESOLVED_ALPHA : 1;
      // Kleinere Punkte, Knotenpunkte gedeckelt (vorher (2 + √Grad) · 0,85 ohne Deckel).
      let r = nodeWorldRadius(node.degree, settings.nodeSize);
      if (i === selected) {
        c = mix(c, TOKENS.ink, 0.45);
        r *= 1.5;
        if (a > 0) a = 1; // der gewählte Knoten ist immer kräftig, auch wenn seine Gruppe ausgegraut ist
      } else if (selOn && !hoverOn) {
        // Direkte Nachbarn der Auswahl voll und etwas heller, der Rest nur leicht zurück.
        if (selSet.has(i)) {
          if (a > 0) a = 1;
          c = mix(c, TOKENS.ink, 0.15);
        } else a *= SELECT_REST_ALPHA;
      }
      if (hoverOn) {
        if (i === hover) {
          c = mix(c, TOKENS.ink, 0.4);
          r *= 1.35;
        } else if (hoverSet.has(i)) c = mix(c, TOKENS.ink, 0.2);
        else a *= 0.16;
      }
      const [cr, cg, cb2] = hexToRgb(c);
      col[i * 3] = cr / 255;
      col[i * 3 + 1] = cg / 255;
      col[i * 3 + 2] = cb2 / 255;
      size[i] = r * 2 * halo;
      alpha[i] = a;
      coreR[i] = r;
    }
    iColAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    // Sichtbare Fäden (nur wenn beide Enden sichtbar): Knoten-Nummern + Farbe beider Enden.
    const E = edges.arr;
    let m = 0;
    for (let k = 0; k < linkS.length; k++) {
      const a = linkS[k] ?? 0;
      const b = linkT[k] ?? 0;
      if (hiddenMask[a] || hiddenMask[b]) continue;
      E.a[m] = a;
      E.b[m] = b;
      for (let c = 0; c < 3; c++) {
        E.colA[m * 3 + c] = col[a * 3 + c] ?? 0;
        E.colB[m * 3 + c] = col[b * 3 + c] ?? 0;
      }
      m += 1;
    }
    edges.commit(m);
    // Hervorgehobene Kanten: beim Zeigen die des Knotens unter der Maus, sonst die der Auswahl.
    // Gegen einen Rest-„Kranz“ bei Hunderten Verbindungen: nur die nächsten HI_MAX_EDGES, beide Enden in der Farbe
    // des Nachbarn (nicht im aufgehellten Weiß-Gelb des gewählten Knotens), Deckkraft 1/√n über ALLE Kanten
    // des Knotens. Die übrigen Kanten zeichnet die normale Ebene oben; die Nachbarn bleiben voll hervorgehoben.
    const focusIdx = hoverOn ? hover : selected;
    const plan = planHighlight({ adj, linkS, linkT, hidden: hiddenMask, focus: focusIdx, dist2: nodeDist2 });
    hiFrom = plan.from;
    hiTo = plan.to;
    hiTotal = plan.total;
    highlightColors(col, hiTo, hiColors);
    const H = hiEdges.arr;
    for (let k = 0; k < hiTo.length; k++) {
      H.a[k] = hiFrom[k] ?? 0;
      H.b[k] = hiTo[k] ?? 0;
      for (let c = 0; c < 3; c++) {
        H.colA[k * 3 + c] = hiColors[k * 6 + c] ?? 0;
        H.colB[k * 3 + c] = hiColors[k * 6 + 3 + c] ?? 0;
      }
    }
    hiEdges.commit(hiTo.length);
    hiOpacity.value = HI_LINE_OPACITY * highlightCrowdFactor(plan.total);
    request();
  }

  /** Quadrat des Abstands zweier Knoten (Rangfolge „nächste Kanten zuerst“ für Hervorhebung und Impuls). */
  function nodeDist2(a: number, b: number): number {
    return ((pos[a * 3] ?? 0) - (pos[b * 3] ?? 0)) ** 2 + ((pos[a * 3 + 1] ?? 0) - (pos[b * 3 + 1] ?? 0)) ** 2 + ((pos[a * 3 + 2] ?? 0) - (pos[b * 3 + 2] ?? 0)) ** 2;
  }

  function setLook(view: GraphView, settings: BrainSettings, selectedId: string | null) {
    look = { view, settings, selectedId };
    applyLook();
  }

  function setForces(f: Forces) {
    const physics = physicsKey(f) !== physicsKey(forces);
    forces = { ...f };
    applyMotion();
    // Nur „Schweben“ geändert: nichts neu rechnen, nur weiterzeichnen (kein Sprung der Wolke).
    if (physics) {
      sim.post({ type: "forces", forces });
      simRunning = nodes.length > 0;
    }
    request();
  }

  function setHover(i: number) {
    if (i === hover) return;
    hover = i;
    hoverSet = new Set();
    if (i >= 0) {
      hoverSet.add(i);
      for (const k of adj[i] ?? []) {
        hoverSet.add(linkS[k] ?? 0);
        hoverSet.add(linkT[k] ?? 0);
      }
    }
    canvas.style.cursor = i >= 0 ? "pointer" : control === "fly" ? "crosshair" : "grab";
    applyLook();
  }

  // --- Lichtimpulse nach Klick ---------------------------------------------------------------------
  function stopPulse() {
    pulse = null;
    pulseLines.visible = false;
    pulseHeads.visible = false;
  }

  /** Endpunkte der Impuls-Kanten aus den aktuellen Positionen (während die Physik noch läuft). */
  function syncPulsePositions() {
    if (!pulse) return;
    const lp = pulseLines.geometry.getAttribute("position") as BufferAttribute;
    const ha = pulseHeads.geometry.getAttribute("aA") as BufferAttribute;
    const hb = pulseHeads.geometry.getAttribute("aB") as BufferAttribute;
    const L = lp.array as Float32Array;
    const A = ha.array as Float32Array;
    const B = hb.array as Float32Array;
    for (let k = 0; k < pulse.from.length; k++) {
      const a = pulse.from[k] ?? 0;
      const b = pulse.to[k] ?? 0;
      for (let c = 0; c < 3; c++) {
        const pa = pos[a * 3 + c] ?? 0;
        const pb = pos[b * 3 + c] ?? 0;
        L[k * 6 + c] = pa;
        L[k * 6 + 3 + c] = pb;
        A[k * 3 + c] = pa;
        B[k * 3 + c] = pb;
      }
    }
    lp.needsUpdate = true;
    ha.needsUpdate = true;
    hb.needsUpdate = true;
  }

  function startPulse(start: number) {
    // „Bewegung reduzieren“ (System): keine wandernden Lichtimpulse — die Auswahl selbst hebt die Kanten hervor.
    if (reducedMotionQuery?.matches) return;
    // Bei Riesen-Knoten nur die nächsten Kanten (kein Strahlenkranz über den ganzen Bildschirm).
    const plan = planPulse({ adj, linkS, linkT, hidden: hiddenMask, start, rank: (_e, a, b) => nodeDist2(a, b) });
    const t = now();
    // Aufleuchten: der Knoten sofort, jede weitere Stufe, wenn ihr Impuls ankommt.
    const flash = flashAttr.array as Float32Array;
    const flashGain = flashGainAttr.array as Float32Array;
    flash.fill(NO_FLASH);
    for (const [i, h] of plan.hop) {
      flash[i] = t + hopArrival(h);
      flashGain[i] = hopGain(h);
    }
    flashAttr.needsUpdate = true;
    flashGainAttr.needsUpdate = true;
    const m = plan.edges.length;
    const col = iColAttr.array as Float32Array;
    const lPos = new Float32Array(m * 6);
    const lCol = new Float32Array(m * 6);
    const lSeed = new Float32Array(m * 2);
    const lT = new Float32Array(m * 2);
    const lDelay = new Float32Array(m * 2);
    const hCol = new Float32Array(m * 3);
    const hSeedA = new Float32Array(m);
    const hSeedB = new Float32Array(m);
    const hDelay = new Float32Array(m);
    const lGain = new Float32Array(m * 2);
    const hGain = new Float32Array(m);
    const lTravel = new Float32Array(m * 2);
    const hTravel = new Float32Array(m);
    const from = new Uint32Array(m);
    const to = new Uint32Array(m);
    plan.edges.forEach((e, k) => {
      from[k] = e.from;
      to[k] = e.to;
      for (let c = 0; c < 3; c++) {
        lCol[k * 6 + c] = col[e.from * 3 + c] ?? 1;
        lCol[k * 6 + 3 + c] = col[e.to * 3 + c] ?? 1;
        hCol[k * 3 + c] = col[e.to * 3 + c] ?? 1;
      }
      lSeed[k * 2] = seeds[e.from] ?? 0;
      lSeed[k * 2 + 1] = seeds[e.to] ?? 0;
      lT[k * 2 + 1] = 1;
      lDelay[k * 2] = e.delay;
      lDelay[k * 2 + 1] = e.delay;
      hSeedA[k] = seeds[e.from] ?? 0;
      hSeedB[k] = seeds[e.to] ?? 0;
      hDelay[k] = e.delay;
      lGain[k * 2] = e.gain;
      lGain[k * 2 + 1] = e.gain;
      hGain[k] = e.gain;
      lTravel[k * 2] = e.travel;
      lTravel[k * 2 + 1] = e.travel;
      hTravel[k] = e.travel;
    });
    pulseLines.geometry.dispose();
    pulseHeads.geometry.dispose();
    const gl = new BufferGeometry();
    gl.setAttribute("position", new BufferAttribute(lPos, 3).setUsage(DynamicDrawUsage));
    gl.setAttribute("color", new BufferAttribute(lCol, 3));
    gl.setAttribute("aSeed", new BufferAttribute(lSeed, 1));
    gl.setAttribute("aT", new BufferAttribute(lT, 1));
    gl.setAttribute("aDelay", new BufferAttribute(lDelay, 1));
    gl.setAttribute("aGain", new BufferAttribute(lGain, 1));
    gl.setAttribute("aTravel", new BufferAttribute(lTravel, 1));
    const gh = new BufferGeometry();
    // `position` braucht three für die Punkt-Anzahl; der Shader rechnet die Lage aus aA/aB.
    gh.setAttribute("position", new BufferAttribute(new Float32Array(m * 3), 3));
    gh.setAttribute("aA", new BufferAttribute(new Float32Array(m * 3), 3).setUsage(DynamicDrawUsage));
    gh.setAttribute("aB", new BufferAttribute(new Float32Array(m * 3), 3).setUsage(DynamicDrawUsage));
    gh.setAttribute("aSeedA", new BufferAttribute(hSeedA, 1));
    gh.setAttribute("aSeedB", new BufferAttribute(hSeedB, 1));
    gh.setAttribute("aDelay", new BufferAttribute(hDelay, 1));
    gh.setAttribute("aGain", new BufferAttribute(hGain, 1));
    gh.setAttribute("aTravel", new BufferAttribute(hTravel, 1));
    gh.setAttribute("color", new BufferAttribute(hCol, 3));
    for (const g of [gl, gh]) g.boundingSphere = new Sphere(new Vector3(), 1e7);
    pulseLines.geometry = gl;
    pulseHeads.geometry = gh;
    pulse = { end: t + plan.durationS, from, to, nodes: plan.hop.size };
    syncPulsePositions();
    pulseUniforms.uStart.value = t;
    pulseLines.visible = m > 0;
    pulseHeads.visible = m > 0;
    request();
  }

  // --- Projektion: Treffer + Beschriftungen ---------------------------------------------------------
  const wp: [number, number, number] = [0, 0, 0];
  /** Weltposition inkl. Atmen/Wiegen/Schweben (so, wie der Shader den Knoten zeichnet). */
  function worldPos(i: number, t: number, out: Vector3): Vector3 {
    const x = pos[i * 3] ?? 0;
    const y = pos[i * 3 + 1] ?? 0;
    const z = pos[i * 3 + 2] ?? 0;
    if (!moving()) return out.set(x, y, z);
    // Läuft je Bild für alle Knoten (Beschriftung/Treffer): ohne neue Arrays je Aufruf.
    animatePosInto(wp, x, y, z, seeds[i] ?? 0, t, motion);
    return out.set(wp[0], wp[1], wp[2]);
  }

  function projector() {
    camera.updateMatrixWorld();
    tmpM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = tmpM.elements;
    const scale = (cssH * 0.5) / Math.tan(((FOV / 2) * Math.PI) / 180);
    const t = now();
    const p = new Vector3();
    return (i: number): { x: number; y: number; w: number; r: number } | null => {
      worldPos(i, t, p);
      const { x, y, z } = p;
      const w = (e[3] ?? 0) * x + (e[7] ?? 0) * y + (e[11] ?? 0) * z + (e[15] ?? 0);
      if (w <= 1) return null;
      const sx = ((((e[0] ?? 0) * x + (e[4] ?? 0) * y + (e[8] ?? 0) * z + (e[12] ?? 0)) / w + 1) * 0.5) * cssW;
      const sy = ((1 - ((e[1] ?? 0) * x + (e[5] ?? 0) * y + (e[9] ?? 0) * z + (e[13] ?? 0)) / w) * 0.5) * cssH;
      return { x: sx, y: sy, w, r: ((coreR[i] ?? 1) * scale) / w };
    };
  }

  /**
   * Knoten unter dem Zeiger. Treffer-Radius = sichtbarer Kern + Rand, mindestens PICK_MIN_PX. Liegt der
   * Zeiger IN einem Kern, gewinnt der vorderste; sonst der nächstgelegene (bei 8 px Mindest-Radius überlappen
   * sich kleine Punkte — dann soll nicht ein weiter hinten liegender Nachbar gewinnen).
   */
  function pickAt(mx: number, my: number): number {
    const project = projector();
    let best = -1;
    let bestInside = false;
    let bestKey = Number.POSITIVE_INFINITY;
    for (let i = 0; i < nodes.length; i++) {
      if (hiddenMask[i]) continue;
      const p = project(i);
      if (!p || p.x < -20 || p.y < -20 || p.x > cssW + 20 || p.y > cssH + 20) continue;
      const rr = pickRadiusPx(p.r);
      const dx = p.x - mx;
      const dy = p.y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 > rr * rr) continue;
      const core = Math.max(MIN_CORE_PX, p.r);
      const inside = d2 <= core * core;
      if (bestInside && !inside) continue;
      const key = inside ? p.w : d2;
      if ((inside && !bestInside) || key < bestKey) {
        bestInside = inside;
        bestKey = key;
        best = i;
      }
    }
    return best;
  }

  function drawLabels() {
    if (!lctx) return;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, cssW, cssH);
    if (!look || nodes.length === 0 || !hasPos) return;
    const project = projector();
    const near: Array<{ i: number; r: number }> = [];
    for (let i = 0; i < nodes.length; i++) {
      if (hiddenMask[i]) continue;
      const p = project(i);
      if (!p || p.r < LABEL_MIN_PX || p.x < 0 || p.y < 0 || p.x > cssW || p.y > cssH) continue;
      near.push({ i, r: p.r });
    }
    near.sort((a, b) => b.r - a.r);
    const order: Array<{ i: number; alpha: number }> = [];
    if (hover >= 0) order.push({ i: hover, alpha: 1 });
    if (selected >= 0) order.push({ i: selected, alpha: 1 });
    if (hover >= 0) {
      const nb = [...hoverSet].filter((i) => i !== hover && !hiddenMask[i]).sort((a, b) => (nodes[b]?.degree ?? 0) - (nodes[a]?.degree ?? 0));
      for (const i of nb.slice(0, MAX_HOVER_LABELS)) order.push({ i, alpha: 0.9 });
    }
    const fade = hover >= 0 ? 0.25 : 1;
    for (const { i, r } of near.slice(0, MAX_NEAR_LABELS)) order.push({ i, alpha: Math.min(0.85, 0.35 + (r - LABEL_MIN_PX) * 0.12) * fade });
    if (near.length < 8 && hover < 0) {
      // Weit weg: wenigstens die großen Knotenpunkte beschriften (Orientierung). Je ferner, desto
      // weniger — ganz fern keine (vorher 10, die sich auf dem kleinen Knäuel stapelten).
      const budget = orientationLabels(lod);
      let added = 0;
      for (const i of byDegree) {
        if (added >= budget) break;
        if (hiddenMask[i]) continue;
        order.push({ i, alpha: 0.6 });
        added += 1;
      }
    }
    lctx.font = '12px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif';
    lctx.textAlign = "center";
    lctx.textBaseline = "top";
    lctx.lineJoin = "round";
    lctx.lineWidth = 3;
    const placed: Array<[number, number, number, number]> = [];
    const done = new Set<number>();
    const [ir, ig, ib] = hexToRgb(TOKENS.ink);
    for (const { i, alpha } of order) {
      if (done.has(i)) continue;
      const node = nodes[i];
      const p = project(i);
      if (!node || !p || alpha <= 0.03) continue;
      const text = node.label.length > 40 ? `${node.label.slice(0, 38)}…` : node.label;
      const w = lctx.measureText(text).width;
      const x0 = p.x - w / 2;
      const y0 = p.y + Math.max(3, p.r) + 3;
      if (x0 > cssW || x0 + w < 0 || y0 > cssH || y0 < -14) continue;
      let hit = false;
      for (const [px, py, pw, ph] of placed)
        if (x0 < px + pw && x0 + w > px && y0 < py + ph && y0 + 14 > py) {
          hit = true;
          break;
        }
      if (hit) continue;
      placed.push([x0, y0, w, 14]);
      done.add(i);
      lctx.strokeStyle = `rgba(10,13,18,${Math.min(0.85, alpha)})`;
      lctx.strokeText(text, p.x, y0);
      lctx.fillStyle = `rgba(${ir},${ig},${ib},${alpha})`;
      lctx.fillText(text, p.x, y0);
    }
  }

  // --- Kamera -------------------------------------------------------------------------------------
  function forward(out: Vector3): Vector3 {
    return camera.getWorldDirection(out);
  }

  /** Worauf die Kamera gerade schaut. */
  function currentTarget(out: Vector3): Vector3 {
    if (tween) return out.copy(lookTarget);
    if (control === "orbit") return out.copy(rig.target);
    return out.copy(camera.position).add(forward(new Vector3()).multiplyScalar(Math.max(50, sceneRadius)));
  }

  function syncYawPitch() {
    const e = new Euler().setFromQuaternion(camera.quaternion, "YXZ");
    yaw = e.y;
    pitch = e.x;
  }

  function applyYawPitch() {
    camera.quaternion.setFromEuler(new Euler(pitch, yaw, 0, "YXZ"));
  }

  /** Laufenden Übergang an der aktuellen Stelle anhalten (man greift ein). */
  function cancelTween() {
    if (!tween) return;
    tween = null;
    if (control === "orbit") rig.jumpTo(camera.position, lookTarget);
    else syncYawPitch();
  }

  function tweenTo(p1: Vector3, g1: Vector3, ms: number) {
    if (ms <= 0) {
      tween = null;
      camera.position.copy(p1);
      lookTarget.copy(g1);
      camera.lookAt(g1);
      if (control === "fly") syncYawPitch();
      else rig.jumpTo(p1, g1);
      request();
      return;
    }
    const g0 = currentTarget(new Vector3());
    tween = { t0: performance.now(), ms, p0: camera.position.clone(), p1: p1.clone(), g0, g1: g1.clone() };
    lookTarget.copy(g0);
    flyVel.set(0, 0, 0);
    rig.stop();
    request();
  }

  /**
   * Robuste Mitte (Median) und Radius (95 %) des Sichtbaren — Ausreißer ziehen nicht zur Seite.
   * Median heißt Sortieren — nicht je Bild. Wer je Bild fragt (Folgen beim Aufbau, Mitte
   * nachführen), bekommt bis `maxAgeMs` das gemerkte Ergebnis; ein Filter-Wechsel macht es ungültig.
   * Das zurückgegebene Objekt wird wiederverwendet (nur lesen).
   */
  function visibleBounds(maxAgeMs = 0): { c: Vector3; r: number } | null {
    const tNow = performance.now();
    if (maxAgeMs > 0 && tNow - boundsAt < maxAgeMs) return boundsHas ? boundsMemo : null;
    const b = robustBounds(pos.subarray(0, nodes.length * 3), hiddenMask, coreR);
    boundsAt = tNow;
    boundsHas = b !== null;
    if (!b) return null;
    boundsMemo.c.set(b.c[0], b.c[1], b.c[2]);
    boundsMemo.r = Math.max(40, b.r);
    return boundsMemo;
  }

  /** Mitte der Wolke nachführen (höchstens 4× je Sekunde neu gerechnet, dazwischen weich geglättet). */
  function updateCenter(dt: number): boolean {
    const tNow = performance.now();
    const first = centerAt < 0;
    if (first || (simRunning && tNow - centerAt > BOUNDS_MAX_AGE_MS)) {
      const b = visibleBounds(BOUNDS_MAX_AGE_MS);
      if (b) centerGoal.copy(b.c);
      if (first) center.copy(centerGoal);
      centerAt = tNow;
    }
    const d = center.distanceTo(centerGoal);
    // „Bewegung reduzieren“: kein Nachgleiten, der Drehpunkt springt still an die neue Mitte.
    if (d > 1e-3 && !reducedMotionQuery?.matches) center.lerp(centerGoal, 1 - Math.exp(-dt * CENTER_RATE));
    else center.copy(centerGoal);
    centerTuple[0] = center.x;
    centerTuple[1] = center.y;
    centerTuple[2] = center.z;
    shared.uCenter.value.copy(center);
    motion.center = centerTuple;
    return d > 1e-3;
  }

  const prevCenter = new Vector3();
  const v3 = new Vector3();
  /** Zuletzt angeflogener Knoten und der Anflug-Abstand (für den Drehpunkt). */
  let focusIdx = -1;
  let focusDist = 0;
  const pivotTmp = new Vector3();
  /**
   * Nur die Gehirnkugel dreht sich, nicht die eigene Perspektive: Drehpunkt für
   * jedes Drehen (zwei Finger, Ziehen). Die ganze Kamera dreht starr um ihn — kein Schwenk zur Mitte, kein
   * Verschieben. Nah an einem angeflogenen Punkt ist er der Drehpunkt, sonst die Mitte der Wolke.
   */
  function rotatePivot(): Vector3 {
    if (focusIdx >= 0 && focusIdx === selected && !hiddenMask[focusIdx]) {
      const p = worldPos(focusIdx, now(), pivotTmp);
      if (rotationPivot({ focused: true, camToFocus: camera.position.distanceTo(p), focusDist }) === "node") return p;
    }
    focusIdx = -1;
    return pivotTmp.copy(center);
  }

  /** Bild-Versatz weich anwenden (setViewOffset: Treffer, Beschriftungen und Strahlen rechnen mit). */
  function applyShift(dt: number, force = false): boolean {
    const a = dt <= 0 || reducedMotionQuery?.matches ? 1 : 1 - Math.exp(-dt * SHIFT_RATE);
    shift2d.x += (shift2d.gx - shift2d.x) * a;
    shift2d.y += (shift2d.gy - shift2d.y) * a;
    const settled = Math.abs(shift2d.gx - shift2d.x) < 0.3 && Math.abs(shift2d.gy - shift2d.y) < 0.3;
    if (settled) {
      shift2d.x = shift2d.gx;
      shift2d.y = shift2d.gy;
    }
    // Die Projektion nur neu rechnen, wenn sich der Versatz wirklich geändert hat (nicht je Bild).
    if (!force && shift2d.x === shift2d.ax && shift2d.y === shift2d.ay) return !settled;
    shift2d.ax = shift2d.x;
    shift2d.ay = shift2d.y;
    if (Math.abs(shift2d.x) < 0.3 && Math.abs(shift2d.y) < 0.3) {
      if (camera.view?.enabled) camera.clearViewOffset();
    } else camera.setViewOffset(cssW, cssH, shift2d.x, shift2d.y, cssW, cssH);
    return !settled;
  }

  /** Bild-Versatz-Ziel für die freie Fläche neben den Kacheln (Kopf, Ansichten, Seitenblatt, Steuerung). */
  function aimShiftAtFreeArea(area: Rect | null) {
    const sh = viewShiftFor(area, cssW, cssH);
    shift2d.gx = sh.x;
    shift2d.gy = sh.y;
  }

  /** Kamera-Ziel, bei dem alles Sichtbare ins Bild passt (Blickrichtung bleibt). */
  function fitTarget(p: Vector3 = new Vector3(), g: Vector3 = new Vector3(), maxAgeMs = 0): { p: Vector3; g: Vector3 } | null {
    const b = visibleBounds(maxAgeMs);
    if (!b) return null;
    sceneRadius = b.r;
    const vFov = (FOV * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    // Nur die freie Fläche neben den Kacheln zählt (schmaleres Sichtfeld, Mitte verschoben).
    const area = opts.fitArea?.() ?? null;
    const fx = area ? Math.max(0.1, (area.right - area.left) / cssW) : 1;
    const fy = area ? Math.max(0.1, (area.bottom - area.top) / cssH) : 1;
    const half = Math.atan(Math.min(Math.tan(vFov / 2) * fy, Math.tan(hFov / 2) * fx));
    const dist = (b.r / Math.sin(half)) * 1.04;
    const dir = v1.copy(camera.position).sub(currentTarget(v2));
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    // Drehziel IST die Mitte der Wolke. Die freie Fläche neben den Kacheln trifft ein Bild-Versatz
    // (vorher wurde das Ziel seitlich verschoben — dann drehte sich alles um eine Achse neben der Wolke).
    g.copy(b.c);
    aimShiftAtFreeArea(area);
    return { p: p.copy(g).addScaledVector(dir, dist), g };
  }

  function fit(ms = 600) {
    centerLock = true;
    focusIdx = -1;
    const t = fitTarget();
    if (t) tweenTo(t.p, t.g, ms);
  }

  /** Solange sich die 3D-Form aufbaut und die Kamera noch nicht von Hand bewegt wurde, folgt sie
   * weich dem Sichtbaren — sonst treiben z. B. im eigenen Gehirn die paar gezeigten Punkte sofort
   * aus dem Bild und kommen erst nach dem Ausschwingen zurück. */
  function follow(dt: number) {
    // Je Bild: gemerkte Mitte/Radius (höchstens 250 ms alt) und feste Hilfsvektoren — keine Allokation.
    const t = fitTarget(followP, followG, BOUNDS_MAX_AGE_MS);
    if (!t) return;
    const a = 1 - Math.exp(-dt * FOLLOW_RATE);
    currentTarget(lookTarget);
    camera.position.lerp(t.p, a);
    lookTarget.lerp(t.g, a);
    camera.lookAt(lookTarget);
    if (control === "fly") syncYawPitch();
    else rig.jumpTo(camera.position, lookTarget);
  }

  function focusNode(id: string) {
    const i = index.get(id);
    if (i === undefined) return;
    centerLock = false;
    const target = worldPos(i, now(), new Vector3());
    const dir = v1.copy(camera.position).sub(target);
    const cur = dir.length();
    if (cur < 1e-3) dir.set(0, 0, 1);
    dir.normalize();
    // Nah ran, aber so, dass die direkten Nachbarn im Bild bleiben (typischer Abstand = Median).
    const nd: number[] = [];
    const nb = new Vector3();
    for (const e of adj[i] ?? []) {
      const b = (linkS[e] ?? 0) === i ? (linkT[e] ?? 0) : (linkS[e] ?? 0);
      if (!hiddenMask[b]) nd.push(worldPos(b, now(), nb).distanceTo(target));
    }
    nd.sort((a, b) => a - b);
    const neighborRadius = Math.min(sceneRadius, nd[Math.floor((nd.length - 1) * 0.5)] ?? 0);
    const vFov = (FOV * Math.PI) / 180;
    const halfFov = Math.min(vFov / 2, Math.atan(Math.tan(vFov / 2) * camera.aspect)) * 0.85;
    // Klick zoomt HINEIN: nie weiter weg als jetzt und höchstens halb so weit wie die Wolke groß ist (bei
    // Knoten mit Nachbarn quer durch die Wolke würde sonst kaum hineingezoomt).
    const want = focusDistance({ neighborRadius, coreRadius: coreR[i] ?? 3, halfFov });
    const dist = Math.min(want, Math.max(cur, 40), Math.max(40, sceneRadius * 0.5));
    focusIdx = i;
    focusDist = dist;
    // Bild-Versatz beim Anfliegen neu für die freie Fläche JETZT (inkl. Seitenblatt links, das
    // beim Auswählen aufgeht) — sonst blieb der alte Versatz vom Einpassen stehen und der Knoten landete
    // unter dem Blatt oder neben der Mitte.
    aimShiftAtFreeArea(opts.fitArea?.() ?? null);
    tweenTo(target.clone().addScaledVector(dir, dist), target, 800);
  }

  function setControl(mode: Control3D) {
    if (mode === control) return;
    cancelTween();
    flyVel.set(0, 0, 0);
    if (mode === "fly") {
      control = mode;
      syncYawPitch();
      canvas.style.cursor = "crosshair";
    } else {
      const f = forward(new Vector3());
      const d = Math.max(50, camera.position.distanceTo(rig.target) || sceneRadius);
      control = mode;
      rig.jumpTo(camera.position, camera.position.clone().addScaledVector(f, d));
      canvas.style.cursor = "grab";
    }
    request();
  }

  // --- Bildschleife --------------------------------------------------------------------------------
  function request() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!raf && active) raf = requestAnimationFrame(frame);
  }

  function frame(t: number) {
    raf = 0;
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 1 / 60;
    lastT = t;
    const time = now();
    shared.uTime.value = time;
    let more = false;
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / tween.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      camera.position.lerpVectors(tween.p0, tween.p1, e);
      lookTarget.lerpVectors(tween.g0, tween.g1, e);
      camera.lookAt(lookTarget);
      if (k >= 1) {
        tween = null;
        if (control === "fly") syncYawPitch();
        else rig.jumpTo(camera.position, lookTarget);
      }
      more = true;
    }
    if (keys.size > 0) {
      const f = forward(new Vector3());
      const right = new Vector3().crossVectors(f, up).normalize();
      const move = new Vector3();
      if (keys.has("w") || keys.has("arrowup")) move.add(f);
      if (keys.has("s") || keys.has("arrowdown")) move.sub(f);
      if (keys.has("d") || keys.has("arrowright")) move.add(right);
      if (keys.has("a") || keys.has("arrowleft")) move.sub(right);
      if (keys.has("e")) move.add(up);
      if (keys.has("q")) move.sub(up);
      if (move.lengthSq() > 0) {
        const speed = Math.max(60, sceneRadius * 0.45) * (shift ? 3.5 : 1) * dt;
        move.normalize().multiplyScalar(speed);
        cancelTween();
        if (control === "orbit") rig.translate(move);
        else camera.position.add(move);
        userMoved = true;
      }
      more = true;
    }
    if (control === "fly" && flyVel.lengthSq() > 1e-4) {
      camera.position.addScaledVector(flyVel, dt);
      flyVel.multiplyScalar(Math.exp(-FLY_DAMP * dt));
      more = true;
    }
    prevCenter.copy(center);
    if (hasPos && updateCenter(dt)) more = true;
    if (applyShift(dt)) more = true;
    if (simRunning && !userMoved && !tween && hasPos) follow(dt);
    // Form ändert sich (Aufbau, Filter): Drehpunkt und Kamera wandern mit der Mitte mit (der Blick bleibt,
    // ein Zoom zur Maus bleibt erhalten — nichts wird zurückgezogen).
    else if (control === "orbit" && !tween && centerLock && hasPos && prevCenter.distanceToSquared(center) > 1e-8) rig.translate(v3.copy(center).sub(prevCenter));
    if (control === "orbit" && !tween) {
      rig.update(dt);
      rig.apply(camera);
      if (rig.moving()) more = true;
    }
    if (pulse) {
      if (time > pulse.end) stopPulse();
      else {
        if (simRunning) syncPulsePositions();
        more = true;
      }
    }
    if (pendingPick) {
      const { x, y } = pendingPick;
      pendingPick = null;
      setHover(pickAt(x, y));
    }
    updateLod();
    const r0 = performance.now();
    renderer.render(scene, camera);
    drawLabels();
    perf.frames += 1;
    perf.renderMs.push(performance.now() - r0);
    if (perf.renderMs.length > 600) perf.renderMs.splice(0, 300);
    // Nur EINE Bildschleife: Kamera-Ereignisse während dieses Bildes haben evtl. schon ein Bild bestellt.
    if (more || simRunning || measuring) {
      if (!raf) raf = requestAnimationFrame(frame);
    } else if (!raf && active && moving() && !document.hidden) {
      // Nur das Schweben bewegt sich: gedrosselt weiterzeichnen.
      lastT = 0;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        request();
      }, IDLE_DRIFT_MS);
    } else if (!raf) lastT = 0;
  }

  // --- Eingaben ------------------------------------------------------------------------------------
  let down: { x: number; y: number; lx: number; ly: number; lt: number; button: number; action: DragAction; moved: boolean; id: number; node: number } | null = null;
  /** Letzte Drehbewegungen (für den Schwung beim Loslassen). */
  let rotSamples: Array<{ t: number; dth: number; dph: number }> = [];
  const wheelMem: WheelMemory = { kind: null, at: -1e9 };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Welt-Punkt unter der Maus: ein Knoten, sonst die Ebene durch den Blickpunkt. */
  function anchorAt(x: number, y: number): Vector3 | null {
    const i = pickAt(x, y);
    if (i >= 0) return worldPos(i, now(), new Vector3());
    camera.updateMatrixWorld();
    const ray = new Vector3((x / cssW) * 2 - 1, -(y / cssH) * 2 + 1, 0.5).unproject(camera).sub(camera.position).normalize();
    const f = forward(new Vector3());
    const denom = ray.dot(f);
    if (denom < 1e-4) return null;
    const dist = currentTarget(v1).sub(camera.position).dot(f) / denom;
    return dist > 0 ? camera.position.clone().addScaledVector(ray, dist) : null;
  }

  function panFly(dx: number, dy: number) {
    const perPx = (2 * Math.max(60, sceneRadius * 0.6) * Math.tan(((FOV / 2) * Math.PI) / 180)) / Math.max(1, cssH);
    const f = forward(new Vector3());
    const right = new Vector3().crossVectors(f, up).normalize();
    const upv = new Vector3().crossVectors(right, f).normalize();
    camera.position.addScaledVector(right, -dx * perPx).addScaledVector(upv, dy * perPx);
  }

  /** Strahl von der Kamera durch einen Bildschirmpunkt. */
  function rayAt(x: number, y: number): Vector3 {
    camera.updateMatrixWorld();
    return new Vector3((x / cssW) * 2 - 1, -(y / cssH) * 2 + 1, 0.5).unproject(camera).sub(camera.position).normalize();
  }

  /** Knoten ziehen: Punkt unter der Maus in der Ebene durch den Knoten, parallel zum Bildschirm. */
  function dragNodeTo(x: number, y: number) {
    if (!grab) return;
    const i = grab.i;
    const t = now();
    const center = worldPos(i, t, new Vector3());
    const normal = forward(new Vector3());
    const hit = rayPlaneHit(camera.position, rayAt(x, y), center, normal);
    if (!hit) return;
    hit.add(grab.offset);
    const [px, py, pz] = unanimatePos([hit.x, hit.y, hit.z], seeds[i] ?? 0, t, motion);
    // Sofort zeichnen (nicht erst auf den Worker warten) — der Knoten klebt an der Maus.
    grab.at = [px, py, pz];
    pos.set(grab.at, i * 3);
    markPositions();
    sim.post({ type: "pin", index: i, x: px, y: py, z: pz });
    simRunning = true;
  }

  function releaseGrab() {
    if (!grab) return;
    sim.post({ type: "unpin", index: grab.i });
    grab = null;
  }

  function lookAround(dx: number, dy: number) {
    yaw -= dx * LOOK_PER_PX;
    pitch = Math.max(-1.52, Math.min(1.52, pitch - dy * LOOK_PER_PX));
    applyYawPitch();
  }

  // Zwei-Finger-Zoom auf Touch-Bildschirmen. Safari (iPhone/iPad) meldet das Kneifen zusätzlich als
  // eigene Geste (`gesturechange`, unten) – dort zoomt nur die Geste, sonst (Android/Chrome) zoomen wir hier.
  // Sobald ein zweiter Finger liegt, endet das Drehen des ersten (kein Sprung beim Loslassen).
  const touchPts = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const safariGestures = typeof window !== "undefined" && "ongesturechange" in window;
  const pinchSpan = () => {
    const [a, b] = [...touchPts.values()];
    return a && b ? { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  };
  const onPointerDown = (e: PointerEvent) => {
    host.focus({ preventScroll: true });
    const p = local(e);
    if (e.pointerType === "touch") {
      touchPts.set(e.pointerId, p);
      if (touchPts.size >= 2) {
        down = null;
        releaseGrab();
        rotSamples = [];
        pinchDist = pinchSpan()?.d ?? 0;
        return;
      }
    }
    cancelTween();
    rig.stop();
    flyVel.set(0, 0, 0);
    rotSamples = [];
    const onNode = e.button === 0 && !e.shiftKey ? pickAt(p.x, p.y) : -1;
    down = { x: p.x, y: p.y, lx: p.x, ly: p.y, lt: performance.now(), button: e.button, action: pointerAction(e.button, e.shiftKey, control, onNode >= 0), moved: false, id: e.pointerId, node: onNode };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // manche Zeiger (z. B. synthetische) lassen sich nicht fangen — Ziehen geht trotzdem
    }
    if (down.action === "node" || down.action === "rotate") canvas.style.cursor = "grabbing";
    else canvas.style.cursor = down.action === "pan" ? "move" : "crosshair";
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = local(e);
    if (e.pointerType === "touch" && touchPts.has(e.pointerId)) {
      touchPts.set(e.pointerId, p);
      if (touchPts.size >= 2) {
        const span = pinchSpan();
        if (!safariGestures && span && pinchDist > 0 && span.d > 0) {
          const factor = Math.max(0.74, Math.min(1.35, pinchDist / span.d));
          userMoved = true;
          cancelTween();
          if (control === "orbit") rig.zoom(factor, anchorAt(span.x, span.y));
          else flyVel.addScaledVector(forward(new Vector3()), -Math.log(factor) * FLY_WHEEL * FLY_DAMP * Math.max(60, sceneRadius * 0.3));
          request();
        }
        pinchDist = span?.d ?? 0;
        return;
      }
    }
    if (down && e.buttons !== 0) {
      const dx = p.x - down.lx;
      const dy = p.y - down.ly;
      const tNow = performance.now();
      down.lx = p.x;
      down.ly = p.y;
      if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > CLICK_SLOP_PX) down.moved = true;
      if (dx === 0 && dy === 0) return;
      if (down.action === "node") {
        // Erst ab ein paar Pixeln greifen — ein Klick bleibt ein Klick (Auswahl/Info-Karte).
        if (!down.moved) return;
        userMoved = true;
        if (!grab && down.node >= 0) {
          const center = worldPos(down.node, now(), new Vector3());
          const hit = rayPlaneHit(camera.position, rayAt(down.x, down.y), center, forward(new Vector3()));
          grab = { i: down.node, offset: hit ? center.clone().sub(hit) : new Vector3(), at: [pos[down.node * 3] ?? 0, pos[down.node * 3 + 1] ?? 0, pos[down.node * 3 + 2] ?? 0] };
        }
        dragNodeTo(p.x, p.y);
        down.lt = tNow;
        request();
        return;
      }
      userMoved = true;
      if (down.action === "rotate") {
        const dth = -dx * ROTATE_PER_PX;
        const dph = -dy * ROTATE_PER_PX;
        rig.rotate(dth, dph, control === "orbit" ? rotatePivot() : null);
        rotSamples.push({ t: tNow, dth, dph });
        while (rotSamples.length > 0 && tNow - (rotSamples[0]?.t ?? 0) > FLING_WINDOW_MS * 1.5) rotSamples.shift();
      } else if (down.action === "pan") {
        centerLock = false;
        if (control === "orbit") rig.pan(dx, dy, camera, cssH);
        else panFly(dx, dy);
      } else lookAround(dx, dy);
      down.lt = tNow;
      request();
      return;
    }
    if (e.buttons === 0) {
      pendingPick = p;
      request();
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    touchPts.delete(e.pointerId);
    if (touchPts.size < 2) pinchDist = 0;
    const p = local(e);
    const d = down;
    down = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = hover >= 0 ? "pointer" : control === "fly" ? "crosshair" : "grab";
    if (!d) return;
    if (d.action === "node" && d.moved) {
      releaseGrab();
      request();
      return;
    }
    if (d.moved) {
      // Schwung: nur wenn zuletzt noch gezogen wurde (nicht erst anhalten, dann loslassen).
      const tNow = performance.now();
      if (d.action === "rotate" && tNow - d.lt < FLING_WINDOW_MS && rotSamples.length >= 2) {
        const first = rotSamples[0];
        const span = Math.max(16, tNow - (first?.t ?? tNow)) / 1000;
        let sth = 0;
        let sph = 0;
        for (const s of rotSamples) {
          sth += s.dth;
          sph += s.dph;
        }
        rig.fling(sth / span, sph / span);
        request();
      }
      return;
    }
    if (d.button !== 0) return;
    const i = pickAt(p.x, p.y);
    const node = i >= 0 ? nodes[i] : undefined;
    if (!node) {
      cb.onSelect(null);
      return;
    }
    cb.onSelect(node);
    startPulse(i);
    // Eine Zeit lang flog nur noch der Doppelklick hin. Jetzt wieder: ein Klick wählt aus UND fliegt weich hin.
    userMoved = true;
    focusNode(node.id);
  };
  // Doppelklick: hinfliegen (Öffnen geht über das Seitenblatt oder Enter). Das echte `dblclick`
  // kommt zuverlässig (auch bei Trackpad-Tippen), eigenes Zeitmessen verpasste es teils.
  const onDblClick = (e: MouseEvent) => {
    const p = local(e);
    const i = pickAt(p.x, p.y);
    const node = i >= 0 ? nodes[i] : undefined;
    if (!node) return;
    userMoved = true;
    focusNode(node.id);
  };
  /** Abgebrochene Geste (System nimmt den Zeiger weg): nur loslassen — kein Klick, kein Schwung. */
  const onPointerCancel = (e: PointerEvent) => {
    touchPts.delete(e.pointerId);
    if (touchPts.size < 2) pinchDist = 0;
    down = null;
    releaseGrab();
    rotSamples = [];
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = control === "fly" ? "crosshair" : "grab";
  };
  const onLeave = () => {
    pendingPick = null;
    setHover(-1);
  };
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    userMoved = true;
    cancelTween();
    const w = e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
    const kind = classifyWheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, wheelDeltaX: w.wheelDeltaX, wheelDeltaY: w.wheelDeltaY }, wheelMem, performance.now());
    const a = wheelAction(kind, e, control, cssH);
    const p = local(e);
    if (a.type === "rotate") {
      // Zwei Finger: sanft umsehen (Beschleunigungs-Kurve, gleich stark in beide Richtungen).
      rig.stop();
      const r = trackpadRotation(a.dx, a.dy);
      rig.rotate(r.dTheta, r.dPhi, control === "orbit" ? rotatePivot() : null);
    } else if (a.type === "zoom") rig.zoom(a.factor, anchorAt(p.x, p.y));
    else if (a.type === "look") {
      const len = Math.hypot(a.dx, a.dy);
      const k = len > 0 ? accelCurve(len) / len : 0;
      lookAround(a.dx * k, a.dy * k);
    } else {
      const dir = anchorAt(p.x, p.y)?.sub(camera.position).normalize() ?? forward(new Vector3());
      flyVel.addScaledVector(dir, a.amount * FLY_WHEEL * FLY_DAMP * Math.max(60, sceneRadius * 0.3));
    }
    request();
  };
  // Safari: Kneifen kommt als Geste (Maßstab), nicht als Rad.
  let gestureScale = 1;
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    gestureScale = 1;
    cancelTween();
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as GestureLike;
    if (!(g.scale > 0)) return;
    const factor = Math.max(0.74, Math.min(1.35, gestureScale / g.scale));
    gestureScale = g.scale;
    userMoved = true;
    const p = local(g);
    if (control === "orbit") rig.zoom(factor, anchorAt(p.x, p.y));
    else flyVel.addScaledVector(forward(new Vector3()), -Math.log(factor) * FLY_WHEEL * FLY_DAMP * Math.max(60, sceneRadius * 0.3));
    request();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!active || e.metaKey || e.ctrlKey || e.altKey) return;
    shift = e.shiftKey;
    const act = keyAction(e.key);
    if (act === "move") {
      keys.add(e.key.toLowerCase());
      e.preventDefault();
      request();
    } else if (act === "fit") {
      userMoved = true;
      fit(700);
    } else if (act === "toggleFly") {
      setControl(control === "fly" ? "orbit" : "fly");
      cb.onControlChange?.(control);
    } else if (act === "deselect") cb.onSelect(null);
    else if (act === "open") {
      const node = selected >= 0 ? nodes[selected] : undefined;
      if (node) cb.onOpen(node);
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    shift = e.shiftKey;
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.has(k)) keys.delete(k);
  };
  const onBlur = () => keys.clear();
  const onReducedMotion = () => {
    applyMotion();
    request();
  };
  reducedMotionQuery?.addEventListener("change", onReducedMotion);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("dblclick", onDblClick);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("gesturestart", onGestureStart);
  canvas.addEventListener("gesturechange", onGestureChange);
  host.addEventListener("keydown", onKeyDown);
  host.addEventListener("keyup", onKeyUp);
  host.addEventListener("blur", onBlur);

  const resize = () => {
    const r = host.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    cssW = r.width;
    cssH = r.height;
    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
    applyShift(0, true);
    labelCanvas.width = Math.round(cssW * dpr);
    labelCanvas.height = Math.round(cssH * dpr);
    labelCanvas.style.width = `${cssW}px`;
    labelCanvas.style.height = `${cssH}px`;
    nodeUniforms.uScale.value = (cssH * dpr * 0.5) / Math.tan(((FOV / 2) * Math.PI) / 180);
    nodeUniforms.uViewport.value.set(cssW * dpr, cssH * dpr);
    request();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  if (opts.exposePerf) {
    window.__brain3dPerf = {
      get nodes() {
        return nodes.length;
      },
      get visible() {
        let c = 0;
        for (let i = 0; i < nodes.length; i++) if (!hiddenMask[i]) c += 1;
        return c;
      },
      get simRunning() {
        return simRunning;
      },
      get firstFrameMs() {
        return firstFrameMs;
      },
      get control() {
        return control;
      },
      get forces() {
        return { ...forces };
      },
      get pulse() {
        return { active: pulse !== null, edges: pulse?.from.length ?? 0, nodes: pulse?.nodes ?? 0 };
      },
      get highlight() {
        return { edges: hiTo.length, total: hiTotal, opacity: Math.round(hiOpacity.value * 1000) / 1000 };
      },
      async measure(ms: number) {
        measuring = true;
        request();
        const f0 = perf.frames;
        perf.renderMs = [];
        const tm0 = performance.now();
        await new Promise((r) => setTimeout(r, ms));
        const frames = perf.frames - f0;
        const dur = performance.now() - tm0;
        measuring = false;
        const sorted = [...perf.renderMs].sort((a, b) => a - b);
        const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
        return { fps: Math.round((frames / dur) * 10000) / 10, frames, renderMsAvg: Math.round(avg * 100) / 100, renderMsP95: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 100) / 100 };
      },
      screenPos(id: string) {
        const i = index.get(id);
        if (i === undefined) return null;
        const p = projector()(i);
        return p ? { x: p.x, y: p.y } : null;
      },
      nodePos(id: string) {
        const i = index.get(id);
        return i === undefined ? null : [pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0];
      },
      nodeLook(id: string) {
        const i = index.get(id);
        if (i === undefined) return null;
        camera.updateMatrixWorld();
        const depth = -worldPos(i, now(), new Vector3()).applyMatrix4(camera.matrixWorldInverse).z;
        const s = spriteLook({ sizeWorld: (sizeAttr.array as Float32Array)[i] ?? 0, depth, alpha: (alphaAttr.array as Float32Array)[i] ?? 0 }, { scale: nodeUniforms.uScale.value, minPx: nodeUniforms.uMinPx.value, dpr });
        return { diameterPx: s.diameterPx / dpr, alpha: s.alpha };
      },
      topNodes(count: number) {
        return byDegree
          .filter((i) => !hiddenMask[i])
          .slice(0, count)
          .map((i) => nodes[i]?.id ?? "");
      },
      cameraDistance() {
        return camera.position.length();
      },
      viewDistance() {
        return camera.position.distanceTo(currentTarget(new Vector3()));
      },
      viewShift() {
        return { x: shift2d.x, y: shift2d.y, gx: shift2d.gx, gy: shift2d.gy };
      },
      pivot() {
        const t = currentTarget(new Vector3());
        return { target: [t.x, t.y, t.z] as [number, number, number], center: [center.x, center.y, center.z] as [number, number, number] };
      },
      lod() {
        return { ...lod, edgeAlpha: lineOpacity.value };
      },
      placeNear(id: string, dist: number) {
        const i = index.get(id);
        if (i === undefined) return;
        userMoved = true;
        const target = worldPos(i, now(), new Vector3());
        const dir = v1.copy(camera.position).sub(target);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
        tweenTo(target.clone().addScaledVector(dir.normalize(), dist), target, 0);
      },
    };
  }

  return {
    setData,
    setLook,
    setForces,
    setControl,
    fit,
    focusNode,
    setActive(on: boolean) {
      active = on;
      if (!on) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        keys.clear();
      } else {
        resize();
        request();
      }
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (nodes.length > 0 && hasPos) save3d(nodes, pos);
      sim.post({ type: "stop" });
      sim.close();
      ro.disconnect();
      reducedMotionQuery?.removeEventListener("change", onReducedMotion);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("dblclick", onDblClick);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      host.removeEventListener("keydown", onKeyDown);
      host.removeEventListener("keyup", onKeyUp);
      host.removeEventListener("blur", onBlur);
      quad.dispose();
      lines.geometry.dispose();
      hiLines.geometry.dispose();
      posTex.dispose();
      pulseLines.geometry.dispose();
      pulseHeads.geometry.dispose();
      for (const m of [coreMat, glowMat, linesMat, hiMat, pulseLineMat, pulseHeadMat]) m.dispose();
      renderer.dispose();
      // dispose() gibt den WebGL-Kontext nicht frei; Chrome hält nur ~16 gleichzeitig und wirft
      // danach den ältesten weg („Too many active WebGL contexts") — nach mehrfachem Verlassen und
      // Wiederkommen der Seite. Daher ausdrücklich freigeben.
      renderer.forceContextLoss();
      canvas.remove();
      if (opts.exposePerf) window.__brain3dPerf = undefined;
    },
  };
}

export type Scene3D = ReturnType<typeof createScene3D>;
