// Wo das Nyx-Feld unter der Leiste hängt – wie die Mitteilungszentrale am Mac: direkt darunter, genau so breit
// wie die Leiste und rechtsbündig mit ihr. Ist die Leiste sehr schmal (enges Fenster), wird das Feld mindestens
// `DROPDOWN_MIN_WIDTH` breit und wächst nach links; es ragt nie über den Fensterrand.

/** Mindestbreite des Felds (schmale Leiste). */
export const DROPDOWN_MIN_WIDTH = 320;
/** Abstand zwischen Leiste und Feld. */
export const DROPDOWN_GAP = 8;
/** Abstand zum Fensterrand. */
export const DROPDOWN_EDGE = 8;
/** Unter dieser Fensterbreite nimmt das Feld die ganze Breite (Handy). */
const PHONE_MAX = 480;
/** Ohne Leiste (Tests, eingebettet): so weit von oben. */
const FALLBACK_TOP = 56;

export interface DropdownPlacement {
  top: number;
  left: number;
  width: number;
}

type AnchorRect = Pick<DOMRect, "left" | "right" | "width" | "bottom">;

export function dropdownPlacement(anchor: AnchorRect | null | undefined, viewportWidth: number): DropdownPlacement {
  const room = Math.max(0, viewportWidth - 2 * DROPDOWN_EDGE);
  const has = !!anchor && anchor.width > 0;
  // Handy: volle Breite (bis auf den Rand) – so schmal wie die Leiste wäre dort kaum lesbar.
  const width = Math.round(viewportWidth < PHONE_MAX ? room : Math.min(room, Math.max(DROPDOWN_MIN_WIDTH, has ? anchor.width : 0)));
  const right = has ? anchor.right : viewportWidth - DROPDOWN_EDGE;
  const left = Math.round(Math.max(DROPDOWN_EDGE, Math.min(right - width, viewportWidth - DROPDOWN_EDGE - width)));
  const top = has && anchor.bottom > 0 ? Math.round(anchor.bottom + DROPDOWN_GAP) : FALLBACK_TOP;
  return { top, left, width };
}
