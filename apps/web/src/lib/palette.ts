// Die Befehlspalette (⌘K) braucht auf dem Handy einen Knopf – dort gibt es keine Tastenkürzel.
// Kopfzeile und Palette sind Geschwister in `App`; wie `navDrawer` ein kleines Ereignis statt eines Providers.
export const OPEN_PALETTE_EVENT = "nyxos:open-palette";

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}
