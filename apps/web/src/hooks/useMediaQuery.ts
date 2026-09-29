import { useSyncExternalStore } from "react";

/** Handy/Touch erkennen – schmal (unter `md`) oder Finger statt Maus. */
export const TOUCH_QUERY = "(pointer: coarse)";
export const PHONE_QUERY = "(max-width: 767px)";

function mql(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

export function matchesQuery(query: string): boolean {
  return mql(query)?.matches ?? false;
}

/** Folgt einer Media-Query live (Drehen, Fenster schmaler ziehen). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = mql(query);
      if (!mq || typeof mq.addEventListener !== "function") return () => undefined;
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => matchesQuery(query),
    () => false,
  );
}

/** Touch-Gerät (iPhone, iPad, Android) – dort gibt es keine Tastenkürzel, kein Hover, kein Shift+Enter. */
export const useTouch = () => useMediaQuery(TOUCH_QUERY);
