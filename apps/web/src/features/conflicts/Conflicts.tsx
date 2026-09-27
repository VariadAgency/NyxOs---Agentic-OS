import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { PageShell } from "../../components/PageShell";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/skeleton";
import { useConflictEntry, useConflictSummary, useCreateReservation, useReleaseReservation } from "../../hooks/useConflicts";
import { CollisionDetail } from "./CollisionDetail";
import { DecisionBlock } from "./DecisionBlock";
import { EntryPages, GroupList } from "./GroupList";
import { AskNyxButton } from "../../components/nyx/AskNyxButton";
import { NyxAura } from "../../components/brand/NyxAura";
import { conflictsFacts, conflictsOverview } from "./decisionText";
import { t, tc, type ConflictsSummary } from "@nyxos/shared";

const SEARCH_PAUSE_MS = 300;

/**
 * Konflikte-Tab. Von oben nach unten:
 * 1. „Was muss ich entscheiden?“ — die wichtigsten offenen Konflikte in einfacher Sprache, mit großen
 *    Knöpfen.
 * 2. Kollisionskarte — nur Ordner-Zusammenfassung, Dateien erst beim Aufklappen, Großansicht
 *    einer Datei mit Vergleich.
 * 3. Reservierungen (von Hand).
 * Daten: kleine Zusammenfassung mit ETag statt der ganzen Karte alle 5 s (das ließ die Seite hängen).
 */
export function Conflicts() {
  const { data, isLoading, isError, refetch } = useConflictSummary();
  const create = useCreateReservation();
  const release = useReleaseReservation();
  const [pathGlob, setPathGlob] = useState("");
  const [label, setLabel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Erst nach einer kurzen Tipp-Pause suchen (nicht bei jedem Tastendruck abfragen).
  const [deferredQuery, setDeferredQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDeferredQuery(query.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const [params, setParams] = useSearchParams();

  const openPath = params.get("path");
  const selected = useConflictEntry(openPath);
  const closeDetail = () =>
    setParams(
      (p) => {
        p.delete("path");
        return p;
      },
      { replace: true },
    );
  const openEntry = (path: string) => setParams({ path });

  if (isLoading) {
    return (
      <div className="grid gap-4 p-4 md:p-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="grid place-items-center p-10 text-center">
        <p className="mb-3 text-callout text-a-mut">{t("Konflikte konnten nicht geladen werden.")}</p>
        <button type="button" onClick={() => void refetch()} className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
          {t("Erneut versuchen")}
        </button>
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!pathGlob.trim() || !label.trim()) return;
    const result = await create.mutateAsync({ pathGlob: pathGlob.trim(), label: label.trim() });
    if ("error" in result) {
      setFormError(result.error);
      return;
    }
    setPathGlob("");
    setLabel("");
  }

  const { totals } = data;

  return (
    <PageShell>
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <h1 className="font-display text-title font-semibold text-a-ink">{t("Konflikte")}</h1>
          <p className="text-callout text-a-mut">{t("Wer ändert gerade dieselben Dateien? Hier siehst und entscheidest du es, bevor etwas kaputtgeht.")}</p>
        </div>
        <a href="#reservierungen" className="shrink-0 text-caption text-a-acc hover:underline">
          ↓ {t("Reservierungen")}
        </a>
      </header>

      <NyxConflictSummary summary={data} />

      <DecisionBlock summary={data} onOpenPath={openEntry} />

      {openPath && selected.data && <CollisionDetail entry={selected.data} onClose={closeDetail} />}
      {openPath && selected.isSuccess && !selected.data && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2 text-callout text-a-mut">
          <span className="min-w-0 flex-1">{t("Diese Datei steht gerade in keiner offenen Session mehr.")}</span>
          <button type="button" onClick={closeDetail} className="shrink-0 rounded-md px-2 py-1 text-a-ink hover:bg-a-p3">
            {t("Schließen")}
          </button>
        </div>
      )}

      <section className="grid min-w-0 gap-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <SectionTitle>{t("Kollisionskarte")}</SectionTitle>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Datei oder Session suchen …")}
            aria-label={t("Kollisionskarte durchsuchen")}
            className="h-(--a-ctl-h) w-full min-w-0 max-w-[260px] rounded-md border border-a-line bg-a-p2 px-2 text-caption text-a-ink outline-none focus:border-a-acc"
          />
        </div>
        <p className="text-caption text-a-mut">
          {totals.files === 1 ? t("1 Datei") : t("{n} Dateien", { n: totals.files })} {totals.groups === 1 ? t("in 1 Ordner") : t("in {n} Ordnern", { n: totals.groups })} ·{" "}
          {t("{n} mit Konflikt", { n: totals.conflicts })} · {t("{n} werden von anderen gelesen", { n: totals.sharedRead })}
          {totals.past > 0 && (
            <span title={t("Mehrere Sessions haben diese Dateien geändert, sind aber inzwischen beendet – nichts mehr zu entscheiden.")}> · {t("{n} im Rückblick (Sessions beendet)", { n: totals.past })}</span>
          )}
        </p>
        {deferredQuery ? (
          <Card data-tile className="grid min-w-0 gap-1 p-1.5">
            <EntryPages q={deferredQuery} onOpen={openEntry} />
          </Card>
        ) : data.groups.length === 0 ? (
          <p className="p-2 text-callout text-a-mut">{t("Keine offenen Sessions schreiben oder lesen gerade Dateien.")}</p>
        ) : (
          <GroupList groups={data.groups} onOpen={openEntry} />
        )}
      </section>

      <section id="reservierungen" className="grid min-w-0 scroll-mt-4 gap-2">
        <SectionTitle>{t("Reservierungen")}</SectionTitle>
        <Card data-tile className="grid min-w-0 gap-3 p-3">
          <p className="text-caption text-a-mut">{t("Ein reservierter Bereich gehört einer Arbeit: neue Aufträge dort starten erst, wenn du ihn freigibst.")}</p>
          <form onSubmit={(e) => void submit(e)} className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="grid min-w-0 gap-1 text-caption text-a-mut">
              {t("Dateibereich (Glob)")}
              <input value={pathGlob} onChange={(e) => setPathGlob(e.target.value)} placeholder="apps/web/src/features/git/**" className="min-w-0 rounded-md border border-a-line bg-a-p2 px-2 py-1.5 text-callout text-a-ink outline-none focus:border-a-acc" />
            </label>
            <label className="grid min-w-0 gap-1 text-caption text-a-mut">
              {t("Bezeichnung")}
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("z. B. Git-Ansicht")} className="min-w-0 rounded-md border border-a-line bg-a-p2 px-2 py-1.5 text-callout text-a-ink outline-none focus:border-a-acc" />
            </label>
            <button type="submit" disabled={create.isPending} className="rounded-md bg-a-acc/15 px-3 py-1.5 text-callout text-a-acc hover:bg-a-acc/25 disabled:opacity-50">
              {t("Reservieren")}
            </button>
          </form>
          {formError && <p className="text-caption text-a-bad [overflow-wrap:anywhere]">{formError}</p>}
          <div className="grid min-w-0 gap-1">
            {data.reservations.length === 0 && <p className="text-caption text-a-mut">{t("Keine Reservierungen.")}</p>}
            {data.reservations.map((r) => (
              <div key={r.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-callout hover:bg-a-p2">
                <span className="min-w-0 max-w-full truncate font-mono text-a-ink" title={r.pathGlob}>
                  {r.pathGlob}
                </span>
                <span className="min-w-0 truncate text-a-mut" title={r.label}>
                  {r.label}
                </span>
                <button type="button" onClick={() => void release.mutateAsync(r.id)} className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-caption text-a-mut hover:bg-a-p3 hover:text-a-ink">
                  {tc("conflicts", "Freigeben")}
                </button>
              </div>
            ))}
          </div>
        </Card>
      </section>
    </PageShell>
  );
}

/**
 * „Nyx-Zusammenfassung“ ganz oben: ein fester Satz aus den Daten (sofort da, ohne Nyx) und ein Knopf, mit dem
 * Nyx das Ganze in einfachen Worten erklärt und vorliest (Antwort 10 Minuten gemerkt).
 */
function NyxConflictSummary({ summary }: { summary: ConflictsSummary }) {
  return (
    <section aria-label={t("Nyx-Zusammenfassung")} data-testid="nyx-conflict-summary" className="grid min-w-0 gap-2 rounded-xl border border-a-violet/35 bg-a-violet/5 p-4">
      <div className="flex min-w-0 items-center gap-2 font-mono text-label uppercase tracking-[.12em] text-a-violet">
        <NyxAura size={16} />
        {t("Nyx-Zusammenfassung")}
      </div>
      <p className="min-w-0 text-headline leading-snug text-a-ink [overflow-wrap:anywhere]">{conflictsOverview(summary)}</p>
      <AskNyxButton label={t("Nyx erklären lassen")} question={t("Was passiert gerade bei meinen Konflikten zwischen den Sessions? Erklär es mir einfach.")} facts={conflictsFacts(summary)} />
    </section>
  );
}
