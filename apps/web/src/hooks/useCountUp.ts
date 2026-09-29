import { useEffect, useRef, useState } from "react";

const DURATION_MS = 600;

/**
 * Zählt eine Zahl beim ERSTEN Erscheinen kurz hoch, danach
 * springt ein neuer Wert direkt (kein Hochzählen bei jedem Live-Update — nur beim ersten Mount).
 * Aus bei `prefers-reduced-motion: reduce`.
 */
export function useCountUp(value: number | null): number | null {
  const [display, setDisplay] = useState<number | null>(value);
  const animated = useRef(false);

  useEffect(() => {
    if (value === null) return;
    if (animated.current) {
      setDisplay(value);
      return;
    }
    animated.current = true;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - (1 - t) * (1 - t);
      setDisplay(Math.round(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return display;
}
