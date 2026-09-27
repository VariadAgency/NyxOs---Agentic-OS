// Wie sich das Netz beim Schwenken anfühlt – als reine Rechenregeln (testbar ohne WebGL).
// Ziel: eine ruhigere, langsamere Bewegung beim Schwenken. Darum: ~60 % der früheren Empfindlichkeit, das Zieh-Tempo folgt dem Finger weich (statt je Maus-Ereignis zu
// springen, was von der Ereignis-Rate abhing), und nach dem Loslassen gleitet das Netz länger aus.

/** Drehung je gezogenem Pixel (rad). Erste Fassung: 0,0022 / 0,0016. */
export const DRAG_YAW_PER_PX = 0.0022 * 0.6;
export const DRAG_PITCH_PER_PX = 0.0016 * 0.6;
/** Trackpad (zwei Finger schieben): Schwung je Pixel. Erste Fassung: 0,0045 / 0,0035. */
export const WHEEL_YAW = 0.0045 * 0.6;
export const WHEEL_PITCH = 0.0035 * 0.6;
/** Wie viel Schwung nach 1 s Ausgleiten bleibt. */
export const GLIDE_KEEP_PER_S = 0.21;
/** In dieser Zeit (ms) holt das Zieh-Tempo 90 % des Finger-Tempos ein – weich statt ruckartig. */
export const DRAG_FOLLOW_MS = 110;

/** Schwung nach `dt` Sekunden Ausgleiten (bildraten-unabhängig). */
export function glide(vel: number, dt: number): number {
  return vel * Math.pow(GLIDE_KEEP_PER_S, dt);
}

/**
 * Zieh-Tempo (rad/s) nach einem Bild: `px` = in diesem Bild gezogene Pixel. Das Ziel-Tempo ist das Finger-Tempo,
 * das aktuelle Tempo läuft ihm weich nach — gleich bei 60 und 120 Bildern je Sekunde.
 */
export function dragVelocity(vel: number, px: number, perPx: number, dt: number): number {
  if (dt <= 0) return vel;
  const want = (px * perPx) / dt;
  const k = 1 - Math.pow(0.1, (dt * 1000) / DRAG_FOLLOW_MS);
  return vel + (want - vel) * k;
}
