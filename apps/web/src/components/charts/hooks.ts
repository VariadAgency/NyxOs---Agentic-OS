// Gemeinsame Hooks der Diagramm-Bausteine: Breite messen, reduzierte Bewegung, einmaliges
// Einzeichnen.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { easeOut } from "./scale";

const REDUCED = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED).matches;
}

/** Folgt `prefers-reduced-motion` live (Systemeinstellung kann sich während der Sitzung ändern). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/**
 * Breite eines Containers (ResizeObserver). `fallback` greift, solange nichts gemessen ist (jsdom,
 * erster Render) — die Höhe steht fest, damit beim Messen nichts springt.
 */
export function useChartWidth<T extends HTMLElement>(fallback = 640): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) >= 1 ? Math.floor(w) : prev));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Fortschritt 0 → 1 fürs einmalige Einzeichnen (≤ 500 ms, ease-out). Läuft genau einmal pro
 * Einbau, sobald `ready` (echte Daten da) — ein Nachladen/Filterwechsel zeichnet NICHT neu ein.
 * Bei `prefers-reduced-motion` sofort 1.
 */
export function useReveal(ready: boolean, durationMs = 500): number {
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState(() => (reduced ? 1 : 0));
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    if (reduced) {
      setProgress(1);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.max(0, Math.min(1, (now - start) / durationMs));
      setProgress(easeOut(t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      // StrictMode baut Effekte im Dev-Modus zweimal auf — beim zweiten Aufbau neu starten dürfen.
      cancelAnimationFrame(raf);
      started.current = false;
    };
  }, [ready, reduced, durationMs]);
  return reduced ? 1 : progress;
}
