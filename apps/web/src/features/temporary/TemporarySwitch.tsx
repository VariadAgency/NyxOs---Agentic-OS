// Schalter „⏳ Temporär“ – im Dialog „Neue Session“ und für einen neuen Haiku-Faden. Eigene
// Komponente, damit die Dialoge nur eine Zeile dazubekommen.
import { t } from "@nyxos/shared";
import { useId } from "react";
import { cn } from "../../lib/cn";
import { useTemporarySettings } from "./api";

interface TemporarySwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Was nach Ablauf passiert – steht klein darunter. */
  what: "session" | "thread";
  compact?: boolean;
  className?: string;
}

export function TemporarySwitch({ checked, onChange, what, compact = false, className }: TemporarySwitchProps) {
  const hintId = useId();
  const settings = useTemporarySettings();
  const hours = settings.data?.hours ?? 6;
  const hint = what === "session" ? t("Verschwindet {hours} Std nach der letzten Aktivität ins Archiv.", { hours }) : t("Wird {hours} Std nach der letzten Nachricht gelöscht.", { hours });
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hintId}
        title={hint}
        onClick={() => onChange(!checked)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc",
          checked ? "border-a-temp/50 bg-a-temp/15 text-a-temp" : "border-a-line bg-a-p2 text-a-mut hover:text-a-ink",
        )}
      >
        <span
          aria-hidden="true"
          className={cn("relative inline-block h-3.5 w-6 shrink-0 rounded-full border transition-colors duration-150", checked ? "border-a-temp bg-a-temp/70" : "border-a-line bg-a-bg")}
        >
          <span className={cn("absolute top-[2px] h-2 w-2 rounded-full transition-[left,background-color] duration-150", checked ? "left-[13px] bg-a-ink" : "left-[2px] bg-a-mut")} />
        </span>
        <span>{t("⏳ Temporär")}</span>
      </button>
      <span id={hintId} className={cn("min-w-0 text-label leading-snug text-a-mut", compact && "sr-only")}>
        {hint}
      </span>
    </div>
  );
}
