// Großansicht: jede Objektart öffnet sich, eine Klick-Kette über mehrere Ebenen und zurück
// funktioniert, die ECHTE Browser-Zurück-Taste geht. Kein Client-Zustand
// für den Stapel — der komplette Stapel steckt im URL-Suchparameter `e` (Komma-Liste von Eintrags-
// IDs); jedes "Öffnen" ist ein echter `navigate()`-Push, jedes "Zurück"/Brotkrümel-Klick ist ein
// History-Delta (`navigate(-n)`) — genau das macht die Browser-Zurück-Taste ebenfalls, die beiden
// Wege sind dieselbe Aktion und bleiben deshalb immer synchron.
import { t } from "@nyxos/shared";
import { lazy, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { AuditFullFile, AuditTop } from "../audits/AuditDetail";
import { Skeleton } from "../../components/ui/skeleton";
import { formatDateTime } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { useEntryDetail, usePromoteIdea, useStartEntry, useStartPlan } from "./hooks";
import { eventLabel, KIND_LABELS, STAGE_META } from "./meta";
import { MaturityRing } from "./MaturityRing";
import { ProgressBar } from "./ProgressBar";
// Lokaler Graph (Tiefe 1–3) wie im Session-Vollbild (RefsPanel.tsx) — eigenes
// Bundle, nur laden, wenn eine Großansicht offen ist.
const LocalGraph = lazy(() => import("../brain/LocalGraph").then((m) => ({ default: m.LocalGraph })));

function useStack(): { stack: number[]; base: string; navigate: ReturnType<typeof useNavigate> } {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get("e");
  const stack = raw
    ? raw
        .split(",")
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 0)
    : [];
  // Pfad aus dem Router (nicht `window.location`) — sonst stimmt die Adresse in Tests/Unterpfaden nicht.
  const base = useLocation().pathname;
  return { stack, base, navigate };
}

function openPath(base: string, stack: number[]): string {
  return `${base}?e=${stack.join(",")}`;
}

function EntryCrumbLabel({ id }: { id: number }) {
  const { data } = useEntryDetail(id);
  return <>{data?.entry.title ?? t("Eintrag {id}", { id })}</>;
}

export function EntryOverlay() {
  const { stack, base, navigate } = useStack();
  const currentId = stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
  const detail = useEntryDetail(currentId);
  const startPlan = useStartPlan(currentId);
  const startMutation = useStartEntry();
  const promote = usePromoteIdea();

  const close = () => {
    if (stack.length > 0) navigate(-stack.length);
  };
  const back = () => navigate(-1);
  const openCrumb = (index: number) => {
    const delta = index - (stack.length - 1);
    if (delta !== 0) navigate(delta);
  };
  const openChild = (id: number) => navigate(openPath(base, [...stack, id]));

  useEffect(() => {
    if (stack.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stack.length]);

  if (currentId === null) return null;

  const entry = detail.data?.entry;
  const stagePill = entry ? STAGE_META[entry.stage] : null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-a-bg/80 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="flex items-center gap-2 border-b border-a-line bg-a-p px-4 py-2.5">
        <button type="button" onClick={back} className="rounded border border-a-line px-2.5 py-1 text-caption text-a-mut hover:bg-a-p3">
          ‹ {t("Zurück")}
        </button>
        <nav aria-label={t("Brotkrümel")} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-caption text-a-mut">
          {stack.map((id, i) => (
            <span key={`${id}-${i}`} className="flex shrink-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden="true">›</span>}
              <button type="button" onClick={() => openCrumb(i)} className={i === stack.length - 1 ? "text-a-ink" : "truncate text-a-mut hover:text-a-ink"}>
                <EntryCrumbLabel id={id} />
              </button>
            </span>
          ))}
        </nav>
        <span className="rounded border border-a-line px-1.5 py-0.5 font-mono text-label text-a-mut">Esc</span>
        <button type="button" onClick={close} className="rounded border border-a-line px-2.5 py-1 text-caption text-a-mut hover:bg-a-p3">
          {t("Schließen")}
        </button>
      </div>

      <div className="cc-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] space-y-5 p-5">
          {detail.isLoading && <div className="text-callout text-a-mut">{t("Lädt …")}</div>}
          {detail.isError && <div className="text-callout text-a-bad">{t("Konnte nicht geladen werden.")}</div>}
          {entry && stagePill && (
            <>
              <header className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-a-p3 px-2 py-0.5 text-caption text-a-mut">{KIND_LABELS[entry.kind]}</span>
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption ${stagePill.bg} ${stagePill.text}`}>
                    <span className={`h-2 w-2 rounded-full ${stagePill.dot} ${entry.stage === "laeuft" ? "cc-pulse" : ""}`} />
                    {stagePill.label}
                  </span>
                </div>
                <h1 className="font-display text-title2 font-semibold text-a-ink">{entry.title}</h1>
                {entry.description && <p className="text-callout whitespace-pre-wrap text-a-mut">{entry.description}</p>}
              </header>

              {/* Audits zeigen Werte, Befund-Text, Verwandte, Aufträge und Sessions statt der kurzen Fakten. */}
              {entry.kind === "audit" ? (
                <AuditTop entryId={entry.id} stage={entry.stage} onOpenEntry={openChild} />
              ) : (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {entry.baustelle && <Fact label={t("Baustelle")} value={entry.baustelle.label} />}
                  {entry.priority && <Fact label={t("Priorität")} value={entry.priority.toUpperCase()} />}
                  {entry.modelSuggestion && <Fact label={t("Modell")} value={entry.modelSuggestion} />}
                  {entry.estimate && <Fact label={t("Schätzung")} value={entry.estimate} />}
                  {entry.fileScope.length > 0 && <Fact label={t("Dateibereich")} value={entry.fileScope[0] ?? ""} />}
                  {entry.sourceType && <Fact label={t("Quelle")} value={entry.sourceType} />}
                </div>
              )}

              {/* Lokaler Graph dieses Eintrags (Nachbarn: Sessions, Dateien,
                  verknüpfte Einträge, Commits) — wie im Session-Vollbild-Reiter "Bezüge". */}
              <section className="cc-card-deep border border-a-line p-3.5">
                <h2 className="mb-2 font-mono text-label tracking-wide text-a-mut uppercase">{t("Lokaler Graph")}</h2>
                <Suspense fallback={<Skeleton className="h-[320px]" />}>
                  <LocalGraph nodeId={`entry:${entry.id}`} />
                </Suspense>
              </section>

              {(entry.stage === "laeuft" || entry.stage === "pruefen") && (
                <section className="cc-card-deep space-y-2 border border-a-line p-3.5">
                  <h2 className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Fortschritt")}</h2>
                  <div className="flex items-center gap-3">
                    <ProgressBar percent={entry.progressPercent} color={entry.stage === "pruefen" ? "done" : "acc"} />
                    <span className="font-mono text-callout tabular-nums text-a-ink">{entry.progressPercent}%</span>
                  </div>
                </section>
              )}

              {detail.data && detail.data.subtasks.length > 0 && (
                <section className="cc-card-deep space-y-1.5 border border-a-line p-3.5">
                  <h2 className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Teilaufgaben")}</h2>
                  <ul className="space-y-1">
                    {detail.data.subtasks.map((s) => (
                      <li key={s.id} className="flex items-center gap-2 text-caption">
                        <span className={`grid h-4 w-4 place-items-center rounded-full text-label ${s.done ? "bg-a-ok/20 text-a-ok" : "bg-a-p3 text-a-mut"}`}>{s.done ? "✓" : "·"}</span>
                        <span className={s.done ? "text-a-mut line-through" : "text-a-ink"}>{s.title}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {entry.maturity && (entry.stage === "geplant" || entry.stage === "startklar") && (
                <section className="cc-card-deep border border-a-line p-3.5">
                  <h2 className="mb-2 font-mono text-label tracking-wide text-a-mut uppercase">{t("Reife-Check")}</h2>
                  <MaturityRing maturity={entry.maturity} />
                </section>
              )}

              {detail.data && detail.data.docs.length > 0 && (
                <section className="cc-card-deep space-y-2 border border-a-line p-3.5">
                  <h2 className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Planungsdokumente")}</h2>
                  {detail.data.docs.map((d) => (
                    <DocContent key={d.path} path={d.path} />
                  ))}
                </section>
              )}

              {detail.data && detail.data.links.length > 0 && (
                <section className="cc-card-deep space-y-2 border border-a-line p-3.5">
                  <h2 className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Verknüpfungen")}</h2>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.data.links.map((l) => {
                      const otherType = l.direction === "out" ? l.toType : l.fromType;
                      const otherId = l.direction === "out" ? l.toId : l.fromId;
                      if (otherType === "entry") {
                        return (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => openChild(Number(otherId))}
                            className="rounded-full border border-a-line px-2.5 py-1 text-caption text-a-mut hover:border-a-acc/50 hover:text-a-ink"
                          >
                            <em className="mr-1 not-italic text-a-mut">{l.direction === "in" ? "←" : "→"} {l.relation}</em>
                            {l.label}
                          </button>
                        );
                      }
                      if (otherType === "session") {
                        return (
                          <Link
                            key={l.id}
                            to={`/sessions/_/_/${otherId}`}
                            className="rounded-full border border-a-line px-2.5 py-1 text-caption text-a-mut hover:border-a-acc/50 hover:text-a-ink"
                          >
                            <em className="mr-1 not-italic text-a-mut">{l.direction === "in" ? "←" : "→"} {l.relation}</em>
                            {l.label}
                          </Link>
                        );
                      }
                      return (
                        <span key={l.id} className="rounded-full border border-a-line px-2.5 py-1 text-caption text-a-mut">
                          <em className="mr-1 not-italic text-a-mut">{l.direction === "in" ? "←" : "→"} {l.relation}</em>
                          {l.label}
                        </span>
                      );
                    })}
                  </div>
                </section>
              )}

              {detail.data && detail.data.events.length > 0 && (
                <section className="cc-card-deep space-y-1.5 border border-a-line p-3.5">
                  <h2 className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Verlauf")}</h2>
                  <ul className="space-y-1 text-caption">
                    {detail.data.events.slice(0, 20).map((ev) => (
                      <li key={ev.id} className="flex gap-2">
                        <span className="font-mono text-a-mut">{formatDateTime(ev.ts)}</span>
                        <span className="text-a-mut">{eventLabel(ev.kind)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {entry.kind === "audit" && <AuditFullFile entryId={entry.id} />}

              {entry.kind === "idee" && entry.stage === "konzept_fertig" && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={promote.isPending || promote.isSuccess}
                    onClick={() => promote.mutate({ id: entry.id })}
                    className="rounded border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 text-callout font-medium text-a-acc hover:bg-a-acc/20 disabled:opacity-50"
                  >
                    {promote.isPending ? t("Legt an …") : t("In Aufgaben übernehmen")}
                  </button>
                  {promote.isError && <span className="text-label text-a-bad">{t("Hat nicht geklappt – bitte noch einmal.")}</span>}
                </div>
              )}

              {entry.stage === "startklar" && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={startMutation.isPending}
                    onClick={() => startMutation.mutate(entry.id)}
                    className="rounded border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 text-callout font-medium text-a-acc hover:bg-a-acc/20 disabled:opacity-50"
                  >
                    {startMutation.isPending ? t("Startet …") : t("Starten")}
                  </button>
                  {startPlan.data && <span className="text-caption text-a-mut">{t("Worktree: {path}", { path: startPlan.data.worktreePath })}</span>}
                  {startMutation.data && <span className="text-label text-a-ok">{t("Gestartet – läuft jetzt in NyxOS")}</span>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="cc-card-deep border border-a-line px-2.5 py-2">
      <div className="text-label text-a-mut">{label}</div>
      <div className="truncate text-caption text-a-ink">{value}</div>
    </div>
  );
}

function useDoc(path: string) {
  return useQuery({
    queryKey: ["doc", path],
    queryFn: async () => {
      const res = await fetch(`/api/entries/docs/${path}`);
      if (!res.ok) return null;
      return (await res.json()) as { path: string; content: string };
    },
  });
}

/** Planungsdokument aus dem Doku-Spiegel — eingeklappt (Pfad als Titel), Inhalt gerendertes Markdown. */
function DocContent({ path }: { path: string }) {
  const { data, isLoading } = useDoc(path);
  return (
    <details className="rounded border border-a-line">
      <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-caption text-a-mut">{path}</summary>
      <div className="cc-scroll max-h-64 overflow-y-auto border-t border-a-line p-3 text-caption">
        {isLoading && <span className="text-a-mut">{t("Lädt …")}</span>}
        {!isLoading && !data && <span className="text-a-mut">{t("Kein Dokument-Spiegel vorhanden.")}</span>}
        {data && <Markdown text={data.content} />}
      </div>
    </details>
  );
}
