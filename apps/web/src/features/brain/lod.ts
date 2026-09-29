// Darstellungs-Stufen für 2D und 3D (vorher wurde es beim Rauszoomen extrem schwammig). Reine Rechenregeln (getestet), die Zeichner lesen nur die Zahlen.
//
// Drei Stufen, weich ineinander übergeblendet (kein Umspringen):
// - fern: kleine, scharfe Punkte ohne Schein, Nebensächliches etwas blasser und entsättigt, Fäden
//   trotzdem sichtbar (Deckkraft mit Untergrenze), nur wenige Beschriftungen.
// - mitte: enger, zarter Schein um größere Punkte.
// - nah: volle Details und Beschriftungen.

export type LodLevel = "far" | "mid" | "near";

export interface Lod {
  /** 0 = gar nicht fern, 1 = ganz fern. */
  far: number;
  /** 0 = gar nicht nah, 1 = ganz nah. */
  near: number;
  level: LodLevel;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function lodFrom(x: number, t: { farFull: number; farNone: number; nearFrom: number; nearFull: number }): Lod {
  const v = Number.isFinite(x) ? x : 1;
  const far = 1 - smoothstep(t.farFull, t.farNone, v);
  const near = smoothstep(t.nearFrom, t.nearFull, v);
  return { far, near, level: far > 0.5 ? "far" : near > 0.5 ? "near" : "mid" };
}

/**
 * 3D: Stufe aus der Bildgröße der Wolke — Radius der Wolke auf dem Bildschirm geteilt durch die halbe
 * Bildhöhe (1 ≈ füllt das Bild; „Alles einpassen“ landet bei ~0,85). Unabhängig von Fenstergröße und Pixeldichte.
 */
export const LOD3D = { farFull: 0.3, farNone: 0.62, nearFrom: 1.7, nearFull: 3.2 } as const;
export function lod3d(cloudFrac: number): Lod {
  return lodFrom(cloudFrac, LOD3D);
}

/** 2D: Stufe aus der Bildgröße eines typischen (kleinen) Knotens, Radius in CSS-px. */
export const LOD2D = { farFull: 0.5, farNone: 1.3, nearFrom: 3, nearFull: 6 } as const;
export function lod2d(leafRadiusPx: number): Lod {
  return lodFrom(leafRadiusPx, LOD2D);
}

// --- Knoten -------------------------------------------------------------------------------------

/**
 * Welt-Radius eines Knotens: kleine Grundgröße + Wurzel aus dem Grad, Knotenpunkte gedeckelt
 * (vorher `(2 + √Grad) · 0,85` ohne Deckel — ein Knoten mit 400 Verbindungen war 7× so groß wie ein
 * Blatt und füllte nah das halbe Bild).
 */
export const NODE_BASE = 1.3;
export const NODE_DEGREE_K = 0.55;
export const NODE_MAX = 7;
export function nodeWorldRadius(degree: number, size: number): number {
  return size * Math.min(NODE_MAX, NODE_BASE + NODE_DEGREE_K * Math.sqrt(Math.max(0, degree)));
}

/** Wichtigkeit 0–1 (aus dem Grad): unwichtige Punkte werden von weitem etwas zurückgenommen. */
export function nodeImportance(degree: number): number {
  return smoothstep(3, 40, degree);
}

/** Von weitem: so viel entsättigt bzw. abgedunkelt werden unwichtige Punkte (höchstens). */
export const FAR_DESATURATE = 0.45;
export const FAR_DARKEN = 0.3;

/** Farbe eines Punkts je Stufe (wie im Shader): unwichtige von weitem entsättigt und etwas dunkler. */
export function farTone(rgb: readonly [number, number, number], importance: number, far: number): [number, number, number] {
  const k = far * (1 - Math.max(0, Math.min(1, importance)));
  const [r, g, b] = rgb;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const d = FAR_DESATURATE * k;
  const dark = 1 - FAR_DARKEN * k;
  return [(r + (l - r) * d) * dark, (g + (l - g) * d) * dark, (b + (l - b) * d) * dark];
}

// --- Schein -------------------------------------------------------------------------------------

/** Schein reicht höchstens bis zum 1,6-fachen Kern-Radius (vorher 2,6 — ein weicher Fleck um jeden Punkt). */
export const GLOW_SPAN = 1.6;
/** Deckkraft des Scheins direkt am Kernrand (fällt nach außen auf 0). */
export const GLOW_ALPHA = 0.32;
/** Schein erst ab diesem Kern-Radius (CSS-px), voll ab GLOW_FULL_PX — winzige Punkte bleiben scharf. */
export const GLOW_FROM_PX = 1.4;
export const GLOW_FULL_PX = 3.5;

/** Stärke des Scheins (0–1): aus in der Ferne, sonst nach Bildgröße des Kerns. */
export function glowAmount(lod: Pick<Lod, "far">, coreRadiusPx: number, enabled = true): number {
  if (!enabled) return 0;
  return (1 - lod.far) * smoothstep(GLOW_FROM_PX, GLOW_FULL_PX, coreRadiusPx);
}

/** Kleinster Kern-Radius auf dem Bildschirm (CSS-px): Punkte werden nie kleiner als 2 px Durchmesser. */
export const MIN_CORE_RADIUS_PX = 1;
export function clampCoreRadiusPx(px: number): number {
  return Math.max(MIN_CORE_RADIUS_PX, Number.isFinite(px) ? px : 0);
}

// --- Fäden --------------------------------------------------------------------------------------

/**
 * Deckkraft der Fäden. Vorher verschwanden sie von weitem (1-Geräte-Pixel-Linien unter den Höfen bzw.
 * in 2D bis 0,06 bei ½ px Breite). Jetzt: Grundwert je Stufe, gedämpft nach der Überdeckung (wie viele
 * Fäden im Mittel über einem Bildpunkt der Wolke liegen — sonst wird ein kleines Knäuel aus 23.000
 * Fäden ein heller Nebel über den Punkten), aber NIE unter EDGE_ALPHA_FLOOR: einzelne Fäden bleiben bei
 * jedem Zoom sichtbar.
 */
export const EDGE_ALPHA = { far: 0.15, mid: 0.22, near: 0.3 } as const;
export const EDGE_ALPHA_FLOOR = 0.06;
/** Bis zu dieser Überdeckung (Fäden je Bildpunkt) volle Grund-Deckkraft, darüber ∝ 1/Überdeckung. */
export const EDGE_OVERLAP_REF = 1.8;
export function edgeAlpha(lod: Pick<Lod, "far" | "near">, overlap = 0): number {
  const base = EDGE_ALPHA.mid + (EDGE_ALPHA.far - EDGE_ALPHA.mid) * lod.far + (EDGE_ALPHA.near - EDGE_ALPHA.mid) * lod.near;
  const damp = overlap > EDGE_OVERLAP_REF ? EDGE_OVERLAP_REF / overlap : 1;
  return Math.max(EDGE_ALPHA_FLOOR, base * damp);
}
/**
 * Mittlere Überdeckung: `edges` Fäden (mittlere Länge ≈ halber Wolkenradius) der Breite `widthPx` auf
 * einer Wolke mit Bild-Radius `radiusPx` (alles CSS-px).
 */
export function edgeOverlap(edges: number, widthPx: number, radiusPx: number): number {
  if (!(radiusPx > 1) || edges <= 0) return 0;
  return (edges * widthPx * 0.5 * radiusPx) / (Math.PI * radiusPx * radiusPx);
}
/** Faden-Breite (CSS-px) — gleich bei jedem Zoom, mindestens 1 Geräte-Pixel. */
export const EDGE_WIDTH_PX = 0.75;
export function edgeWidthDevicePx(linkWidth: number, dpr: number): number {
  return Math.max(1, EDGE_WIDTH_PX * Math.max(0.2, linkWidth) * dpr);
}
/** Fadenfarbe: Mischung der Endpunkte, ein gutes Stück Richtung neutrales Grau (weniger Farbrauschen). */
export const EDGE_NEUTRAL = [0.46, 0.47, 0.5] as const;
export function edgeNeutralMix(lod: Pick<Lod, "far">): number {
  return 0.45 + 0.2 * lod.far;
}
/** Schimmer: ein schmaler heller Streifen wandert langsam die Fäden entlang (Periode in s). */
export const SHIMMER_PERIOD_S = 7;
export const SHIMMER_GAIN = 0.9;

// --- Beschriftungen -----------------------------------------------------------------------------

/**
 * Wie viele „Orientierungs“-Beschriftungen (größte Knotenpunkte) ohne Hover/Auswahl erscheinen.
 * Ganz fern keine (sonst stapeln sie sich auf dem Knäuel), in der Mitte wenige, nah alle nahen.
 */
export function orientationLabels(lod: Pick<Lod, "far">): number {
  if (lod.far >= 0.85) return 0;
  return Math.round(8 * (1 - lod.far));
}
