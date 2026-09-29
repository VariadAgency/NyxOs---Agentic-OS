/**
 * Eine Quelle der Wahrheit für Art-Schlüssel, Anzeigenamen und Reihenfolge (P2-6 Zusammenbau).
 * Vorher gab es zwei Kopien (`apps/server/src/categorize.ts` und `apps/web/src/lib/arts.ts`), die
 * von Hand synchron gehalten werden mussten. Server und Web importieren jetzt beide von hier —
 * keine Verhaltensänderung, nur ein Ort für die Liste.
 */
import { lazyRecord } from "./lazy-text.js";

export const ARTS = ["coding", "audit", "planung", "ideen", "recherche", "server", "unsortiert"] as const;
export type Art = (typeof ARTS)[number];

/** Display names: German source texts, translated on every read. */
export const ART_LABELS: Record<Art, string> = lazyRecord({
  coding: "Coding",
  audit: "Audit",
  planung: "Planung & Besprechung",
  ideen: "Ideen",
  recherche: "Recherche",
  server: "Server & Deploy",
  unsortiert: "Unsortiert",
});

export function isArt(v: unknown): v is Art {
  return typeof v === "string" && (ARTS as readonly string[]).includes(v);
}

/** Anzeigename für eine Art — unbekannte Schlüssel (sollte nicht vorkommen) fallen auf sich selbst zurück. */
export function artLabel(art: string): string {
  return (ART_LABELS as Record<string, string>)[art] ?? art;
}

/** Sortiert Zeilen mit einem `art`-Feld in der festen Reihenfolge oben; unbekannte Arten ans Ende. */
export function sortArts<T extends { art: string }>(rows: T[]): T[] {
  const rank = (art: string) => {
    const i = ARTS.indexOf(art as Art);
    return i === -1 ? ARTS.length : i;
  };
  return [...rows].sort((a, b) => rank(a.art) - rank(b.art));
}
