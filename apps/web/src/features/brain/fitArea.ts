// „Einpassen" um überlagernde Kacheln herum: Kopf, Ansichten, Seitenblatt, Legende und
// Steuerung liegen ÜBER dem Graphen. Statt die ganze Fläche zu nehmen, passt das Gehirn in die größte
// freie Fläche daneben ein — sonst verschwindet ein Teil des Graphen unter den Kacheln.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Kacheln, die über dem Graphen liegen, markieren sich mit diesem Attribut. */
export const OVERLAY_ATTR = "data-brain-overlay";

const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Größte freie Rechteck-Fläche in `width × height`, die keine Kachel schneidet (Kacheln mit
 * `margin` Abstand). Kandidaten-Kanten sind der Rand und die Kanten der Kacheln — bei ≤ 8 Kacheln
 * sind das wenige Tausend Kombinationen. Bleibt zu wenig Platz (schmales Fenster), gibt es `null`:
 * dann normal über die ganze Fläche einpassen.
 */
export function freeArea(width: number, height: number, obstacles: Rect[], margin = 12, minShare = 0.3): Rect | null {
  if (width <= 0 || height <= 0) return null;
  const obs = obstacles
    .map((o) => ({ left: o.left - margin, top: o.top - margin, right: o.right + margin, bottom: o.bottom + margin }))
    .filter((o) => o.right > 0 && o.bottom > 0 && o.left < width && o.top < height);
  if (obs.length === 0) return { left: 0, top: 0, right: width, bottom: height };
  const clampX = (v: number) => Math.max(0, Math.min(width, v));
  const clampY = (v: number) => Math.max(0, Math.min(height, v));
  const lefts = [0, ...obs.map((o) => clampX(o.right))];
  const rights = [width, ...obs.map((o) => clampX(o.left))];
  const tops = [0, ...obs.map((o) => clampY(o.bottom))];
  const bottoms = [height, ...obs.map((o) => clampY(o.top))];
  let best: Rect | null = null;
  let bestScore = 0;
  for (const left of lefts)
    for (const right of rights) {
      if (right - left <= 0) continue;
      for (const top of tops)
        for (const bottom of bottoms) {
          if (bottom - top <= 0) continue;
          const r = { left, top, right, bottom };
          if (obs.some((o) => overlaps(r, o))) continue;
          // Fläche zählt, aber sehr schmale Streifen taugen nicht zum Einpassen (Seitenverhältnis dämpfen).
          const w = right - left;
          const h = bottom - top;
          const score = w * h * Math.min(1, (Math.min(w, h) / Math.max(w, h)) * 3);
          if (score > bestScore) {
            bestScore = score;
            best = r;
          }
        }
    }
  if (!best) return null;
  const share = Math.min((best.right - best.left) / width, (best.bottom - best.top) / height);
  return share >= minShare ? best : null;
}

/** Kacheln (mit `data-brain-overlay`) relativ zu `host` messen und die freie Fläche liefern. */
export function measureFreeArea(host: HTMLElement | null): Rect | null {
  if (!host) return null;
  const box = host.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const obstacles: Rect[] = [];
  for (const el of host.querySelectorAll<HTMLElement>(`[${OVERLAY_ATTR}]`)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    obstacles.push({ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top });
  }
  return freeArea(box.width, box.height, obstacles);
}

// Arbeitsspeicher wird wiederverwendet (wächst nur), Sortieren numerisch im Float64Array —
// keine neuen Listen bei jedem Aufruf.
let scratch = new Float64Array(0);

function medianOf(a: Float64Array): number {
  a.sort();
  const m = a.length >> 1;
  return a.length % 2 ? (a[m] ?? 0) : ((a[m - 1] ?? 0) + (a[m] ?? 0)) / 2;
}

/**
 * Damit sich die Wolke wie ein Globus dreht (statt um eine seitliche Achse): Mitte und Radius
 * der Wolke robust — Mitte je Achse als Median, Radius als 95-%-Abstand (+ kleiner Rand). Ein paar weit
 * abgedriftete Knoten ziehen weder den Drehpunkt zur Seite noch zoomen sie alles winzig (= dunkel).
 */
export function robustBounds(pos: ArrayLike<number>, hidden: ArrayLike<number>, radii?: ArrayLike<number>): { c: [number, number, number]; r: number } | null {
  const n = Math.floor(pos.length / 3);
  if (scratch.length < n) scratch = new Float64Array(Math.max(n, scratch.length * 2, 64));
  let k: number;
  const c: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    k = 0;
    for (let i = 0; i < n; i++) if (!hidden[i]) scratch[k++] = pos[i * 3 + axis] ?? 0;
    if (k === 0) return null;
    c[axis] = medianOf(scratch.subarray(0, k));
  }
  k = 0;
  for (let i = 0; i < n; i++) {
    if (hidden[i]) continue;
    scratch[k++] = Math.hypot((pos[i * 3] ?? 0) - c[0], (pos[i * 3 + 1] ?? 0) - c[1], (pos[i * 3 + 2] ?? 0) - c[2]) + (radii?.[i] ?? 0);
  }
  const d = scratch.subarray(0, k);
  d.sort();
  const q95 = d[Math.min(k - 1, Math.floor(k * 0.95))] ?? 0;
  return { c, r: q95 * 1.06 };
}

/**
 * Versatz des Bildes (CSS-px), damit die Mitte der Wolke in der Mitte der freien Fläche erscheint — über
 * `camera.setViewOffset`, NICHT über ein verschobenes Drehziel (das war die „seitliche Achse“).
 */
export function viewShiftFor(area: Pick<Rect, "left" | "right" | "top" | "bottom"> | null, cssW: number, cssH: number): { x: number; y: number } {
  if (!area) return { x: 0, y: 0 };
  const x = -((area.left + area.right) / 2 - cssW / 2);
  const y = -((area.top + area.bottom) / 2 - cssH / 2);
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}
