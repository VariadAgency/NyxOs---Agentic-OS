import { t } from "@nyxos/shared";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { MoveDialog, type PendingMove } from "../components/sessions/MoveDialog";
import { RulesPanel } from "../components/sessions/RulesPanel";
import { SessionFullscreen } from "../components/sessions/SessionFullscreen";
import { SessionOverview } from "../components/sessions/SessionOverview";
import { TabRows } from "../components/sessions/TabRows";
import { Toast, type ToastAction } from "../components/sessions/Toast";
import { useAssignSession, useUnassignSession, useCategories, useSessionDetail } from "../hooks/useSessionApi";
import { useSessions } from "../hooks/useSessions";
import { BAUSTELLE_NONE, BAUSTELLE_OHNE, useSessionsRoute } from "../hooks/useSessionsRoute";
import { recordSessionOpen } from "../features/recent/recentApi";
import type { AssignTarget, Baustelle, RuleDimension, Session } from "../lib/api";
import { ART_ORDER, artLabel, sortArts } from "../lib/arts";
import { groupSessions, tabCounts } from "../lib/sessionOrder";
import { isTemporary, TempFilterChip, useHideTemporary, withoutTemporary } from "../features/temporary/TempFilterChip";

interface ToastState {
  message: string;
  action?: ToastAction | null;
}

/** Sessions-Tab: drei Tab-Zeilen, Übersicht mit Karten, Vollbild je Session. */
export function SessionsView() {
  const sessionsQuery = useSessions();
  const route = useSessionsRoute();
  // Zähler passend zum Werkzeug-Filter (Art- und Baustellen-Zeile).
  const categoriesQuery = useCategories(route.tool);
  // Verschieben-Menü im Vollbild braucht ALLE Baustellen, nicht nur die des gewählten Werkzeugs
  // (bei „Alle“ dieselbe Query, also keine zweite Anfrage).
  const allCategoriesQuery = useCategories("alle");
  const location = useLocation();
  const navigate = useNavigate();
  const assignMutation = useAssignSession();
  const unassignMutation = useUnassignSession();

  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [hideTemporary, setHideTemporary] = useHideTemporary();

  const sessions = sessionsQuery.data ?? [];
  const categories = categoriesQuery.data ?? [];
  // Reiter-Zähler aus derselben Liste und nach derselben Regel wie die Übersicht
  // (Werkzeug- und Temporär-Filter, offen + geschlossen + beendet, Kind-Sessions) — nicht aus
  // `/api/categories`, das anders zählte („Coding 11“ über „1 offen + Beendet (16)“).
  const tabCategories = useMemo(
    () => tabCounts(withoutTemporary(sessions.filter((s) => route.tool === "alle" || s.tool === route.tool), hideTemporary)),
    [sessions, route.tool, hideTemporary],
  );

  // Ohne Art in der URL: auf die erste Art mit offenen Sessions springen (sonst die erste bekannte Art).
  useEffect(() => {
    if (route.art !== null || sessionsQuery.isPending || categoriesQuery.isPending) return;
    const base: { art: string; count: number }[] = tabCategories.length > 0 ? tabCategories.map((c) => ({ art: c.art, count: c.count })) : ART_ORDER.map((art) => ({ art, count: 0 }));
    const withCounts = sortArts(base);
    const first = withCounts.find((c) => c.count > 0) ?? withCounts[0];
    navigate(`/sessions/${first?.art ?? "coding"}/_${route.tool !== "alle" ? `?tool=${route.tool}` : ""}`, { replace: true });
    // `categoriesQuery.isPending` gehört dazu – kam die Kategorien-Antwort NACH der Session-Liste,
    // lief der Effekt nie wieder und /sessions blieb leer (Klick auf „Sessions“ in der Leiste zeigte nichts).
  }, [route.art, sessionsQuery.isPending, categoriesQuery.isPending, tabCategories]);

  // Links ohne Art (`/sessions/_/_/:id`, z. B. aus dem Git-Tab) zeigten „– / –“ im
  // Brotkrümel, keine gewählte Art und Baustelle „Alle 0“. Sobald die Session bekannt ist, auf ihre Art springen.
  // Die Liste (`useSessions`) ist begrenzt — ältere Sessions über die Detail-Abfrage auflösen (dieselbe
  // Query wie das Vollbild, also aus dem Cache).
  const listed = route.id ? sessions.find((s) => s.id === route.id || s.sessionId === route.id) : undefined;
  const detail = useSessionDetail(route.id && !listed && !sessionsQuery.isPending ? route.id : null);
  const openedSession = listed ?? detail.data?.session;
  const unplacedSession = route.art === BAUSTELLE_NONE ? openedSession : undefined;
  useEffect(() => {
    if (!unplacedSession) return;
    // Suchteil (`?tool=`, `?at=` für den Sprung im Verlauf) unverändert mitnehmen.
    navigate(`/sessions/${unplacedSession.art}/${BAUSTELLE_NONE}/${unplacedSession.id}${location.search}`, { replace: true });
  }, [unplacedSession?.id, unplacedSession?.art, location.search]);

  // Öffnen einer Session für „Zuletzt geöffnet“ merken (angemeldet am Server, sonst still im Browser).
  const openedKey = openedSession?.id ?? null;
  useEffect(() => {
    if (openedKey) void recordSessionOpen(openedKey);
  }, [openedKey]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  if (sessionsQuery.isPending || categoriesQuery.isPending) {
    return (
      <div className="grid gap-2 p-4">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-11" />
        ))}
      </div>
    );
  }

  if (sessionsQuery.isError || categoriesQuery.isError) {
    return (
      <div className="grid justify-items-start gap-3 p-6 text-callout">
        <p className="text-a-bad">{t("Sessions konnten nicht geladen werden.")}</p>
        <Button
          onClick={() => {
            void sessionsQuery.refetch();
            void categoriesQuery.refetch();
          }}
        >
          {t("Erneut versuchen")}
        </Button>
      </div>
    );
  }

  if (route.art === null) return null; // Redirect läuft gerade (Effekt oben)

  const toolFiltered = sessions.filter((s) => route.tool === "alle" || s.tool === route.tool);
  const artAll = toolFiltered.filter((s) => s.art === route.art);
  const artFiltered = withoutTemporary(artAll, hideTemporary);
  // "Ohne Baustelle" ist ein EIGENER Filter (Sessions ohne Baustelle), nicht dasselbe wie
  // "Alle" (kein Filter) — beide teilten sich vorher `route.baustelle === null`.
  const scoped =
    route.baustelle === BAUSTELLE_OHNE
      ? artFiltered.filter((s) => s.baustelle === null)
      : route.baustelle
        ? artFiltered.filter((s) => s.baustelle?.slug === route.baustelle)
        : artFiltered;
  const openRows = groupSessions(scoped).open;

  // Links aus Suche, ⌘K-Treffern und Gehirn tragen die nackte sessionId, Karten/Tabs den Schlüssel
  // `<tool>:<id>` — beides öffnet das Vollbild.
  const matchesRoute = (s: Session) => s.id === route.id || s.sessionId === route.id;
  const selected: Session | null = route.id ? (scoped.find(matchesRoute) ?? sessions.find(matchesRoute) ?? null) : null;

  const baustelleLabel =
    route.baustelle === BAUSTELLE_OHNE
      ? t("Ohne Baustelle")
      : route.baustelle
        ? (categories.find((c) => c.art === route.art)?.baustellen.find((b) => b.slug === route.baustelle)?.label ??
          sessions.find((s) => s.baustelle?.slug === route.baustelle)?.baustelle?.label ??
          route.baustelle)
        : null;
  const placeLabel = artLabel(route.art) + (baustelleLabel ? ` → ${baustelleLabel}` : "");

  // Ziehen auf einen ART-/BAUSTELLEN-Tab bzw. die manuelle Auswahl im Vollbild korrigiert **nur**
  // die übergebene(n) Dimension(en) — nie beide über eine Ordner-Bedingung.
  const openMove = (session: Session, dims: RuleDimension[], art: string, baustelle: Baustelle | null) => {
    if (dims.length === 0) return;
    setPendingMove({
      sessionId: session.id,
      sessionTitle: session.title ?? session.sessionId,
      dims,
      art: dims.includes("art") ? art : undefined,
      artLabel: dims.includes("art") ? artLabel(art) : undefined,
      baustelle: dims.includes("baustelle") ? baustelle : undefined,
    });
  };

  const confirmMove = (asRule: boolean) => {
    if (!pendingMove) return;
    const target: AssignTarget = {};
    if (pendingMove.dims.includes("art")) target.art = pendingMove.art;
    if (pendingMove.dims.includes("baustelle")) target.baustelle = pendingMove.baustelle ?? null;
    const move = pendingMove;
    assignMutation.mutate(
      { id: move.sessionId, target, asRule },
      {
        onSuccess: (result) => {
          setPendingMove(null);
          const ruleIds = result.rules.map((r) => r.id);
          const message =
            result.rules.length > 0
              ? t(result.resorted.length === 1 ? "Verschoben — {n} Session neu sortiert" : "Verschoben — {n} Sessions neu sortiert", { n: result.resorted.length })
              : t("Verschoben — nur diese Session");
          const action: ToastAction = {
            label: t("Rückgängig"),
            onClick: () =>
              unassignMutation.mutate(
                { id: move.sessionId, ruleIds, dims: move.dims },
                { onSuccess: () => setToast(null) },
              ),
          };
          setToast({ message, action });
        },
      },
    );
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_1fr]">
      <TabRows
        categories={tabCategories}
        openRows={openRows}
        route={route}
        activeBaustelleLabel={baustelleLabel}
        onOpenRules={() => setRulesOpen(true)}
        onDropOnArt={(sessionId, art) => {
          const session = sessions.find((s) => s.id === sessionId);
          if (session) openMove(session, ["art"], art, null);
        }}
        onDropOnBaustelle={(sessionId, _art, baustelle) => {
          const session = sessions.find((s) => s.id === sessionId);
          if (session) openMove(session, ["baustelle"], session.art, baustelle);
        }}
      />
      <div className="min-w-0 cc-scroll min-h-0 overflow-y-auto bg-a-bg">
        {selected ? (
          <SessionFullscreen
            session={selected}
            categories={allCategoriesQuery.data ?? categories}
            at={route.at}
            onMove={(dims, art, baustelle) => openMove(selected, dims, art, baustelle)}
          />
        ) : (
          <SessionOverview
            sessions={scoped}
            placeLabel={placeLabel}
            filters={<TempFilterChip hide={hideTemporary} onChange={setHideTemporary} count={artAll.filter(isTemporary).length} />}
            onOpen={(session) => route.art && route.goTo(session.art, session.baustelle?.slug ?? route.baustelle, session.id)}
            onDragStart={(session) => (event) => event.dataTransfer.setData("text/session-id", session.id)}
          />
        )}
      </div>
      <MoveDialog move={pendingMove} pending={assignMutation.isPending} onConfirm={confirmMove} onCancel={() => setPendingMove(null)} />
      <RulesPanel open={rulesOpen} onClose={() => setRulesOpen(false)} onToast={(message) => setToast({ message })} />
      <Toast message={toast?.message ?? null} action={toast?.action} />
    </div>
  );
}
