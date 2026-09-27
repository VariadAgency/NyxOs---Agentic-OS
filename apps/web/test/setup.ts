import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// findBy…/waitFor warten auf eine Bedingung; die Vorgabe (1 s) riss unter Volllast bei Tests, die die
// ganze App rendern. 5 s kosten grüne Läufe nichts (sie enden, sobald die Bedingung stimmt).
configure({ asyncUtilTimeout: 5_000 });

// Ohne test.globals räumt @testing-library/react nicht automatisch auf.
afterEach(() => {
  cleanup();
});

// jsdom kennt ResizeObserver nicht; cmdk misst damit die Listenhöhe.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom layoutet nicht: Elemente sind immer 0×0. @tanstack/react-virtual (ChatPanel) rendert ohne
// Höhe keine Zeilen — ein fester Wert reicht für Tests (keine echte Pixel-Genauigkeit nötig).
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });

// jsdom hat kein WebSocket. useLiveSocket braucht nur onopen/onmessage/onclose und close().
class WebSocketStub {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close(): void {}
}

if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = WebSocketStub as unknown as typeof WebSocket;
}

// jsdom implementiert scrollIntoView nicht; cmdk ruft es beim Auswählen eines Eintrags auf.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom kennt kein matchMedia; KpiTile/EntryOverlay fragen `prefers-reduced-motion` ab.
// Antwortet immer mit "nicht reduziert" — Tests, die reduzierte Bewegung brauchen, stubben gezielt selbst.
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
