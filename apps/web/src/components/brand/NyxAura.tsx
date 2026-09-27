// Das NyxOS-Markenlogo – die lila Aura aus dem Nyx-Tab als kleines, lebendiges SVG (kein WebGL, viele
// Instanzen möglich). Kern pulsiert sanft, der Ring wabert und dreht sich langsam, das Glühen atmet (reines CSS).
// Spricht der Nutzer oder Nyx, liest das Logo den gemeinsamen Pegel (`features/nyx/voice/levelBus.ts`) als
// `--nyx-lvl`: Kern größer und heller, Ring wabert stärker und dreht schneller, Glühen weitet sich.
// „Bewegung reduzieren“: still, der Pegel ändert nur leicht die Helligkeit.
// Farbe je Zustand (blau/rot/orange/grün/lila); beim Werkzeug zieht Nyx Punkte aus der Wolke in den Kern.
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { cn } from "../../lib/cn";
import { NYX_TOOL_ROUND_MS } from "../../features/nyx/visualSequence";
import { attachNyxLevel } from "../../features/nyx/voice/levelBus";
import { CORE_R, RING_INNER, RING_OUTER, RING_WOBBLE, SATELLITES, wobblePath } from "./auraGeometry";
import "./nyxAura.css";

export type NyxAuraState = "idle" | "listening" | "thinking" | "speaking" | "tool";

export const NYX_AURA_MIN = 14;
export const NYX_AURA_MAX = 64;
/** Ab dieser Größe (px) sind die winzigen Satelliten zu sehen. */
const SATELLITE_MIN = 24;
/** Ab dieser Größe (px) zeigt das Werkzeug die Such-Punkte. */
const SEEK_MIN = 18;
/** Punkte der Such-Wolke (Winkel °, Abstand) – Nyx zieht sie beim Werkzeug nacheinander in den Kern. */
const SEEK_POINTS: readonly (readonly [deg: number, dist: number])[] = [
  [-60, 47],
  [0, 43],
  [60, 48],
  [120, 44],
  [180, 47],
  [240, 43],
];

const PATH_INNER = wobblePath(RING_INNER);
const PATH_WOBBLE = wobblePath(RING_WOBBLE);
const PATH_OUTER = wobblePath(RING_OUTER);

export interface NyxAuraProps {
  /** Kantenlänge in px (14–64). */
  size?: number;
  /** Was Nyx gerade tut – leicht andere Farbe und anderes Tempo. */
  state?: NyxAuraState;
  className?: string;
  /** Beschriftung für Screenreader; ohne = reine Zierde (aria-hidden). */
  label?: string;
}

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(cb: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mq = window.matchMedia(REDUCE_QUERY);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}

function readReduced(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCE_QUERY).matches;
}

/** „Bewegung reduzieren“ (live, ändert sich mit der Systemeinstellung). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, readReduced, () => false);
}

export function NyxAura({ size = 20, state = "idle", className, label }: NyxAuraProps) {
  const px = Math.max(NYX_AURA_MIN, Math.min(NYX_AURA_MAX, Math.round(size)));
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const halo = `nyx-mark-h-${uid}`;
  const core = `nyx-mark-k-${uid}`;

  useEffect(() => {
    const el = ref.current;
    return el ? attachNyxLevel(el) : undefined;
  }, []);

  // Striche in Bildschirm-Pixeln denken: bei 16 px muss der Ring noch ~1 px breit sein.
  const unit = 100 / px;
  const inner = Math.max(3.2, unit * 1.1);
  const outer = Math.max(1.6, unit * 0.7);

  return (
    <svg
      ref={ref}
      viewBox="-50 -50 100 100"
      width={px}
      height={px}
      className={cn("nyx-mark", className)}
      data-state={state}
      data-motion={reduced ? "still" : "live"}
      data-testid="nyx-aura"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <radialGradient id={halo} r="50%">
          <stop offset="0" className="nyx-mark__stop-deep" />
          <stop offset="0.55" className="nyx-mark__stop-deeper" />
          <stop offset="1" className="nyx-mark__stop-none" />
        </radialGradient>
        <radialGradient id={core} r="50%">
          <stop offset="0" className="nyx-mark__stop-white" />
          <stop offset="0.3" className="nyx-mark__stop-white" />
          <stop offset="0.55" className="nyx-mark__stop-lav" />
          <stop offset="0.8" className="nyx-mark__stop-tint" />
          <stop offset="1" className="nyx-mark__stop-tint-none" />
        </radialGradient>
      </defs>
      <g className="nyx-mark__lvl-halo">
        <circle className="nyx-mark__halo" r="50" fill={`url(#${halo})`} />
      </g>
      <g className="nyx-mark__lvl-ring">
        <g className="nyx-mark__outer">
          <path d={PATH_OUTER} className="nyx-mark__ring-glow" strokeWidth={outer * 3.2} />
          <path d={PATH_OUTER} className="nyx-mark__ring-pale" strokeWidth={outer} />
        </g>
        <g className="nyx-mark__inner">
          <path d={PATH_INNER} className="nyx-mark__ring-glow nyx-mark__ring-glow--in" strokeWidth={inner * 2.6} />
          <path d={PATH_INNER} className="nyx-mark__ring" strokeWidth={inner} />
        </g>
        <g className="nyx-mark__wobble">
          <path d={PATH_WOBBLE} className="nyx-mark__ring nyx-mark__ring--wob" strokeWidth={inner} />
        </g>
        {px >= SATELLITE_MIN && (
          <g className="nyx-mark__sats">
            {SATELLITES.map(([deg, dist, r]) => {
              const a = (deg * Math.PI) / 180;
              return <circle key={deg} cx={(dist * Math.cos(a)).toFixed(2)} cy={(dist * Math.sin(a)).toFixed(2)} r={Math.max(r, unit * 0.45)} className="nyx-mark__sat" />;
            })}
          </g>
        )}
      </g>
      {state === "tool" && px >= SEEK_MIN && (
        <g className="nyx-mark__seeks" data-testid="nyx-aura-seek" style={{ ["--nyx-seek-round" as string]: `${NYX_TOOL_ROUND_MS}ms`, ["--n" as string]: SEEK_POINTS.length }}>
          {SEEK_POINTS.map(([deg, dist], i) => {
            const a = (deg * Math.PI) / 180;
            return <circle key={deg} cx={(dist * Math.cos(a)).toFixed(2)} cy={(dist * Math.sin(a)).toFixed(2)} r={Math.max(2.2, unit * 0.6)} className="nyx-mark__seek" style={{ ["--i" as string]: i }} />;
          })}
        </g>
      )}
      <g className="nyx-mark__lvl-core">
        <g className="nyx-mark__core">
          <circle r={CORE_R + 4} fill={`url(#${core})`} />
          <circle r={Math.max(4.5, unit * 0.9)} className="nyx-mark__spark" />
        </g>
      </g>
    </svg>
  );
}
