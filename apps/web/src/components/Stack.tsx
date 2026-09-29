import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Zweispaltiges Layout ab 1280px, darunter gestapelt (eine Spalte). Mit einer
 * expliziten Zeilenhöhe (`60vh`) für die erste Zeile im gestapelten Fall: Ohne sie ist die Zeile
 * `auto`-hoch, und ein Kind mit `h-full` (z. B. `ChatPanel`s virtualisierter Scroll-Container)
 * kann daraus keine feste Höhe ableiten (klassisches CSS-Zirkelproblem bei %-Höhe in einer
 * `auto`-Zeile) — der Virtualizer misst dann 0px und rendert keine Zeile. Unsichtbar bei kleinen
 * Test-Verläufen (jsdom kennt keine echte Boxgröße), aber real reproduzierbar mit einem großen
 * Verlauf unter 1280px Breite: der Chat blieb komplett leer (gefunden mit echten Daten über
 * `apps/web/e2e/real-data.spec.ts`, `pnpm probe`). Ab 1280px unverändert eine Zeile über beide
 * Spalten (`grid-rows-1`), wie vorher.
 *
 * `grid-cols-[1.25fr_1fr]` ohne `minmax(0, …)` lässt eine lange,
 * unumbrochene Zeile in einer Spalte (Bash-Ziel, Dateipfad) die ganze Spur aufreißen — `fr` allein
 * hat einen impliziten Mindestinhalt (`auto`), keine `0`. Mit `minmax(0, …)` darf die Spur bis auf
 * den verfügbaren Platz schrumpfen, ein `truncate`/`min-w-0` im Kind greift dann wieder. Die
 * Info-Spalte bekommt zusätzlich eine Mindestbreite (320px: Werte dürfen nie
 * unter „Toke…" zusammenfallen).
 */
export function Stack({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 grid-rows-[60vh_auto] gap-4 min-[1280px]:grid-rows-1 min-[1280px]:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)]",
        className,
      )}
      {...props}
    />
  );
}
