// Tab „Gehirn": alles, was die NyxOS weiß, als lebendiger Kräfte-Graph wie Obsidians Graph-Ansicht.
import { t, type GraphNode, type GraphNodeType } from "@nyxos/shared";
import { statsLine } from "./headline";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "../../components/ui/button";
import { colorKeyOf, type ColorKey, type FamilyKey } from "./colors";
import { ControlPanel } from "./ControlPanel";
import { computeView } from "./filter";
import { measureFreeArea, type Rect } from "./fitArea";
import { GraphCanvas, type GraphCanvasHandle } from "./GraphCanvas";
import type { SimNode } from "./graphData";
import { isGroupHidden, Legend, toggleGroup as toggleGroupIn } from "./Legend";
import { openTarget } from "./links";
import { NodeSheet } from "./NodeSheet";
import { loadSettings, saveSettings, type BrainSettings } from "./settings";
import { useGraph } from "./useGraph";
import { ViewBar } from "./ViewBar";
import { sessionBrain } from "./views";

const loadGraph3D = () => import("./Graph3D");
const Graph3D = lazy(loadGraph3D);

export const BRAIN_POSITIONS_KEY = "nyxos.brain.positions.v1";

/** Filter-Felder: ändert man eines davon von Hand, ist die Ansicht „eigene Einstellung". */
const FILTER_KEYS = ["groups", "noteGroups", "subGroups", "period", "states", "showOrphans", "showUnresolved", "search"] as const;
function markCustom(prev: BrainSettings, next: BrainSettings): BrainSettings {
  if (next.activeView !== prev.activeView) return next;
  const changed = FILTER_KEYS.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  if (!changed || prev.activeView === "session" || prev.activeView === "baustelle") return next;
  return { ...next, activeView: "custom" };
}

export function useBrainSettings(): [BrainSettings, (s: BrainSettings) => void] {
  const [settings, setSettings] = useState<BrainSettings>(() => loadSettings());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Noch nicht gespeicherter Stand (Speichern ist um 300 ms verzögert). */
  const pending = useRef<BrainSettings | null>(null);
  useEffect(() => {
    clearTimeout(timer.current);
    pending.current = settings;
    timer.current = setTimeout(() => {
      pending.current = null;
      saveSettings(settings);
    }, 300);
  }, [settings]);
  // Beim Verlassen der Seite sofort speichern, statt die letzte Änderung zu verwerfen.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (pending.current) saveSettings(pending.current);
      pending.current = null;
    },
    [],
  );
  return [settings, setSettings];
}

export function useOpenNode() {
  const navigate = useNavigate();
  return (n: GraphNode) => {
    const target = openTarget(n);
    if (!target) return;
    if (target.kind === "route") void navigate(target.to);
    else window.location.href = target.href;
  };
}

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };

export function BrainView() {
  const [settings, setSettingsRaw] = useBrainSettings();
  const setSettings = (next: BrainSettings) => setSettingsRaw(markCustom(settings, next));
  const load = useGraph(settings.groups.file !== "hide");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Freie Fläche neben den Kacheln — kurz gemerkt, weil 3D beim Aufbau je Bild einpasst.
  const areaMemo = useRef<{ at: number; area: Rect | null }>({ at: -1e9, area: null });
  const fitArea = useCallback((): Rect | null => {
    const now = performance.now();
    if (now - areaMemo.current.at < 250) return areaMemo.current.area;
    const area = measureFreeArea(rootRef.current);
    areaMemo.current = { at: now, area };
    return area;
  }, []);
  // Auswahl öffnet/schließt das Seitenblatt links — die gemerkte freie Fläche gilt dann nicht
  // mehr (sonst fliegt „Anfliegen“ kurz danach mit der Fläche ohne Blatt an).
  useLayoutEffect(() => {
    areaMemo.current = { at: -1e9, area: null };
  }, [selectedId]);
  const graph3dRef = useRef<GraphCanvasHandle | null>(null);
  const openNode = useOpenNode();
  const is3d = settings.mode === "3d";
  // 3D bleibt nach dem ersten Umschalten eingehängt (Wechsel ohne Neuaufbau).
  const [has3d, setHas3d] = useState(is3d);
  useEffect(() => {
    if (is3d) setHas3d(true);
  }, [is3d]);
  // 3D-Bundle im Leerlauf vorladen, damit der erste Wechsel nicht erst three.js holen muss.
  useEffect(() => {
    const w = window as IdleWindow;
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(() => void loadGraph3D(), { timeout: 4000 });
      return () => w.cancelIdleCallback?.(h);
    }
    const timer = window.setTimeout(() => void loadGraph3D(), 2500);
    return () => window.clearTimeout(timer);
  }, []);
  const activeGraph = () => (is3d ? graph3dRef.current : canvasRef.current);

  const ready = load.status === "ready" ? load : null;
  const view = useMemo(
    () => (ready ? computeView(ready.graph.nodes, ready.graph.links, settings) : null),
    // dataVersion statt graph: das Objekt bleibt bei Deltas dasselbe
    [ready?.dataVersion, settings.groups, settings.noteGroups, settings.subGroups, settings.focus, settings.search, settings.showOrphans, settings.showUnresolved, settings.period, settings.states],
  );
  const counts = useMemo(() => {
    const c: Partial<Record<GraphNodeType, number>> = {};
    for (const n of ready?.graph.nodes ?? []) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [ready?.dataVersion]);
  /** Je Farbgruppe: was die Ansicht zeigt (von Hand ausgeblendete Gruppen bleiben zum Einblenden stehen). */
  const colorCounts = useMemo(() => {
    const c: Partial<Record<ColorKey, number>> = {};
    for (const n of ready?.graph.nodes ?? []) {
      const k = colorKeyOf(n);
      if (view?.hidden.has(n.id) && !isGroupHidden(settings, k)) continue;
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [ready?.dataVersion, view, settings.groups, settings.noteGroups, settings.subGroups]);
  const allColorCounts = useMemo(() => {
    const c: Partial<Record<ColorKey, number>> = {};
    for (const n of ready?.graph.nodes ?? []) {
      const k = colorKeyOf(n);
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [ready?.dataVersion]);
  const baustellen = useMemo(() => (ready?.graph.nodes ?? []).filter((n) => n.type === "baustelle").sort((a, b) => b.degree - a.degree), [ready?.structureVersion]);
  const selected = ready && selectedId ? (ready.graph.nodes.find((n) => n.id === selectedId) ?? null) : null;
  const focused = ready && settings.focus ? ready.graph.nodes.find((n) => n.id === settings.focus?.id) : undefined;

  const toggleGroup = (key: ColorKey | FamilyKey) => setSettings(toggleGroupIn(settings, key));

  // `?focus=<id>` (z. B. aus dem lokalen Graphen): nach dem Laden auswählen und hinzoomen. Der
  // Timer hängt an einer Ref (nicht am Effekt-Aufräumen), sonst bricht das Entfernen des
  // Parameters ihn ab.
  const [params, setParams] = useSearchParams();
  const focusParam = params.get("focus");
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(focusTimer.current), []);
  useEffect(() => {
    if (!ready || !focusParam) return;
    if (!ready.graph.nodes.some((n) => n.id === focusParam)) return;
    setSelectedId(focusParam);
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => activeGraph()?.focusNode(focusParam, 2.6), 900);
    setParams(
      (p) => {
        p.delete("focus");
        return p;
      },
      { replace: true },
    );
  }, [ready?.structureVersion, focusParam]);

  // `?brain=<id>` (Knopf „Eigenes Gehirn" in Session/Großansicht): Gehirn gefiltert auf diesen
  // Knoten + Nachbarn bis Tiefe 2. Gilt nur für diesen Besuch.
  const brainParam = params.get("brain");
  useEffect(() => {
    if (!ready || !brainParam) return;
    const node = ready.graph.nodes.find((n) => n.id === brainParam || n.id === `session:${brainParam}`);
    if (node) {
      setSettingsRaw(sessionBrain(settings, node.id, node.label));
      setSelectedId(node.id);
    }
    setParams(
      (p) => {
        p.delete("brain");
        return p;
      },
      { replace: true },
    );
  }, [ready?.structureVersion, brainParam]);

  // Andere Ansicht (Vorgabe, Baustelle, Session-Gehirn, Tiefe): auf das Sichtbare einpassen.
  const viewKey = `${settings.activeView}|${settings.focus?.id ?? ""}|${settings.focus?.depth ?? ""}`;
  const lastViewKey = useRef(viewKey);
  useEffect(() => {
    if (lastViewKey.current === viewKey) return;
    lastViewKey.current = viewKey;
    if (settings.activeView === "custom") return; // eigene Filter-Änderung: Bild nicht wegziehen
    const timer = setTimeout(() => {
      activeGraph()?.zoomToFit(600);
      // 3D ist eingehängt, aber gerade nicht dran: gleich mit einpassen, sonst zeigt es beim
      // Umschalten noch den alten Ausschnitt (2D nicht, das hat versteckt keine Größe).
      if (!is3d) graph3dRef.current?.zoomToFit(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [viewKey]);

  // Legende sitzt unten links auf derselben Ebene wie die 3D-Bedienleiste (in 3D in deren
  // Leiste, in 2D allein an derselben Stelle), eingeklappt als kleine Kachel.
  const legend =
    ready && view ? (
      <div data-brain-overlay="" className="pointer-events-auto w-fit">
        <Legend settings={settings} counts={colorCounts} onToggle={toggleGroup} />
      </div>
    ) : null;

  const stats = statsLine(counts);

  const select = (id: string) => {
    setSelectedId(id);
    activeGraph()?.focusNode(id);
  };

  return (
    <div ref={rootRef} className="relative h-full min-h-[480px] overflow-hidden bg-a-bg" data-testid="brain-view" data-mode={settings.mode} data-visible-count={view?.visibleCount ?? 0} data-dimmed-count={view?.dimmed.size ?? 0} data-hidden-count={view?.hidden.size ?? 0}>
      {/* weicher Lichtschein hinter der Wolke (Tiefe) */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_45%,rgba(167,123,255,0.05),transparent_60%)]" />

      {load.status === "loading" ? (
        <div className="absolute inset-0 grid place-items-center">
          <div className="grid justify-items-center gap-3 text-a-mut">
            <span className="h-10 w-10 animate-pulse rounded-full border border-a-line bg-a-p2" />
            <span className="text-callout">{t("Gehirn wird geladen …")}</span>
          </div>
        </div>
      ) : null}
      {load.status === "error" ? (
        <div className="absolute inset-0 grid place-items-center">
          <div className="grid justify-items-center gap-2 text-callout">
            <p className="text-a-bad">{t("Gehirn konnte nicht geladen werden ({message}).", { message: load.message })}</p>
            <Button onClick={load.reload}>{t("Erneut versuchen")}</Button>
          </div>
        </div>
      ) : null}
      {ready && view && ready.graph.nodes.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center text-callout text-a-mut">{t("Noch nichts im Gehirn — sobald Sessions oder Notizen ankommen, erscheinen sie hier.")}</div>
      ) : null}

      {ready && view && ready.graph.nodes.length > 0 ? (
        <>
          {/* 2D bleibt eingehängt (nur versteckt), damit der Wechsel zurück sofort da ist. */}
          <div className={is3d ? "hidden" : "contents"}>
            <GraphCanvas
              ref={canvasRef}
              graph={ready.graph}
              structureVersion={ready.structureVersion}
              view={view}
              settings={settings}
              selectedId={selectedId}
              persistKey={BRAIN_POSITIONS_KEY}
              zoomOnClick
              exposePerf="__brainPerf"
              fitArea={fitArea}
              onSelect={(n) => setSelectedId(n?.id ?? null)}
              onOpen={openNode}
            />
          </div>
          {has3d ? (
            <Suspense fallback={is3d ? <div className="absolute inset-0 grid place-items-center text-callout text-a-mut">{t("3D wird geladen …")}</div> : null}>
              <Graph3D
                ref={graph3dRef}
                graph={ready.graph}
                structureVersion={ready.structureVersion}
                view={view}
                settings={settings}
                selectedId={selectedId}
                active={is3d}
                onSelect={(n: SimNode | null) => setSelectedId(n?.id ?? null)}
                onOpen={openNode}
                onControlChange={(control3d) => setSettingsRaw({ ...settings, control3d })}
                fitArea={fitArea}
                bottomLeft={is3d ? legend : null}
              />
            </Suspense>
          ) : null}
        </>
      ) : null}

      {/* Oben links: Kopf, Ansichten, Seitenblatt; unten (eigene Leiste) die Legende. Die Spalte endet über
          der Leiste, damit sich nichts überlappt (das Seitenblatt wird kürzer und scrollt). */}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 top-4 flex items-start justify-between gap-4">
        <div className={`flex h-full min-h-0 min-w-0 flex-col gap-2 ${is3d ? "pb-28 sm:pb-16" : "pb-12"}`}>
          {/* Schlank — eine Zeile nur mit den Kennzahlen, ohne zweites „Gehirn“ (der Reiter
              heißt schon so). Zu lang → waagrecht scrollbar, nie zweizeilig. Die Ansichten direkt darunter. */}
          <h1 className="sr-only">{t("Gehirn")}</h1>
          {ready ? (
            <p
              data-brain-overlay=""
              data-testid="brain-stats"
              title={stats.full}
              className="cc-scroll pointer-events-auto w-fit max-w-full overflow-x-auto whitespace-nowrap rounded-full border border-a-line bg-a-p/80 px-3 py-1 font-mono text-label leading-5 tabular-nums text-a-mut shadow-lg backdrop-blur"
            >
              {/* Bei schmalem Bildschirm die kurze Fassung (die lange wurde abgeschnitten). */}
              <span className="sm:hidden">{stats.short}</span>
              <span className="hidden sm:inline">{stats.full}</span>
            </p>
          ) : null}
          {ready ? (
            <div data-brain-overlay="" className="pointer-events-auto w-fit max-w-full">
              <ViewBar settings={settings} onChange={setSettingsRaw} baustellen={baustellen} focusLabel={focused?.label ?? null} />
            </div>
          ) : null}
          {selected && ready ? (
            <NodeSheet node={selected} graph={ready.graph} colors={settings.colors} onSelect={select} onClose={() => setSelectedId(null)} />
          ) : null}
        </div>
        <div data-brain-overlay="" className="pointer-events-auto">
          <ControlPanel
            settings={settings}
            onChange={setSettings}
            counts={counts}
            colorCounts={allColorCounts}
            visibleCount={view?.visibleCount ?? 0}
            totalCount={ready?.graph.nodes.length ?? 0}
            onFit={() => activeGraph()?.zoomToFit()}
          />
        </div>
      </div>
      {!is3d && legend ? <div className="pointer-events-none absolute bottom-4 left-4 flex items-end">{legend}</div> : null}
    </div>
  );
}
