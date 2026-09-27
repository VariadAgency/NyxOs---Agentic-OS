// Großansicht einer Kollisionszeile — Dateien, beteiligte Sessions, Zeiten, Link zur Session
// („alles anklickbar“ + Verknüpfungen). Inline-Panel wie `DetailShell` im Agenten-Tab
// (`?path=` als einzige Quelle der Wahrheit, wie `?run=`/`?skill=`/`?e=`).
// Darunter „Vergleichen“ (Änderungen beider Sessions nebeneinander, Git-Stände).
// Lange Pfade/Titel brechen um bzw. kürzen mit Tooltip — nichts ragt aus der Kachel.
import { t, type CollisionEntry, type CollisionParty } from "@nyxos/shared";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { formatDateTime } from "../../lib/format";
import { sessionColor } from "./collisionGroups";
import { CompareSection } from "./CompareSection";

function PartyRow({ party }: { party: CollisionParty }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-callout hover:bg-a-p2">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: sessionColor(party.sessionKey) }} />
      <Link to={`/sessions/_/_/${encodeURIComponent(party.sessionKey)}`} title={party.title ?? party.sessionKey} className="min-w-0 flex-1 truncate text-a-ink hover:underline">
        {party.title ?? party.sessionKey}
      </Link>
      {party.alive === false && <span className="shrink-0 rounded-full bg-a-p2 px-1.5 py-px text-label text-a-mut">{t("beendet")}</span>}
      <span className="shrink-0 font-mono text-label text-a-mut">{t("seit {time}", { time: formatDateTime(party.firstSeenAt) })}</span>
    </li>
  );
}

export function CollisionDetail({ entry, onClose }: { entry: CollisionEntry; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Die Großansicht steht oben — beim Öffnen aus der Liste weiter unten dorthin springen.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [entry.path]);
  return (
    <div ref={ref} data-testid="collision-detail" data-tile className="grid min-w-0 scroll-mt-4 gap-3 rounded-lg border border-a-conf/40 bg-a-p2 p-4 shadow-[0_8px_24px_rgba(0,0,0,.35)]">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <h2 className="min-w-0 font-mono text-callout font-semibold text-a-ink [overflow-wrap:anywhere]">{entry.path}</h2>
        <button type="button" onClick={onClose} className="shrink-0 rounded-md px-2 py-1 text-caption text-a-mut hover:bg-a-p3 hover:text-a-ink">
          {t("Schließen")} ✕
        </button>
      </div>
      <p className="text-callout text-a-mut">{entry.reason ?? t("Keine Überschneidung.")}</p>
      {entry.reservation && (
        <p className="min-w-0 text-caption text-a-mut [overflow-wrap:anywhere]">
          {t("Reserviert:")} <span className="text-a-ink">{entry.reservation.label}</span> (<span className="font-mono">{entry.reservation.pathGlob}</span>)
        </p>
      )}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="grid min-w-0 content-start gap-1">
          <h3 className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Schreiben ({n})", { n: entry.writers.length })}</h3>
          {entry.writers.length === 0 ? <p className="px-2 text-caption text-a-mut">{t("Niemand.")}</p> : <ul className="grid gap-0.5">{entry.writers.map((w) => <PartyRow key={w.sessionKey} party={w} />)}</ul>}
        </div>
        <div className="grid min-w-0 content-start gap-1">
          <h3 className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Lesen ({n})", { n: entry.readers.length })}</h3>
          {entry.readers.length === 0 ? <p className="px-2 text-caption text-a-mut">{t("Niemand.")}</p> : <ul className="grid gap-0.5">{entry.readers.map((r) => <PartyRow key={r.sessionKey} party={r} />)}</ul>}
        </div>
      </div>
      <CompareSection entry={entry} />
    </div>
  );
}
