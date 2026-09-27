// Große Ordner (z. B. Downloads mit Tausenden Einträgen) nicht auf einmal zeichnen. Erst ein Stück,
// der Rest kommt beim Scrollen (Beobachter am Ende der Liste) oder per Knopf. Eine gewählte Datei weiter
// hinten (Tastatur, Suche) ist immer mit dabei.
import { useEffect, useRef, useState } from "react";
import { t, type FinderEntry } from "@nyxos/shared";

export const PROGRESSIVE_STEP = 200;

/** Wie viele Einträge gerade gezeichnet werden; wächst beim Scrollen. Neuer Ordner → wieder von vorn. */
export function useProgressive(entries: FinderEntry[], selected: string | null): { shown: FinderEntry[]; rest: number; more: () => void } {
  const [limit, setLimit] = useState(PROGRESSIVE_STEP);
  const first = entries[0]?.rel ?? "";
  const dir = first.slice(0, Math.max(0, first.lastIndexOf("/")));
  const lastDir = useRef(dir);
  useEffect(() => {
    if (lastDir.current === dir) return;
    lastDir.current = dir;
    setLimit(PROGRESSIVE_STEP);
  }, [dir]);
  const selIndex = selected ? entries.findIndex((e) => e.rel === selected) : -1;
  const need = Math.max(limit, selIndex >= 0 ? Math.ceil((selIndex + 1) / PROGRESSIVE_STEP) * PROGRESSIVE_STEP : 0);
  const shown = need >= entries.length ? entries : entries.slice(0, need);
  return { shown, rest: entries.length - shown.length, more: () => setLimit((l) => Math.max(l, need) + PROGRESSIVE_STEP) };
}

/** Knopf am Ende der Liste; lädt von selbst nach, sobald er in die Nähe des sichtbaren Bereichs kommt. */
export function MoreButton({ rest, onMore, className }: { rest: number; onMore: () => void; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting)) onMoreRef.current();
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [rest]);
  if (rest <= 0) return null;
  return (
    <button ref={ref} type="button" onClick={onMore} className={className ?? "mx-auto my-2 block rounded-md border border-a-line bg-a-p2 px-3 py-1 text-caption text-a-mut hover:text-a-ink"}>
      {t("Weitere {n} von {rest} anzeigen", { n: Math.min(rest, PROGRESSIVE_STEP), rest })}
    </button>
  );
}
