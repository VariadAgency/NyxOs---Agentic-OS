import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * EIN Seitenkopf für alle Tabs. Links Titel (`text-title`, 28 px) und darunter
 * optional eine Unterzeile in einfachen Worten; rechts optional die Aktionen der Seite. Auf dem Handy rutschen
 * die Aktionen unter den Titel (nichts wird gequetscht).
 */
export function PageHeader({ title, sub, actions, className }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header data-page-header="" className={cn("flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <div className="grid min-w-0 gap-1">
        <h1 className="font-display text-title font-semibold text-a-ink">{title}</h1>
        {sub && <p className="text-callout text-a-mut">{sub}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
