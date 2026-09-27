// Nyx-Denken: Gedanken (Text, den Nyx vor seinen Werkzeug-Aufrufen schrieb) sichtbar, aber getrennt von der
// Antwort – eingeklappt, gedämpft, zum Aufklappen. Sie werden NIE vorgelesen (die Stimme bekommt nur die Antwort).
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";

export function NyxThoughts({ thoughts, className }: { thoughts: readonly string[] | undefined; className?: string }) {
  if (!thoughts?.length) return null;
  return (
    <details data-testid="nyx-thoughts" className={cn("group min-w-0 text-caption text-a-mut", className)}>
      <summary className="cursor-pointer select-none list-none font-mono text-label uppercase tracking-wide hover:text-a-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="mr-1 inline-block transition-transform duration-150 group-open:rotate-90">
          ›
        </span>
        {t("Gedanken")}
        {thoughts.length > 1 ? ` (${thoughts.length})` : ""}
      </summary>
      <div className="mt-1 grid gap-1 border-l border-a-line pl-2 italic">
        {thoughts.map((thought, i) => (
          <p key={i} className="min-w-0 break-words [overflow-wrap:anywhere]">
            {thought}
          </p>
        ))}
      </div>
    </details>
  );
}
