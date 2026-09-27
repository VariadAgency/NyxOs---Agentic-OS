// React-Hülle ums 3D-Netz. Legt die three.js-Szene an, führt Beschriftungen (Werkzeug mit Namen,
// hervorgehobener Knoten, Hover) per Projektion direkt am DOM nach (kein React-State bei 60 fps) und fällt auf
// die bisherige 2D-Fassung (`NeuralNetFull`) zurück, wenn der Browser kein WebGL hat oder die GPU den
// Kontext verliert. `data-state`/`data-tool`/`data-renderer`/`data-fps` sind für Tests und die Abnahme.
import { nyxToolDoing, t, type NyxState } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { nodeText, type NetModel, type NetNode } from "../netModel";
import { NeuralNetFull } from "../NeuralNetFull";
import type { LevelDrive } from "../voice/level";
import { visualFor } from "./visual";

export interface NyxNet3DProps {
  model: NetModel;
  state: NyxState;
  drive: LevelDrive;
  tool: string | null;
  /** Knoten-ID aus dem Gehirn-Graph, der zusätzlich leuchten soll (`nyx.state.node`). */
  highlightNode?: string | null;
  /** Breite (CSS-px), die rechts von einer Leiste verdeckt ist — das Netz rückt in die freie Mitte. */
  rightInset?: number;
  onOpen?: (href: string) => void;
}

declare global {
  interface Window {
    /** Gemessene Bildrate des Nyx-Netzes (Abnahme, Playwright). */
    __nyxNetFps?: number[];
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function NyxNet3D(props: NyxNet3DProps) {
  const [mode, setMode] = useState<"webgl" | "2d">(() => (webglAvailable() ? "webgl" : "2d"));
  const label = `${visualFor(props.state).label}${props.tool ? ` (${nyxToolDoing(props.tool)})` : ""} – ${t("Netz aus {n} Knoten", { n: props.model.nodes.length })}`;
  if (mode === "2d") {
    return (
      <div className="absolute inset-0" data-renderer="2d" style={{ right: props.rightInset ?? 0 }}>
        <NeuralNetFull model={props.model} state={props.state} drive={props.drive} tool={props.tool} highlightNode={props.highlightNode} onOpen={props.onOpen} />
      </div>
    );
  }
  return <Net3D {...props} label={label} onLost={() => setMode("2d")} />;
}

function Net3D({ model, state, drive, tool, highlightNode, rightInset = 0, onOpen, label, onLost }: NyxNet3DProps & { label: string; onLost: () => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const toolLabelRef = useRef<HTMLDivElement | null>(null);
  const hlLabelRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<import("./scene").NyxNetScene | null>(null);
  const live = useRef({ state, tool, highlightNode: highlightNode ?? null });
  live.current = { state, tool, highlightNode: highlightNode ?? null };
  const hoverIdx = useRef(-1);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<NetNode | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const lostRef = useRef(onLost);
  lostRef.current = onLost;
  const insetRef = useRef(rightInset);
  insetRef.current = rightInset;
  // Die Szene lädt nach (eigenes Bündel) — bis dahin kann schon das echte Modell da sein: immer das neueste nehmen.
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;
    // Szene erst hier laden: three.js landet so im Bündel des Nyx-Tabs, nicht im Start-Bündel.
    void import("./scene").then(({ createNyxScene }) => {
      if (disposed) return;
      let scene: import("./scene").NyxNetScene;
      try {
        scene = createNyxScene(canvas, {
          drive,
          reducedMotion: prefersReducedMotion(),
          live: () => live.current,
          onFps: (fps) => {
            wrap.dataset.fps = String(fps);
            wrap.dataset.dpr = String(sceneRef.current?.pixelRatio() ?? "");
            (window.__nyxNetFps ??= []).push(fps);
            if (window.__nyxNetFps.length > 120) window.__nyxNetFps.shift();
          },
          onLost: () => lostRef.current(),
          afterFrame: (s) => placeLabels(s),
        });
      } catch {
        lostRef.current();
        return;
      }
      sceneRef.current = scene;
      scene.setModel(modelRef.current);
      scene.setRightInset(insetRef.current);
      const fit = () => {
        const r = wrap.getBoundingClientRect();
        scene.resize(r.width, r.height);
      };
      fit();
      ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
      ro?.observe(wrap);
      wrap.dataset.ready = "true";
    });

    const place = (el: HTMLDivElement | null, s: import("./scene").NyxNetScene, i: number, text: string | undefined) => {
      if (!el) return;
      const p = i >= 0 ? s.screenOf(i) : null;
      if (!p || !text) {
        el.style.opacity = "0";
        return;
      }
      el.style.opacity = "1";
      el.style.transform = `translate3d(${Math.round(p.x + 14)}px, ${Math.round(p.y - 34)}px, 0)`;
      const span = el.querySelector("[data-text]");
      if (span && span.textContent !== text) span.textContent = text;
    };
    const placeLabels = (s: import("./scene").NyxNetScene) => {
      const m = s.model();
      const ti = s.activeTool();
      place(toolLabelRef.current, s, ti, ti >= 0 ? nodeText(m?.nodes[ti]) : undefined);
      const hi = s.highlighted();
      place(hlLabelRef.current, s, hi !== ti ? hi : -1, hi >= 0 ? nodeText(m?.nodes[hi]) : undefined);
      place(hoverRef.current, s, hoverIdx.current, hoverIdx.current >= 0 ? nodeText(m?.nodes[hoverIdx.current]) : undefined);
    };

    return () => {
      disposed = true;
      ro?.disconnect();
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
    // Die Szene lebt so lange wie die Komponente; Modell/Leiste werden unten nachgereicht (bewusst ohne `model`).
  }, [drive]);

  useEffect(() => {
    sceneRef.current?.setModel(model);
  }, [model]);
  useEffect(() => {
    sceneRef.current?.setRightInset(rightInset);
  }, [rightInset]);

  const pickAt = (clientX: number, clientY: number): number => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const s = sceneRef.current;
    if (!rect || !s) return -1;
    return s.pick(clientX - rect.left, clientY - rect.top);
  };

  return (
    <div
      ref={wrapRef}
      data-nyx="nyx-netz"
      data-state={state}
      data-tool={tool ?? ""}
      data-renderer="webgl"
      role="img"
      aria-label={label}
      className="absolute inset-0 overflow-hidden"
      onPointerMove={(e) => {
        if (e.buttons) return;
        const i = pickAt(e.clientX, e.clientY);
        if (i === hoverIdx.current) return;
        hoverIdx.current = i;
        setHover(i >= 0 ? (model.nodes[i] ?? null) : null);
      }}
      onPointerDown={(e) => {
        downAt.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerLeave={() => {
        hoverIdx.current = -1;
        setHover(null);
      }}
      onClick={(e) => {
        // Nach dem Drehen (Ziehen) nichts öffnen.
        const d = downAt.current;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
        const i = pickAt(e.clientX, e.clientY);
        const href = i >= 0 ? model.nodes[i]?.href : undefined;
        if (href) openRef.current?.(href);
      }}
      style={{ cursor: hover?.href ? "pointer" : "grab" }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
      <div ref={toolLabelRef} className="nyx-net-label nyx-net-label--tool" style={{ opacity: 0 }} aria-hidden="true">
        <span className="nyx-net-label__dot" />
        <span data-text />
      </div>
      <div ref={hlLabelRef} className="nyx-net-label" style={{ opacity: 0 }} aria-hidden="true">
        <span className="nyx-net-label__dot" />
        <span data-text />
      </div>
      <div ref={hoverRef} className="nyx-net-label nyx-net-label--hover" style={{ opacity: 0 }} aria-hidden="true">
        <span className="nyx-net-label__dot" style={{ background: hover?.color }} />
        <span data-text />
        {hover?.href && <span className="nyx-net-label__hint">· {t("Klick öffnet")}</span>}
      </div>
    </div>
  );
}
