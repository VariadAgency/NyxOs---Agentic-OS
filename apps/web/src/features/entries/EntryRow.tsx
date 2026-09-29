import type { Entry } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";
import { KIND_LABELS, PRIORITY_LABELS } from "./meta";
import { ProgressBar } from "./ProgressBar";

interface EntryRowProps {
  entry: Entry;
  onOpen: () => void;
  onStart?: () => void;
  onPromote?: () => void;
  starting?: boolean;
  style?: React.CSSProperties;
}

/**
 * Ganze Zeile klickbar (Hover-Hintergrund). Zeigt Fortschritt ODER Reife-Kurzstand, nie beides — Fortschritt nur
 * ab Stufe "läuft" (davor ist er immer 0 und sagt nichts).
 */
export function EntryRow({ entry, onOpen, onStart, onPromote, starting, style }: EntryRowProps) {
  const showProgress = entry.stage === "laeuft" || entry.stage === "pruefen";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      style={style}
      className="cc-stagger grid cursor-pointer grid-cols-[1fr_auto_auto] items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-a-line hover:bg-a-p2"
    >
      <div className="min-w-0">
        <div className="truncate text-callout font-medium text-a-ink">{entry.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-label text-a-mut">
          <span className="rounded bg-a-p3 px-1.5 py-0.5 text-a-mut">{KIND_LABELS[entry.kind]}</span>
          {entry.priority && <span className={cn("rounded px-1.5 py-0.5", entry.priority === "p0" ? "bg-a-bad/15 text-a-bad" : "bg-a-p3 text-a-mut")}>{PRIORITY_LABELS[entry.priority]}</span>}
          {entry.baustelle && <span>{entry.baustelle.label}</span>}
          {entry.estimate && <span>{entry.estimate}</span>}
          {entry.sourceRemovedAt && (
            <span className="rounded bg-a-wait/15 px-1.5 py-0.5 text-a-wait" title={t("Die Quelle (Datei) gibt es nicht mehr.")}>
              {t("Quelle entfernt")}
            </span>
          )}
        </div>
      </div>
      <div className="w-32 shrink-0">
        {showProgress ? (
          <div className="flex items-center gap-2">
            <ProgressBar percent={entry.progressPercent} color={entry.stage === "pruefen" ? "done" : "acc"} />
            <span className="w-9 text-right font-mono text-label text-a-mut tabular-nums">{entry.progressPercent}%</span>
          </div>
        ) : entry.maturity ? (
          <span className="text-label text-a-mut">
            {t("{passed} / {total} Reife", { passed: entry.maturity.passedCount, total: entry.maturity.totalCount })}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {onPromote && (
          <button type="button" className="rounded border border-a-acc/40 bg-a-acc/10 px-2.5 py-1 text-caption text-a-acc hover:bg-a-acc/20" onClick={onPromote}>
            {t("In Aufgaben übernehmen")}
          </button>
        )}
        {onStart && (
          <button type="button" disabled={starting} className="rounded border border-a-acc/40 bg-a-acc/10 px-2.5 py-1 text-caption text-a-acc hover:bg-a-acc/20 disabled:opacity-50" onClick={onStart}>
            {starting ? t("Startet …") : t("Starten")}
          </button>
        )}
        <button type="button" className="rounded border border-a-line px-2.5 py-1 text-caption text-a-mut hover:bg-a-p3" onClick={onOpen}>
          {t("Öffnen")}
        </button>
      </div>
    </div>
  );
}
