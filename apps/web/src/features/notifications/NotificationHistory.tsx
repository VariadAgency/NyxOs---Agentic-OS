// "Verlauf": the last 50 notifications with reason (sent, skipped by Nyx, quiet hours, duplicate, sub-agent,
// occasion off …), each with "Passt" / "Brauche ich nicht". Twice "Brauche ich nicht" for the same kind → a rule
// suggestion on top to accept ("Kontext-Wächter nur, wenn ich weg bin?").
import { dateTimeFormat, t, tc, type NotifyDecision, type NotifyFeedback, type NotifyHistoryItem, type NotifySettingsPatch, type NotifySuggestion } from "@nyxos/shared";
import { useState } from "react";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { useNotifyFeedback, useNotifyHistory } from "./api";
import { BTN, BTN_ACCENT, Section, Segmented } from "./parts";

type Filter = "all" | "sent" | "held";

/** First only the newest few – 50 entries one below the other made the page ~7000 px long on a phone. */
const HISTORY_FIRST = 5;
const HISTORY_STEP = 10;

const HELD_TONE: Partial<Record<NotifyDecision, "wait" | "bad">> = { quiet_hours: "wait", away_batch: "wait", nyx_bundle: "wait", telegram: "wait", send_failed: "bad" };

/** Today only the time, otherwise date + time (user's language and time zone). */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = dateTimeFormat({ day: "2-digit", month: "2-digit", year: "numeric" });
  return day.format(d) === day.format(new Date())
    ? dateTimeFormat({ hour: "2-digit", minute: "2-digit" }).format(d)
    : dateTimeFormat({ day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

function nyxBadge(item: NotifyHistoryItem): string | null {
  const n = item.nyx;
  if (!n) return null;
  const parts: string[] = [];
  if (n.review === "senden" || n.review === "weglassen" || n.review === "buendeln") parts.push(t("geprüft"));
  if (n.review === "zeitlimit") parts.push(t("keine Antwort in 8 s"));
  if (n.review === "fehler") parts.push(t("nicht erreichbar"));
  if (n.review === "uebersprungen") parts.push(t("nicht gefragt (dringend)"));
  if (n.wrote === "nyx") parts.push(t("hat geschrieben"));
  if (n.wrote === "vorlage" && n.review !== "zeitlimit" && n.review !== "fehler") parts.push(t("Vorlage behalten"));
  return parts.length > 0 ? t("Nyx: {parts}", { parts: parts.join(", ") }) : null;
}

function SuggestionCard({ s, save, dismissed }: { s: NotifySuggestion; save: (p: NotifySettingsPatch) => void; dismissed: () => void }) {
  return (
    <div role="group" aria-label={t("Regel-Vorschlag")} className="grid gap-2 rounded-xl border border-a-acc/40 bg-a-p px-3 py-3" data-testid={`suggestion-${s.kind}`}>
      <p className="text-callout text-a-ink">
        <span className="font-medium">{s.text}</span>{" "}
        <span className="text-a-mut">{t("Du hast {n}× „Brauche ich nicht“ gesagt.", { n: s.count })}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cn(BTN, BTN_ACCENT)} onClick={() => save({ rules: { when: { [s.kind]: s.when } } })}>
          {t("Übernehmen")}
        </button>
        <button
          type="button"
          className={BTN}
          onClick={() => {
            dismissed();
            save({ rules: { dismissSuggestion: s.kind } });
          }}
        >
          {t("Nein danke")}
        </button>
      </div>
    </div>
  );
}

function HistoryRow({ item, onFeedback, pending }: { item: NotifyHistoryItem; onFeedback: (v: NotifyFeedback) => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const tone = item.delivered ? "ok" : (HELD_TONE[item.decision ?? "sent"] ?? "mut");
  const badge = nyxBadge(item);
  const fb = (v: NotifyFeedback, label: string) => (
    <button
      type="button"
      aria-pressed={item.feedback === v}
      disabled={pending}
      onClick={() => onFeedback(v)}
      className={cn(BTN, "px-2.5", item.feedback === v && (v === "passt" ? "border-a-ok/60 text-a-ok" : "border-a-wait/60 text-a-wait"))}
    >
      {label}
    </button>
  );
  return (
    <li className="grid min-w-0 gap-1.5 rounded-xl border border-a-line bg-a-p px-3 py-2.5" data-testid="history-item">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-label text-a-mut">{when(item.at)}</span>
        <span className="rounded-full bg-a-p3 px-2 py-0.5 text-label text-a-mut">{item.kindLabel}</span>
        {item.bundle && <span className="rounded-full bg-a-p3 px-2 py-0.5 text-label text-a-mut">{t("gesammelt")}</span>}
      </div>
      <button type="button" className="min-h-11 min-w-0 rounded-md text-left focus-visible:outline-2 focus-visible:outline-a-acc" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="block text-callout text-a-ink">{item.title}</span>
        <span className={cn("block whitespace-pre-line break-words text-caption text-a-mut", !open && "line-clamp-2")}>{item.message}</span>
      </button>
      <p className="flex min-w-0 items-start gap-1.5 text-caption">
        <span aria-hidden className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", tone === "ok" ? "bg-a-ok" : tone === "wait" ? "bg-a-wait" : tone === "bad" ? "bg-a-bad" : "bg-a-mut")} />
        <span className={cn("min-w-0 break-words", tone === "bad" ? "text-a-bad" : "text-a-ink/85")}>{item.reason}</span>
      </p>
      {badge && <p className="text-caption text-a-nyx">{badge}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-0.5" role="group" aria-label={t("Rückmeldung")}>
        {fb("passt", t("Passt"))}
        {fb("unnoetig", t("Brauche ich nicht"))}
      </div>
    </li>
  );
}

export function NotificationHistory({ save }: { save: (p: NotifySettingsPatch) => void }) {
  const history = useNotifyHistory();
  const feedback = useNotifyFeedback();
  const [filter, setFilter] = useState<Filter>("all");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(HISTORY_FIRST);
  const items = history.data?.items ?? [];
  const matching = items.filter((i) => (filter === "all" ? true : filter === "sent" ? i.delivered : !i.delivered));
  const shown = matching.slice(0, limit);
  const rest = matching.length - shown.length;
  const suggestions = (history.data?.suggestions ?? []).filter((s) => !hidden.has(s.kind));
  return (
    <Section id="verlauf" title={t("Verlauf")} intro={t("Was zuletzt rausging – und was nicht, mit Grund. Deine Rückmeldung lernt Nyx mit.")}>
      {suggestions.map((s) => (
        <SuggestionCard key={s.kind} s={s} save={save} dismissed={() => setHidden((h) => new Set(h).add(s.kind))} />
      ))}
      <Segmented<Filter>
        label={t("Verlauf filtern")}
        options={[
          { value: "all", label: t("Alle") },
          { value: "sent", label: t("Gesendet") },
          { value: "held", label: t("Nicht gesendet") },
        ]}
        value={filter}
        onChange={(f) => {
          setFilter(f);
          setLimit(HISTORY_FIRST);
        }}
      />
      {history.isLoading && (
        <div className="grid gap-1.5" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {history.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-callout text-a-bad">{friendlyError(history.error, tc("notifications", "Der Verlauf konnte nicht geladen werden."))}</p>
          <button type="button" className={BTN} onClick={() => void history.refetch()}>
            {t("Erneut versuchen")}
          </button>
        </div>
      )}
      {history.data && shown.length === 0 && (
        <p className="rounded-xl border border-a-line bg-a-p px-3 py-3 text-callout text-a-mut">{items.length === 0 ? t("Noch keine Mitteilung.") : t("Nichts in dieser Auswahl.")}</p>
      )}
      {feedback.isError && <p className="text-caption text-a-bad">{friendlyError(feedback.error, t("Die Rückmeldung ging nicht durch – bitte noch einmal."))}</p>}
      {shown.length > 0 && (
        <ul className="grid gap-1.5" data-testid="history-list">
          {shown.map((item) => (
            <HistoryRow key={item.id} item={item} pending={feedback.isPending && feedback.variables?.id === item.id} onFeedback={(value) => feedback.mutate({ id: item.id, value })} />
          ))}
        </ul>
      )}
      {rest > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} onClick={() => setLimit((n) => n + HISTORY_STEP)} data-testid="history-more">
            {t("Ältere zeigen ({n})", { n: rest })}
          </button>
          {limit > HISTORY_FIRST && (
            <button type="button" className={BTN} onClick={() => setLimit(HISTORY_FIRST)}>
              {t("Weniger zeigen")}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
