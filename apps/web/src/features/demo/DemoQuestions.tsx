// Demo: Fragen, die Nyx hier beantworten kann – als Knöpfe über der Eingabe (Klick schickt die Frage ganz normal ab).
// Mit Demo-Antworten (ohne KI) eine Zeile dazu, dass Nyx nach dem Einrichten alles mit der eigenen KI beantwortet.
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";
import { useDemo, useDemoQuestions } from "./demoApi";

export function DemoQuestions({ onAsk, disabled, className }: { onAsk: (question: string) => void; disabled?: boolean; className?: string }) {
  const { demo, engine } = useDemo();
  const questions = useDemoQuestions(demo).data ?? [];
  if (!demo) return null;
  return (
    <div data-testid="demo-questions" className={cn("grid min-w-0 gap-1.5", className)}>
      {questions.length > 0 && (
        <div role="group" aria-label={t("Probier eine Frage an Nyx")} className="flex min-w-0 flex-wrap gap-1.5">
          {questions.map((q) => (
            <button
              key={q}
              type="button"
              disabled={disabled}
              onClick={() => onAsk(q)}
              className="max-w-full truncate rounded-full border border-a-nyx/40 bg-a-nyx/10 px-2.5 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-nyx/20 disabled:cursor-not-allowed disabled:opacity-50"
              title={q}
            >
              {q}
            </button>
          ))}
        </div>
      )}
      {engine === "scripted" && <p className="text-label text-a-mut">{t("Demo-Antworten – nach dem Einrichten beantwortet Nyx alles mit deiner KI.")}</p>}
    </div>
  );
}
