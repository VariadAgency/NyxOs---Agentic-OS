import { t } from "@nyxos/shared";
import { useEffect, useState } from "react";
import type { CategoryCount, Session } from "../../lib/api";
import { useCloseSession } from "../../hooks/useSessionApi";
import { openNewSession } from "../../features/terminal/terminalApi";
import { RecentButton } from "../../features/recent/RecentButton";
import { ART_ORDER, artLabel } from "../../lib/arts";
import { cn } from "../../lib/cn";
import { isOrphaned, sessionLabel } from "../../lib/sessionLabel";
import { useScrollEdges } from "../../hooks/useScrollEdges";
import { BAUSTELLE_OHNE, type SessionsRoute, type ToolFilter } from "../../hooks/useSessionsRoute";
import type { SessionRow } from "../../lib/sessionOrder";
import { TopBarActions } from "../TopBarSlot";
import { useTooltip } from "../ui/Tooltip";
import { CloseDialog } from "./CloseDialog";
import { SearchBox } from "./SearchBox";
import { TabCloseDot } from "./TabCloseDot";
import { ToolTag } from "./ToolTag";

const TOOL_OPTIONS: { id: ToolFilter; label: string }[] = [
  { id: "alle", label: t("Alle") },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

/**
 * EIN flacher Aktiv-Stil für ART und BAUSTELLE (Fläche `p3` + feine Linie, kein Schatten,
 * kein Unterstrich) — vorher hatte BAUSTELLE einen eingesetzten Akzent-Schatten und ART eine weich
 * ausgeblendete Kante. Leere Kategorien (0 unter dem aktuellen Filter) bleiben stehen, aber
 * zurückgenommen: normale statt fetter Schrift und die „0“. Bewusst NICHT dunkler als `a-mut` —
 * die Kontrast-Regel (`contrast-no-dim-text.test.tsx`) verbietet unlesbar graue Schrift.
 */
const TAB_FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-a-acc";
function chipClass(selected: boolean, empty: boolean): string {
  if (selected) return "border-a-line bg-a-p3 text-a-ink";
  return cn("border-transparent text-a-mut hover:bg-a-p2 hover:text-a-ink", empty && "font-normal");
}

interface TabRowsProps {
  /** Zähler wie die Liste darunter (Werkzeug- + Temporär-Filter, `tabCounts` in `sessionOrder.ts`). */
  categories: CategoryCount[];
  openRows: SessionRow[];
  route: SessionsRoute;
  /** Name der gewählten Baustelle, falls sie unter dem Filter leer ist und darum in `categories` fehlt. */
  activeBaustelleLabel: string | null;
  onDropOnArt: (sessionId: string, art: string) => void;
  onDropOnBaustelle: (sessionId: string, art: string, baustelle: { slug: string; label: string } | null) => void;
  /** Öffnet den Regeln-Bereich (Regeln müssen in der UI verwaltbar/abschaltbar sein). */
  onOpenRules: () => void;
}

function withDragSessionId(event: React.DragEvent): string | null {
  return event.dataTransfer.getData("text/session-id") || null;
}

function Count({ n }: { n: number }) {
  return <span className="font-mono text-label font-normal text-a-mut">{n}</span>;
}

// Verwaiste Geister-Sessions ohne Amber-Punkt (sie warten nicht wirklich auf dich).
const dotClass = (s: Session) => (s.state === "running" ? "bg-a-ok" : s.state === "waiting" ? (isOrphaned(s) ? "bg-a-mut" : "bg-a-wait") : s.state === "crashed" ? "bg-a-bad" : "bg-a-idle");

/**
 * Ein Tab der SESSION-Zeile. Der volle Titel steht als eigener Hinweis UNTER dem Tab.
 * Der Status-Punkt links ist zugleich das Schließen-✕ (lang drücken, `TabCloseDot`); per
 * Tastatur schließt Entf/⌫ auf dem Tab – beides nur mit Rückfrage.
 */
function SessionTab({ session, selected, onClick, onRequestClose }: { session: Session; selected: boolean; onClick: () => void; onRequestClose: () => void }) {
  const hint = useTooltip(sessionLabel(session));
  return (
    <div className={cn("relative top-px flex shrink-0", selected && "z-10")}>
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-keyshortcuts="Delete"
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/session-id", session.id)}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            onRequestClose();
          }
        }}
        {...hint.triggerProps}
        className={cn(
          "flex h-9 min-w-[150px] max-w-[250px] items-center gap-2 rounded-t-lg border border-b-0 pl-[30px] pr-2.5 text-caption",
          TAB_FOCUS,
          selected ? "border-a-line bg-a-bg text-a-ink" : "border-a-line bg-a-p2 text-a-mut hover:bg-a-p3 hover:text-a-ink",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">{sessionLabel(session)}</span>
        <ToolTag tool={session.tool} />
      </button>
      <TabCloseDot
        title={sessionLabel(session)}
        dotClass={dotClass(session)}
        onRequestClose={onRequestClose}
        testId={`tab-dot-${sessionLabel(session)}`}
        className="absolute top-1/2 left-[5px] -translate-y-1/2"
      />
      {hint.tooltip}
    </div>
  );
}

function ToolGroup({ route }: { route: SessionsRoute }) {
  return (
    <div className="flex h-(--a-ctl-h) shrink-0 overflow-hidden rounded-md border border-a-line" role="group" aria-label={t("Werkzeug")}>
      {TOOL_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-pressed={route.tool === opt.id}
          onClick={() => route.setTool(opt.id)}
          className={cn("px-2.5 text-caption", route.tool === opt.id ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

interface CompactFilterProps {
  route: SessionsRoute;
  arts: { art: string; count: number }[];
  baustellen: CategoryCount["baustellen"];
  allCount: number;
  onOpenRules: () => void;
}

/**
 * Unter 768 px werden ART und BAUSTELLE zu EINEM Knopf („Coding · Alle ▾“). Er öffnet
 * ein Blatt von unten mit allen Arten, Baustellen, dem Werkzeug-Filter und den Regeln – vorher belegten drei
 * Filterzeilen 220 px, bevor die erste Session kam.
 */
function CompactFilter({ route, arts, baustellen, allCount, onOpenRules }: CompactFilterProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const activeBaustelle = route.baustelle === null ? t("Alle") : (baustellen.find((b) => (b.slug ?? BAUSTELLE_OHNE) === route.baustelle)?.label ?? t("Alle"));
  const summary = `${route.art ? artLabel(route.art) : t("Sessions")} · ${activeBaustelle}${route.tool === "alle" ? "" : ` · ${TOOL_OPTIONS.find((o) => o.id === route.tool)?.label ?? ""}`}`;
  const pick = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-a-line px-3 py-2 md:hidden">
      <button
        type="button"
        data-testid="sessions-filter-compact"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn("flex h-(--a-ctl-h) min-w-0 items-center gap-1.5 rounded-lg border border-a-line bg-a-p3 px-3 text-callout font-semibold text-a-ink", TAB_FOCUS)}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <span aria-hidden="true" className="shrink-0 text-a-mut">
          ▾
        </span>
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-end" role="presentation">
          <button type="button" aria-label={t("Filter schließen")} onClick={() => setOpen(false)} className="cc-scrim absolute inset-0" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("Sessions filtern")}
            className="cc-scroll relative grid max-h-[75dvh] w-full gap-4 overflow-y-auto rounded-t-2xl border-t border-a-line bg-a-p2 p-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-pop"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-headline font-semibold text-a-ink">{t("Sessions filtern")}</h2>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-caption text-a-mut hover:bg-a-p3 hover:text-a-ink">
                {t("Fertig")}
              </button>
            </div>
            <section className="grid gap-2" aria-label={t("Art der Arbeit")}>
              <h3 className="text-label font-semibold tracking-wide text-a-mut uppercase">{t("Art")}</h3>
              <div className="flex flex-wrap gap-1.5">
                {arts.map(({ art, count }) => (
                  <button
                    key={art}
                    type="button"
                    aria-pressed={route.art === art}
                    onClick={pick(() => route.goTo(art, null))}
                    className={cn("rounded-lg border px-3 py-1.5 text-callout font-semibold", TAB_FOCUS, chipClass(route.art === art, count === 0))}
                  >
                    {artLabel(art)} <Count n={count} />
                  </button>
                ))}
              </div>
            </section>
            {route.art && (
              <section className="grid gap-2" aria-label={t("Baustelle")}>
                <h3 className="text-label font-semibold tracking-wide text-a-mut uppercase">{t("Baustelle")}</h3>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    aria-pressed={route.baustelle === null}
                    onClick={pick(() => route.art && route.goTo(route.art, null))}
                    className={cn("rounded-md border px-2.5 py-1 text-caption font-medium", TAB_FOCUS, chipClass(route.baustelle === null, allCount === 0))}
                  >
                    {t("Alle")} <Count n={allCount} />
                  </button>
                  {baustellen.map((b) => {
                    const tabValue = b.slug ?? BAUSTELLE_OHNE;
                    return (
                      <button
                        key={b.slug ?? "none"}
                        type="button"
                        aria-pressed={route.baustelle === tabValue}
                        onClick={pick(() => route.art && route.goTo(route.art, tabValue))}
                        className={cn("rounded-md border px-2.5 py-1 text-caption font-medium", TAB_FOCUS, chipClass(route.baustelle === tabValue, b.count === 0))}
                      >
                        {b.label} <Count n={b.count} />
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            <section className="grid gap-2" aria-label={t("Werkzeug")}>
              <h3 className="text-label font-semibold tracking-wide text-a-mut uppercase">{t("Werkzeug")}</h3>
              <div className="flex">
                <ToolGroup route={route} />
              </div>
            </section>
            <button type="button" onClick={pick(onOpenRules)} className="justify-self-start text-caption text-a-acc hover:underline">
              {t("Regeln ansehen und abschalten")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RulesButton({ onClick }: { onClick: () => void }) {
  const hint = useTooltip(t("Regeln ansehen und abschalten"));
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        {...hint.triggerProps}
        className="flex h-(--a-ctl-h) shrink-0 items-center rounded-md border border-a-line px-2.5 text-caption text-a-mut hover:bg-a-p2 hover:text-a-ink"
      >
        {t("Regeln")}
      </button>
      {hint.tooltip}
    </>
  );
}

function NewSessionTab() {
  const hint = useTooltip(t("Neue Session starten (Claude oder Codex, im Terminal)"));
  return (
    <>
      <button
        type="button"
        data-nyx="neue-session"
        onClick={openNewSession}
        aria-label={t("Neue Session")}
        {...hint.triggerProps}
        className={cn(
          "relative top-px flex h-9 w-9 shrink-0 items-center justify-center rounded-t-lg border border-b-0 border-a-line bg-a-p2 text-headline text-a-mut hover:bg-a-p3 hover:text-a-ink",
          TAB_FOCUS,
        )}
      >
        +
      </button>
      {hint.tooltip}
    </>
  );
}

/**
 * Drei Tab-Zeilen wie in Safari: ART → BAUSTELLE → SESSION. Suche, „Zuletzt
 * geöffnet“, Regeln und der Werkzeug-Filter stehen rechts in der Kopfleiste
 * (`TopBarActions`) statt in einer eigenen Zeile darüber — spart eine ganze Zeile Höhe.
 */
export function TabRows({ categories, openRows, route, activeBaustelleLabel, onDropOnArt, onDropOnBaustelle, onOpenRules }: TabRowsProps) {
  const artEdges = useScrollEdges<HTMLDivElement>();
  const bauEdges = useScrollEdges<HTMLDivElement>();
  const sessionEdges = useScrollEdges<HTMLDivElement>();
  // Session aus der Tab-Leiste schließen – immer erst nach Rückfrage.
  const [closing, setClosing] = useState<Session | null>(null);
  const closeMutation = useCloseSession();
  const confirmClose = () => {
    if (!closing) return;
    const target = closing;
    closeMutation.mutate(target.id, {
      onSuccess: () => {
        setClosing(null);
        // Wie im Browser: war der Tab offen, geht es zurück zur Übersicht.
        const wasOpen = route.id === target.id || route.id === target.sessionId;
        if (wasOpen && route.art) route.goTo(route.art, route.baustelle, null);
      },
    });
  };

  const artsWithCounts = [...new Set([...ART_ORDER, ...categories.map((c) => c.art)])].map((art) => ({
    art,
    count: categories.find((c) => c.art === art)?.count ?? 0,
  }));
  const currentCategory = route.art ? categories.find((c) => c.art === route.art) : undefined;
  // „Alle“ ist die Zahl der Art selbst — dieselbe Quelle wie der Art-Tab, keine zweite Rechnung.
  const allCount = currentCategory?.count ?? 0;
  const baustellen = [...(currentCategory?.baustellen ?? [])];
  // Die gewählte Baustelle bleibt sichtbar (mit 0), auch wenn der Filter sie gerade leert —
  // sonst verschwände der aktive Tab, und man sähe nicht mehr, wo man ist. Andere leere
  // Baustellen liefert der Server gar nicht erst (sie verschwinden).
  if (route.baustelle && !baustellen.some((b) => (b.slug ?? BAUSTELLE_OHNE) === route.baustelle)) {
    const isOhne = route.baustelle === BAUSTELLE_OHNE;
    baustellen.push({ slug: isOhne ? null : route.baustelle, label: isOhne ? t("Ohne Baustelle") : (activeBaustelleLabel ?? route.baustelle), count: 0 });
  }

  return (
    <div className="bg-a-p">
      <TopBarActions>
        <SearchBox />
        <RecentButton currentTool={route.tool} />
        {/* Unter 768 px stehen Regeln und Werkzeug im Filter-Blatt (Kopfleiste sonst übervoll). */}
        <span className="hidden md:contents">
          <RulesButton onClick={onOpenRules} />
          <ToolGroup route={route} />
        </span>
      </TopBarActions>

      <CompactFilter route={route} arts={artsWithCounts} baustellen={baustellen} allCount={allCount} onOpenRules={onOpenRules} />

      <div className="hidden min-w-0 items-center gap-2.5 border-b border-a-line px-4 py-2 md:flex" role="tablist" aria-label={t("Art der Arbeit")}>
        <span className="w-[70px] shrink-0 font-mono text-label tracking-wider text-a-mut">{t("ART")}</span>
        {/* Fade-Maske nur an dem Rand, hinter dem die Zeile weiterscrollt (`useScrollEdges`). */}
        <div data-testid="art-tabs-scroll" {...artEdges} className="cc-edge-fade flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
          {artsWithCounts.map(({ art, count }) => {
            const selected = route.art === art;
            return (
              <button
                key={art}
                type="button"
                role="tab"
                aria-selected={selected}
                data-empty={count === 0}
                onClick={() => route.goTo(art, null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = withDragSessionId(e);
                  if (id) onDropOnArt(id, art);
                }}
                className={cn("shrink-0 rounded-lg border px-3.5 py-1.5 text-callout font-semibold", TAB_FOCUS, chipClass(selected, count === 0))}
              >
                {artLabel(art)} <Count n={count} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="hidden min-w-0 items-center gap-2.5 border-b border-a-line px-4 py-1.5 md:flex" role="tablist" aria-label={t("Baustelle")}>
        <span className="w-[70px] shrink-0 font-mono text-label tracking-wider text-a-mut">{t("BAUSTELLE")}</span>
        <div {...bauEdges} className="cc-edge-fade flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
          <button
            type="button"
            role="tab"
            aria-selected={route.baustelle === null}
            data-empty={allCount === 0}
            onClick={() => route.art && route.goTo(route.art, null)}
            className={cn("shrink-0 rounded-md border px-2.5 py-1 text-caption font-medium", TAB_FOCUS, chipClass(route.baustelle === null, allCount === 0))}
          >
            {t("Alle")} <Count n={allCount} />
          </button>
          {baustellen.map((b) => {
            // "Ohne Baustelle" (b.slug === null) ist ein EIGENER, explizit wählbarer Tab
            // — nicht dasselbe wie "Alle" (kein Filter), auch wenn beide `baustelle: null` als
            // Ziel-Wert für eine Zuordnung teilen (s. `onDropOnBaustelle`).
            const tabValue = b.slug ?? BAUSTELLE_OHNE;
            const selected = route.baustelle === tabValue;
            return (
              <button
                key={b.slug ?? "none"}
                type="button"
                role="tab"
                aria-selected={selected}
                data-empty={b.count === 0}
                onClick={() => route.art && route.goTo(route.art, tabValue)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = withDragSessionId(e);
                  if (id && route.art) onDropOnBaustelle(id, route.art, b.slug ? { slug: b.slug, label: b.label } : null);
                }}
                className={cn("shrink-0 rounded-md border px-2.5 py-1 text-caption font-medium", TAB_FOCUS, chipClass(selected, b.count === 0))}
              >
                {b.label} <Count n={b.count} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-w-0 items-end gap-2.5 px-3 pt-2.5 md:px-4" role="tablist" aria-label={t("Sessions")}>
        <span className="hidden w-[70px] shrink-0 pb-2 md:block font-mono text-label tracking-wider text-a-mut">{t("SESSION")}</span>
        <div {...sessionEdges} className="cc-edge-fade flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]">
          <button
            type="button"
            role="tab"
            aria-selected={route.id === null}
            onClick={() => route.art && route.goTo(route.art, route.baustelle)}
            className={cn(
              "relative top-px h-9 shrink-0 rounded-t-lg border border-b-0 px-3.5 text-caption",
              TAB_FOCUS,
              route.id === null ? "z-10 border-a-line bg-a-bg text-a-ink" : "border-a-line bg-a-p2 text-a-mut hover:bg-a-p3 hover:text-a-ink",
            )}
          >
            ▦ {t("Übersicht")}
          </button>
          {openRows.map(({ session }) => {
            const selected = route.id === session.id || route.id === session.sessionId;
            return (
              <SessionTab
                key={session.id}
                session={session}
                selected={selected}
                onClick={() => route.art && route.goTo(route.art, route.baustelle, selected ? null : session.id)}
                onRequestClose={() => setClosing(session)}
              />
            );
          })}
          <NewSessionTab />
        </div>
      </div>
      <CloseDialog
        open={closing !== null}
        sessionTitle={closing ? sessionLabel(closing) : ""}
        title={closing ? t("Session „{title}“ endgültig schließen?", { title: sessionLabel(closing) }) : undefined}
        pending={closeMutation.isPending}
        error={closeMutation.isError ? t("Das Schließen hat nicht geklappt. Bitte noch einmal versuchen.") : null}
        onConfirm={confirmClose}
        onCancel={() => {
          closeMutation.reset();
          setClosing(null);
        }}
      />
    </div>
  );
}
