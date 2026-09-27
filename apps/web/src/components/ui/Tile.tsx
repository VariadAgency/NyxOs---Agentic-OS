// Wiederverwendbare Kachel (Agenten, später auch andere Bestände). Eine Farbe je Kachel
// (Token als CSS-Farbe), Symbol oben links, Titel + Untertitel, freier Inhalt, Fußzeile. Klickbar als
// echter <button>, sonst reiner Container. EINE Fläche (`--a-p`) ohne Verlauf/Farbschleier –
// die Farbe steckt nur im Symbol und (beim Hover/Auswählen) in der feinen Linie. Hover hebt sanft an
// (aus bei reduzierter Bewegung).
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface TileProps {
  /** CSS-Farbe, z. B. `var(--a-violet)` — nie grau (Kategorien sind bunt). */
  color: string;
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  /** Rechts oben, z. B. ein Zustands-Punkt. */
  badge?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Zusätzliche data-*-Attribute (Tests, Nyx-Kennungen). */
  data?: Record<`data-${string}`, string>;
  ariaLabel?: string;
}

export function Tile({ color, icon, title, subtitle, badge, children, footer, onClick, selected, className, style, data, ariaLabel }: TileProps) {
  const As = onClick ? "button" : "div";
  return (
    <As
      {...(onClick ? { type: "button" as const, onClick, "aria-pressed": selected ?? false } : {})}
      {...data}
      aria-label={ariaLabel}
      data-slot="tile"
      style={{ "--c": color, ...style } as CSSProperties}
      className={cn(
        "cc-stagger group/tile relative grid min-w-0 content-start gap-3 overflow-hidden rounded-2xl border bg-a-p p-4 text-left",
        "transition-[border-color,transform,box-shadow,background-color] duration-200 ease-apple",
        selected ? "border-(--c)/70 bg-a-p2 shadow-[0_0_0_1px_var(--c)]" : "border-a-line",
        onClick && "cursor-pointer hover:border-(--c)/45 hover:bg-a-p2 hover:shadow-raise focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--c) motion-safe:hover:-translate-y-0.5",
        className,
      )}
    >
      <span className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 place-items-center rounded-xl font-display text-headline font-semibold transition-transform duration-200 motion-safe:group-hover/tile:scale-105"
          style={{ background: `color-mix(in srgb, ${color} 16%, var(--a-p2))`, color }}
        >
          {icon}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="line-clamp-2 font-display text-headline font-semibold leading-tight tracking-[-0.01em] text-a-ink [overflow-wrap:anywhere]" title={title}>{title}</span>
          {subtitle && <span className="truncate text-caption text-a-mut">{subtitle}</span>}
        </span>
        {badge && <span className="shrink-0">{badge}</span>}
      </span>
      {children && <span className="relative grid min-w-0 gap-2">{children}</span>}
      {footer && <span className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-a-line pt-2.5 text-caption text-a-mut">{footer}</span>}
    </As>
  );
}

/** Raster für Kacheln: füllt die Breite, jede Kachel mindestens 260 px, auf dem Handy eine Spalte. */
export function TileGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3", className)}>{children}</div>;
}
