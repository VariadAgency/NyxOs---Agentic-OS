// Nyx' Netz in echtem 3D (three.js, eigener schlanker Aufbau wie `brain/scene3d.ts`).
//
// - Knoten: EIN instanziertes Viereck-Objekt (Kern + Hof im Shader), Kanten: EIN `LineSegments`-Objekt mit
//   laufenden Signalen im Shader, dazu leuchtende Signal-Köpfe (Punkte, Position je Bild von der CPU).
// - Kern: Billboard in der Mitte (Ball, atmender Ring, Denk-Bögen, Wellen) — pulsiert mit Nyx' Stimme.
// - Raum: Sternenfeld weit draußen und Staub um das Netz (dreht langsam gegenläufig → Tiefe).
// - Bewegung dauerhaft: langsame Drehung, leichtes Kippen, Atmen, jedes Teil schwebt (Shader).
// - Bedienung sanft: Ziehen dreht mit Schwung, zwei Finger schauen sich langsam um,
//   Kneifen zoomt; die Maus neigt die Kamera leicht mit (Parallaxe).
// - Schwenken ~60 % so empfindlich, Zieh-Tempo folgt weich, längeres Ausgleiten (`motion.ts`);
//   Kern-Kabel und Synapsen-Wolke heller (`EDGE_WEIGHT`), mehr Signal-Köpfe.
// - Zeichnet jedes Bild (Dauerbewegung), pausiert, wenn der Tab verborgen ist. `prefers-reduced-motion`:
//   kaum Drehung, kein Schweben, keine Wellen. Bildrate wird gemessen (`fps`).
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { NyxState } from "@nyxos/shared";
import { findToolIndex, targetsOfTool, type NetModel } from "../netModel";
import { NYX_SPEAK_BLEND_MS } from "../../visualSequence";
import type { LevelDrive } from "../voice/level";
import { extendLayout, layoutNet, NET_RADIUS, type NetLayout } from "./layout3d";
import {
  CORE_FRAGMENT,
  CORE_VERTEX,
  drift,
  EDGE_FRAGMENT,
  EDGE_VERTEX,
  HEAD_FRAGMENT,
  HEAD_VERTEX,
  MAX_WAVES,
  NODE_FRAGMENT,
  NODE_VERTEX,
  STAR_FRAGMENT,
  STAR_VERTEX,
} from "./shaders";
import { DRAG_PITCH_PER_PX, DRAG_YAW_PER_PX, dragVelocity, glide, WHEEL_PITCH, WHEEL_YAW } from "./motion";
import { corePulse, EDGE_CORE_END, EDGE_WEIGHT, resolveStateColors, shouldSpawnWave, visualFor, waveLift, waveRadius, WAVE_LIFE_S, type NetVisual, type Wave } from "./visual";

export interface NyxLiveInput {
  state: NyxState;
  tool: string | null;
  highlightNode: string | null;
}

export interface NyxSceneOptions {
  drive: LevelDrive;
  reducedMotion: boolean;
  live(): NyxLiveInput;
  /** Nach jedem Bild (Beschriftungen nachführen). */
  afterFrame?(scene: NyxNetScene): void;
  /** Etwa jede Sekunde: gemessene Bildrate. */
  onFps?(fps: number): void;
  /** GPU hat den Zeichenkontext verloren → Aufrufer wechselt auf die 2D-Fassung. */
  onLost?(): void;
}

export interface NyxNetScene {
  setModel(model: NetModel): void;
  /** Sichtbare Fläche (CSS-px) und wie weit rechts eine Leiste das Bild verdeckt (Netz rückt in die freie Mitte). */
  resize(width: number, height: number): void;
  setRightInset(px: number): void;
  /** Knoten unter dem Punkt (CSS-px), −1 = keiner. Nur beschriftete Dinge (keine Deko-Neuronen). */
  pick(x: number, y: number): number;
  /** Bildschirm-Position eines Knotens (CSS-px) oder null, wenn hinter der Kamera. */
  screenOf(index: number): { x: number; y: number } | null;
  /** Index des Werkzeug-Knotens, der gerade leuchtet (−1 = keiner). */
  activeTool(): number;
  /** Index des hervorgehobenen Knotens (−1 = keiner). */
  highlighted(): number;
  model(): NetModel | null;
  fps(): number;
  /** Aktuelle Rechen-Auflösung (Geräte-Pixel je CSS-Pixel), sinkt bei zu wenig fps. */
  pixelRatio(): number;
  dispose(): void;
}

const CAM_DIST = 7.2;
const ZOOM_MIN = 4.2;
const ZOOM_MAX = 11;
const FOV = 42;
const NODE_WORLD = 0.06;
const DRIFT_AMP = 0.07;
const MAX_HEADS = 240;
const STARS = 1600;
const DUST = 520;
const CORE_SIZE = NET_RADIUS * 1.45;

/**
 * Farben für Sterne und Staub: die knalligen Akzente (Tokens aus app.css, POS-Designsystem),
 * zu einem warmen Weiß hin aufgehellt — bunt, aber nie blaustichig. Rückfallwerte nur, falls ein Token fehlt.
 */
const SPACE_TOKENS: readonly [string, string][] = [
  ["--a-done", "#4da3ff"],
  ["--a-wait", "#ffb020"],
  ["--a-ok", "#2fd27a"],
  ["--a-bad", "#ff5a4e"],
  ["--a-gold", "#e3b341"],
  ["--a-conf", "#ff6b8a"],
  ["--a-violet", "#a77bff"],
  ["--a-acc", "#3cc6c0"],
];
const STAR_WHITE: [string, string] = ["--a-ink", "#f3f3ef"];

function cssColor(read: (token: string) => string, [token, fallback]: readonly [string, string]): string {
  const v = read(token).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : fallback;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

function starField(count: number, rMin: number, rMax: number, sizeMin: number, sizeMax: number, seed: number, flat: number, tints: readonly Color[], white: Color): BufferGeometry {
  const rand = rng(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seeds = new Float32Array(count);
  const c = new Color();
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = rMin + (rMax - rMin) * Math.pow(rand(), 0.7);
    pos[i * 3] = Math.cos(th) * s * r;
    pos[i * 3 + 1] = u * r * flat;
    pos[i * 3 + 2] = Math.sin(th) * s * r;
    c.copy(tints[Math.floor(rand() * tints.length)] ?? white).lerp(white, 0.25 + rand() * 0.55);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    size[i] = sizeMin + (sizeMax - sizeMin) * Math.pow(rand(), 3);
    seeds[i] = rand();
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("color", new BufferAttribute(col, 3));
  g.setAttribute("aSize", new BufferAttribute(size, 1));
  g.setAttribute("aSeed", new BufferAttribute(seeds, 1));
  return g;
}

function starMaterial(alpha: number, twinkle: number) {
  const u = { uTime: { value: 0 }, uDpr: { value: 1 }, uTwinkle: { value: twinkle }, uAlpha: { value: alpha }, uPush: { value: 0 } };
  const mat = new ShaderMaterial({
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    uniforms: u,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  return { mat, u };
}

interface Built {
  model: NetModel;
  layout: NetLayout;
  seeds: Float32Array;
  /** Knotenfarben (r, g, b je Knoten) — für die Signal-Köpfe, ohne Farb-Text je Bild zu lesen. */
  colors: Float32Array;
  nodeGeo: InstancedBufferGeometry;
  nodeMesh: Mesh;
  glow: Float32Array;
  glowTarget: Float32Array;
  glowAttr: InstancedBufferAttribute;
  edgeGeo: BufferGeometry;
  edgeLines: LineSegments;
  activeAttr: BufferAttribute;
  headGeo: BufferGeometry;
  headPoints: Points;
  headPos: Float32Array;
  headAlpha: Float32Array;
  headColor: Float32Array;
  /** Bildschirm-Positionen (CSS-px) + Radius je Knoten, jedes Bild neu. */
  sx: Float32Array;
  sy: Float32Array;
  sr: Float32Array;
  sVisible: Uint8Array;
  nodeCount: number;
}

export function createNyxScene(canvas: HTMLCanvasElement, opts: NyxSceneOptions): NyxNetScene {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  // Auflösung passt sich an: schafft die GPU keine ~45 fps, wird in Stufen gröber gerechnet (nie unter 1).
  const maxDpr = Math.min(2, window.devicePixelRatio || 1);
  let dpr = maxDpr;
  let slowSeconds = 0;
  renderer.setPixelRatio(dpr);

  // Farben einmal aus den Tokens lesen (nicht je Bild): Zustände, Werkzeug, Raum.
  const css = typeof getComputedStyle === "function" ? getComputedStyle(canvas) : null;
  const read = (token: string) => css?.getPropertyValue(token) ?? "";
  const palette = resolveStateColors(read);
  const stateColor = Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, new Color(v)])) as Record<NyxState, Color>;
  const toolColor = stateColor.tool;
  const spaceTints = SPACE_TOKENS.map((t) => new Color(cssColor(read, t)));
  const starWhite = new Color(cssColor(read, STAR_WHITE));
  // Zustands-Werte einmal vorrechnen — keine neuen Objekte je Bild.
  const visuals = Object.fromEntries((Object.keys(palette) as NyxState[]).map((k) => [k, visualFor(k, opts.reducedMotion)])) as Record<NyxState, NetVisual>;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 400);
  camera.position.set(0, 0, CAM_DIST);
  const net = new Group();
  scene.add(net);
  const space = new Group();
  scene.add(space);

  // ── Raum ──
  const { mat: starMat, u: starU } = starMaterial(0.9, 0.55);
  const stars = new Points(starField(STARS, 60, 140, 1, 3.6, 7, 0.75, spaceTints, starWhite), starMat);
  space.add(stars);
  const { mat: dustMat, u: dustU } = starMaterial(0.5, 0.3);
  const dust = new Points(starField(DUST, NET_RADIUS * 1.15, NET_RADIUS * 3.2, 1, 2.6, 11, 0.8, spaceTints, starWhite), dustMat);
  scene.add(dust);

  // ── Kern ──
  const waveUniform = Array.from({ length: MAX_WAVES }, () => new Vector2(0, 0));
  const coreU = {
    uSize: { value: CORE_SIZE },
    uTime: { value: 0 },
    uPulse: { value: 1 },
    uLevel: { value: 0 },
    uThink: { value: 0 },
    uIntensity: { value: 1 },
    uColor: { value: stateColor.idle.clone() },
    uWaves: { value: waveUniform },
  };
  const coreMat = new ShaderMaterial({
    vertexShader: CORE_VERTEX,
    fragmentShader: CORE_FRAGMENT,
    uniforms: coreU,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
  });
  const coreMesh = new Mesh(new PlaneGeometry(2, 2), coreMat);
  coreMesh.frustumCulled = false;
  coreMesh.renderOrder = 3;
  net.add(coreMesh);

  // ── Netz-Materialien (geteilt, Uniforms werden je Bild gesetzt) ──
  const shared = { uTime: { value: 0 }, uDrift: { value: opts.reducedMotion ? 0 : DRIFT_AMP }, uCamDist: { value: CAM_DIST } };
  const nodeU = { uScale: { value: 1 }, uMinPx: { value: 3 }, uViewport: { value: new Vector2(1, 1) }, uEnergy: { value: 0.6 } };
  const nodeMat = new ShaderMaterial({
    vertexShader: NODE_VERTEX,
    fragmentShader: NODE_FRAGMENT,
    uniforms: { ...shared, ...nodeU },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const edgeU = {
    uClock: { value: 0 },
    uShare: { value: 0.05 },
    uBase: { value: 0.1 },
    uTint: { value: stateColor.idle.clone() },
    uActiveColor: { value: toolColor.clone() },
  };
  const edgeMat = new ShaderMaterial({
    vertexShader: EDGE_VERTEX,
    fragmentShader: EDGE_FRAGMENT,
    uniforms: { ...shared, ...edgeU },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const headU = { uScale: { value: 1 }, uDpr: { value: dpr } };
  const headMat = new ShaderMaterial({
    vertexShader: HEAD_VERTEX,
    fragmentShader: HEAD_FRAGMENT,
    uniforms: headU,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  let built: Built | null = null;

  const disposeBuilt = () => {
    if (!built) return;
    net.remove(built.nodeMesh, built.edgeLines, built.headPoints);
    built.nodeGeo.dispose();
    built.edgeGeo.dispose();
    built.headGeo.dispose();
    built = null;
  };

  const build = (model: NetModel, prev: NetLayout | null) => {
    const layout = prev ? extendLayout(prev, model) : layoutNet(model);
    disposeBuilt();
    const n = model.nodes.length;
    const seeds = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const c = new Color();
    model.nodes.forEach((node, i) => {
      seeds[i] = (i * 0.6180339887) % 1;
      c.set(node.color);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      // Kern zeichnet das Billboard; Deko-Neuronen und Synapsen kleiner als echte Dinge.
      size[i] = node.kind === "core" ? 0 : NODE_WORLD * node.size * (node.kind === "tool" ? 1.25 : node.kind === "synapse" ? 0.9 : 1);
    });
    const nodeGeo = new InstancedBufferGeometry();
    nodeGeo.setAttribute("corner", new BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    nodeGeo.setIndex([0, 1, 2, 0, 2, 3]);
    nodeGeo.setAttribute("iPos", new InstancedBufferAttribute(layout.positions, 3));
    nodeGeo.setAttribute("iColor", new InstancedBufferAttribute(col, 3));
    nodeGeo.setAttribute("iSize", new InstancedBufferAttribute(size, 1));
    nodeGeo.setAttribute("iSeed", new InstancedBufferAttribute(seeds, 1));
    const glow = new Float32Array(n);
    const glowAttr = new InstancedBufferAttribute(glow, 1);
    glowAttr.setUsage(DynamicDrawUsage);
    nodeGeo.setAttribute("iGlow", glowAttr);
    nodeGeo.instanceCount = n;
    const nodeMesh = new Mesh(nodeGeo, nodeMat);
    nodeMesh.frustumCulled = false;
    nodeMesh.renderOrder = 2;

    const m = model.edges.length;
    const ePos = new Float32Array(m * 6);
    const eCol = new Float32Array(m * 6);
    const eSeed = new Float32Array(m * 2);
    const eT = new Float32Array(m * 2);
    const ePhase = new Float32Array(m * 2);
    const eActive = new Float32Array(m * 2);
    const eWeight = new Float32Array(m * 2);
    model.edges.forEach((e, k) => {
      const w = EDGE_WEIGHT[e.kind];
      for (let side = 0; side < 2; side++) {
        const i = side === 0 ? e.a : e.b;
        const v = k * 2 + side;
        ePos[v * 3] = layout.positions[i * 3] ?? 0;
        ePos[v * 3 + 1] = layout.positions[i * 3 + 1] ?? 0;
        ePos[v * 3 + 2] = layout.positions[i * 3 + 2] ?? 0;
        eCol[v * 3] = col[i * 3] ?? 0;
        eCol[v * 3 + 1] = col[i * 3 + 1] ?? 0;
        eCol[v * 3 + 2] = col[i * 3 + 2] ?? 0;
        eSeed[v] = seeds[i] ?? 0;
        eT[v] = side;
        ePhase[v] = e.phase;
        // Kabel am Kern: am Kern-Ende heller, läuft nach außen auf das Grundgewicht aus.
        eWeight[v] = side === 0 && e.a === 0 ? w * EDGE_CORE_END : w;
      }
    });
    const edgeGeo = new BufferGeometry();
    edgeGeo.setAttribute("position", new BufferAttribute(ePos, 3));
    edgeGeo.setAttribute("color", new BufferAttribute(eCol, 3));
    edgeGeo.setAttribute("aSeed", new BufferAttribute(eSeed, 1));
    edgeGeo.setAttribute("aT", new BufferAttribute(eT, 1));
    edgeGeo.setAttribute("aPhase", new BufferAttribute(ePhase, 1));
    edgeGeo.setAttribute("aWeight", new BufferAttribute(eWeight, 1));
    const activeAttr = new BufferAttribute(eActive, 1);
    activeAttr.setUsage(DynamicDrawUsage);
    edgeGeo.setAttribute("aActive", activeAttr);
    const edgeLines = new LineSegments(edgeGeo, edgeMat);
    edgeLines.frustumCulled = false;
    edgeLines.renderOrder = 1;

    const headPos = new Float32Array(MAX_HEADS * 3);
    const headAlpha = new Float32Array(MAX_HEADS);
    const headColor = new Float32Array(MAX_HEADS * 3);
    const headGeo = new BufferGeometry();
    headGeo.setAttribute("position", new BufferAttribute(headPos, 3).setUsage(DynamicDrawUsage));
    headGeo.setAttribute("aAlpha", new BufferAttribute(headAlpha, 1).setUsage(DynamicDrawUsage));
    headGeo.setAttribute("color", new BufferAttribute(headColor, 3).setUsage(DynamicDrawUsage));
    const headPoints = new Points(headGeo, headMat);
    headPoints.frustumCulled = false;
    headPoints.renderOrder = 4;

    net.add(edgeLines, nodeMesh, headPoints);
    built = {
      model,
      layout,
      seeds,
      colors: col,
      nodeGeo,
      nodeMesh,
      glow,
      glowTarget: new Float32Array(n),
      glowAttr,
      edgeGeo,
      edgeLines,
      activeAttr,
      headGeo,
      headPoints,
      headPos,
      headAlpha,
      headColor,
      sx: new Float32Array(n),
      sy: new Float32Array(n),
      sr: new Float32Array(n),
      sVisible: new Uint8Array(n),
      nodeCount: n,
    };
    targetsKey = -2;
    hlId = undefined;
    // Ausglimmender Werkzeug-Knoten: im neuen Netz stimmt sein Index nicht mehr (ein laufendes Werkzeug sucht neu).
    if (!toolActive) toolIdx = -1;
  };

  // ── Größe, Kamera ──
  let width = 1;
  let height = 1;
  let inset = 0;
  let insetShown = 0;
  const applyView = () => {
    camera.aspect = width / Math.max(1, height);
    // Leiste rechts: Bild so verschieben, dass das Netz in der freien Fläche mittig steht.
    camera.setViewOffset(width, height, insetShown / 2, 0, width, height);
    camera.updateProjectionMatrix();
  };
  const resize = (w: number, h: number) => {
    width = Math.max(1, w);
    height = Math.max(1, h);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    applyView();
  };

  // ── Bedienung (sanft) ──
  let yaw = 0.4;
  let yawVel = 0;
  let pitch = 0.12;
  let pitchVel = 0;
  let dist = CAM_DIST;
  let distTarget = CAM_DIST;
  let parX = 0;
  let parY = 0;
  let parTargetX = 0;
  let parTargetY = 0;
  let dragging: { id: number; x: number; y: number } | null = null;
  // Gezogene Pixel seit dem letzten Bild — das Bild macht daraus ein weich folgendes Tempo (`dragVelocity`).
  let pendX = 0;
  let pendY = 0;
  let lastInteract = -1e9;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = { id: e.pointerId, x: e.clientX, y: e.clientY };
    pendX = 0;
    pendY = 0;
  };
  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    parTargetX = ((e.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2;
    parTargetY = ((e.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2;
    if (!dragging || dragging.id !== e.pointerId) return;
    const dx = e.clientX - dragging.x;
    const dy = e.clientY - dragging.y;
    dragging.x = e.clientX;
    dragging.y = e.clientY;
    pendX += dx;
    pendY += dy;
    lastInteract = performance.now();
  };
  const onPointerUp = () => {
    dragging = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    lastInteract = performance.now();
    // Kneifen (Trackpad) bzw. Strg+Rad = Zoom; zwei Finger schieben = langsam umsehen.
    if (e.ctrlKey) {
      distTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, distTarget * Math.exp(e.deltaY * 0.01)));
      return;
    }
    const unit = e.deltaMode === 1 ? 16 : 1;
    yawVel += Math.max(-40, Math.min(40, e.deltaX * unit)) * WHEEL_YAW;
    pitchVel += Math.max(-40, Math.min(40, e.deltaY * unit)) * WHEEL_PITCH;
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    stop();
    opts.onLost?.();
  };
  canvas.addEventListener("webglcontextlost", onLost);

  // ── Zustand je Bild ──
  let angle = 0;
  let clock = 0;
  let share = 0.05;
  let energy = 0.55;
  let think = 0;
  let inLvl = 0;
  let outLvl = 0;
  let prevIn = 0;
  let lastWave = -10;
  const waves: Wave[] = [];
  const tint = stateColor.idle.clone();
  const tcol = new Color();
  let toolIdx = -1;
  let toolActive = false;
  /** Überblendzeit der Zustandsfarbe; in die Antwort (grün) langsam (NYX_SPEAK_BLEND_MS). */
  let blendMs = 450;
  let lastState: NyxState = opts.live().state;
  let hlIdx = -1;
  // undefined = nach neuem Netz neu suchen (Indizes haben sich verschoben).
  let hlId: string | null | undefined = undefined;
  // Ziele des Werkzeugs: nur neu bestimmen, wenn Werkzeug oder Netz wechseln (nicht je Bild).
  const targets = new Set<number>();
  let targetsKey = -2;
  let toolGlow = 0;
  const v3 = new Vector3();
  const d3: [number, number, number] = [0, 0, 0];
  const t0 = performance.now();
  let last = t0;
  let frames = 0;
  let fpsAt = t0;
  let fps = 0;
  let raf = 0;
  let running = false;
  let lost = false;

  const markActive = (b: Built, tool: number, targets: Set<number>) => {
    const arr = b.activeAttr.array as Float32Array;
    b.model.edges.forEach((e, k) => {
      const on = tool >= 0 && ((e.a === 0 && e.b === tool) || (e.a === tool && targets.has(e.b)) || (e.b === tool && targets.has(e.a))) ? 1 : 0;
      arr[k * 2] = on;
      arr[k * 2 + 1] = on;
    });
    b.activeAttr.needsUpdate = true;
  };

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.064, (now - last) / 1000);
    last = now;
    const t = (now - t0) / 1000;
    frames++;
    if (now - fpsAt >= 1000) {
      fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0;
      fpsAt = now;
      opts.onFps?.(fps);
      slowSeconds = fps < 45 ? slowSeconds + 1 : 0;
      if (slowSeconds >= 2 && dpr > 1) {
        dpr = Math.max(1, Math.round((dpr - 0.25) * 100) / 100);
        slowSeconds = 0;
        resize(width, height);
      }
    }
    const live = opts.live();
    const vis = visuals[live.state];
    const b = built;

    // Werkzeug- und Hervorhebungs-Knoten (neue Werkzeuge bekommen einen Platz auf dem inneren Ring).
    if (b) {
      // Endet das Werkzeug, glimmt sein Knoten langsam aus (statt mit einem Schlag weg zu sein).
      const nextTool = live.tool ? findToolIndex(b.model, live.tool, { add: true }) : -1;
      toolActive = nextTool >= 0;
      if (toolActive) toolIdx = nextTool;
      else if (toolGlow < 0.03) toolIdx = -1;
      if (b.model.nodes.length !== b.nodeCount) {
        build(b.model, b.layout);
        return;
      }
      if (live.highlightNode !== hlId) {
        hlId = live.highlightNode;
        hlIdx = hlId ? b.model.nodes.findIndex((nd) => nd.id === hlId) : -1;
      }
    }

    // Weiche Übergänge (bildraten-unabhängig).
    const ease = (ms: number) => 1 - Math.pow(0.1, (dt * 1000) / ms);
    share += (vis.signalShare - share) * ease(900);
    energy += (vis.energy - energy) * ease(600);
    think += ((live.state === "thinking" ? 1 : 0) - think) * ease(500);
    toolGlow += ((toolActive ? 1 : 0) - toolGlow) * ease(toolActive ? 350 : NYX_SPEAK_BLEND_MS);
    if (live.state !== lastState) {
      blendMs = live.state === "speaking" ? NYX_SPEAK_BLEND_MS : 450;
      lastState = live.state;
    }
    tint.lerp(stateColor[live.state], ease(blendMs));
    // Pegel: echt, sonst leise synthetisch, damit „hört zu“/„spricht“ auch ohne Ton im Browser lebt.
    let targetIn = opts.drive.input;
    let targetOut = opts.drive.output;
    if (live.state === "listening" && targetIn < 0.02) targetIn = 0.16 + 0.1 * Math.max(0, Math.sin(t * 3.1)) * Math.max(0, Math.sin(t * 1.3 + 1));
    if (live.state === "speaking") targetOut = Math.max(Math.min(1, targetOut * 1.6), 0.22 + Math.abs(Math.sin(t * 6.3)) * 0.28 * (0.6 + 0.4 * Math.sin(t * 2.1)));
    inLvl += (targetIn - inLvl) * ease(110);
    outLvl += (targetOut - outLvl) * ease(90);

    // Wellen aus dem Kern im Takt des Mikro-Pegels.
    if (shouldSpawnWave(live.state, inLvl, prevIn, t - lastWave, opts.reducedMotion)) {
      waves.push({ born: t, strength: Math.min(1, 0.35 + inLvl * 0.9) });
      lastWave = t;
      if (waves.length > MAX_WAVES) waves.shift();
    }
    prevIn = inLvl;
    while (waves.length && t - (waves[0]?.born ?? t) > WAVE_LIFE_S) waves.shift();

    // Bewegung: Drehung + Schwung + Kippen + Atmen.
    angle += vis.spin * dt;
    if (dragging) {
      // Beim Ziehen folgt das Tempo dem Finger weich; nach dem Loslassen gleitet es lange aus.
      yawVel = dragVelocity(yawVel, pendX, DRAG_YAW_PER_PX, dt);
      pitchVel = dragVelocity(pitchVel, pendY, DRAG_PITCH_PER_PX, dt);
      pendX = 0;
      pendY = 0;
    } else {
      yawVel = glide(yawVel, dt);
      pitchVel = glide(pitchVel, dt);
    }
    yaw += yawVel * dt;
    pitch += pitchVel * dt;
    // Nach dem Loslassen kippt das Netz langsam in eine angenehme Neigung zurück.
    if (now - lastInteract > 2500) pitch += (0.12 - pitch) * ease(2500);
    pitch = Math.max(-0.9, Math.min(0.9, pitch));
    const wobble = opts.reducedMotion ? 0 : 0.1 * Math.sin(t * 0.083) + 0.05 * Math.sin(t * 0.21);
    net.rotation.set(pitch + wobble, angle + yaw, opts.reducedMotion ? 0 : 0.04 * Math.sin(t * 0.11));
    const breath = opts.reducedMotion ? 1 : 1 + 0.018 * Math.sin(t * 0.55);
    net.scale.setScalar(breath);
    space.rotation.y = -angle * 0.12 + yaw * 0.05;
    space.rotation.x = 0.1 + pitch * 0.04;
    dust.rotation.y = angle * 0.35 + yaw * 0.6;
    dust.rotation.x = (pitch + wobble) * 0.6;
    distTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, distTarget));
    dist += (distTarget - dist) * ease(260);
    parX += (parTargetX - parX) * ease(900);
    parY += (parTargetY - parY) * ease(900);
    const par = opts.reducedMotion ? 0 : 0.22;
    camera.position.set(parX * par, -parY * par * 0.7, dist);
    camera.lookAt(0, 0, 0);
    insetShown += (inset - insetShown) * ease(220);
    if (Math.abs(inset - insetShown) > 0.3) applyView();

    // Uniforms
    shared.uTime.value = t;
    shared.uCamDist.value = dist;
    clock += vis.signalSpeed * dt;
    const scalePx = (height * dpr) / (2 * Math.tan((FOV * Math.PI) / 360));
    nodeU.uScale.value = scalePx;
    nodeU.uMinPx.value = 2.2 * dpr;
    nodeU.uViewport.value.set(width * dpr, height * dpr);
    nodeU.uEnergy.value = 0.55 + energy * 0.45;
    edgeU.uClock.value = clock;
    edgeU.uShare.value = share;
    edgeU.uBase.value = 0.07 + energy * 0.07;
    edgeU.uTint.value.copy(tint);
    headU.uScale.value = scalePx;
    headU.uDpr.value = dpr;
    starU.uTime.value = t;
    starU.uDpr.value = dpr;
    dustU.uTime.value = t;
    dustU.uDpr.value = dpr;
    dustU.uPush.value = live.state === "speaking" ? outLvl * 0.06 : live.state === "listening" ? inLvl * 0.05 : 0;
    const level = live.state === "speaking" ? outLvl : live.state === "listening" ? inLvl : 0;
    coreU.uTime.value = t;
    coreU.uPulse.value = corePulse(live.state, t, inLvl, outLvl, opts.reducedMotion);
    coreU.uLevel.value = level;
    coreU.uThink.value = think;
    coreU.uIntensity.value = 0.75 + energy * 0.35;
    coreU.uColor.value.copy(tint);
    for (let i = 0; i < MAX_WAVES; i++) {
      const w = waves[i];
      const u = waveUniform[i] as Vector2;
      if (!w) u.set(0, 0);
      else {
        const age = t - w.born;
        u.set(waveRadius(age, NET_RADIUS) / CORE_SIZE, w.strength * (1 - age / WAVE_LIFE_S));
      }
    }

    if (b) {
      if (targetsKey !== toolIdx) {
        targetsKey = toolIdx;
        targets.clear();
        if (toolIdx >= 0) for (const i of targetsOfTool(b.model, toolIdx)) targets.add(i);
        markActive(b, toolIdx, targets);
      }
      const n = b.nodeCount;
      const R = NET_RADIUS;
      const gt = b.glowTarget;
      for (let i = 0; i < n; i++) {
        const r = b.layout.radius[i] ?? 0;
        const seed = b.seeds[i] ?? 0;
        let g = opts.reducedMotion ? 0.05 : 0.06 + 0.06 * Math.sin(t * 0.8 + seed * 40);
        for (const w of waves) g += waveLift(w, t, r, R);
        if (live.state === "listening") {
          const node = b.model.nodes[i];
          if (node) {
            const bands = opts.drive.bands;
            const sector = Math.floor(((Math.atan2(node.y, node.x) + Math.PI) / (2 * Math.PI)) * bands.length) % Math.max(1, bands.length);
            g += (bands[sector] ?? 0) * 0.25;
          }
        } else if (live.state === "speaking") {
          g += outLvl * 0.45 * Math.max(0, 1.1 - r / R);
        }
        // Ganz mit dem Glühen skaliert – beim Übergang zu grün glimmt der Knoten gleichmäßig aus.
        if (i === toolIdx) g = Math.max(g, toolGlow * (1 + 0.08 * Math.sin(t * 5)));
        else if (targets.has(i)) g = Math.max(g, 0.5 * toolGlow);
        if (i === hlIdx) g = Math.max(g, 0.7);
        gt[i] = g;
      }

      // Signal-Köpfe (gleiche Formel wie im Kanten-Shader) — sanftes Anheben am Ziel, kein Aufblitzen.
      let heads = 0;
      const lp = b.layout.positions;
      const activeArr = b.activeAttr.array as Float32Array;
      for (let k = 0; k < b.model.edges.length && heads < MAX_HEADS; k++) {
        const e = b.model.edges[k];
        if (!e) continue;
        const active = activeArr[k * 2] ?? 0;
        const on = active > 0 ? 1 : 1 - Math.min(1, Math.max(0, (e.phase - (share - 0.04)) / 0.04));
        if (on <= 0.02) continue;
        const h = (((clock * (0.7 + e.phase * 0.6) + e.phase * 7) % 1) + 1) % 1;
        drift(b.seeds[e.a] ?? 0, t, shared.uDrift.value, d3);
        const ax = (lp[e.a * 3] ?? 0) + d3[0];
        const ay = (lp[e.a * 3 + 1] ?? 0) + d3[1];
        const az = (lp[e.a * 3 + 2] ?? 0) + d3[2];
        drift(b.seeds[e.b] ?? 0, t, shared.uDrift.value, d3);
        const bx = (lp[e.b * 3] ?? 0) + d3[0];
        const by = (lp[e.b * 3 + 1] ?? 0) + d3[1];
        const bz = (lp[e.b * 3 + 2] ?? 0) + d3[2];
        b.headPos[heads * 3] = ax + (bx - ax) * h;
        b.headPos[heads * 3 + 1] = ay + (by - ay) * h;
        b.headPos[heads * 3 + 2] = az + (bz - az) * h;
        b.headAlpha[heads] = on * Math.sin(h * Math.PI) * (active ? 0.95 : 0.7);
        if (active) tcol.copy(toolColor);
        else tcol.setRGB(b.colors[e.b * 3] ?? 1, b.colors[e.b * 3 + 1] ?? 1, b.colors[e.b * 3 + 2] ?? 1).lerp(tint, 0.3);
        b.headColor[heads * 3] = tcol.r;
        b.headColor[heads * 3 + 1] = tcol.g;
        b.headColor[heads * 3 + 2] = tcol.b;
        heads++;
        // Ankunft: Ziel leicht anheben.
        if (h > 0.82) gt[e.b] = (gt[e.b] ?? 0) + ((h - 0.82) / 0.18) * 0.22 * on;
      }
      for (let i = heads; i < MAX_HEADS; i++) b.headAlpha[i] = 0;
      (b.headGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
      (b.headGeo.getAttribute("aAlpha") as BufferAttribute).needsUpdate = true;
      (b.headGeo.getAttribute("color") as BufferAttribute).needsUpdate = true;
      b.headGeo.setDrawRange(0, Math.max(1, heads));

      const kUp = ease(120);
      const kDown = ease(520);
      for (let i = 0; i < n; i++) {
        const target = Math.min(1, gt[i] ?? 0);
        const cur = b.glow[i] ?? 0;
        b.glow[i] = cur + (target - cur) * (target > cur ? kUp : kDown);
      }
      b.glowAttr.needsUpdate = true;
    }

    renderer.render(scene, camera);

    // Bildschirm-Positionen für Treffer und Beschriftungen.
    if (b) {
      net.updateMatrixWorld();
      const lp = b.layout.positions;
      for (let i = 0; i < b.nodeCount; i++) {
        drift(b.seeds[i] ?? 0, t, shared.uDrift.value, d3);
        v3.set((lp[i * 3] ?? 0) + d3[0], (lp[i * 3 + 1] ?? 0) + d3[1], (lp[i * 3 + 2] ?? 0) + d3[2]).applyMatrix4(net.matrixWorld);
        const depth = v3.distanceTo(camera.position);
        v3.project(camera);
        b.sVisible[i] = v3.z < 1 ? 1 : 0;
        b.sx[i] = (v3.x * 0.5 + 0.5) * width;
        b.sy[i] = (-v3.y * 0.5 + 0.5) * height;
        const node = b.model.nodes[i];
        const worldSize = node?.kind === "core" ? CORE_SIZE * 0.1 : NODE_WORLD * (node?.size ?? 1);
        b.sr[i] = (worldSize * (scalePx / dpr)) / Math.max(0.1, depth);
      }
    }
    opts.afterFrame?.(api);
  };

  const start = () => {
    if (running || lost) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };
  const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);

  const api: NyxNetScene = {
    pixelRatio: () => dpr,
    setModel(model) {
      build(model, null);
    },
    resize,
    setRightInset(px) {
      inset = Math.max(0, px);
    },
    pick(x, y) {
      const b = built;
      if (!b) return -1;
      let best = -1;
      let bestD = Infinity;
      for (let i = 1; i < b.nodeCount; i++) {
        const node = b.model.nodes[i];
        if (!node || node.kind === "neuron" || node.kind === "synapse" || !b.sVisible[i]) continue;
        const d = Math.hypot((b.sx[i] ?? 0) - x, (b.sy[i] ?? 0) - y);
        if (d <= Math.max(9, (b.sr[i] ?? 0) * 1.6) && d < bestD) {
          best = i;
          bestD = d;
        }
      }
      return best;
    },
    screenOf(i) {
      const b = built;
      if (!b || i < 0 || i >= b.nodeCount || !b.sVisible[i]) return null;
      return { x: b.sx[i] ?? 0, y: b.sy[i] ?? 0 };
    },
    activeTool: () => (toolGlow > 0.05 ? toolIdx : -1),
    highlighted: () => hlIdx,
    model: () => built?.model ?? null,
    fps: () => fps,
    dispose() {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onLost);
      disposeBuilt();
      for (const o of [stars, dust]) o.geometry.dispose();
      coreMesh.geometry.dispose();
      for (const mat of [starMat, dustMat, coreMat, nodeMat, edgeMat, headMat]) mat.dispose();
      renderer.dispose();
      // Den Zeichenkontext sofort zurückgeben: Browser erlauben nur wenige gleichzeitig (Tab oft auf/zu).
      if (!lost) renderer.forceContextLoss();
    },
  };
  if (document.visibilityState !== "hidden") start();
  return api;
}
