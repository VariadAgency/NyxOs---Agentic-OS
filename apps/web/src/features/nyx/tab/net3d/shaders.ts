// Shader des 3D-Netzes. Aufbau wie im Gehirn (`brain/shaders3d.ts`): Knoten als instanzierte
// Vierecke mit Kern + weichem Hof, Schweben im Shader, Kanten als ein `LineSegments`-Objekt. Dazu der
// leuchtende Kern (Billboard mit Ring, Bögen und Wellen, Idee aus adewaskar/jarvis `scene/Core.tsx`, MIT —
// eigene, vereinfachte Fassung ohne Rauschen), laufende Signale auf den Kanten und ein Sternenfeld.
// Die Schwebe-Formel gibt es hier auch als TypeScript (`drift`), damit Signal-Köpfe und Beschriftungen
// exakt an den Knoten sitzen.

/** Schweben: Frequenzen (rad/s) und Phasen-Faktoren je Achse. */
const DRIFT_F = [0.29, 0.21, 0.35] as const;
const DRIFT_P = [6.2831, 10.1664, 15.1673] as const;

export function drift(seed: number, t: number, amp: number, out: [number, number, number]): [number, number, number] {
  out[0] = amp * Math.sin(t * DRIFT_F[0] + seed * DRIFT_P[0]);
  out[1] = amp * Math.sin(t * DRIFT_F[1] + seed * DRIFT_P[1]);
  out[2] = amp * Math.sin(t * DRIFT_F[2] + seed * DRIFT_P[2]);
  return out;
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

const DRIFT_GLSL = /* glsl */ `
uniform float uTime;
uniform float uDrift;
vec3 drift(float s) {
  return uDrift * vec3(sin(uTime * ${f(DRIFT_F[0])} + s * ${f(DRIFT_P[0])}), sin(uTime * ${f(DRIFT_F[1])} + s * ${f(DRIFT_P[1])}), sin(uTime * ${f(DRIFT_F[2])} + s * ${f(DRIFT_P[2])}));
}`;

/** Tiefe → Helligkeit: vorne voll, hinten gedämpft (Raumtiefe ohne Nebel-Objekt). */
const FADE_GLSL = /* glsl */ `
uniform float uCamDist;
float depthFade(float z) {
  return clamp(1.18 - (-z - uCamDist) * 0.26, 0.28, 1.0);
}`;

export const NODE_VERTEX = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute vec3 iColor;
attribute float iSize;
attribute float iSeed;
attribute float iGlow;
uniform float uScale;
uniform float uMinPx;
uniform vec2 uViewport;
varying vec3 vColor;
varying vec2 vUv;
varying float vGlow;
varying float vFade;
${DRIFT_GLSL}
${FADE_GLSL}
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos + drift(iSeed), 1.0);
  float px = iSize * (1.0 + iGlow * 0.7) * uScale / max(0.001, -mv.z);
  float d = iSize > 0.0 ? max(px, uMinPx) : 0.0;
  vec4 clip = projectionMatrix * mv;
  clip.xy += corner * d / uViewport * clip.w;
  gl_Position = clip;
  vColor = iColor;
  vUv = corner;
  vGlow = iGlow;
  vFade = depthFade(mv.z);
}`;

export const NODE_FRAGMENT = /* glsl */ `
uniform float uEnergy;
varying vec3 vColor;
varying vec2 vUv;
varying float vGlow;
varying float vFade;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float aa = fwidth(r) * 1.5;
  float core = 1.0 - smoothstep(0.2 - aa, 0.2, r);
  float halo = pow(1.0 - r, 2.4) * (0.32 + vGlow * 0.75);
  float a = (core * (0.62 + vGlow * 0.38) + halo) * vFade * uEnergy;
  if (a < 0.004) discard;
  vec3 col = mix(vColor, vec3(1.0), core * (0.18 + vGlow * 0.3));
  gl_FragColor = vec4(col, min(1.0, a));
}`;

/**
 * Kanten mit laufenden Signalen: `aT` = 0 am Anfang, 1 am Ende der Kante (wird über die Linie interpoliert),
 * `uClock` ist eine Signal-Uhr (läuft je Zustand schneller/langsamer, ohne Sprünge).
 */
export const EDGE_VERTEX = /* glsl */ `
attribute vec3 color;
attribute float aSeed;
attribute float aT;
attribute float aPhase;
attribute float aActive;
attribute float aWeight;
varying vec3 vColor;
varying float vT;
varying float vPhase;
varying float vActive;
varying float vFade;
varying float vWeight;
${DRIFT_GLSL}
${FADE_GLSL}
void main() {
  vec4 mv = modelViewMatrix * vec4(position + drift(aSeed), 1.0);
  gl_Position = projectionMatrix * mv;
  vColor = color;
  vT = aT;
  vPhase = aPhase;
  vActive = aActive;
  vWeight = aWeight;
  vFade = depthFade(mv.z);
}`;

export const EDGE_FRAGMENT = /* glsl */ `
uniform float uClock;
uniform float uShare;
uniform float uBase;
uniform vec3 uTint;
uniform vec3 uActiveColor;
varying vec3 vColor;
varying float vT;
varying float vPhase;
varying float vActive;
varying float vFade;
varying float vWeight;
void main() {
  float on = max(1.0 - smoothstep(uShare - 0.04, uShare, vPhase), vActive);
  float h = fract(uClock * (0.7 + vPhase * 0.6) + vPhase * 7.0);
  float x = vT - h;
  float head = exp(-x * x * 220.0);
  float trail = x < 0.0 ? exp(x * 7.0) * 0.35 : 0.0;
  float sig = (head + trail) * on;
  // Am Kern-Ende (vWeight über 2,9) nimmt das Kabel die Zustandsfarbe des Kerns an – es glimmt aus ihm heraus.
  vec3 base = mix(mix(vColor, uTint, 0.25 + 0.5 * clamp(vWeight - 2.9, 0.0, 1.0)), uActiveColor, vActive);
  // Kern-Kabel (vWeight > 1) leuchten im Grund heller, zum Kern hin am hellsten; Signale etwas kräftiger.
  float a = (uBase * vWeight * (1.0 + vActive * 2.2) + sig * (0.6 + vActive * 0.3) * min(1.35, 0.75 + vWeight * 0.25)) * vFade;
  gl_FragColor = vec4(mix(base, vec3(1.0), head * on * 0.35), a);
}`;

/** Leuchtende Köpfe der Signale (Punkte, Position kommt je Bild von der CPU). */
export const HEAD_VERTEX = /* glsl */ `
attribute float aAlpha;
attribute vec3 color;
uniform float uScale;
uniform float uDpr;
varying float vA;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aAlpha > 0.0 ? clamp(0.05 * uScale / max(0.5, -mv.z), 3.0 * uDpr, 22.0 * uDpr) : 0.0;
  vA = aAlpha;
  vColor = color;
}`;

export const HEAD_FRAGMENT = /* glsl */ `
varying float vA;
varying vec3 vColor;
void main() {
  if (vA <= 0.0) discard;
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 0.3, d);
  float glow = (1.0 - d) * (1.0 - d);
  gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.6), (core * 0.8 + glow * 0.55) * vA);
}`;

export const MAX_WAVES = 6;

/** Kern: Billboard in der Mitte — heller Ball, atmender Ring, Denk-Bögen, Wellen nach außen. */
export const CORE_VERTEX = /* glsl */ `
uniform float uSize;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
}`;

export const CORE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform float uLevel;
uniform float uThink;
uniform float uIntensity;
uniform vec3 uColor;
uniform vec2 uWaves[${MAX_WAVES}];
varying vec2 vUv;
float sq(float x) { return x * x; }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float rc = 0.075 * uPulse;
  float core = 1.0 - smoothstep(rc * 0.45, rc, r);
  float glow = exp(-(r * r) / (rc * rc * 7.0)) * (0.5 + uLevel * 0.5);
  float haze = exp(-r * 5.5) * 0.22;
  float wob = 0.0045 * sin(ang * 3.0 + uTime * 0.9) + 0.003 * sin(ang * 5.0 - uTime * 1.3) + 0.002 * sin(ang * 8.0 + uTime * 1.7);
  float ringR = rc * 1.6 + wob * (1.0 + uLevel * 1.2);
  float ringW = 0.005 + uLevel * 0.004;
  float ring = exp(-sq((r - ringR) / ringW)) * (0.3 + uLevel * 0.3);
  float ring2 = exp(-sq((r - rc * 2.05 - wob * 0.6) / 0.0035)) * 0.12;
  float arcR = rc * 2.3;
  float arcs = uThink * exp(-sq((r - arcR) / 0.006)) * smoothstep(0.35, 1.0, sin(ang * 3.0 - uTime * 2.2));
  float waves = 0.0;
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    vec2 w = uWaves[i];
    if (w.y > 0.0) waves += w.y * exp(-sq((r - w.x) / (0.012 + w.x * 0.03)));
  }
  float a = (core + glow * 0.85 + haze + ring + ring2 + arcs * 0.7 + waves * 0.5) * uIntensity;
  a *= 1.0 - smoothstep(0.85, 1.0, r);
  vec3 col = mix(uColor, vec3(1.0), clamp(core * 0.7 + glow * 0.15, 0.0, 1.0));
  gl_FragColor = vec4(col, min(1.0, a));
}`;

/** Sterne und Staub: Punkte mit leichtem Funkeln. */
export const STAR_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aSeed;
attribute vec3 color;
uniform float uTime;
uniform float uDpr;
uniform float uTwinkle;
uniform float uPush;
varying float vA;
varying vec3 vColor;
void main() {
  vec3 p = position * (1.0 + uPush);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 1.0 - uTwinkle * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 1.7) + aSeed * 40.0));
  vA = tw;
  vColor = color;
  gl_PointSize = aSize * uDpr;
}`;

export const STAR_FRAGMENT = /* glsl */ `
uniform float uAlpha;
varying float vA;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  if (d > 1.0) discard;
  float a = pow(1.0 - d, 2.0) * vA * uAlpha;
  gl_FragColor = vec4(vColor, a);
}`;
