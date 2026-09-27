// Gemerkte Finder-Einstellungen (Ansicht, Sortierung, Spaltenbreiten, versteckte Dateien).
// Nur Bequemlichkeit je Browser — localStorage, jeder Zugriff abgesichert (privates Fenster o. ä.).
import { t } from "@nyxos/shared";
import { useCallback, useState } from "react";
import type { SortSpec } from "./sort";

export type FinderViewMode = "symbole" | "liste" | "spalten" | "galerie";
export const VIEW_MODES: { id: FinderViewMode; label: string; glyph: string }[] = [
  { id: "symbole", label: t("Symbole"), glyph: "▦" },
  { id: "liste", label: t("Liste"), glyph: "☰" },
  { id: "spalten", label: t("Spalten"), glyph: "▥" },
  { id: "galerie", label: t("Galerie"), glyph: "▭" },
];

function read<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as unknown;
    return valid(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Speicher gesperrt — dann eben nur für diese Sitzung
  }
}

export function usePref<T>(key: string, fallback: T, valid: (v: unknown) => boolean): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback, valid));
  const set = useCallback(
    (v: T) => {
      setValue(v);
      write(key, v);
    },
    [key],
  );
  return [value, set];
}

export const isViewMode = (v: unknown) => VIEW_MODES.some((m) => m.id === v);
export const isSortSpec = (v: unknown) => {
  const s = v as SortSpec | null;
  return !!s && ["name", "date", "size", "kind"].includes(s.by) && (s.dir === "asc" || s.dir === "desc");
};
export const isWidths = (v: unknown) => Array.isArray(v) && v.every((n) => typeof n === "number" && n >= 140 && n <= 800);

export const PREF_KEYS = {
  view: "nyx.finder.view",
  sort: "nyx.finder.sort",
  hidden: "nyx.finder.hidden",
  widths: "nyx.finder.columnWidths",
} as const;
