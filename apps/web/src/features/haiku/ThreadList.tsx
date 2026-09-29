// Fadenliste im Haiku-Panel – Titel, Zeit, Suche, „Neuer Faden“, temporäre Fäden mit ⏳ + Restzeit.
// Ersetzt das frühere Aufklappmenü, in dem der Verlauf schwer zu finden war.
// Je Zeile ein Menü „⋯“ (`renderMenu`), dieselbe Liste dient auch als Archiv-Ansicht.
import { t, type HaikuThread } from "@nyxos/shared";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { TempBadge, useMinuteNow } from "../temporary/TempBadge";
import { FIELD } from "./ui";

interface ThreadListProps {
  threads: HaikuThread[] | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  activeId: number | null;
  onOpen: (id: number) => void;
  /** Fehlt → kein „+ Neuer Faden“ (z. B. im Archiv). */
  onNew?: () => void;
  /** Menü „⋯“ je Faden. */
  renderMenu?: (thread: HaikuThread) => ReactNode;
  /** Name der Liste für Screenreader/Tests (Standard „Fäden“). */
  label?: string;
  /** Text, wenn es gar keine Fäden gibt. */
  emptyText?: string;
  /** Unter der Liste, z. B. der Knopf „Archiv“. */
  footer?: ReactNode;
  /** Suchfeld beim Öffnen fokussieren (Liste als Aufklapper). */
  autoFocus?: boolean;
  /** Weitere Knöpfe zwischen Suche und „+ Neuer Faden“ (z. B. „⏳ Temporär“ für den aktuellen Faden). */
  actions?: ReactNode;
  className?: string;
  listClassName?: string;
}

export function ThreadList({
  threads,
  loading,
  failed,
  onRetry,
  activeId,
  onOpen,
  onNew,
  renderMenu,
  label = t("Fäden"),
  emptyText = t("Noch keine Fäden. Deine erste Frage startet einen."),
  footer,
  autoFocus = false,
  actions,
  className,
  listClassName,
}: ThreadListProps) {
  const [q, setQ] = useState("");
  const now = useMinuteNow();
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = threads ?? [];
    return needle ? all.filter((th) => `${th.title} ${th.topic}`.toLowerCase().includes(needle)) : all;
  }, [threads, q]);

  return (
    <div className={cn("grid min-h-0 min-w-0 content-start gap-2", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t("Fäden durchsuchen")}</span>
          <input
            type="search"
            aria-label={t("Fäden durchsuchen")}
            placeholder={t("Fäden durchsuchen …")}
            value={q}
            autoFocus={autoFocus}
            onChange={(e) => setQ(e.target.value)}
            className={cn(FIELD, "h-(--a-ctl-h) py-0 text-caption")}
          />
        </label>
        {actions}
        {onNew && (
          <button
            type="button"
            onClick={onNew}
            className="shrink-0 rounded-md border border-a-acc/50 bg-a-acc/10 px-2.5 py-1 text-caption font-medium text-a-acc transition-colors duration-150 hover:bg-a-acc/20"
          >
            <span aria-hidden="true">+ </span>{t("Neuer Faden")}
          </button>
        )}
      </div>

      {loading && (
        <div className="grid gap-1.5" aria-label={t("Fäden laden")}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-a-p2 motion-reduce:animate-none" />
          ))}
        </div>
      )}
      {failed && (
        <p className="text-caption text-a-bad">
          {t("Fäden konnten nicht geladen werden.")}{" "}
          <button type="button" onClick={onRetry} className="text-a-acc underline">
            {t("Erneut versuchen")}
          </button>
        </p>
      )}
      {!loading && !failed && (threads?.length ?? 0) === 0 && <p className="px-1 text-caption text-a-mut">{emptyText}</p>}
      {!loading && !failed && (threads?.length ?? 0) > 0 && shown.length === 0 && <p className="px-1 text-caption text-a-mut">{t("Kein Faden passt zu „{q}“.", { q: q.trim() })}</p>}

      {shown.length > 0 && (
        <ul aria-label={label} className={cn("cc-scroll grid min-h-0 content-start gap-0.5 overflow-y-auto", listClassName)}>
          {shown.map((th) => {
            const active = th.id === activeId;
            return (
              <li key={th.id} className="group flex min-w-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onOpen(th.id)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "grid w-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg border-l-[3px] px-2.5 py-1.5 text-left transition-colors duration-150",
                    active ? "border-a-acc bg-a-p3" : "border-transparent hover:bg-a-p2",
                  )}
                >
                  <span className={cn("truncate text-caption", active ? "text-a-ink" : "text-a-ink/90")}>{th.title || th.topic}</span>
                  {th.temporary && th.expiresAt ? <TempBadge expiresAt={th.expiresAt} what="thread" /> : <span />}
                  <span className="truncate font-mono text-label text-a-mut">{relativeTime(th.updatedAt, now) ?? th.day}</span>
                </button>
                {renderMenu?.(th)}
              </li>
            );
          })}
        </ul>
      )}
      {footer}
    </div>
  );
}
