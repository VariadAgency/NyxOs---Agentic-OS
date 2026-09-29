// Tab "Idee an den Entwickler": title, description, how important (3 steps), e-mail (optional).
import { SUPPORT_LIMITS, t, type SupportImportance, type SupportSendResult, type SupportState } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { friendlyError } from "../../lib/friendlyError";
import { useRemoveOutboxItem, useSendIdea } from "./api";
import { AREA, Chips, Field, FIELD, Note } from "./parts";
import { SentNote } from "./SentNote";

const IMPORTANCE: { value: SupportImportance; label: string }[] = [
  { value: "nice", label: t("Wäre schön") },
  { value: "important", label: t("Wichtig") },
  { value: "essential", label: t("Brauche ich dringend") },
];

export function IdeaTab({ state }: { state: SupportState | undefined }) {
  const send = useSendIdea();
  const dropDraft = useRemoveOutboxItem();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [importance, setImportance] = useState<SupportImportance>("important");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<SupportSendResult | null>(null);
  const [draftId, setDraftId] = useState<number | null>(null);
  const seenDraft = useRef<string | null>(null);

  const draft = state?.drafts.idea ?? null;
  useEffect(() => {
    if (!draft || draft.draft.kind !== "idea") return;
    const key = `${draft.id}@${draft.updatedAt}`;
    if (seenDraft.current === key || title || description) return;
    seenDraft.current = key;
    setTitle(draft.draft.title);
    setDescription(draft.draft.description);
    setImportance(draft.draft.importance);
    setDraftId(draft.id);
  }, [draft, title, description]);

  const canSend = title.trim().length >= 3 && description.trim().length >= 3 && !send.isPending;
  const submit = () => {
    if (!canSend) return;
    send.mutate(
      { title, description, importance, email: email.trim() || null, ...(draftId ? { draftId } : {}) },
      {
        onSuccess: (r) => {
          setResult(r);
          setTitle("");
          setDescription("");
          setImportance("important");
          setDraftId(null);
        },
      },
    );
  };

  if (result) return <SentNote result={result} configured={state?.configured ?? false} onAgain={() => (setResult(null), send.reset())} againLabel={t("Noch eine Idee schicken")} />;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-callout leading-relaxed text-a-mut">{t("Was fehlt dir in NyxOS? Jede Idee wird gelesen – die besten landen in einer der nächsten Versionen.")}</p>
      {draftId !== null && (
        <Note tone="info" role="status">
          <span>{t("Nyx hat diese Idee für dich vorbereitet. Prüf sie in Ruhe – abschicken kannst nur du.")}</span>
          <button
            type="button"
            className="w-fit text-caption text-a-acc hover:text-a-ink"
            onClick={() => {
              dropDraft.mutate(draftId);
              setDraftId(null);
              setTitle("");
              setDescription("");
            }}
          >
            {t("Entwurf verwerfen")}
          </button>
        </Note>
      )}
      <Field label={t("Titel")}>
        <input data-nyx="support-idea-title" className={FIELD} value={title} maxLength={SUPPORT_LIMITS.titleChars} required placeholder={t("z. B. Sessions nach Projekt filtern")} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={t("Beschreibung")}>
        <textarea data-nyx="support-idea-description" className={AREA} value={description} maxLength={SUPPORT_LIMITS.textChars} required placeholder={t("Was soll es tun, und wobei hilft es dir?")} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid gap-1.5">
        <span className="text-caption font-medium text-a-ink">{t("Wie wichtig ist dir das?")}</span>
        <Chips label={t("Wie wichtig ist dir das?")} options={IMPORTANCE} value={importance} onChange={setImportance} nyx="support-idea-importance" />
      </div>
      <Field label={t("E-Mail für Rückfragen")} optional hint={t("Nur wenn du eine Antwort möchtest. Sie geht nur an den Entwickler.")}>
        <input data-nyx="support-idea-email" type="email" autoComplete="email" inputMode="email" className={FIELD} value={email} maxLength={SUPPORT_LIMITS.emailChars} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {send.isError && (
        <Note tone="bad" role="alert">
          {friendlyError(send.error, t("Die Idee ging nicht raus – bitte noch einmal versuchen."))}
        </Note>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" data-nyx="support-idea-send" data-nyx-risk="" className="min-h-11 px-4 sm:min-h-9" disabled={!canSend} aria-busy={send.isPending}>
          {send.isPending ? t("Sendet …") : state?.configured === false ? t("In den Postausgang legen") : t("Idee schicken")}
        </Button>
        {!state?.configured && state && <span className="text-caption text-a-mut">{t("Geht raus, sobald die Meldestelle eingerichtet ist.")}</span>}
      </div>
    </form>
  );
}
