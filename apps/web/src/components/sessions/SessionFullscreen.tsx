import { useId, useState, type ReactNode } from "react";
import type { Baustelle, CategoryCount, RuleDimension, Session } from "../../lib/api";
import { duration, relativeTime } from "../../lib/format";
import { sessionLabel, sessionStateMeta } from "../../lib/sessionLabel";
import { cn } from "../../lib/cn";
import { useCloseSession, useReopenSession, useSessionDetail } from "../../hooks/useSessionApi";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { useTooltip } from "../ui/Tooltip";
import { Stack } from "../Stack";
import { ToolTag } from "./ToolTag";
import { CloseDialog } from "./CloseDialog";
import { ChangesPanel } from "./ChangesPanel";
import { AgentsPanel } from "./AgentsPanel";
import { RefsPanel } from "./RefsPanel";
import { InfoPanel } from "./InfoPanel";
import { MoveMenu } from "./MoveMenu";
import { useSearchParams } from "react-router";
import { TerminalPanel } from "../../features/terminal/TerminalPanel";
import { SessionTerminalActions } from "../../features/terminal/SessionTerminalActions";
import { useBridgeStatus } from "../../features/terminal/terminalApi";
// Kontext-Wächter — Ring + Menü im Kopf (Logik in features/context-guard/).
import { ContextGuardBadge } from "../../features/context-guard/ContextGuardBadge";
import { BuildStatusPill } from "../../features/builds/BuildStatusPill";
import { useBuilds } from "../../features/builds/useBuilds";
// Chat mit Eingabe, Kopf-Aktionen, dünne Info-Leiste.
import { SessionChat } from "../../features/session-chat/SessionChat";
import { SessionActions, type ExtraMenuAction } from "../../features/session-chat/SessionActions";
import { useFitLevel } from "../../hooks/useFitLevel";
import type { BuildRunRow } from "../../features/builds/useBuilds";
import { describeBuildRun, t } from "@nyxos/shared";
import { SessionAuditCard } from "../../features/session-chat/SessionAuditCard";
import { readInfoCollapsed, SessionInfoRail, writeInfoCollapsed } from "../../features/session-chat/SessionInfoRail";
import { currentModel, folderLabel, modelLabel } from "../../features/session-chat/model";
import { IconPanelClose } from "../../features/session-chat/icons";
import { chatKey } from "../../features/session-chat/api";
import { TakeoverButton } from "../../features/terminal/TakeoverButton";
import { useQueryClient } from "@tanstack/react-query";

type Tab = "chat" | "terminal" | "changes" | "agents" | "refs";
const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: t("Chat") },
  { id: "terminal", label: t("Terminal") },
  { id: "changes", label: t("Änderungen") },
  { id: "agents", label: t("Agenten") },
  { id: "refs", label: t("Bezüge") },
];

interface SessionFullscreenProps {
  session: Session;
  categories: CategoryCount[];
  at: number | null;
  onMove: (dims: RuleDimension[], art: string, baustelle: Baustelle | null) => void;
}

/**
 * In der gesperrten Chat-Eingabe steht der Knopf „In der NyxOS übernehmen“. Nach dem
 * Übernehmen läuft die Session in der NyxOS — dann sofort den Sperr-Zustand neu holen, damit der Nutzer
 * gleich hier weiterschreiben kann (nicht erst nach dem nächsten 10-s-Abruf).
 */
function ChatTakeover({ session }: { session: Session }) {
  const qc = useQueryClient();
  return <TakeoverButton session={session} onDone={() => void qc.invalidateQueries({ queryKey: chatKey(session.id) })} className="h-(--a-ctl-h) shrink-0 py-0" />;
}

/** Kurzer Text mit Ellipse, voller Text als Hinweis (kürzen statt umbrechen). */
function Clipped({ children, full, className, testId }: { children: ReactNode; full: string; className?: string; testId?: string }) {
  const tip = useTooltip(full);
  const descId = useId();
  return (
    <>
      <span data-testid={testId} className={cn("min-w-0 truncate", className)} tabIndex={0} {...tip.triggerProps} aria-describedby={descId}>
        {children}
      </span>
      <span id={descId} className="sr-only">
        {full}
      </span>
      {tip.tooltip}
    </>
  );
}

/** Session-Vollbild: Kopf, Reiter, Chat + Info-Bereich (unter 1280 px gestapelt). */
export function SessionFullscreen({ session, categories, at, onMove }: SessionFullscreenProps) {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (params.get("tab") === "terminal" ? "terminal" : "chat"));
  const bridge = useBridgeStatus();
  const [confirmClose, setConfirmClose] = useState(false);
  const [infoCollapsed, setInfoCollapsed] = useState(readInfoCollapsed);
  const detailQuery = useSessionDetail(session.id);
  const closeMutation = useCloseSession();
  const reopenMutation = useReopenSession();

  const live = detailQuery.data?.session ?? session;
  // Build-Wächter: neuester Lauf zuerst (API-Reihenfolge).
  const buildRuns = useBuilds(live.id).data ?? [];

  const setCollapsed = (v: boolean) => {
    setInfoCollapsed(v);
    writeInfoCollapsed(v);
  };

  const collapseButton = (
    <Button variant="ghost" onClick={() => setCollapsed(true)} aria-label={t("Infos einklappen")} title={t("Infos zu einem schmalen Balken einklappen (mehr Platz für den Chat)")} className="h-7 w-7 px-0 py-0">
      <IconPanelClose size={15} />
    </Button>
  );

  const side = infoCollapsed ? (
    <SessionInfoRail session={live} detail={detailQuery.data} onExpand={() => setCollapsed(false)} />
  ) : (
    // Eigene Scroll-Spur — lange Dateilisten schieben den Chat nie mehr aus dem Bild.
    <div data-testid="session-info" className="cc-scroll grid min-h-0 min-w-0 content-start gap-3 overflow-y-auto pr-1">
      <div className="flex items-center justify-between">
        <h4 className="font-mono text-label font-semibold tracking-wide text-a-mut uppercase">{t("Session-Infos")}</h4>
        {collapseButton}
      </div>
      <SessionAuditCard sessionId={live.id} />
      {detailQuery.data && <InfoPanel detail={detailQuery.data} />}
    </div>
  );

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_auto_1fr]">
      <SessionHead
        live={live}
        categories={categories}
        onMove={onMove}
        buildRuns={buildRuns}
        onOpenTerminal={() => setTab("terminal")}
        onWatch={() => setTab("chat")}
        onClose={() => setConfirmClose(true)}
        onReopen={() => reopenMutation.mutate(live.id)}
        reopenPending={reopenMutation.isPending}
      />

      <div className="flex gap-1 overflow-x-auto border-b border-a-line px-3.5 py-1.5 [scrollbar-width:none]" role="tablist" aria-label={t("Session-Ansicht")}>
        {TABS.map((tabDef) => {
          // Terminal-Reiter: nur aus, wenn der Rechner offline ist. Läuft die Session in einem eigenen
          // Fenster, bleibt der Reiter an und bietet dort „In der NyxOS übernehmen“ an.
          const termOff = tabDef.id === "terminal" && !(bridge.data?.online ?? false);
          const termHint = t("Dein Rechner ist gerade nicht verbunden");
          return (
            <button
              key={tabDef.id}
              type="button"
              role="tab"
              aria-selected={tab === tabDef.id}
              aria-disabled={termOff || undefined}
              disabled={termOff && tab !== "terminal"}
              title={termOff ? termHint : undefined}
              onClick={() => setTab(tabDef.id)}
              className={cn("shrink-0 rounded-md px-2.5 py-1 text-caption", tab === tabDef.id ? "bg-a-p3 text-a-ink" : termOff ? "cursor-not-allowed text-a-mut" : "text-a-mut hover:text-a-ink")}
            >
              {tabDef.label}
              {termOff && tab !== "terminal" && <span className="ml-1 text-label">· {t("Rechner offline")}</span>}
            </button>
          );
        })}
      </div>

      <div className="cc-scroll min-h-0 min-w-0 overflow-y-auto p-3.5">
        {detailQuery.isPending ? (
          <div className="grid gap-2">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-16" />
            ))}
          </div>
        ) : detailQuery.isError ? (
          <div className="grid justify-items-start gap-2 text-caption">
            <p className="text-a-bad">{t("Session-Details konnten nicht geladen werden.")}</p>
            <Button onClick={() => detailQuery.refetch()}>{t("Erneut versuchen")}</Button>
          </div>
        ) : tab === "terminal" ? (
          <div className="h-[calc(100dvh-230px)] min-h-[420px] w-full min-w-0 overflow-hidden rounded-lg border border-a-line bg-a-bg">
            <TerminalPanel key={live.id} session={live} onWatch={() => setTab("chat")} />
          </div>
        ) : (
          <MainAndSide collapsed={infoCollapsed}>
            {/* `data-testid`s für den Playwright-Layout-Test: Breite/Stapel-Reihenfolge lassen
                sich so ohne fragile Textsuche prüfen. */}
            {tab === "chat" ? (
              <SessionChat key={live.id} session={live} at={at} takeover={<ChatTakeover session={live} />} />
            ) : (
              <div data-testid="session-main" className="cc-scroll min-h-0 overflow-y-auto rounded-lg border border-a-line bg-a-p">
                {tab === "changes" && <ChangesPanel detail={detailQuery.data} />}
                {tab === "agents" && <AgentsPanel detail={detailQuery.data} />}
                {tab === "refs" && <RefsPanel detail={detailQuery.data} />}
              </div>
            )}
            {side}
          </MainAndSide>
        )}
      </div>

      <CloseDialog
        open={confirmClose}
        sessionTitle={sessionLabel(live)}
        pending={closeMutation.isPending}
        onConfirm={() =>
          closeMutation.mutate(live.id, {
            onSuccess: () => setConfirmClose(false),
          })
        }
        onCancel={() => setConfirmClose(false)}
      />
    </div>
  );
}

/**
 * Einklapp-Stufen des Kopfs. Vorher klappten Knöpfe nach festen Container-Breiten ein
 * (1500/1700 px) — bei 1280 px lief der Kopf trotzdem über. Jetzt misst `useFitLevel` den Platz: Titel und
 * Pfad kürzen sich zuerst (Ellipse), erst wenn sie am Minimum sind, klappt die nächste Stufe ein.
 */
const HEAD_LEVEL = {
  moveIcon: 1, // „Verschieben nach …“ → nur Symbol
  d3Menu: 2, // „Kontext komprimieren“ / „Session prüfen“ → Menü „⋯“
  stateShort: 3, // Zustand ohne „· vor 2 Std“
  killMenu: 4, // „Prozess beenden“ → Menü „⋯“
  closeMenu: 5, // „Schließen“ → Menü „⋯“
  shortLabels: 6, // „In der NyxOS übernehmen“ → „Übernehmen“, „Im Terminal öffnen“ → „Terminal“
  titleShrink: 7, // Titel darf unter 160 px (bis 88 px) kürzen
  noSparkline: 8, // Build-Plakette ohne Verlauf
  noPath: 9, // Pfad ausblenden (steht in den Session-Infos)
  noModel: 10, // Modell ausblenden (steht in den Session-Infos)
  // Reicht auch das nicht (Handy, 390 px), rutschen die Knöpfe in eine eigene zweite
  // Zeile – vorher war „In der NyxOS übernehmen“ nur noch „Üb…“, „Prozess beenden“/„Schließen“ fehlten ganz.
  wrap: 11,
} as const;
const HEAD_MAX_LEVEL = 11;

interface SessionHeadProps {
  live: Session;
  categories: CategoryCount[];
  onMove: (dims: RuleDimension[], art: string, baustelle: Baustelle | null) => void;
  buildRuns: BuildRunRow[];
  onOpenTerminal: () => void;
  onWatch: () => void;
  onClose: () => void;
  onReopen: () => void;
  reopenPending: boolean;
}

/**
 * EINE Zeile. Links Zustand, Titel, Werkzeug, Modell, Pfad (Titel/Pfad kürzen sich mit Ellipse +
 * Hinweis), rechts Ring, Verschieben, Terminal-Aktionen, Schließen, Session-Knöpfe. Knöpfe brechen nie um und
 * ragen nie heraus: bei wenig Platz klappen sie stufenweise ein (s. `HEAD_LEVEL`). Alle Bedienelemente
 * haben die gemeinsame Höhe `--a-ctl-h`. Eigene Komponente, damit das Nachmessen nur den Kopf neu zeichnet.
 */
function SessionHead({ live, categories, onMove, buildRuns, onOpenTerminal, onWatch, onClose, onReopen, reopenPending }: SessionHeadProps) {
  const bridge = useBridgeStatus();
  const online = bridge.data?.online ?? false;
  const [killOpen, setKillOpen] = useState(false);
  // Geister-Sessions ruhig als „verwaist“ statt „wartet auf dich“.
  const meta = sessionStateMeta(live);
  const age = relativeTime(live.lastActivityAt) ?? duration(live.startedAt, null);
  const isClosed = live.state === "closed";
  const running = live.status === "running";
  const buildCurrent = buildRuns[0] ?? null;
  const buildHistory = [...buildRuns].reverse();
  // Das AKTUELLE Modell (vorher `models[0]` = erstes), bei Wechsel alle im Hinweis.
  const model = currentModel(live);
  const otherModels = live.models.filter((m) => m !== model);
  const modelHint = live.models.length > 1 ? t("Modelle in dieser Session: {list} · jetzt: {model}", { list: live.models.join(" → "), model }) : t("Modell: {model}", { model });
  const title = sessionLabel(live);

  // Neu messen, sobald sich etwas ändert, das die Breite der Zeile bestimmt.
  const resetKey = [live.id, title, live.cwd, model, live.models.length, meta.label, age, isClosed, running, live.attachable, buildRuns.length, buildCurrent?.status].join("|");
  const { ref, contentRef, level } = useFitLevel(HEAD_MAX_LEVEL, resetKey);
  const at = (l: number) => level >= l;

  const extra: ExtraMenuAction[] = [];
  if (running && at(HEAD_LEVEL.killMenu)) extra.push({ label: t("Prozess beenden"), disabledReason: online ? null : t("Dein Rechner ist gerade nicht verbunden."), onSelect: () => setKillOpen(true) });
  if (!isClosed && at(HEAD_LEVEL.closeMenu)) extra.push({ label: t("Schließen"), onSelect: onClose });

  return (
    <div
      ref={ref}
      data-testid="session-head"
      data-fit-level={level}
      className={cn("flex min-w-0 items-center gap-2 border-b border-a-line px-4 py-2", at(HEAD_LEVEL.wrap) ? "flex-wrap gap-y-1.5 px-3" : "flex-nowrap")}
    >
      <span
        className={cn("inline-flex h-(--a-ctl-h) shrink-0 items-center gap-1.5 rounded-full px-2.5 text-caption whitespace-nowrap", meta.bg, meta.text)}
        title={age ? `${meta.label} · ${age}` : undefined}
      >
        <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
        {meta.label}
        {age && !at(HEAD_LEVEL.stateShort) && ` · ${age}`}
      </span>
      {/* Build-Wächter: nur zeigen, wenn diese Session schon einen Build ausgelöst hat. */}
      {buildRuns.length > 0 && (
        <BuildStatusPill
          current={buildCurrent}
          view={buildCurrent ? (buildCurrent.view ?? describeBuildRun(buildCurrent)) : null}
          history={at(HEAD_LEVEL.noSparkline) ? [] : buildHistory}
          className="shrink-0"
        />
      )}
      {/* Der Titel behält bis zur Stufe `titleShrink` mindestens 160 px — vorher klappen
          lieber Knöpfe ins Menü „⋯“, als dass nur „Software review au…“ übrig bleibt. */}
      <Clipped full={title} className={cn("flex-[1_1_180px] text-headline font-bold text-a-ink", at(HEAD_LEVEL.titleShrink) ? "min-w-[88px]" : "min-w-[160px]")}>
        {title}
      </Clipped>
      {/* In der schmalen Zwei-Zeilen-Form steht das Werkzeug schon im Reiter darüber. */}
      {!at(HEAD_LEVEL.wrap) && <ToolTag tool={live.tool} />}
      {/* Modell als Kurzform („Opus 5.5“) — kürzt sich nicht, voller Name im Tooltip. */}
      {model && !at(HEAD_LEVEL.noModel) && (
        <Clipped testId="session-model" full={modelHint} className="inline-flex shrink-0 items-center gap-1 rounded border border-a-line px-1.5 text-label whitespace-nowrap text-a-mut">
          <span>{modelLabel(model)}</span>
          {otherModels.length > 0 && <span className="shrink-0 rounded bg-a-p3 px-1 text-label text-a-ink">+{otherModels.length}</span>}
        </Clipped>
      )}
      {/* Pfad mit dem letzten Ordner vorn („…/NyxOS“) statt eines abgeschnittenen Endes. */}
      {live.cwd && !at(HEAD_LEVEL.noPath) && (
        <Clipped testId="session-path" full={live.cwd} className="max-w-[180px] shrink-0 rounded border border-a-line px-1.5 font-mono text-label text-a-mut">
          {folderLabel(live.cwd)}
        </Clipped>
      )}

      <div ref={contentRef} className={cn("ml-auto flex shrink-0 flex-nowrap items-center gap-1.5 [&_button]:whitespace-nowrap", at(HEAD_LEVEL.wrap) && "basis-full justify-end")}>
        {/* Kontext-Wächter — Ring + Menü im Kopf. */}
        <ContextGuardBadge sessionId={live.id} compact contextWindow={live.contextWindow} at={live.lastActivityAt} />
        <MoveMenu categories={categories} currentArt={live.art} currentBaustelle={live.baustelle} onPick={onMove} compact={at(HEAD_LEVEL.moveIcon)} />
        {/* Terminal-Aktionen: gleiche Höhe, Fehlermeldung schwebt unter der Zeile statt sie umzubrechen. */}
        <div className="relative flex shrink-0 flex-nowrap items-center gap-1.5 [&_button]:h-(--a-ctl-h) [&_button]:py-0 [&>[role=alert]]:absolute [&>[role=alert]]:top-full [&>[role=alert]]:right-0 [&>[role=alert]]:z-30 [&>[role=alert]]:mt-1.5 [&>[role=alert]]:w-72 [&>[role=alert]]:rounded-md [&>[role=alert]]:border [&>[role=alert]]:border-a-wait/40 [&>[role=alert]]:bg-a-p2 [&>[role=alert]]:p-2">
          <SessionTerminalActions
            session={live}
            onOpenTerminal={onOpenTerminal}
            onWatch={onWatch}
            short={at(HEAD_LEVEL.shortLabels)}
            killInMenu={at(HEAD_LEVEL.killMenu)}
            killOpen={killOpen}
            onKillOpen={setKillOpen}
          />
        </div>
        {isClosed ? (
          <Button onClick={onReopen} disabled={reopenPending} className="h-(--a-ctl-h) shrink-0 py-0">
            {reopenPending ? t("Öffne …") : t("Wieder öffnen")}
          </Button>
        ) : (
          !at(HEAD_LEVEL.closeMenu) && (
            // "Schließen" ist keine Hauptaktion — `ghost` statt der gelb umrandeten
            // `warn`-Variante, die vorher wie der Primärknopf wirkte.
            <Button variant="ghost" onClick={onClose} className="h-(--a-ctl-h) shrink-0 py-0">
              {t("Schließen")}
            </Button>
          )
        )}
        <SessionActions session={live} inline={!at(HEAD_LEVEL.d3Menu)} extra={extra} />
      </div>
    </div>
  );
}

/** Chat/Panel links, Infos rechts — aufgeklappt als `Stack`, eingeklappt als 48-px-Balken. */
function MainAndSide({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  if (!collapsed) return <Stack className="h-full min-h-[420px]">{children}</Stack>;
  return <div className="grid h-full min-h-[420px] grid-cols-[minmax(0,1fr)_48px] gap-3">{children}</div>;
}
