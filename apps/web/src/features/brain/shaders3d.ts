// Shader der 3D-Ansicht + ihre Rechenregeln als TypeScript (für Tests, Treffer, Beschriftungen).
// Die GLSL-Zahlen kommen aus denselben Konstanten wie die TS-Funktionen — beide können nicht auseinanderlaufen.
//
// Renderstufen (fern/mitte/nah, `lod.ts`), enger Schein ohne weißen Mittelpunkt, Fäden als
// Bänder mit fester Bildschirm-Breite (vorher 1-Geräte-Pixel-Linien, von weitem unsichtbar).
//
// Warum große Knoten nah „wie unsichtbar“ waren (vorher `scene3d.ts`):
// 1. `gl_PointSize = clamp(px, uMinPx, 360.0)` — nah wuchs ein großer Knoten nicht mehr mit, und ein
//    Punkt verschwindet ganz, sobald seine MITTE aus dem Bild rutscht. Jetzt: Vierecke je Knoten
//    (instanziert), ohne Größen-Deckel, am Rand sauber angeschnitten.
// 2. Deckkraft unabhängig von der Nähe: die größten Knoten sind Bibliotheks-Knoten, und die sind
//    standardmäßig ausgegraut (14 %). Ein riesiger 14-%-Fleck wirkt nah wie nichts. Jetzt: je größer
//    ein Knoten auf dem Bildschirm, desto kräftiger (`spriteLook`) — von weitem bleibt alles wie es war.
// 3. Keine Tiefe (`depthWrite: false`): alles dahinter schien voll durch den nahen Knoten hindurch.
//    Jetzt: ein erster Durchgang zeichnet die deckenden Kerne mit Tiefe, der zweite den Schein.
import { EDGE_NEUTRAL, FAR_DARKEN, FAR_DESATURATE, GLOW_ALPHA, GLOW_FROM_PX, GLOW_FULL_PX, MIN_CORE_RADIUS_PX, SHIMMER_GAIN, SHIMMER_PERIOD_S } from "./lod";

/** Nahe Knoten werden mindestens so kräftig (Deckkraft). */
export const NEAR_ALPHA = 0.92;
/** Ab diesem Bild-Durchmesser (CSS-px, mit Schein) beginnt das Kräftiger-Werden, hier ist es voll. */
export const NEAR_START_PX = 80;
export const NEAR_FULL_PX = 220;
/** Ab hier gilt ein Knoten als deckend (Kern schreibt Tiefe). */
export const OPAQUE_MIN = 0.97;
/**
 * Aufhellen, wenn ein Impuls ankommt. Vorher: +80 % Größe, Hof aufgeblasen, 55 % Weiß und
 * `alpha = max(alpha, fl)` — blasse Knoten blitzten voll deckend auf, am Ende der Welle „wie ein
 * Feuerwerk“. Jetzt: gleiche Größe, gleicher Hof, nur minimal heller, sanft ein und aus.
 */
export const FLASH_BRIGHTEN = 0.2;
/** So viel Deckkraft kommt beim Aufhellen höchstens dazu (blasse Knoten bleiben blass). */
export const FLASH_ALPHA = 0.12;
/** Einblenden (s), danach Abklingen (1/s). */
export const FLASH_RISE_S = 0.28;
export const FLASH_DECAY = 2.4;
/** Nach dieser Zeit ist das Aufhellen praktisch weg (s). */
export const FLASH_FADE_S = 2;
/** Schweben: Frequenzen (rad/s) und Phasen-Faktoren je Achse. */
const DRIFT_F = [0.31, 0.23, 0.37] as const;
const DRIFT_P = [6.2831, 10.1664, 15.1673] as const;
/** Damit sich die ganze Masse mehr bewegt: Atmen (Wolke weitet sich) und leichtes Wiegen um die
 * Hochachse — beide langsam, beide um die Ruhelage (nichts driftet weg). Werte bei Schweben = 1. */
const BREATH_MAX = 0.05;
const BREATH_F = 0.42;
const SWAY_MAX = 0.07;
const SWAY_F = 0.13;
/** Schweben (0–1) → Ausschlag je Knoten in Weltmaß (eine Kante ist bei Vorgabe ~26 lang). Vorher 9. */
export const DRIFT_WORLD = 14;
/** Bei einer Auswahl (vorher wurde alles extrem dunkel) bleibt der Rest gut sichtbar, nur leicht
 * zurückgenommen — gewählter Knoten und seine direkten Nachbarn sind voll da. */
export const SELECT_REST_ALPHA = 0.4;
// Weit entfernte, winzige Punkte werden nicht mehr zurückgenommen (vorher bis 70 %, die Punkte hatten
// dadurch immer niedrige Deckkraft). Der Kern ist immer voll deckend.
/**
 * Damit Punkte scharf und klickbar sind, hat der farbige Kern
 * einen Mindest-Radius (CSS-px), der Schein wächst drum herum, alle Kanten laufen über ~1 Geräte-Pixel.
 * Früher war der Mindest-Radius 2,4 px (rausgezoomt extrem schwammig) — bei ~7.000 Knoten
 * war von weitem JEDER Punkt so groß (plus Hof bis 6 px), die Wolke wurde ein Farbnebel. Jetzt 1 px
 * (2 px Durchmesser): kleine, scharfe, einzeln erkennbare Punkte.
 */
export const MIN_CORE_PX = MIN_CORE_RADIUS_PX;
/** Treffer-Radius mindestens so groß (CSS-px) — auch kleine Punkte lassen sich sicher anklicken. */
export const PICK_MIN_PX = 8;
/** Zusätzlicher Rand um den sichtbaren Kern beim Treffen (CSS-px). */
export const PICK_PAD_PX = 3;

/** Treffer-Radius (CSS-px) für einen Kern mit Bild-Radius `corePx` (CSS-px). */
export function pickRadiusPx(corePx: number): number {
  return Math.max(PICK_MIN_PX, Math.max(MIN_CORE_PX, corePx) + PICK_PAD_PX);
}

/** Mindest-Durchmesser des ganzen Sprites (Geräte-px), damit der Kern (Anteil `core` am Radius) nie unter MIN_CORE_PX fällt. */
export function minSpritePx(core: number, dpr: number): number {
  return (2 * MIN_CORE_PX * dpr) / Math.max(0.05, core);
}

/**
 * Abstand beim Anfliegen eines Punkts (Weltmaß) — nah genug, dass er groß und klar wird, weit genug,
 * dass seine direkten Nachbarn (`neighborRadius`, typischer Abstand zu ihnen) im Bild bleiben.
 */
export function focusDistance(o: { neighborRadius: number; coreRadius: number; halfFov: number }): number {
  const fit = (o.neighborRadius * 1.25) / Math.tan(Math.max(0.05, o.halfFov));
  return Math.max(40, o.coreRadius * 14, fit);
}

export interface SpriteUniforms {
  /** Geräte-Pixel je Welteinheit in Tiefe 1. */
  scale: number;
  /** Mindest-Durchmesser (Geräte-Pixel). */
  minPx: number;
  dpr: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Was der Vertex-Shader für einen Knoten ausrechnet: Durchmesser (Geräte-px) und Deckkraft. */
export function spriteLook(n: { sizeWorld: number; depth: number; alpha: number }, u: SpriteUniforms): { diameterPx: number; alpha: number } {
  const px = (n.sizeWorld * u.scale) / Math.max(1e-3, n.depth);
  const near = n.alpha > 0 ? smoothstep(NEAR_START_PX * u.dpr, NEAR_FULL_PX * u.dpr, px) : 0;
  const a = n.alpha + (Math.max(n.alpha, NEAR_ALPHA) - n.alpha) * near;
  return { diameterPx: Math.max(px, u.minPx), alpha: a };
}

/** Versatz durchs Schweben (Weltmaß) — gleiche Formel wie im Shader. */
export function driftOffset(seed: number, t: number, amp: number): [number, number, number] {
  if (amp === 0) return [0, 0, 0];
  return [amp * Math.sin(t * DRIFT_F[0] + seed * DRIFT_P[0]), amp * Math.sin(t * DRIFT_F[1] + seed * DRIFT_P[1]), amp * Math.sin(t * DRIFT_F[2] + seed * DRIFT_P[2])];
}

/** Wie stark sich alles von selbst bewegt. „Bewegung reduzieren“ (System) oder Schweben 0 → ganz still. */
export interface Motion {
  /** Ausschlag je Knoten (Weltmaß). */
  drift: number;
  /** Atmen: relative Weitung der ganzen Wolke. */
  breath: number;
  /** Wiegen um die Hochachse (rad). */
  sway: number;
  /** Mitte der Wolke — Atmen und Wiegen gehen um diesen Punkt, nicht um den Ursprung. */
  center?: readonly [number, number, number];
}

export function motionParams(drift: number, reducedMotion: boolean): Motion {
  const d = Math.max(0, Math.min(1, drift));
  if (reducedMotion || d === 0) return { drift: 0, breath: 0, sway: 0 };
  return { drift: d * DRIFT_WORLD, breath: d * BREATH_MAX, sway: d * SWAY_MAX };
}

/** Gezeichnete Lage eines Knotens (Physik-Lage + Atmen + Wiegen + Schweben) — gleiche Formel wie im Shader. */
export function animatePos(p: ArrayLike<number>, seed: number, t: number, m: Motion): [number, number, number] {
  return animatePosInto([0, 0, 0], p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, seed, t, m);
}

/** Wie `animatePos`, schreibt aber in `out` — ohne Speicher je Aufruf (läuft je Bild für alle Knoten). */
export function animatePosInto<T extends { 0: number; 1: number; 2: number }>(out: T, px: number, py: number, pz: number, seed: number, t: number, m: Motion): T {
  const b = 1 + m.breath * Math.sin(t * BREATH_F);
  const a = m.sway * Math.sin(t * SWAY_F);
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const [cx, cy, cz] = m.center ?? [0, 0, 0];
  const x = (px - cx) * b;
  const y = (py - cy) * b;
  const z = (pz - cz) * b;
  const d = m.drift;
  out[0] = cx + x * c + z * sn + d * Math.sin(t * DRIFT_F[0] + seed * DRIFT_P[0]);
  out[1] = cy + y + d * Math.sin(t * DRIFT_F[1] + seed * DRIFT_P[1]);
  out[2] = cz - x * sn + z * c + d * Math.sin(t * DRIFT_F[2] + seed * DRIFT_P[2]);
  return out;
}

/** Umkehrung von `animatePos`: gezeichnete Lage → Physik-Lage (Knoten ziehen). */
export function unanimatePos(w: ArrayLike<number>, seed: number, t: number, m: Motion): [number, number, number] {
  const b = 1 + m.breath * Math.sin(t * BREATH_F);
  const a = m.sway * Math.sin(t * SWAY_F);
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const [dx, dy, dz] = driftOffset(seed, t, m.drift);
  const [cx, cy, cz] = m.center ?? [0, 0, 0];
  const x = (w[0] ?? 0) - dx - cx;
  const y = (w[1] ?? 0) - dy - cy;
  const z = (w[2] ?? 0) - dz - cz;
  return [cx + (x * c - z * sn) / b, cy + y / b, cz + (x * sn + z * c) / b];
}

/** Verlauf des Aufhellens über die Zeit seit der Ankunft (s): weich ein, langsam aus, 0…1. */
export function flashEnvelope(dt: number): number {
  if (!(dt > 0)) return 0;
  return smoothstep(0, FLASH_RISE_S, dt) * Math.exp(-Math.max(0, dt - FLASH_RISE_S) * FLASH_DECAY);
}

/** Was das Aufhellen mit einem Knoten macht (wie im Shader): minimal heller, Größe bleibt. */
export function flashLook(fl: number, alpha: number): { brighten: number; sizeFactor: number; alpha: number } {
  return { brighten: fl * FLASH_BRIGHTEN, sizeFactor: 1, alpha: alpha > 0 ? Math.min(1, alpha + fl * FLASH_ALPHA) : alpha };
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

const DRIFT_GLSL = /* glsl */ `
uniform float uTime;
uniform float uDrift;
uniform float uBreath;
uniform float uSway;
uniform vec3 uCenter;
vec3 drift(float s) {
  return uDrift * vec3(sin(uTime * ${f(DRIFT_F[0])} + s * ${f(DRIFT_P[0])}), sin(uTime * ${f(DRIFT_F[1])} + s * ${f(DRIFT_P[1])}), sin(uTime * ${f(DRIFT_F[2])} + s * ${f(DRIFT_P[2])}));
}
// Physik-Lage → gezeichnete Lage (wie animatePos): atmen, wiegen, schweben.
vec3 animate(vec3 p, float s) {
  float b = 1.0 + uBreath * sin(uTime * ${f(BREATH_F)});
  float a = uSway * sin(uTime * ${f(SWAY_F)});
  float c = cos(a);
  float sn = sin(a);
  vec3 q = (p - uCenter) * b;
  return uCenter + vec3(q.x * c + q.z * sn, q.y, -q.x * sn + q.z * c) + drift(s);
}`;

/**
 * Knoten als Viereck je Instanz: scharfer Kern + enger Schein, nah kräftig, minimal heller, wenn ein
 * Impuls ankommt. Der Schein hängt an der Renderstufe (`uFar`, fern aus) und an der Bildgröße des Kerns
 * (winzige Punkte ohne Schein); unwichtige Punkte (`iImp`) werden von weitem etwas entsättigt und dunkler.
 */
export const NODE_VERTEX = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute vec3 iColor;
attribute float iSize;
attribute float iAlpha;
attribute float iSeed;
attribute float iFlash;
attribute float iFlashGain;
attribute float iImp;
uniform float uScale;
uniform float uMinPx;
uniform float uDpr;
uniform vec2 uViewport;
uniform float uCore;
uniform float uGlow;
uniform float uFar;
varying vec3 vColor;
varying float vAlpha;
varying float vCoreAlpha;
varying vec2 vUv;
varying float vFlash;
varying float vHalfPx;
varying float vGlow;
${DRIFT_GLSL}
void main() {
  float dt = uTime - iFlash;
  float fl = dt > 0.0 ? smoothstep(0.0, ${f(FLASH_RISE_S)}, dt) * exp(-max(0.0, dt - ${f(FLASH_RISE_S)}) * ${f(FLASH_DECAY)}) * iFlashGain : 0.0;
  vec4 mv = modelViewMatrix * vec4(animate(iPos, iSeed), 1.0);
  float px = iSize * uScale / max(0.001, -mv.z);
  float d = max(px, uMinPx);
  vec4 clip = projectionMatrix * mv;
  clip.xy += corner * d / uViewport * clip.w;
  gl_Position = clip;
  vHalfPx = d * 0.5;
  float near = iAlpha > 0.0 ? smoothstep(${f(NEAR_START_PX)} * uDpr, ${f(NEAR_FULL_PX)} * uDpr, px) : 0.0;
  float a = iAlpha + (max(iAlpha, ${f(NEAR_ALPHA)}) - iAlpha) * near;
  // Ob ein Kern deckend gezeichnet wird, hängt nie am Aufhellen (sonst „ploppt“ er kurz um).
  vCoreAlpha = a;
  if (iAlpha > 0.0) a = min(1.0, a + fl * ${f(FLASH_ALPHA)});
  vAlpha = a;
  // Schein: fern aus, sonst erst ab einer gewissen Kerngröße (CSS-px) — kein Nebel aus Tausenden Höfen.
  float coreCss = uCore * vHalfPx / uDpr;
  vGlow = uGlow * (1.0 - uFar) * smoothstep(${f(GLOW_FROM_PX)}, ${f(GLOW_FULL_PX)}, coreCss);
  float k = uFar * (1.0 - iImp);
  float l = dot(iColor, vec3(0.2126, 0.7152, 0.0722));
  vColor = mix(iColor, vec3(l), ${f(FAR_DESATURATE)} * k) * (1.0 - ${f(FAR_DARKEN)} * k);
  vUv = corner;
  vFlash = fl;
}`;

/** Aufhellen in der eigenen Farbe (vorher Richtung Weiß — viele Treffer wirkten wie ein weißer Blitz). */
const FLASH_LIFT_GLSL = /* glsl */ `
vec3 flashLift(vec3 c, float fl) {
  return mix(c, min(c * 1.6 + 0.04, vec3(1.0)), fl * ${f(FLASH_BRIGHTEN * 2.5)});
}`;

/**
 * Aussehen eines Knotens in Geräte-Pixeln (r = Abstand zur Mitte): farbiger Kern (100 %) mit Kante über
 * ~1 Geräte-Pixel (scharf bei jedem Zoom), außen ein enger Schein (bis GLOW_SPAN × Kern), der schnell
 * ausläuft. Ohne weißen Punkt in der Mitte.
 * Ergebnis: rgb + Deckkraft-Anteil (0–1, vor vAlpha).
 */
const NODE_SHADE_GLSL = /* glsl */ `${FLASH_LIFT_GLSL}
uniform float uCore;
varying vec3 vColor;
varying float vAlpha;
varying float vCoreAlpha;
varying vec2 vUv;
varying float vFlash;
varying float vHalfPx;
varying float vGlow;
vec4 nodeShade(float r) {
  float coreR = uCore * vHalfPx;
  float core = 1.0 - smoothstep(coreR - 0.5, coreR + 0.5, r);
  float t = clamp((r - coreR) / max(1.0, vHalfPx - coreR), 0.0, 1.0);
  float halo = (1.0 - t) * (1.0 - t) * (1.0 - t) * vGlow * ${f(GLOW_ALPHA)};
  vec3 col = flashLift(vColor, vFlash);
  return vec4(col, max(core, halo));
}`;

/** Zweiter Durchgang: Kern + Schein, gemischt (Kerne, die nicht deckend sind, und der Schein aller). */
export const NODE_GLOW_FRAGMENT = /* glsl */ `${NODE_SHADE_GLSL}
void main() {
  float d = length(vUv);
  if (d > 1.0 || vAlpha < 0.004) discard;
  float r = d * vHalfPx;
  vec4 s = nodeShade(r);
  float a = s.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(s.rgb, a);
}`;

/** Erster Durchgang: nur deckende Kerne, schreibt Tiefe — dahinter scheint nichts mehr durch. */
export const NODE_CORE_FRAGMENT = /* glsl */ `${NODE_SHADE_GLSL}
void main() {
  float r = length(vUv) * vHalfPx;
  float coreR = uCore * vHalfPx;
  if (vCoreAlpha < ${f(OPAQUE_MIN)} || r > coreR - 0.5) discard;
  gl_FragColor = vec4(nodeShade(r).rgb, 1.0);
}`;

/** Breite des zarten Faden-Scheins je Seite (CSS-px, mal DPR) und seine Deckkraft am Rand des Fadens. */
export const EDGE_FEATHER_PX = 1;
export const EDGE_GLOW_ALPHA = 0.25;

/**
 * Fäden als Bänder (ein Viereck je Kante, instanziert): feste Breite auf dem Bildschirm (`uWidth`,
 * Geräte-px) statt `gl.LINES` (immer genau 1 Geräte-Pixel = auf Retina ½ px — von weitem unsichtbar).
 * Die Lage beider Enden kommt aus einer Positions-Textur (xyz + Schweben-Samen in w), so muss je
 * Physik-Schritt nur die Textur (~7.000 Texel) neu, nicht ~23.000 Kanten. Enden hinter der Kamera werden
 * an der Nahebene abgeschnitten.
 */
export const EDGE_VERTEX = /* glsl */ `
attribute vec2 corner;
attribute float iA;
attribute float iB;
attribute vec3 iColA;
attribute vec3 iColB;
uniform sampler2D uPos;
uniform float uTexW;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uFeather;
uniform float uNear;
varying vec3 vColor;
varying float vSide;
varying float vAlong;
varying float vSeed;
${DRIFT_GLSL}
vec4 nodeAt(float i) {
  float y = floor((i + 0.5) / uTexW);
  float x = i - y * uTexW;
  return texelFetch(uPos, ivec2(int(x + 0.5), int(y + 0.5)), 0);
}
void main() {
  vec4 A = nodeAt(iA);
  vec4 B = nodeAt(iB);
  vec4 va = modelViewMatrix * vec4(animate(A.xyz, A.w), 1.0);
  vec4 vb = modelViewMatrix * vec4(animate(B.xyz, B.w), 1.0);
  float lim = -uNear;
  vColor = corner.x < 0.5 ? iColA : iColB;
  vAlong = corner.x;
  vSeed = fract(A.w * 7.31 + B.w * 3.17);
  vSide = 0.0;
  if (va.z > lim && vb.z > lim) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  if (va.z > lim) va = mix(vb, va, (lim - vb.z) / (va.z - vb.z));
  else if (vb.z > lim) vb = mix(va, vb, (lim - va.z) / (vb.z - va.z));
  vec4 ca = projectionMatrix * va;
  vec4 cb = projectionMatrix * vb;
  vec2 sa = ca.xy / ca.w * uViewport * 0.5;
  vec2 sb = cb.xy / cb.w * uViewport * 0.5;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = uWidth * 0.5 + uFeather;
  vec4 c = corner.x < 0.5 ? ca : cb;
  c.xy += nrm * corner.y * hw / (uViewport * 0.5) * c.w;
  gl_Position = c;
  vSide = corner.y * hw;
}`;

/**
 * Faden: scharfer Kern (Kante über ~1 Geräte-Pixel), daneben ein ganz zarter Schein, Farbe der Enden
 * ein gutes Stück Richtung Grau (`uNeutral`), und ein schmaler heller Streifen, der langsam entlangwandert
 * (Schimmer; aus bei „Bewegung reduzieren“).
 */
export const EDGE_FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform float uWidth;
uniform float uFeather;
uniform float uNeutral;
uniform float uShimmer;
uniform float uTime;
varying vec3 vColor;
varying float vSide;
varying float vAlong;
varying float vSeed;
const vec3 NEUTRAL = vec3(${f(EDGE_NEUTRAL[0])}, ${f(EDGE_NEUTRAL[1])}, ${f(EDGE_NEUTRAL[2])});
void main() {
  float d = abs(vSide);
  float hw = uWidth * 0.5;
  float core = 1.0 - smoothstep(hw - 0.5, hw + 0.5, d);
  float g = clamp((d - hw) / max(uFeather, 0.001), 0.0, 1.0);
  float glow = (1.0 - g) * (1.0 - g) * ${f(EDGE_GLOW_ALPHA)};
  float x = vAlong - (fract(uTime / ${f(SHIMMER_PERIOD_S)} + vSeed) * 1.6 - 0.3);
  float sh = exp(-x * x * 60.0) * uShimmer;
  vec3 col = mix(vColor, NEUTRAL, uNeutral);
  col = mix(col, clamp(col * 1.4 + 0.08, 0.0, 1.0), sh);
  float a = max(core, glow) * uOpacity * (1.0 + ${f(SHIMMER_GAIN)} * sh);
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, min(1.0, a));
}`;

/**
 * Lichtimpuls wie in Glasfaser: ein kleiner heller Kopf mit kurzem Schweif, der die Kante entlang zum
 * Nachbarn läuft. Vorher additiv, mit langem Schweif und Nachglühen der ganzen Faser — bei einem
 * Knoten mit 70 Verbindungen schossen helle Strahlen sternförmig über den ganzen Bildschirm. Jetzt:
 * normal gemischt (viele Impulse summieren sich nicht zu Weiß), gedeckelt, kurz, ohne Nachglühen.
 */
export const PULSE_TRAVEL_S = 0.6;
export const PULSE_ADDITIVE = false;
/** Kräftig (zwischenzeitlich waren die Glasfaserblitze komplett dunkel) — die Menge begrenzt jetzt
 * PULSE_SOURCE_CAP (nächste Kanten), nicht die Helligkeit. */
export const PULSE_LINE_MAX_ALPHA = 0.78;
const PULSE_HEAD_SHARP = 90;
const PULSE_TRAIL_K = 9;
const PULSE_TRAIL_A = 0.3;
const PULSE_FADE_END = 1.25;
const PULSE_HEAD_BASE = 0.18;
const PULSE_HEAD_PEAK = 0.8;

/** Deckkraft der Faser an Stelle `t` (0 = Start, 1 = Ziel), wenn der Kopf bei `head` ist — wie im Shader. */
export function pulseLineAlpha(t: number, head: number, gain: number): number {
  if (head <= 0) return 0;
  const x = t - head;
  const h = Math.exp(-x * x * PULSE_HEAD_SHARP);
  const trail = x < 0 ? Math.exp(x * PULSE_TRAIL_K) * PULSE_TRAIL_A : 0;
  const fade = 1 - smoothstep(1, PULSE_FADE_END, head);
  return Math.min(PULSE_LINE_MAX_ALPHA, (h + trail) * fade) * Math.max(0, Math.min(1, gain));
}

/** Deckkraft des wandernden Kopfes (nur unterwegs sichtbar) — wie im Shader. */
export function pulseHeadAlpha(head: number, gain: number): number {
  if (!(head > 0 && head < 1)) return 0;
  return (Math.sin(head * Math.PI) * PULSE_HEAD_PEAK + PULSE_HEAD_BASE) * Math.max(0, Math.min(1, gain));
}

export const PULSE_LINE_VERTEX = /* glsl */ `
attribute vec3 color;
attribute float aSeed;
attribute float aT;
attribute float aDelay;
attribute float aGain;
attribute float aTravel;
uniform float uStart;
varying vec3 vColor;
varying float vT;
varying float vHead;
varying float vGain;
${DRIFT_GLSL}
void main() {
  vColor = color;
  vT = aT;
  vGain = aGain;
  vHead = (uTime - uStart - aDelay) / aTravel;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(animate(position, aSeed), 1.0);
}`;
export const PULSE_LINE_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vT;
varying float vHead;
varying float vGain;
void main() {
  if (vHead <= 0.0) discard;
  float x = vT - vHead;
  float head = exp(-x * x * ${f(PULSE_HEAD_SHARP)});
  float trail = x < 0.0 ? exp(x * ${f(PULSE_TRAIL_K)}) * ${f(PULSE_TRAIL_A)} : 0.0;
  float fade = 1.0 - smoothstep(1.0, ${f(PULSE_FADE_END)}, vHead);
  float a = min(${f(PULSE_LINE_MAX_ALPHA)}, (head + trail) * fade) * vGain;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(vColor, min(vColor * 1.45 + 0.06, vec3(1.0)), head), a);
}`;

/** Kleiner leuchtender Kopf des Impulses (Punkt-Sprite, wandert von a nach b), ohne Strahlenkranz. */
export const PULSE_HEAD_VERTEX = /* glsl */ `
attribute vec3 aA;
attribute vec3 aB;
attribute float aSeedA;
attribute float aSeedB;
attribute float aDelay;
attribute float aGain;
attribute float aTravel;
attribute vec3 color;
uniform float uStart;
uniform float uScale;
uniform float uDpr;
varying vec3 vColor;
varying float vA;
${DRIFT_GLSL}
void main() {
  float h = (uTime - uStart - aDelay) / aTravel;
  vec3 p = mix(animate(aA, aSeedA), animate(aB, aSeedB), clamp(h, 0.0, 1.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vA = (h > 0.0 && h < 1.0) ? (sin(h * 3.14159) * ${f(PULSE_HEAD_PEAK)} + ${f(PULSE_HEAD_BASE)}) * aGain : 0.0;
  gl_PointSize = vA > 0.0 ? clamp(5.0 * uScale / max(1.0, -mv.z), 3.5 * uDpr, 12.0 * uDpr) : 0.0;
  vColor = color;
}`;
export const PULSE_HEAD_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vA;
void main() {
  if (vA <= 0.0) discard;
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 0.45, d);
  float glow = (1.0 - d) * (1.0 - d);
  float a = max(core, glow * 0.5) * vA;
  gl_FragColor = vec4(mix(vColor, min(vColor * 1.5 + 0.08, vec3(1.0)), core), a);
}`;
