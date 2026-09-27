// Regler „Kräfte“ (Obsidian-Stil) — eigene kleine Datei, damit der 3D-Worker sie ohne den Rest der
// Einstellungen laden kann.

export interface Forces {
  /** Zug zur Mitte (Obsidian „Zentrumskraft"), 0–1. */
  center: number;
  /** Abstoßung zwischen Knoten, 0–20. */
  repel: number;
  /** Zug entlang der Kanten, 0–1. */
  link: number;
  /** Ziel-Länge der Kanten, 30–500. */
  distance: number;
  /** Schweben — leichte Eigenbewegung der 3D-Wolke, 0 (still) bis 1. */
  drift: number;
}

// Kompaktere Wolke wie in Obsidian: mehr Zentrumszug, weniger Abstoßung,
// kürzere Kantenlänge — vorher wirkte der Graph als ausgefranster Stern statt runder Wolke.
export const DEFAULT_FORCES: Forces = { center: 0.7, repel: 7, link: 1, distance: 160, drift: 0.5 };

/** Nur die Werte, die die Physik betreffen — „Schweben“ ist reine Darstellung und weckt sie nicht. */
export function physicsKey(f: Forces): string {
  return `${f.center}|${f.repel}|${f.link}|${f.distance}`;
}
