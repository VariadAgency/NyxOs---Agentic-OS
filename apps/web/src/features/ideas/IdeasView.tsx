// Ideen-Tab: Ideen sind normale NyxOS-Einträge (kind „idee“). Liste mit Stufen-Filter, Sortierung und
// Suche, neue Idee ablegen, Klick öffnet die Großansicht (`?e=<id>`). Eine Idee mit fertigem Konzept
// wird per „In Aufgaben übernehmen“ zur Aufgabe. Filter stehen in der Adresse (Zurück behält sie).
import type { Entry } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorDetails } from "../../components/ErrorDetails";
import { KpiTile } from "../../components/KpiTile";
import { PageShell } from "../../components/PageShell";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/friendlyError";
import { useCreateEntry, useEntries, usePromoteIdea } from "../entries/hooks";
import { PRIORITY_LABELS } from "../entries/meta";
import { RemovedSourceSection } from "../entries/RemovedSourceSection";
import { IDEA_STAGE_ORDER, ideasMarkdown, isIdeaStage, type IdeaSort, type IdeaStage, sortIdeas, splitIdeaText, stageLabel } from "./meta";
import { Chip, StageBadge, stageChipClass } from "./parts";

type StageFilter = IdeaStage | "all";

function useFilters() {
  const [params, setParams] = useSearchParams();
  const rawStage = params.get("stage");
  const stage: StageFilter = rawStage && isIdeaStage(rawStage) ? rawStage : "all";
  const sort: IdeaSort = params.get("sort") === "updated" ? "updated" : "pipeline";
  // Suche lokal (jeder Tastendruck sofort), die Adresse zieht nach — so geht beim schnellen Tippen nichts verloren.
  const [q, setQ] = useState(params.get("q") ?? "");
  const set = (patch: Record<string, string | undefined>) => {
    // Vom AKTUELLEN Stand der Adresse ausgehen, nicht vom letzten Render: zwei schnelle Änderungen
    // würden sich sonst gegenseitig überschreiben.
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const search = (value: string) => {
    setQ(value);
    set({ q: value || undefined });
  };
  const reset = () => {
    setQ("");
    setParams(new URLSearchParams(), { replace: true });
  };
  return { stage, sort, q, set, search, reset } as const;
}

/** Großansicht öffnen: `?e=<id>` an die aktuelle Adresse (Filter bleiben, Zurück schließt). */
function useOpenIdea() {
  const navigate = useNavigate();
  return (id: number) => {
    const next = new URLSearchParams(window.location.search);
    next.set("e", String(id));
    navigate({ pathname: "/ideas", search: `?${next.toString()}` });
  };
}

export function IdeasView() {
  const f = useFilters();
  const openIdea = useOpenIdea();
  const all = useEntries({ kind: "idee" });
  const query = f.q.trim();
  const found = useEntries({ kind: "idee", q: query || undefined });
  const [copied, setCopied] = useState(false);
  const [promotedId, setPromotedId] = useState<number | null>(null);
  const promote = usePromoteIdea();

  const everything = useMemo(() => (all.data ?? []).filter((e) => !e.sourceRemovedAt), [all.data]);
  const counts = useMemo(() => {
    const c: Record<IdeaStage, number> = { eingang: 0, in_klaerung: 0, konzept_fertig: 0 };
    for (const e of everything) if (isIdeaStage(e.stage)) c[e.stage] += 1;
    return c;
  }, [everything]);
  const matching = useMemo(() => (found.data ?? []).filter((e) => !e.sourceRemovedAt), [found.data]);
  const removed = useMemo(() => (found.data ?? []).filter((e) => e.sourceRemovedAt), [found.data]);
  const ideas = useMemo(() => sortIdeas(f.stage === "all" ? matching : matching.filter((e) => e.stage === f.stage), f.sort), [matching, f.stage, f.sort]);
  const total = everything.length;
  const isLoading = found.isLoading;
  const isError = found.isError;

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(ideasMarkdown(ideas));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const promoteIdea = (id: number) =>
    promote.mutate(
      { id },
      {
        onSuccess: () => setPromotedId(id),
      },
    );

  return (
    <PageShell gap="gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile label={t("Eingang")} value={counts.eingang} detail={t("frisch abgelegt")} />
        <KpiTile label={t("In Klärung")} value={counts.in_klaerung} detail={t("Rückfragen offen")} accent="wait" />
        <KpiTile label={t("Konzept fertig")} value={counts.konzept_fertig} detail={t("kann in die Aufgaben")} accent="acc" />
        <KpiTile label={t("Gesamt")} value={total} detail={t("offene Ideen")} accent="ok" />
      </div>

      <Composer onCreated={openIdea} />

      {promotedId !== null && (
        <p data-testid="idea-promoted" className="rounded-lg border border-a-ok/40 bg-a-ok/5 px-3 py-2 text-caption text-a-ink">
          {t("Übernommen – die Idee steht jetzt unter Aufgaben.")}{" "}
          <Link to={`/tasks?e=${promotedId}`} className="text-a-acc hover:underline">
            {t("Aufgabe öffnen →")}
          </Link>
        </p>
      )}
      {promote.isError && (
        <div className="grid gap-1 text-caption text-a-bad" role="alert">
          {friendlyError(promote.error)}
          <ErrorDetails error={promote.error} />
        </div>
      )}

      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-(--a-ctl-h) min-w-0 flex-1 basis-64 items-center gap-2 rounded-lg border border-a-line bg-a-p px-3 focus-within:border-a-acc/60">
            <span aria-hidden="true" className="text-a-mut">
              ⌕
            </span>
            <input
              type="search"
              value={f.q}
              onChange={(e) => f.search(e.target.value)}
              placeholder={t("Ideen durchsuchen (Titel und Text) …")}
              className="w-full bg-transparent text-callout text-a-ink outline-none placeholder:text-a-mut"
            />
          </label>
          <Chip active={f.sort === "pipeline"} onClick={() => f.set({ sort: undefined })} testId="sort-pipeline">
            {t("Nach Stand")}
          </Chip>
          <Chip active={f.sort === "updated"} onClick={() => f.set({ sort: "updated" })} testId="sort-updated">
            {t("Neueste zuerst")}
          </Chip>
          <Button variant="ghost" onClick={() => void copyAll()} disabled={ideas.length === 0} title={t("Alle sichtbaren Ideen als Markdown kopieren")}>
            {copied ? t("Kopiert ✓") : t("Als Markdown kopieren")}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Stufe")}>
          <Chip active={f.stage === "all"} onClick={() => f.set({ stage: undefined })} count={total} testId="stage-all">
            {t("Alle")}
          </Chip>
          {IDEA_STAGE_ORDER.map((s) => (
            <Chip key={s} active={f.stage === s} onClick={() => f.set({ stage: s })} activeClass={stageChipClass(s)} count={counts[s]} testId={`stage-${s}`}>
              {stageLabel(s)}
            </Chip>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      )}
      {isError && (
        <div className="cc-card-deep grid gap-2 border border-a-bad/40 p-4 text-callout">
          <b className="text-a-bad">{t("Die Ideen konnten nicht geladen werden.")}</b>
          <span className="text-a-mut">{friendlyError(found.error)}</span>
          <div>
            <Button onClick={() => void found.refetch()}>{t("Noch einmal laden")}</Button>
          </div>
          <ErrorDetails error={found.error} />
        </div>
      )}

      {!isLoading && !isError && ideas.length === 0 && (
        <div data-testid="ideas-empty" className="cc-card-deep grid justify-items-center gap-1 border border-a-line p-8 text-center">
          <b className="text-a-ink">{total === 0 && !query ? t("Noch keine Ideen.") : t("Keine Idee passt zu diesem Filter.")}</b>
          <p className="text-caption text-a-mut">
            {total === 0 && !query ? t("Leg oben deine erste Idee ab – ein paar Sätze genügen.") : t("Andere Stufe oder anderen Begriff wählen, oder die Filter zurücksetzen.")}
          </p>
          {(total > 0 || query) && (
            <Button className="mt-2" onClick={f.reset}>
              {t("Filter zurücksetzen")}
            </Button>
          )}
        </div>
      )}

      <ul className="grid grid-cols-[minmax(0,1fr)] items-start gap-2 min-[1600px]:grid-cols-2" data-testid="ideas-list">
        {ideas.map((idea, i) => (
          <li key={idea.id} className="motion-safe:animate-[fadein_200ms_ease-out_both]" style={i < 8 ? { animationDelay: `${i * 25}ms` } : undefined}>
            <IdeaCard idea={idea} onOpen={() => openIdea(idea.id)} onPromote={idea.stage === "konzept_fertig" ? () => promoteIdea(idea.id) : undefined} promoting={promote.isPending && promote.variables?.id === idea.id} />
          </li>
        ))}
      </ul>

      {!isLoading && <RemovedSourceSection entries={removed} onOpen={openIdea} />}
    </PageShell>
  );
}

function IdeaCard({ idea, onOpen, onPromote, promoting }: { idea: Entry; onOpen: () => void; onPromote?: () => void; promoting: boolean }) {
  const updated = relativeTime(idea.updatedAt ?? null);
  const text = (idea.description ?? "").trim();
  const snippet = text && text !== (idea.title ?? "").trim() ? text : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid="idea-card"
      // Klickpfad der NyxOS-Karte (/ideas/<id> → idea:<id>); data-nyx-href = wohin der Klick führt.
      data-nyx={`idea:${idea.id}`}
      data-nyx-href={`/ideas/${idea.id}`}
      data-nyx-item="idea"
      data-nyx-at={idea.updatedAt}
      className="cc-card-deep grid w-full cursor-pointer gap-2 border border-a-line px-4 py-3 text-left hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StageBadge stage={idea.stage} />
        {idea.priority && <span className="inline-flex h-5 items-center rounded-md bg-a-p3 px-1.5 font-mono text-label text-a-mut">{PRIORITY_LABELS[idea.priority] ?? idea.priority}</span>}
        {idea.baustelle && <span className="text-label text-a-mut">{idea.baustelle.label}</span>}
        {updated && <span className="ml-auto font-mono text-label text-a-mut">{updated}</span>}
      </div>
      <div className="text-headline font-medium leading-snug text-a-ink">{idea.title || t("Ohne Titel")}</div>
      {snippet && <p className="line-clamp-2 text-caption leading-relaxed text-a-mut">{snippet}</p>}
      {onPromote && (
        <div onClick={(e) => e.stopPropagation()}>
          <Button variant="primary" disabled={promoting} onClick={onPromote} data-testid="promote">
            {promoting ? t("Legt an …") : t("In Aufgaben übernehmen")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Neue Idee ablegen: Text genügt — die erste Zeile wird zum Titel. */
function Composer({ onCreated }: { onCreated: (id: number) => void }) {
  const create = useCreateEntry();
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const busy = create.isPending;
  const canSend = text.trim().length > 0 && !busy;

  const send = () => {
    if (!canSend) return;
    create.mutate(
      { kind: "idee", ...splitIdeaText(text) },
      {
        onSuccess: (res) => {
          setText("");
          setExpanded(false);
          if (res?.entry?.id) onCreated(res.entry.id);
        },
      },
    );
  };

  return (
    <section className="cc-card-deep grid gap-2 border border-a-line p-3" data-testid="idea-composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setExpanded(true)}
        rows={expanded ? 4 : 1}
        disabled={busy}
        placeholder={t("Neue Idee – einfach drauflos schreiben …")}
        aria-label={t("Neue Idee")}
        className="w-full resize-y rounded-lg border border-a-line bg-a-bg px-3 py-2 text-callout text-a-ink outline-none placeholder:text-a-mut focus:border-a-acc/60 disabled:opacity-60"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
        }}
      />
      {(expanded || text) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mx-1 text-caption text-a-mut">{busy ? t("Wird abgelegt …") : t("Die erste Zeile wird zum Titel, der Rest zur Beschreibung. ⌘↩ legt ab.")}</span>
          <Button variant="primary" className="ml-auto" disabled={!canSend} onClick={send}>
            {busy ? t("Legt ab …") : t("Idee ablegen")}
          </Button>
        </div>
      )}
      {create.isError && (
        <div className="grid gap-1 text-caption text-a-bad">
          {friendlyError(create.error)}
          <ErrorDetails error={create.error} />
        </div>
      )}
    </section>
  );
}
