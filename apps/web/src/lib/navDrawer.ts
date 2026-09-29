import { useSyncExternalStore } from "react";

/**
 * Auf schmalen Bildschirmen (< 768 px) ist die Seitenleiste ein Menü, das von links
 * hereingleitet. Offen/zu teilen sich der Menü-Knopf in der Kopfzeile und die Leiste selbst — beide
 * sind Geschwister in `App`, darum (wie `TopBarSlot`) ein kleiner Modul-Speicher statt eines Providers.
 * Ab 768 px steht die Leiste fest; der Zustand ist dort wirkungslos.
 */
let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const openNavDrawer = () => set(true);
export const closeNavDrawer = () => set(false);
export const toggleNavDrawer = () => set(!open);

export function useNavDrawerOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}
