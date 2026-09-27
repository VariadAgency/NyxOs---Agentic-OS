import { t } from "@nyxos/shared";
import type { Session } from "../../lib/api";
import { duration, lastActivitySentence } from "../../lib/format";
import { sessionLabel, sessionStateMeta } from "../../lib/sessionLabel";
import { cn } from "../../lib/cn";
import { useSessionContextThresholds } from "../../features/context-guard/api";
import { ContextRing } from "./ContextRing";
import { ToolTag } from "./ToolTag";
import { TempBadge } from "../../features/temporary/TempBadge";

interface SessionCardProps {
  session: Session;
  subagentCount: number;
  onOpen: () => void;
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent) => void;
}

/** Session-Karte: Status, Titel, Werkzeug, letzte Aktivität, Fortschritt-lose Metazeile. */
export function SessionCard({ session, subagentCount, onOpen, draggable, onDragStart }: SessionCardProps) {
  // Geister-Sessions (wartet > 1 Tag, nie eine Nachricht) ruhig als „verwaist“.
  const meta = sessionStateMeta(session);
  const activity = lastActivitySentence(session);
  const age = duration(session.startedAt, session.status === "running" ? null : session.lastActivityAt);
  const thresholds = useSessionContextThresholds(session.id, session.models);

  return (
    <button
      type="button"
      onClick={onOpen}
      draggable={draggable}
      onDragStart={onDragStart}
      data-session-id={session.id}
      data-nyx={`session-row:${session.id}`}
      // Nyx-Cursor findet „die neueste Session“ (item:session) über Art + letzte Aktivität.
      data-nyx-item="session"
      data-nyx-at={session.lastActivityAt ?? session.startedAt}
      // Eine ruhige Fläche (kein Verlauf, keine Lichtkante), Linie hellt beim Hover auf (150 ms). 3-px-Statuskante
      // links statt eines einheitlichen Rands rundum — der Zustand ist damit schon aus dem
      // Augenwinkel sichtbar, bevor man die Pille liest (Farbe aus `meta.text`, "text-a-x" → "border-a-x").
      // `min-w-0` + Spalte `minmax(0,1fr)`, sonst drückt ein langer Titel Karte und Ring bei 390 px aus dem Bild.
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-xl border border-a-line bg-a-p p-3.5 text-left transition-colors duration-150 ease-apple hover:border-a-line-strong hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc",
        "border-l-[3px]",
        meta.border,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption", meta.bg, meta.text)}>
          <span className={cn("h-2 w-2 rounded-full", meta.dot, session.state === "running" && "cc-pulse")} />
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-callout font-semibold text-a-ink">{sessionLabel(session)}</span>
        {session.state === "running" && session.contextPct !== null && (
          <ContextRing
            pct={session.contextPct}
            size={22}
            contextWindow={session.contextWindow}
            at={session.lastActivityAt}
            hinweisPct={thresholds?.hinweisPct}
            erzwingenPct={thresholds ? (thresholds.erzwingenEnabled ? thresholds.erzwingenPct : null) : undefined}
          />
        )}
        {session.temporaryExpiresAt && <TempBadge expiresAt={session.temporaryExpiresAt} reason={session.temporaryReason} what="session" />}
        <ToolTag tool={session.tool} />
      </div>
      <div className="truncate text-caption text-a-mut">
        {activity}
        {subagentCount > 0 && (
          <span className="text-a-mut">
            {" "}
            · {t(subagentCount === 1 ? "{n} Sub-Agent" : "{n} Sub-Agenten", { n: subagentCount })}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 text-caption text-a-mut">
        {session.models[0] && <span>{session.models[0]}</span>}
        {session.baustelle && <span>{session.baustelle.label}</span>}
        <span className="ml-auto font-mono">{age}</span>
      </div>
    </button>
  );
}
