// Lokaler Graph (Tiefe 1–3) als Baustein: Session-Vollbild (Reiter „Bezüge", auch für archivierte
// Sessions), Aufgaben-/Ideen-Großansicht. Klick auf einen Punkt zeigt rechts eine Info-Karte,
// Doppelklick öffnet seine Großansicht.
import { t } from "@nyxos/shared";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/button";
import { computeView } from "./filter";
import { GraphCanvas } from "./GraphCanvas";
import type { SimNode } from "./graphData";
import { NodeCard } from "./NodeCard";
import { defaultSettings, loadSettings } from "./settings";
import { useOpenNode } from "./BrainView";
import { useLocalGraph } from "./useGraph";

interface Props {
  /** Knoten-ID (`session:claude:<uuid>`, `note:<pfad>` …) oder nackte Session-ID. */
  nodeId: string;
  initialDepth?: 1 | 2 | 3;
  heightClass?: string;
  title?: string;
}

export function LocalGraph({ nodeId, initialDepth = 1, heightClass = "h-[320px]", title = t("Lokaler Graph") }: Props) {
  const [depth, setDepth] = useState<1 | 2 | 3>(initialDepth);
  const load = useLocalGraph(nodeId, depth);
  const openNode = useOpenNode();
  // Gewählter Punkt gehört zu genau einem Mittelpunkt (Session): Wechselt die Session, schließt die
  // Karte, statt Daten der alten Session stehen zu lassen. Der Punkt wird bei jedem Laden
  // frisch aus dem Graphen geholt (aktuelle Werte; fällt er weg, schließt die Karte).
  const [picked, setPicked] = useState<{ owner: string; id: string } | null>(null);
  const closeCard = useCallback(() => setPicked(null), []);
  // Eigene Farben aus dem großen Gehirn übernehmen (gleiche Farbe = gleiche Gruppe überall).
  const settings = useMemo(() => {
    const own = loadSettings();
    return { ...defaultSettings(), colorByType: true, colors: own.colors, glow: own.glow, labelZoom: 0.6, nodeSize: 1.15, forces: { center: 0.6, repel: 12, link: 1, distance: 220, drift: 0 } };
  }, []);
  const ready = load.status === "ready" ? load : null;
  const selected: SimNode | null = picked && picked.owner === nodeId && ready ? (ready.graph.nodes.find((n) => n.id === picked.id) ?? null) : null;
  const view = useMemo(
    () => (ready ? computeView(ready.graph.nodes, ready.graph.links, settings) : null),
    [ready?.dataVersion, settings],
  );

  return (
    <section aria-label={title} className="grid gap-2" data-testid="local-graph" data-node-count={ready?.graph.nodes.length ?? 0} data-depth={depth}>
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="font-mono text-label font-semibold uppercase tracking-wide text-a-mut">{title}</h5>
        <div role="radiogroup" aria-label={t("Tiefe")} className="flex rounded-md border border-a-line bg-a-p2 p-0.5">
          {([1, 2, 3] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={depth === d}
              onClick={() => setDepth(d)}
              className={cn("rounded px-2 py-0.5 text-label transition-colors duration-150", depth === d ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
            >
              {t("Tiefe {d}", { d })}
            </button>
          ))}
        </div>
        {ready ? <span className="font-mono text-label tabular-nums text-a-mut">{t("{n} Punkte", { n: ready.graph.nodes.length })}</span> : null}
        {ready?.center ? (
          <span className="ml-auto flex items-center gap-3">
            <Link to={`/gehirn?brain=${encodeURIComponent(ready.center)}`} className="text-caption text-a-acc hover:underline" title={t("Das große Gehirn, gefiltert auf diesen Punkt und alles bis zwei Schritte daneben")}>
              {t("Eigenes Gehirn")} →
            </Link>
            <Link to={`/gehirn?focus=${encodeURIComponent(ready.center)}`} className="text-caption text-a-acc hover:underline">
              {t("Im Gehirn zeigen")} →
            </Link>
          </span>
        ) : null}
      </div>
      <div className={cn("relative overflow-hidden rounded-lg border border-a-line bg-a-bg", heightClass)}>
        {load.status === "loading" ? <div className="absolute inset-0 animate-pulse bg-a-p2/40" /> : null}
        {load.status === "error" ? (
          <div className="absolute inset-0 grid place-items-center text-caption text-a-mut">
            {load.message === t("Nicht gefunden") ? t("Noch nicht im Gehirn (kommt mit dem nächsten Abgleich).") : <Button onClick={load.reload}>{t("Erneut versuchen")}</Button>}
          </div>
        ) : null}
        {ready && view ? (
          <GraphCanvas
            graph={ready.graph}
            structureVersion={ready.structureVersion}
            view={view}
            settings={settings}
            selectedId={selected?.id ?? null}
            centerId={ready.center}
            compact
            exposePerf="__localGraphPerf"
            onSelect={(n) => setPicked(n ? { owner: nodeId, id: n.id } : null)}
            onOpen={openNode}
          />
        ) : null}
        {selected ? <NodeCard node={selected} colors={settings.colors} onClose={closeCard} /> : null}
      </div>
    </section>
  );
}
