import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/**
 * Seitenbezogene Bedienelemente in der EINEN Kopfleiste (`TopBar`). Eine Seite rendert
 * ihre Knöpfe in `<TopBarActions>`; sie erscheinen rechts in der Kopfleiste, zwischen Brotkrümel
 * und „Vollbild“. Seiten ohne `TopBarActions` behalten ihre Kopfleiste unverändert.
 *
 * Bewusst ein kleiner Modul-Speicher statt eines Context-Providers: `TopBar` und die Seiten liegen
 * als Geschwister in `App` — so braucht es keinen zusätzlichen Provider um den ganzen Baum.
 */

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  for (const fn of listeners) fn();
}

/** Der Platzhalter in der Kopfleiste. */
export function TopBarSlotTarget({ className }: { className?: string }) {
  const ref = useCallback((el: HTMLDivElement | null) => setSlot(el), []);
  return <div ref={ref} data-testid="topbar-actions" className={className} />;
}

/** Inhalt, der in die Kopfleiste gehört. Ohne Kopfleiste (z. B. Einzeltests) rendert er nichts. */
export function TopBarActions({ children }: { children: ReactNode }) {
  const target = useSyncExternalStore(subscribe, () => slot, () => null);
  return target ? createPortal(children, target) : null;
}
