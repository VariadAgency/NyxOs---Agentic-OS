import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Karte: EINE ruhige Fläche (`--a-p`), 1 px feine Linie, Radius 14 px – kein Verlauf,
 * keine Lichtkante (keine zweifarbigen Kacheln). Als Link/Button (klickbar) oder als
 * reiner Container nutzbar.
 */
export function Card({ children, className, as: As = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "button" } & Record<string, unknown>) {
  return (
    <As
      data-slot="card"
      className={cn(
        // `content-start` verhindert, dass eine Karte mit `grid gap-*` als
        // Inhalt den übrigen Freiraum zwischen ihre Zeilen verteilt (schwebende Überschriften,
        // Riesen-Lücken) — greift nur, wenn die Karte selbst ein Grid/Flex ist (die meisten
        // Aufrufer geben `grid …` in `className` mit), sonst wirkungslos.
        "relative content-start rounded-xl border border-a-line bg-a-p p-4 transition-colors duration-150 ease-apple",
        // Hover-Leben für ALLE Karten, nicht nur klickbare — dezent (nur Linie),
        // ohne bei reinen Container-Karten Klickbarkeit vorzutäuschen.
        "hover:border-a-line-strong",
        As === "button" && "text-left hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc",
        className,
      )}
      {...rest}
    >
      {children}
    </As>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-mono text-caption font-medium uppercase tracking-wider text-a-mut">{children}</h2>;
}
