import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Gemeinsamer Seitenrahmen für ALLE Tabs: volle Breite ohne
 * Kappung (keine leeren Ränder links/rechts, nur der einheitliche Seitenabstand), eine Spalte mit `minmax(0,1fr)` statt eines nackten Grids. Eine `fr`-Spur hat sonst einen
 * impliziten Mindestinhalt (`auto`) — eine lange, unumbrochene Zeile (Pfad, Status-Pillen,
 * `nowrap`/`truncate`-Kinder) reißt die Spalte sonst über den Viewport hinaus, egal wie schmal er
 * ist. Genau dieser Fehler ließ Git/Nutzung bei 1024 px rechts aus dem Bild laufen (derselbe Fehler
 * wie zuvor in `Stack.tsx`, s. dort). `content-start` verhindert zusätzlich, dass eine Karte mit
 * `grid gap-*` als Inhalt den Freiraum zwischen ihre eigenen Zeilen verteilt ("schwebende
 * Überschriften", "Titel mitten in der Karte").
 *
 * `gap` ist bewusst ein Prop (nicht Teil der Basisklasse): Abstände bleiben einheitlich 24 px
 * (`gap-6`, Standard) bzw. 16 px (`gap-4`) je nach Dichte des Tabs — nie etwas dazwischen.
 */
export function PageShell({ children, className, gap = "gap-6" }: { children: ReactNode; className?: string; gap?: "gap-4" | "gap-5" | "gap-6" }) {
  return <div className={cn("grid w-full min-w-0 grid-cols-[minmax(0,1fr)] content-start p-4 md:p-6", gap, className)}>{children}</div>;
}
