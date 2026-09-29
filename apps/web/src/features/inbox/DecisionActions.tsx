// Antwort-Knöpfe einer Entscheidung – EINMAL gebaut, auf der Karte und in der Großansicht benutzt (gleiche
// Logik, gleiche Texte). Jeder Block trägt `data-nyx-risk`: der Nyx-Cursor zeigt hier höchstens, klickt/tippt nie.
import type { Approval, InboxItem } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { FIELD } from "../haiku/ui";
import { deliveryText } from "./decisionMeta";
import { useAnswerInbox, useDecideApproval, useDismissInbox } from "./useInbox";

interface Common {
  onToast: (m: string) => void;
  /** Nach erfolgreicher Antwort (Karte: ausblenden). */
  onDone?: () => void;
  /** Verzögerung bis zum Neuladen (Karte: Ausblende-Bewegung abwarten). */
  leaveMs?: number;
}

export function ApprovalActions({ approval, onToast, onDone, leaveMs = 0 }: Common & { approval: Approval }) {
  const decide = useDecideApproval(leaveMs);
  const run = (decision: "approve" | "deny") =>
    decide.mutate(
      { id: approval.id, decision },
      {
        onSuccess: () => {
          onDone?.();
          onToast(decision === "approve" ? t("Freigegeben – gilt genau einmal für diesen Befehl") : t("Abgelehnt – die Session bekommt ein Nein"));
        },
      },
    );
  return (
    // Freigeben/Ablehnen entscheidest NUR du — der Nyx-Cursor zeigt, klickt/tippt hier nie.
    <div data-nyx-risk="" className="grid min-w-0 gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          data-nyx-risk=""
          disabled={decide.isPending || decide.isSuccess}
          onClick={() => run("approve")}
          className="rounded-lg border border-transparent bg-a-primary px-3.5 py-1.5 text-caption font-semibold text-a-on-primary hover:brightness-110 disabled:opacity-50 max-md:min-h-11 max-md:px-5 max-md:text-callout"
        >
          {t("Freigeben")}
        </button>
        <button
          type="button"
          data-nyx-risk=""
          disabled={decide.isPending || decide.isSuccess}
          onClick={() => run("deny")}
          className="rounded-lg border border-a-line bg-a-p2 px-3.5 py-1.5 text-caption text-a-ink hover:bg-a-p3 disabled:opacity-50 max-md:min-h-11 max-md:px-5 max-md:text-callout"
        >
          {t("Ablehnen")}
        </button>
        <span className="min-w-0 text-caption text-a-mut">{t("Freigeben erlaubt genau diesen einen Befehl einmal.")}</span>
      </div>
      {decide.isError && <p className="text-caption text-a-bad">{t("Nicht gespeichert – bitte noch einmal.")}</p>}
    </div>
  );
}

export function QuestionActions({ item, onToast, onDone, leaveMs = 0 }: Common & { item: InboxItem }) {
  const answer = useAnswerInbox(leaveMs);
  const dismiss = useDismissInbox(leaveMs);
  const [text, setText] = useState("");
  const busy = answer.isPending || dismiss.isPending || answer.isSuccess || dismiss.isSuccess;

  const send = (a: { optionId?: string; text?: string }) =>
    answer.mutate(
      { id: item.id, answer: a },
      {
        onSuccess: (updated) => {
          onDone?.();
          onToast(deliveryText(updated));
        },
      },
    );

  return (
    // Ja/Nein/Optionen/eigene Antwort entscheidest NUR du — der Nyx-Cursor zeigt, klickt/tippt hier nie.
    <div data-nyx-risk="" className="grid min-w-0 gap-2.5">
      {item.options.length > 0 && (
        <div className={cn("grid min-w-0 gap-2", item.yesNo ? "grid-cols-2" : "grid-cols-1")}>
          {item.options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              data-nyx-risk=""
              disabled={busy}
              onClick={() => send({ optionId: opt.id })}
              className={cn(
                "min-w-0 rounded-lg border border-a-line bg-a-p2 text-left text-a-ink transition-colors duration-150 hover:border-a-acc/60 hover:bg-a-p3 disabled:opacity-50",
                // Normale Knopfhöhe (36 px) statt riesiger Ja/Nein-Flächen; auf dem Handy daumengroß (44 px).
                item.yesNo ? "h-9 text-center text-callout font-semibold max-md:h-11" : "px-3 py-2 text-callout max-md:min-h-11",
              )}
            >
              <span className="block truncate">{opt.label}</span>
              {!item.yesNo && opt.detail && <span className="block text-caption text-a-mut">{opt.detail}</span>}
            </button>
          ))}
        </div>
      )}

      <form
        className="flex min-w-0 items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send({ text: text.trim() });
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t("Eigene Antwort zu „{title}“", { title: item.title })}</span>
          <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Eigene Antwort …")} className={cn(FIELD, "min-h-[36px] resize-y")} />
        </label>
        <button type="submit" data-nyx-risk="" disabled={busy || !text.trim()} className="rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 text-caption text-a-acc disabled:opacity-40 max-md:min-h-11">
          {t("Antworten")}
        </button>
        <button
          type="button"
          data-nyx-risk=""
          disabled={busy}
          onClick={() =>
            dismiss.mutate(item.id, {
              onSuccess: () => {
                onDone?.();
                onToast(t("Verworfen"));
              },
            })
          }
          className="rounded-lg px-2.5 py-1.5 text-caption text-a-mut hover:bg-a-p2 hover:text-a-ink disabled:opacity-50 max-md:min-h-11"
        >
          {t("Verwerfen")}
        </button>
      </form>
      {(answer.isError || dismiss.isError) && <p className="text-caption text-a-bad">{t("Nicht gespeichert – bitte noch einmal.")}</p>}
    </div>
  );
}

/**
 * Ja/Nein für einen (gebündelten) Sortier-Vorschlag – gilt für ALLE Karten des Bündels. Jede wird einzeln
 * beantwortet, ein Fehler bricht die übrigen nicht ab. Klappt nur ein Teil, steht genau das da.
 */
export function SortActions({ target, items, onToast, onDone, leaveMs = 0 }: Common & { target: string; items: InboxItem[] }) {
  const answer = useAnswerInbox(leaveMs);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  /** Schon gespeicherte Antworten – ein zweiter Versuch schickt nur noch die fehlenden. */
  const [saved, setSaved] = useState<ReadonlySet<number>>(() => new Set());
  const [failedCount, setFailedCount] = useState(0);
  const n = items.length;

  const decide = async (optionId: "ja" | "nein") => {
    setBusy(true);
    setFailedCount(0);
    const todo = items.filter((item) => !saved.has(item.id));
    const ok = new Set(saved);
    let failed = 0;
    for (const item of todo) {
      try {
        await answer.mutateAsync({ id: item.id, answer: { optionId } });
        ok.add(item.id);
      } catch {
        failed++;
      }
    }
    setSaved(ok);
    setBusy(false);
    if (failed > 0) {
      setFailedCount(failed);
      return;
    }
    setDone(true);
    onDone?.();
    onToast(optionId === "ja" ? (n === 1 ? t("Session nach „{target}“ sortiert", { target }) : t("{n} Sessions nach „{target}“ sortiert", { n, target })) : t("Vorschlag abgelehnt – es bleibt, wie es ist"));
  };

  return (
    <div data-nyx-risk="" className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          data-nyx-risk=""
          disabled={busy || done}
          onClick={() => void decide("ja")}
          className="h-9 rounded-lg border border-transparent bg-a-primary px-3.5 text-callout font-semibold text-a-on-primary hover:brightness-110 disabled:opacity-50"
        >
          {n === 1 ? t("Ja") : n === 2 ? t("Ja, beide") : t("Ja, alle {n}", { n })}
        </button>
        <button
          type="button"
          data-nyx-risk=""
          disabled={busy || done}
          onClick={() => void decide("nein")}
          className="h-9 rounded-lg border border-a-line bg-a-p2 px-3.5 text-callout text-a-ink hover:bg-a-p3 disabled:opacity-50"
        >
          {t("Nein")}
        </button>
        <span className="min-w-0 text-caption text-a-mut">{t("Bei „Ja“ wird nur zugeordnet, keine Regel angelegt.")}</span>
      </div>
      {failedCount > 0 && (
        <p role="alert" className="text-caption text-a-bad">
          {failedCount === n ? t("Nicht gespeichert – bitte noch einmal.") : t("{failed} von {n} nicht gespeichert – ein neuer Klick schickt nur die fehlenden.", { failed: failedCount, n })}
        </p>
      )}
    </div>
  );
}
