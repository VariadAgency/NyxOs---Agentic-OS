// Zähler an „Entscheidungen“ in der Leiste (offene Inbox-Punkte + offene Freigaben).
// Sortier-Vorschläge zählen NICHT in den farbigen Zähler (Kleinkram, soll nicht locken) – sie stehen als
// kleiner grauer Zusatz „+2“ daneben, nur wenn es welche gibt.
import { t } from "@nyxos/shared";
import { useOpenQuestions } from "./useInbox";

const capped = (n: number) => (n > 99 ? "99+" : String(n));

/** „2 Sortier-Vorschläge“ / „1 Sortier-Vorschlag“ (Vorlese-Text zum grauen Zusatz). */
export const sortingLabel = (n: number) => (n === 1 ? t("{n} Sortier-Vorschlag", { n }) : t("{n} Sortier-Vorschläge", { n }));

export function InboxNavBadge() {
  const q = useOpenQuestions().data;
  const count = q?.total ?? 0;
  const sorting = q?.sorting ?? 0;
  if (!count && !sorting) return null;
  return (
    <span className="ml-auto flex items-center gap-1">
      {count > 0 && (
        <span aria-label={t("{n} offen", { n: count })} className="rounded-full bg-a-wait/15 px-1.5 py-px font-mono text-label font-semibold tabular-nums text-a-wait">
          {capped(count)}
        </span>
      )}
      {sorting > 0 && (
        <span aria-label={sortingLabel(sorting)} title={sortingLabel(sorting)} className="font-mono text-label tabular-nums text-a-mut">
          +{capped(sorting)}
        </span>
      )}
    </span>
  );
}
