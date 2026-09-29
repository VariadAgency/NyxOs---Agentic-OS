// Aufgaben-Tab: Kopf mit Fortschrittsring und farbigen Kennzahlen, Verteilung nach Projekt (klickbar =
// Filter), darunter eine Karte je Auftrag (Farbe = Projekt) mit ihren Paketen (Farbe = Status) und
// aufklappbaren Schritten. Alles untereinander, alles anklickbar. Der Audits-Tab nutzt dieselbe Ansicht
// (fest auf `kind=audit`). Standard-Filter „Aufträge + Bugs“ — Audit-Befunde stehen im eigenen Tab und
// zählen hier erst, wenn man sie per Chip dazuholt.
import type { EntryKind } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router";
import { PageShell } from "../../components/PageShell";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { useEntries, useStartEntry } from "../entries/hooks";
import { EntriesEmptyState, ImportStatusLine, type ImportView } from "../entries/ImportSource";
import { RemovedSourceSection } from "../entries/RemovedSourceSection";
import { taskCounts } from "./counts";
import { groupTasks, isTaskStage, KIND_FILTERS, kindQuery, matchesKindFilter, openCount, projectOf, STAGE_ORDER, STAGE_THEME, taskStats, type TaskKindFilter, type TaskStage } from "./model";
import { TaskGroupCard } from "./TaskGroupCard";
import { useBridgeStatus } from "../terminal/terminalApi";
import { ProgressRing, ProjectBreakdown, TaskKpis } from "./TaskHeader";

export interface TasksViewProps {
  /** Audits-Tab nutzt dieselbe Ansicht, aber fest auf `kind=audit` (kein Umschalten). */
  fixedKind?: EntryKind;
  title?: string;
  hint?: string;
}

function LoadingState() {
  return (
    <div className="grid gap-4" aria-busy aria-label={t("Aufgaben laden")}>
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[120px] rounded-xl" />
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-[190px] rounded-2xl" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}

export function TasksView({ fixedKind, title, hint }: TasksViewProps) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<TaskKindFilter>("standard");
  const filter: TaskKindFilter = fixedKind === "audit" || fixedKind === "aufgabe" || fixedKind === "bug" ? fixedKind : fixedKind ? "alles" : kind;
  const [project, setProject] = useState<string | null>(null);
  const [stage, setStage] = useState<TaskStage | null>(null);
  const startMutation = useStartEntry();
  const bridge = useBridgeStatus(); // „Agent starten“ nur mit Brücke
  const { data: raw, isLoading, isError, refetch } = useEntries({ q: q || undefined, kind: fixedKind ?? kindQuery(kind) });
  const entries = useMemo(() => (raw ?? []).filter((e) => fixedKind !== undefined || matchesKindFilter(e, kind)), [raw, fixedKind, kind]);
  // Offene Befunde für den Chip „Audit“ — bekannt, solange die Liste sie enthält (Standard, Alles, Audit).
  const openAudits = useMemo(() => (raw ?? []).filter((e) => e.kind === "audit" && !e.sourceRemovedAt && e.stage !== "erledigt").length, [raw]);
  const auditsKnown = !fixedKind && (kind === "standard" || kind === "alles" || kind === "audit") && raw !== undefined;

  const openEntry = (id: number) => navigate(`${window.location.pathname}?e=${id}`);
  const importView: ImportView = fixedKind === "audit" ? "audits" : "aufgaben";
  // Einträge ohne Quelle (GOAL.md gelöscht, Befund aus dem Plan genommen) stehen gesondert
  // unten und zählen nicht als offen — gelöscht wird nie automatisch.
  const active = useMemo(() => entries.filter((e) => !e.sourceRemovedAt), [entries]);
  const removed = useMemo(() => entries.filter((e) => e.sourceRemovedAt), [entries]);

  // Eine Quelle, stimmige Summe. Nur Aufgaben-Stufen — sonst zählt die Unterzeile von
  // „Offen gesamt“ z. B. eine Frage in „eingang“ mit, die in keiner Karte steht.
  const counts = useMemo(() => taskCounts(active.filter((e) => isTaskStage(e.stage))), [active]);
  const stats = useMemo(() => taskStats(active), [active]);
  const groups = useMemo(() => {
    const filtered = active.filter((e) => (!project || projectOf(e).key === project) && (!stage || e.stage === stage));
    return groupTasks(filtered);
  }, [active, project, stage]);

  const heading = title ?? t("Aufgaben");
  const sentence =
    stats.total === 0
      ? t("Noch keine Aufträge.")
      : [
          openCount(filter, stats.open),
          stats.inArbeit > 0 ? t("{n} in Arbeit", { n: stats.inArbeit }) : t("gerade läuft nichts"),
          t("{n} heute fertig", { n: stats.fertigHeute }),
          stats.pruefen > 0 ? (stats.pruefen === 1 ? t("{n} wartet auf deine Abnahme", { n: stats.pruefen }) : t("{n} warten auf deine Abnahme", { n: stats.pruefen })) : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const hasEntries = entries.length > 0;
  const nothingAtAll = (raw ?? []).length === 0;
  const filtersActive = project !== null || stage !== null;

  return (
    <PageShell gap="gap-5">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-title font-semibold text-a-ink">{heading}</h1>
          <p className="mt-1 text-callout text-a-mut">{isLoading ? t("Lädt …") : sentence}</p>
        </div>
        {!isLoading && stats.total > 0 && (
          <div className="flex items-center gap-3">
            <span className="hidden text-right text-caption leading-tight text-a-mut sm:block">
              <span className="block font-mono uppercase tracking-wide">{t("Gesamt")}</span>
              {t("{done} von {total} erledigt", { done: stats.erledigt, total: stats.total })}
            </span>
            <ProgressRing pct={stats.progress} size={68} stroke={6} color="var(--a-acc)" label={t("Gesamtfortschritt")} />
          </div>
        )}
      </header>

      {isLoading && <LoadingState />}

      {!isLoading && !isError && (
        <>
          <TaskKpis stats={stats} openDetail={counts.detail} />
          <ProjectBreakdown stats={stats} selected={project} onSelect={setProject} />
        </>
      )}

      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-(--a-ctl-h) min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-a-line bg-a-p px-3 focus-within:border-a-acc/60">
            <span aria-hidden="true" className="text-a-mut">
              ⌕
            </span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("Aufgaben suchen: Titel, Baustelle, Bug-Nr …")}
              className="w-full bg-transparent text-callout text-a-ink outline-none placeholder:text-a-mut"
            />
          </label>
          {!fixedKind && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Nach Art filtern")}>
              {KIND_FILTERS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  aria-pressed={kind === k.value}
                  aria-label={k.value === "audit" && auditsKnown ? `${k.label} ${openAudits}` : undefined}
                  onClick={() => setKind(k.value)}
                  title={k.value === "audit" ? t("Audit-Befunde stehen auch im Tab Audits") : undefined}
                  className={"text-caption " + cn("inline-flex h-(--a-ctl-h) items-center gap-1.5 rounded-full border px-2.5", kind === k.value ? "border-a-acc/50 bg-a-acc/10 text-a-acc" : "border-a-line text-a-mut hover:bg-a-p2")}
                >
                  {k.label}
                  {k.value === "audit" && auditsKnown && <span className="font-mono tabular-nums">{openAudits}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {hasEntries && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Nach Status filtern")}>
            {STAGE_ORDER.map((s) => {
              const theme = STAGE_THEME[s];
              const on = stage === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setStage(on ? null : s)}
                  className={"text-caption " + cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors", on ? "border-(--s)/60 bg-(--s)/15 text-(--s)" : "border-a-line text-a-mut hover:bg-a-p2 hover:text-a-ink")}
                  style={{ "--s": theme.color } as CSSProperties}
                >
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: theme.color }} />
                  {theme.label}
                  <span className="font-mono tabular-nums">{stats.byStage[s]}</span>
                </button>
              );
            })}
            {filtersActive && (
              <button
                type="button"
                onClick={() => {
                  setProject(null);
                  setStage(null);
                }}
                className="ml-1 rounded-full px-2.5 py-1 text-caption text-a-acc hover:bg-a-acc/10"
              >
                {t("Filter zurücksetzen")}
              </button>
            )}
          </div>
        )}
      </div>

      <p className="text-caption text-a-mut">
        {hint ??
          (filter === "standard"
            ? t("Aufträge entstehen aus GOAL.md-Dateien und fertigen Konzepten (Tab Ideen → „In Aufgaben übernehmen“), dazu die Bugs. Audit-Befunde stehen im Tab Audits, hier per Chip „Audit“. Rohe Ideen tauchen hier nie auf.")
            : t("Aufgaben entstehen aus fertigen Konzepten (Tab Ideen → „In Aufgaben übernehmen“), aus Bugs und aus Audit-Befunden. Rohe Ideen tauchen hier nie auf."))}
      </p>
      {/* Leer ohne Suche: der Leer-Zustand sagt dasselbe ausführlicher — nicht doppelt. */}
      {(hasEntries || q) && <ImportStatusLine view={importView} />}

      {isError && (
        <div className="grid justify-items-center gap-2 rounded-xl border border-a-bad/30 bg-a-bad/5 p-6 text-center">
          <b className="text-a-ink">{t("Die Aufgaben konnten gerade nicht geladen werden.")}</b>
          <p className="text-caption text-a-mut">{t("Meist ist der Server kurz nicht erreichbar. Versuch es gleich noch einmal.")}</p>
          <button type="button" onClick={() => void refetch()} className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
            {t("Erneut versuchen")}
          </button>
        </div>
      )}
      {!isLoading && !isError && !hasEntries &&
        (!q && nothingAtAll && (fixedKind || kind === "standard" || kind === "alles") ? (
          <EntriesEmptyState view={importView} />
        ) : (
          <div className="cc-card-deep border border-a-line p-6 text-center">
            <b className="text-a-ink">{t("Keine Aufgabe passt zu diesem Filter.")}</b>
            <p className="mt-1 text-caption text-a-mut">{t("Suche oder Filter zurücksetzen.")}</p>
          </div>
        ))}

      {!isLoading && hasEntries && filtersActive && groups.length === 0 && active.length > 0 && (
        <div className="grid justify-items-center gap-2 rounded-xl border border-dashed border-a-line p-6 text-center">
          <b className="text-a-ink">{t("In dieser Auswahl ist gerade nichts.")}</b>
          <p className="text-caption text-a-mut">{stage ? t("Kein Paket steht auf „{stage}“.", { stage: STAGE_THEME[stage].label }) : t("Dieses Projekt hat keine offenen Pakete.")}</p>
          <button
            type="button"
            onClick={() => {
              setProject(null);
              setStage(null);
            }}
            className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2"
          >
            {t("Alle zeigen")}
          </button>
        </div>
      )}

      {!isLoading && groups.length > 0 && (
        <section aria-label={t("Aufträge")} data-testid="task-groups" className="grid grid-cols-[minmax(0,1fr)] items-start gap-3 min-[1600px]:grid-cols-2">
          {groups.map((g, i) => (
            <TaskGroupCard
              key={g.key}
              group={g}
              index={i}
              onOpen={openEntry}
              onStart={(id) => startMutation.mutate(id)}
              startingId={startMutation.isPending ? (startMutation.variables ?? null) : null}
              bridgeOnline={bridge.data?.online}
            />
          ))}
        </section>
      )}
      {!isLoading && <RemovedSourceSection entries={removed} onOpen={openEntry} />}
    </PageShell>
  );
}
