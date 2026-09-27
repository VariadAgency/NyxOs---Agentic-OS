// Längen-Wähler direkt an der Chat-Eingabe (Nyx-Tab-Chat und Nyx-Feld). Segment mit vier Knöpfen; „Auto“ = Nyx
// richtet die Länge nach der Frage. Ausdrückliche Wünsche in der Frage („in 4000 Zeichen“) gehen immer vor.
import { NYX_ANSWER_LENGTHS, t } from "@nyxos/shared";
import type { KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { useAnswerLength } from "./answerLength";

export function AnswerLengthPicker({ className }: { className?: string }) {
  const [value, setValue] = useAnswerLength();
  // Pfeiltasten wechseln die Wahl (Radio-Gruppe), Tab springt als Ganzes weiter.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = NYX_ANSWER_LENGTHS.findIndex((o) => o.value === value);
    const next = NYX_ANSWER_LENGTHS[(i + step + NYX_ANSWER_LENGTHS.length) % NYX_ANSWER_LENGTHS.length];
    if (!next) return;
    setValue(next.value);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="shrink-0 text-caption text-a-mut" aria-hidden="true">
        {t("Länge")}
      </span>
      <div
        role="radiogroup"
        aria-label={t("Antwort-Länge")}
        data-nyx="nyx-antwort-laenge"
        onKeyDown={onKeyDown}
        className="inline-flex min-w-0 flex-wrap rounded-full border border-a-line bg-a-p2 p-0.5"
      >
        {NYX_ANSWER_LENGTHS.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              title={t(o.hint)}
              data-value={o.value}
              onClick={() => setValue(o.value)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-caption transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-a-acc",
                on ? "bg-a-acc font-semibold text-a-bg" : "text-a-mut hover:text-a-ink",
              )}
            >
              {t(o.label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
