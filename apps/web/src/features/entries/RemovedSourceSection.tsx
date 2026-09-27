// Einträge, deren Quelle es nicht mehr gibt (GOAL.md gelöscht, Befund aus dem Maßnahmenplan
// genommen). Der Import löscht nie — sie bleiben sichtbar, aber gesondert
// ganz unten und zählen nicht als offen. Taucht die Quelle wieder auf, verschwinden sie von hier.
import type { Entry } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { EntryRow } from "./EntryRow";

export function RemovedSourceSection({ entries, onOpen }: { entries: Entry[]; onOpen: (id: number) => void }) {
  if (entries.length === 0) return null;
  return (
    <section aria-label={t("Quelle entfernt")} className="space-y-0.5">
      <h2 className="flex flex-wrap items-baseline gap-2 px-1 py-1.5 font-mono text-label tracking-wide text-a-mut uppercase">
        {t("Quelle entfernt")} <span className="text-a-ink normal-case">{entries.length}</span>
        <span className="font-sans text-label normal-case text-a-mut">{t("Die Quelle gibt es nicht mehr. Der Eintrag bleibt, bis du ihn aufräumst.")}</span>
      </h2>
      <div className="space-y-0.5">
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} onOpen={() => onOpen(entry.id)} />
        ))}
      </div>
    </section>
  );
}
