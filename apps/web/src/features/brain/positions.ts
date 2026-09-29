// Positionen zwischen Besuchen merken (localStorage, gerundet) — beim nächsten Öffnen steht die Form sofort.
import { safeStorage } from "./settings";

type Pos = Record<string, [number, number]>;

export function loadPositions(key: string): Map<string, [number, number]> {
  try {
    const raw = safeStorage()?.getItem(key);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Pos));
  } catch {
    return new Map();
  }
}

export function savePositions(key: string, nodes: Array<{ id: string; x?: number; y?: number }>): void {
  const out: Pos = {};
  for (const n of nodes) if (n.x !== undefined && n.y !== undefined && Number.isFinite(n.x) && Number.isFinite(n.y)) out[n.id] = [Math.round(n.x), Math.round(n.y)];
  try {
    safeStorage()?.setItem(key, JSON.stringify(out));
  } catch {
    // Speicher voll: dann startet das nächste Mal eben neu (keine Fehlermeldung)
  }
}
