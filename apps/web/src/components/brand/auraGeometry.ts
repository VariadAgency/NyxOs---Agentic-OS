// Form des NyxOS-Logos (die lila Aura aus dem Nyx-Tab) – EINE Quelle für das lebendige Logo in der App
// (`NyxAura.tsx`) und das stille Web-App-Symbol (`public/favicon.svg` + PNGs, erzeugt von `scripts/make-icons.mjs`).
// Bewusst ohne Importe und nur mit löschbaren Typen: Node 24 lädt die Datei im Skript direkt (ohne Übersetzer).
// Koordinaten: viewBox -50 … 50, Mitte 0/0.

/** Eine Welle auf dem Ring: Ausschlag (Einheiten), Anzahl Beulen, Phase (rad). */
export type Wave = readonly [amp: number, lobes: number, phase: number];

export interface RingShape {
  r: number;
  waves: readonly Wave[];
}

/** Heller Kern (weiches Glühen bis zu diesem Radius). */
export const CORE_R = 19;
/** Innerer, kräftiger Ring – leicht wellig wie im Nyx-Tab. */
export const RING_INNER: RingShape = { r: 27, waves: [[1.9, 5, 0.3], [0.9, 3, 1.7]] };
/** Derselbe Ring stark wabernd – wird mit dem Pegel eingeblendet (spricht jemand, wabert der Ring). */
export const RING_WOBBLE: RingShape = { r: 27.5, waves: [[4.2, 6, 0.9], [1.6, 4, 2.4]] };
/** Zweiter, blasserer Ring außen. */
export const RING_OUTER: RingShape = { r: 37.5, waves: [[1.3, 4, 1.1], [0.7, 7, 0.2]] };
/** Winzige Satelliten (Winkel in Grad, Abstand, Radius). */
export const SATELLITES: readonly (readonly [deg: number, dist: number, r: number])[] = [
  [24, 44, 1.7],
  [148, 41.5, 1.25],
  [262, 45.5, 1.45],
];

/** Geschlossener, welliger Ring als SVG-Pfad. */
export function wobblePath(shape: RingShape, steps = 96): string {
  let d = "";
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    let r = shape.r;
    for (const [amp, lobes, phase] of shape.waves) r += amp * Math.sin(lobes * t + phase);
    const x = (r * Math.cos(t)).toFixed(2);
    const y = (r * Math.sin(t)).toFixed(2);
    d += `${i === 0 ? "M" : "L"}${x} ${y}`;
  }
  return `${d}Z`;
}

/** Feste Farben NUR für das stille App-Symbol (Datei ohne CSS-Tokens); Werte wie `--a-nyx` in `app.css`. */
export const AURA_HEX = {
  nyx: "#c77dff",
  ringGlow: "#a55cff",
  pale: "#b890ff",
  lavender: "#ecdcff",
  deep: "#5a1fa3",
  deeper: "#2a0b52",
  edge: "#08020f",
} as const;

export interface IconOptions {
  /** Größe des Motivs im Quadrat (1 = randvoll). Für „maskable“ kleiner (Schutzrand). */
  scale?: number;
  /** Eckenradius des schwarzen Grunds (0 = eckig, z. B. für Apple, das selbst rundet). */
  radius?: number;
  /** Satelliten zeigen (bei sehr kleinen Symbolen besser aus). */
  satellites?: boolean;
}

/** Stilles Aura-Motiv auf Schwarz als eigenständige SVG-Datei (App-Symbol, Favicon). */
export function auraIconSvg({ scale = 0.94, radius = 0, satellites = true }: IconOptions = {}): string {
  const c = AURA_HEX;
  const sats = satellites
    ? SATELLITES.map(([deg, dist, r]) => {
        const a = (deg * Math.PI) / 180;
        return `<circle cx="${(dist * Math.cos(a)).toFixed(2)}" cy="${(dist * Math.sin(a)).toFixed(2)}" r="${r}" fill="${c.lavender}" opacity=".85"/>`;
      }).join("")
    : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">`,
    `<defs>`,
    `<radialGradient id="h" r="50%"><stop offset="0" stop-color="${c.deep}"/><stop offset=".55" stop-color="${c.deeper}"/><stop offset="1" stop-color="${c.edge}"/></radialGradient>`,
    `<radialGradient id="k" r="50%"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="#fff"/><stop offset=".55" stop-color="${c.lavender}" stop-opacity=".9"/><stop offset=".8" stop-color="${c.nyx}" stop-opacity=".35"/><stop offset="1" stop-color="${c.nyx}" stop-opacity="0"/></radialGradient>`,
    `<filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>`,
    `<filter id="w" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4.5"/></filter>`,
    `</defs>`,
    `<rect width="100" height="100" rx="${radius}" fill="#000"/>`,
    `<g transform="translate(50 50) scale(${scale})">`,
    `<circle r="50" fill="url(#h)"/>`,
    `<path d="${wobblePath(RING_OUTER)}" fill="none" stroke="${c.ringGlow}" stroke-width="5" opacity=".3" filter="url(#b)"/>`,
    `<path d="${wobblePath(RING_OUTER)}" fill="none" stroke="${c.pale}" stroke-width="1.6" opacity=".55"/>`,
    `<path d="${wobblePath(RING_INNER)}" fill="none" stroke="${c.ringGlow}" stroke-width="14" opacity=".3" filter="url(#w)"/>`,
    `<path d="${wobblePath(RING_INNER)}" fill="none" stroke="${c.ringGlow}" stroke-width="7" opacity=".5" filter="url(#b)"/>`,
    `<path d="${wobblePath(RING_INNER)}" fill="none" stroke="${c.nyx}" stroke-width="3.2"/>`,
    `<circle r="${CORE_R + 4}" fill="url(#k)"/>`,
    `<circle r="4.5" fill="#fff"/>`,
    sats,
    `</g>`,
    `</svg>`,
  ].join("");
}
