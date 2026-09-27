// Reiter „Gedächtnis“: was Nyx sich über dich und das Projekt merkt — ansehen, ändern, vergessen lassen.
// Fehlt die Schnittstelle des Nyx-Kerns, steht hier ehrlich, dass es noch nichts gibt.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "../../../../lib/cn";
import { relativeTime } from "../../../../lib/format";
import { ErrorBox, FIELD } from "../../../haiku/ui";
import { t, tc, type NyxMemoryCategory } from "@nyxos/shared";
import { fetchMemory, forgetMemory, updateMemory, type NyxMemoryItem } from "../nyxTabApi";

/** Woher der Eintrag kommt, in einfachen Worten. */
function sourceOf(item: NyxMemoryItem): string {
  if (item.createdBy === "vorschlag") return t("aus einem Vorschlag");
  if (item.createdBy !== "nyx") return t("von dir eingetragen");
  return item.sourceThreadId ? t("aus Chat #{id}", { id: item.sourceThreadId }) : t("von Nyx gelernt");
}

/** Anzeige-Name der Kategorie (der Server liefert nur den Wert). */
function categoryLabel(category: NyxMemoryCategory): string {
  if (category === "user") return t("Über dich");
  if (category === "project") return t("Projekt");
  return t("Vorlieben");
}

function MemoryRow({ item }: { item: NyxMemoryItem }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.fact);
  const [confirm, setConfirm] = useState(false);
  const save = useMutation({ mutationFn: () => updateMemory(item.id, text.trim()), onSuccess: () => (setEditing(false), void qc.invalidateQueries({ queryKey: ["nyx", "memory"] })) });
  const forget = useMutation({ mutationFn: () => forgetMemory(item.id), onSuccess: () => void qc.invalidateQueries({ queryKey: ["nyx", "memory"] }) });
  return (
    <li className="grid gap-1.5 rounded-lg border border-a-line bg-a-p2 p-2.5">
      {editing ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={cn(FIELD, "resize-y")} aria-label={t("Erinnerung ändern")} />
      ) : (
        <p className="whitespace-pre-wrap text-callout leading-relaxed text-a-ink">{item.fact}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption">
        <span className="rounded-full border border-a-violet/40 bg-a-violet/10 px-2 py-px font-mono text-label text-a-violet">{categoryLabel(item.category)}</span>
        <span className="font-mono text-label text-a-mut">{sourceOf(item)}</span>
        <span className="font-mono text-label text-a-mut">{relativeTime(item.updatedAt || item.createdAt)}</span>
        <span className="ml-auto flex gap-2">
          {editing ? (
            <>
              <button type="button" onClick={() => save.mutate()} disabled={!text.trim() || save.isPending} className="text-a-acc underline disabled:opacity-40">
                {t("Speichern")}
              </button>
              <button type="button" onClick={() => (setEditing(false), setText(item.fact))} className="text-a-mut underline">
                {t("Abbrechen")}
              </button>
            </>
          ) : confirm ? (
            <>
              <span className="text-a-ink">{t("Wirklich vergessen?")}</span>
              <button type="button" onClick={() => forget.mutate()} className="text-a-bad underline">
                {t("Ja, vergessen")}
              </button>
              <button type="button" onClick={() => setConfirm(false)} className="text-a-mut underline">
                {t("Nein")}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)} className="text-a-acc underline">
                {tc("nyx", "Ändern")}
              </button>
              <button type="button" onClick={() => setConfirm(true)} className="text-a-bad/90 underline">
                {t("Vergessen")}
              </button>
            </>
          )}
        </span>
      </div>
      {(save.isError || forget.isError) && <span className="text-caption text-a-bad">{(save.error ?? forget.error)?.message}</span>}
    </li>
  );
}

export function MemoryPanel() {
  const q = useQuery({ queryKey: ["nyx", "memory"], queryFn: fetchMemory, staleTime: 15_000 });
  return (
    <div className="cc-scroll grid h-full content-start gap-3 overflow-y-auto p-3" data-nyx="nyx-gedaechtnis">
      {q.isLoading && <div className="text-caption text-a-mut">{t("Lade Gedächtnis …")}</div>}
      {q.isError && <ErrorBox text={t("Das Gedächtnis lässt sich gerade nicht laden.")} onRetry={() => void q.refetch()} />}
      {q.data === null && (
        <div className="grid gap-1.5 rounded-xl border border-dashed border-a-line p-4 text-callout text-a-mut">
          <span className="text-a-ink">{t("Nyx merkt sich noch nichts dauerhaft.")}</span>
          <span>{t("Das Gedächtnis kommt mit dem neuen Nyx-Kern. Dann steht hier, was Nyx über dich und dein Projekt weiß – und du kannst jede Erinnerung ändern oder vergessen lassen.")}</span>
        </div>
      )}
      {q.data && q.data.length === 0 && (
        <div className="grid gap-1.5 rounded-xl border border-dashed border-a-line p-4 text-callout text-a-mut">
          <span className="text-a-ink">{t("Noch keine Erinnerungen.")}</span>
          <span>{t("Sag Nyx zum Beispiel „Merk dir: Deploys nur nach 22 Uhr“.")}</span>
        </div>
      )}
      {q.data && q.data.length > 0 && (
        <>
          <div className="font-mono text-label text-a-mut">{q.data.length === 1 ? t("1 Erinnerung") : t("{n} Erinnerungen", { n: q.data.length })}</div>
          <ul className="grid gap-2">
            {q.data.map((m) => (
              <MemoryRow key={m.id} item={m} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
