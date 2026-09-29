// Gemeinsame Bausteine des Tabs „Nutzung“ (aus UsageView.tsx herausgelöst — die Vergleichs-/Ziel-Panels
// nutzen dieselbe Karte, denselben Umschalter und dieselbe Leer-Zeile).
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg border border-a-line bg-a-p p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("rounded-md px-3 py-1 text-caption transition-colors duration-150", value === o.value ? "bg-a-p3 font-semibold text-a-ink shadow-card" : "text-a-mut hover:text-a-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Panel({ title, sub, children, className, action }: { title: string; sub?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section aria-label={title} className={cn("cc-card-deep grid min-w-0 content-start gap-3 rounded-xl border border-a-line p-4", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="grid gap-0.5">
          <h2 className="font-mono text-label font-semibold uppercase tracking-wider text-a-mut">{title}</h2>
          {sub && <p className="text-caption text-a-mut">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="grid min-h-[96px] place-items-center text-center text-callout text-a-mut">{children}</p>;
}

/** Werkzeug-Farbe: Claude Orange, Codex Hellblau. */
export function toolColor(tool: string): string {
  return tool === "claude" ? "var(--a-claude)" : "var(--a-codex)";
}

export const TOOL_NAME: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** Stufen innerhalb EINES Werkzeug-Farbtons (Farbton = Werkzeug, Stufe = Rang im Werkzeug) — die
 * Legende daneben trägt die Identität, Farbe ist nie allein (dataviz: zusammengesetzte Kodierung). */
const MODEL_STEPS = [100, 68, 46, 32, 22];

export function modelColor(tool: string, rankInTool: number): string {
  const base = toolColor(tool);
  const step = MODEL_STEPS[Math.min(rankInTool, MODEL_STEPS.length - 1)] ?? 100;
  return step === 100 ? base : `color-mix(in srgb, ${base} ${step}%, var(--a-p3))`;
}
