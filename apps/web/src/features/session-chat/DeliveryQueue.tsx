// Die Zustell-Warteschlange der Session sichtbar machen — alles, was die NyxOS gerade
// NICHT eintippen durfte (Session arbeitete, Freigabe-Frage offen, angefangener Text), steht hier und
// geht von selbst raus, sobald die Session auf dich wartet. Zurückziehen geht jederzeit. Abgelaufenes
// oder Gescheitertes der letzten Stunde bleibt ehrlich sichtbar.
import { t, type SessionDeliveryView } from "@nyxos/shared";
import { cn } from "../../lib/cn";
import { useCancelDelivery, useSessionDeliveries } from "./api";

const KIND_LABEL: Record<SessionDeliveryView["kind"], string> = {
  chat: t("Deine Nachricht"),
  approval: t("Freigabe-Bescheid"),
  inbox: t("Inbox-Antwort"),
  haiku_answer: t("Antwort von Nyx"),
  compact: t("Kontext komprimieren"),
  control: t("Steuerung"),
};
/** Kategorie-Farben (bunt, nie grau), s. Tokens in app.css. */
const KIND_COLOR: Record<SessionDeliveryView["kind"], string> = {
  chat: "text-a-acc",
  approval: "text-a-conf",
  inbox: "text-a-violet",
  haiku_answer: "text-a-indigo",
  compact: "text-a-wait",
  control: "text-a-magenta",
};
const RECENT_MS = 60 * 60_000;

function since(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return min < 1 ? t("gerade eben") : min < 60 ? t("seit {n} Min", { n: min }) : t("seit {n} Std", { n: Math.round(min / 60) });
}

/** Queued and recently undelivered entries of the session (one query for the list and the phone toggle). */
function useQueueEntries(sessionId: string) {
  const { data } = useSessionDeliveries(sessionId);
  // „sending“ = die Brücke tippt gerade — sichtbar, aber nicht mehr zurückziehbar.
  const queued = (data ?? []).filter((d) => d.status === "queued" || d.status === "sending");
  const missed = (data ?? []).filter((d) => (d.status === "expired" || d.status === "failed") && d.doneAt && Date.now() - Date.parse(d.doneAt) < RECENT_MS);
  return { queued, missed };
}

/**
 * Phone: the queue is collapsed – a "2 waiting" button next to the agents bar expands the list (with
 * "Zurückziehen"). The history stays large; nothing is gone, it is one tap away.
 */
export function DeliveryQueueToggle({ sessionId, open, onToggle, controls }: { sessionId: string; open: boolean; onToggle: () => void; controls: string }) {
  const { queued, missed } = useQueueEntries(sessionId);
  if (queued.length === 0 && missed.length === 0) return null;
  const parts = [
    queued.length > 0 ? (queued.length === 1 ? t("1 wartet") : t("{n} warten", { n: queued.length })) : null,
    missed.length > 0 ? t("{n} nicht zugestellt", { n: missed.length }) : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      data-testid="delivery-queue-toggle"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn("flex min-h-11 shrink-0 items-center gap-1.5 border-t border-l border-a-line px-3 text-caption font-medium hover:bg-a-p2 first:flex-1 first:border-l-0", missed.length > 0 && queued.length === 0 ? "text-a-bad" : "text-a-wait")}
    >
      <span aria-hidden className="h-2 w-2 rounded-full bg-current" />
      {parts.join(" · ")}
      <span aria-hidden className="text-a-mut">{open ? "▾" : "▴"}</span>
    </button>
  );
}

export function DeliveryQueue({ sessionId, id }: { sessionId: string; id?: string }) {
  const { queued, missed } = useQueueEntries(sessionId);
  const cancel = useCancelDelivery(sessionId);
  if (queued.length === 0 && missed.length === 0) return null;

  return (
    <section id={id} data-testid="delivery-queue" aria-label={t("Wartet auf eine Pause der Session")} className="mx-2 mb-1 grid min-w-0 grid-cols-1 gap-1 overflow-hidden rounded-lg border border-dashed border-a-wait/50 bg-a-wait/5 px-3 py-2 text-caption">
      {queued.length > 0 && <p className="font-medium text-a-wait">{t("In der Warteschlange – geht raus, sobald die Session auf dich wartet")}</p>}
      {queued.map((d) => (
        <div key={d.id} className="flex min-w-0 items-baseline gap-2 pointer-coarse:items-center">
          <span className={cn("shrink-0 font-mono text-label", KIND_COLOR[d.kind])}>{KIND_LABEL[d.kind]}</span>
          <span className="min-w-0 flex-1 truncate text-a-ink" title={d.text}>
            {d.text}
          </span>
          <span className="shrink-0 font-mono text-label text-a-mut" title={d.reason ?? undefined}>
            {since(d.createdAt)}
          </span>
          {d.status === "sending" ? (
            <span className="shrink-0 text-label text-a-wait">{t("wird gerade gesendet")}</span>
          ) : (
            <button type="button" className="shrink-0 text-label text-a-bad hover:underline disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-2" disabled={cancel.isPending} onClick={() => cancel.mutate(d.id)}>
              {t("Zurückziehen")}
            </button>
          )}
        </div>
      ))}
      {cancel.error && (
        <p role="alert" className="text-label text-a-bad">
          {cancel.error.message}
        </p>
      )}
      {missed.map((d) => (
        <div key={d.id} className="grid min-w-0 gap-0.5 text-a-mut">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className={cn("shrink-0 font-mono text-label", KIND_COLOR[d.kind])}>{KIND_LABEL[d.kind]}</span>
            <span className="min-w-0 flex-1 truncate" title={d.text}>
              {d.text}
            </span>
          </div>
          <span className="text-label text-a-bad">{d.reason ?? t("Nicht zugestellt.")}</span>
        </div>
      ))}
    </section>
  );
}
