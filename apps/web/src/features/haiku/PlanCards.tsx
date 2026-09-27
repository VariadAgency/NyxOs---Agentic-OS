// Pläne von Haiku (Inbox-Punkte mit kind "plan") als Karte über dem Chat: „Ändern“ / „Freigeben“.
import { t, type InboxItem } from "@nyxos/shared";
import { useState } from "react";
import { Markdown } from "../../lib/markdown";
import { cn } from "../../lib/cn";
import { useAnswerInbox, useOpenInbox } from "../inbox/useInbox";
import { FIELD, SourceChips } from "./ui";

export function PlanCards() {
  const inbox = useOpenInbox();
  const plans = (inbox.data ?? []).filter((i) => i.kind === "plan" && i.status === "open");
  if (plans.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-2">
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} />
      ))}
    </div>
  );
}

function PlanCard({ plan }: { plan: InboxItem }) {
  const answer = useAnswerInbox(220);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  return (
    <article
      aria-label={t("Plan: {title}", { title: plan.title })}
      // Plan freigeben/ändern entscheidest nur du — nie der Nyx-Cursor.
      data-nyx-risk=""
      className={cn("cc-rise grid min-w-0 gap-2 rounded-lg border border-a-acc/30 bg-a-acc/5 p-3", answer.isSuccess && "cc-leave")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <b className="min-w-0 flex-1 truncate text-caption font-semibold text-a-ink">{plan.title}</b>
        <span className="shrink-0 rounded-full bg-a-wait/10 px-2 py-px font-mono text-label text-a-wait">{t("wartet auf OK")}</span>
      </div>
      {plan.body && (
        <div className="min-w-0 text-caption leading-relaxed text-a-ink">
          <Markdown text={plan.body} />
        </div>
      )}
      <SourceChips sources={plan.sources} />
      {editing && (
        <label className="grid gap-1">
          <span className="sr-only">{t("Was soll anders sein?")}</span>
          <textarea
            className={cn(FIELD, "min-h-[64px] resize-y")}
            placeholder={t("Was soll anders sein?")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {editing ? (
          <>
            <button
              type="button"
              disabled={!text.trim() || answer.isPending}
              onClick={() => answer.mutate({ id: plan.id, answer: { optionId: "aendern", text: text.trim() } })}
              className="rounded-md border border-a-acc/40 bg-a-acc/10 px-2.5 py-1 text-caption text-a-acc disabled:opacity-40"
            >
              {t("Änderung schicken")}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-md px-2 py-1 text-caption text-a-mut hover:text-a-ink">
              {t("Abbrechen")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="rounded-md border border-a-line bg-a-p2 px-2.5 py-1 text-caption text-a-ink hover:bg-a-p3">
            {t("Ändern")}
          </button>
        )}
        <span className="flex-1" />
        {!editing && (
          <button
            type="button"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ id: plan.id, answer: { optionId: "freigeben" } })}
            className="rounded-md border border-a-acc bg-a-acc px-3 py-1 text-caption font-semibold text-a-bg hover:brightness-110 disabled:opacity-40"
          >
            {t("Freigeben")}
          </button>
        )}
      </div>
      {answer.isError && <p className="text-caption text-a-bad">{t("Antwort nicht gespeichert – bitte noch einmal.")}</p>}
    </article>
  );
}
