// Einklapp-Stufe nach GEMESSENEM Platz statt nach festen Breakpoints.
//
// Stufe 0 = alles ausgeschrieben. Läuft der Behälter über (scrollWidth > clientWidth), geht es eine Stufe
// weiter — synchron vor dem Zeichnen (Layout-Effekt), bis es passt oder die letzte Stufe erreicht ist.
// Ändert sich die Breite des Behälters, wird von Stufe 0 neu gemessen (flushSync im ResizeObserver, damit
// kein überlaufendes Bild gezeichnet wird). Wachsender Inhalt (z. B. der Kontext-Ring kommt nach dem Laden
// dazu) wird über `contentRef` bemerkt und klappt eine Stufe weiter.
// Die Reihenfolge der Stufen bestimmt der Aufrufer; Elemente, die sich kürzen können (Titel, Pfad), tun das
// vorher von selbst über `min-w-0`/`truncate` — erst wenn auch sie am Minimum sind, läuft der Behälter über.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export function useFitLevel(maxLevel: number, resetKey: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [level, setLevel] = useState(0);

  const overflows = useCallback(() => {
    const el = ref.current;
    return !!el && el.scrollWidth > el.clientWidth + 1;
  }, []);

  // Anderer Inhalt (anderer Titel, Session läuft/ruht …): neu von vorn messen.
  useLayoutEffect(() => {
    setLevel(0);
  }, [resetKey]);

  // Nach jedem Rendern: passt es nicht, eine Stufe weiter (läuft synchron bis es passt).
  useLayoutEffect(() => {
    if (level < maxLevel && overflows()) setLevel(level + 1);
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    let frame = 0;
    const onHead = () => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // Breite geändert: von vorn, die Layout-Effekte klappen synchron bis zur passenden Stufe.
      flushSync(() => setLevel(0));
    };
    const onContent = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (overflows()) setLevel((l) => Math.min(maxLevel, l + 1));
      });
    };
    const headRo = new ResizeObserver(onHead);
    headRo.observe(el);
    const contentRo = new ResizeObserver(onContent);
    if (contentRef.current) contentRo.observe(contentRef.current);
    return () => {
      headRo.disconnect();
      contentRo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [maxLevel, overflows]);

  return { ref, contentRef, level };
}
