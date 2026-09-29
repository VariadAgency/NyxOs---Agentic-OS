// Session-Farben der Kollisionskarte. Die Gruppierung (`folderKey`, Zusammenfassung,
// Entscheidungen) rechnet der Server (`@nyxos/shared` `buildConflictModel`) —
// die Web-App bekommt nur noch die kleine Zusammenfassung und Details seitenweise.
export { folderKey } from "@nyxos/shared";

/** Dunkle, kategoriale Palette (für `--a-bg`/`--a-p*`-Flächen validiert): Session-Farbpunkte sind Identität, nie ein Status, deshalb
 * eine eigene, feste Reihenfolge statt der Status-Token (`--a-ok/wait/bad/…`). */
export const SESSION_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] as const;

/** Stabiler Index in `SESSION_PALETTE` je Session — dieselbe Session hat überall dieselbe Farbe. */
export function sessionColorIndex(sessionKey: string): number {
  let hash = 0;
  for (let i = 0; i < sessionKey.length; i++) hash = (hash * 31 + sessionKey.charCodeAt(i)) >>> 0;
  return hash % SESSION_PALETTE.length;
}

export function sessionColor(sessionKey: string): string {
  return SESSION_PALETTE[sessionColorIndex(sessionKey)] as string;
}
