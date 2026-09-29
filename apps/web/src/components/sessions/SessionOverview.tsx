import { t } from "@nyxos/shared";
import { useState } from "react";
import type { Session } from "../../lib/api";
import { groupSessions, statusCounterSentence } from "../../lib/sessionOrder";
import { stateMeta } from "../../lib/stateMeta";
import { cn } from "../../lib/cn";
import { SessionCard } from "./SessionCard";

interface SessionOverviewProps {
  sessions: Session[];
  placeLabel: string;
  onOpen: (session: Session) => void;
  onDragStart: (session: Session) => (event: React.DragEvent) => void;
  /** Filter-Chips im Kopf (z. B. „Temporäre ausblenden“) – bleiben auch bei leerer Liste sichtbar. */
  filters?: React.ReactNode;
}

/** Übersicht: Kopf, Status-Zähler, Karten, eingeklappt Geschlossen/Beendet. */
export function SessionOverview({ sessions, placeLabel, onOpen, onDragStart, filters }: SessionOverviewProps) {
  const { open, closed, ended } = groupSessions(sessions);
  const [showClosed, setShowClosed] = useState(false);
  const [showEnded, setShowEnded] = useState(false);

  if (open.length === 0 && closed.length === 0 && ended.length === 0) {
    return (
      <div className="grid justify-items-center gap-1.5 p-10 text-center">
        {filters}
        <b className="text-a-ink">{t("Keine Sessions in {place}", { place: placeLabel })}</b>
        <span className="text-caption text-a-mut">{t("Neue Session mit Claude oder Codex in diesem Bereich starten.")}</span>
      </div>
    );
  }

  const byState = new Map<string, number>();
  for (const row of open) byState.set(row.session.state ?? "ended", (byState.get(row.session.state ?? "ended") ?? 0) + 1);

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3.5 p-4 md:p-5">
      <div className="flex flex-wrap items-end gap-3.5">
        <h4 className="font-display text-title2 font-bold text-a-ink">{placeLabel}</h4>
        <span className="pb-0.5 font-mono text-label text-a-mut">
          {t("{n} offen", { n: open.length })}
          {closed.length > 0 ? ` · ${t("{n} geschlossen", { n: closed.length })}` : ""}
        </span>
        {filters && <div className="ml-auto pb-0.5">{filters}</div>}
      </div>

      {open.length > 0 && (
        <div className="flex flex-wrap gap-2 text-caption" aria-label={statusCounterSentence(open)}>
          {[...byState.entries()].map(([state, n]) => {
            const meta = stateMeta(state as Session["state"]);
            return (
              <span key={state} className={cn("rounded-full px-2 py-0.5", meta.bg, meta.text)}>
                {n} {meta.label}
              </span>
            );
          })}
        </div>
      )}

      {open.length === 0 ? (
        <div className="grid justify-items-center gap-1 rounded-lg border border-a-line bg-a-p p-8 text-center">
          <b className="text-a-ink">{t("Keine offenen Sessions in {place}", { place: placeLabel })}</b>
          <span className="text-caption text-a-mut">{t("Neue Session hier starten, sobald wieder gearbeitet wird.")}</span>
        </div>
      ) : (
        <div className="grid gap-2" role="list" aria-label={t("Sessions in {place}", { place: placeLabel })}>
          {open.map((row) => (
            <SessionCard
              key={row.session.id}
              session={row.session}
              subagentCount={row.subagents.length}
              onOpen={() => onOpen(row.session)}
              draggable
              onDragStart={onDragStart(row.session)}
            />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowClosed((v) => !v)} className="text-caption text-a-mut hover:text-a-ink">
            {showClosed ? "▾" : "▸"} {t("Geschlossen in diesem Bereich ({n})", { n: closed.length })}
          </button>
          {showClosed && (
            <div className="mt-2 grid gap-2">
              {closed.map((session) => (
                <SessionCard key={session.id} session={session} subagentCount={0} onOpen={() => onOpen(session)} />
              ))}
            </div>
          )}
        </div>
      )}

      {ended.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowEnded((v) => !v)} className="text-caption text-a-mut hover:text-a-ink pointer-coarse:min-h-11 pointer-coarse:pr-3">
            {showEnded ? "▾" : "▸"} {t("Beendet ({n})", { n: ended.length })}
          </button>
          {showEnded && (
            <div className="mt-2 grid gap-2">
              {ended.map((session) => (
                <SessionCard key={session.id} session={session} subagentCount={0} onOpen={() => onOpen(session)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
