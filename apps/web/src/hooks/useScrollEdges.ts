import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Meldet, ob ein waagerecht scrollender Bereich links bzw. rechts noch weitergeht. Die
 * Tab-Zeilen blenden damit nur an einem Rand aus, hinter dem wirklich etwas liegt (`.cc-edge-fade`).
 * Gibt einen Callback-Ref zurück, damit Größenänderungen (ResizeObserver) und Scrollen beide zählen.
 */
export function useScrollEdges<T extends HTMLElement>() {
  const [edges, setEdges] = useState({ left: false, right: false });
  const cleanup = useRef<(() => void) | null>(null);

  const ref = useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    // Inhalt (neue Tabs) ändert die Breite, ohne dass sich das Element selbst ändert.
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    cleanup.current = () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  return { ref, "data-fade-left": edges.left, "data-fade-right": edges.right } as const;
}
