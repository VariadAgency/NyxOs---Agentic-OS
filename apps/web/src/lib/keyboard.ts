// Gemeinsame Prüfungen für globale Tastenkürzel (z. B. Taste F = Vollbild in `App.tsx`).

/** Tippt der Nutzer gerade (Feld, editierbarer Text, Terminal)? Dann ist ein Buchstabe ein Buchstabe, kein Kürzel. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return true;
  return el.closest('.xterm, [contenteditable=""], [contenteditable="true"], [role="textbox"]') !== null;
}

const MODAL_SELECTOR = '[aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"]';

/**
 * Liegt gerade ein SICHTBARER Dialog über allem? Versteckte Dialoge zählen nicht: Das Nyx-Zentrum bleibt nach dem
 * ersten Öffnen mit `hidden` und `aria-modal="true"` im DOM – eine reine Selektor-Prüfung hielte es für immer offen.
 */
export function isModalOpen(root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll<HTMLElement>(MODAL_SELECTOR)) {
    if (el.closest("[hidden]") === null && el.closest('[aria-hidden="true"]') === null) return true;
  }
  return false;
}
