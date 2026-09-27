// 3D-Ansicht (Umschalter „3D"): eigener three.js-Aufbau (`scene3d.ts`), Physik im Worker. Wird
// erst beim ersten Umschalten geladen (eigenes Bundle, im Leerlauf vorgeladen) und bleibt danach
// eingehängt — Wechsel 2D↔3D ohne Neuaufbau und ohne Hänger.
import { t } from "@nyxos/shared";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { GraphView } from "./filter";
import type { Rect } from "./fitArea";
import type { GraphCanvasHandle } from "./GraphCanvas";
import type { LiveGraph, SimNode } from "./graphData";
import { Graph3DHelp } from "./Graph3DHelp";
import { createScene3D, type Control3D, type Scene3D } from "./scene3d";
import type { BrainSettings } from "./settings";

interface Props {
  graph: LiveGraph;
  structureVersion: number;
  view: GraphView;
  settings: BrainSettings;
  selectedId: string | null;
  /** false = 2D ist gerade dran: nicht zeichnen, Tasten ignorieren. */
  active: boolean;
  onSelect(node: SimNode | null): void;
  onOpen(node: SimNode): void;
  onControlChange(mode: Control3D): void;
  /** Freie Fläche neben den Kacheln fürs Einpassen. */
  fitArea?: () => Rect | null;
  /** Legende links in derselben Leiste wie die 3D-Bedienung. */
  bottomLeft?: ReactNode;
}

const Graph3D = forwardRef<GraphCanvasHandle, Props>(function Graph3D(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const labelsRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);

  useImperativeHandle(ref, () => ({
    focusNode: (id) => sceneRef.current?.focusNode(id),
    zoomToFit: (ms = 600) => sceneRef.current?.fit(ms),
  }));

  useEffect(() => {
    const host = hostRef.current;
    const labels = labelsRef.current;
    if (!host || !labels) return;
    const scene = createScene3D(
      host,
      labels,
      {
        onSelect: (n) => propsRef.current.onSelect(n),
        onOpen: (n) => propsRef.current.onOpen(n),
        onControlChange: (m) => propsRef.current.onControlChange(m),
        onReady: () => setReady(true),
      },
      { exposePerf: true, fitArea: () => propsRef.current.fitArea?.() ?? null },
    );
    sceneRef.current = scene;
    const p = propsRef.current;
    scene.setControl(p.settings.control3d);
    scene.setLook(p.view, p.settings, p.selectedId);
    // Kräfte vor den Daten: der Worker startet gleich mit den Reglerwerten.
    scene.setForces(p.settings.forces);
    scene.setData(p.graph.nodes, p.graph.links);
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const firstData = useRef(true);
  useEffect(() => {
    if (firstData.current) {
      firstData.current = false;
      return;
    }
    sceneRef.current?.setData(propsRef.current.graph.nodes, propsRef.current.graph.links);
  }, [props.structureVersion]);

  useEffect(() => {
    sceneRef.current?.setLook(props.view, props.settings, props.selectedId);
  }, [props.view, props.settings.colorByType, props.settings.colors, props.settings.glow, props.settings.nodeSize, props.selectedId]);

  useEffect(() => {
    sceneRef.current?.setControl(props.settings.control3d);
  }, [props.settings.control3d]);

  // Regler „Kräfte“ → Worker.
  const firstForces = useRef(true);
  useEffect(() => {
    if (firstForces.current) {
      firstForces.current = false;
      return;
    }
    sceneRef.current?.setForces(props.settings.forces);
  }, [props.settings.forces]);

  useEffect(() => {
    sceneRef.current?.setActive(props.active);
    if (props.active) hostRef.current?.focus({ preventScroll: true });
  }, [props.active]);

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      aria-label={t("Gehirn in 3D — mit Maus und Tastatur bewegen")}
      className={cn("absolute inset-0 outline-none", !props.active && "hidden")}
      data-testid="graph-3d"
      data-ready={ready ? "1" : "0"}
    >
      <canvas ref={labelsRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      {!ready ? <div className="pointer-events-none absolute inset-0 grid place-items-center text-callout text-a-mut">{t("3D wird aufgebaut …")}</div> : null}
      {/* Untere Leiste: links die Legende, daneben Steuerung + Tastenhilfe (kurz, einklappbar) — eine Ebene. */}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 flex flex-col items-start gap-2 sm:flex-row sm:items-end sm:gap-3" data-testid="brain-3d-help">
        {props.bottomLeft ? <div className="shrink-0">{props.bottomLeft}</div> : null}
        <div className="flex w-full min-w-0 flex-1 justify-start sm:justify-center">
          <Graph3DHelp control={props.settings.control3d} onControlChange={(m) => propsRef.current.onControlChange(m)} onFit={() => sceneRef.current?.fit(700)} />
        </div>
      </div>
    </div>
  );
});

export default Graph3D;
