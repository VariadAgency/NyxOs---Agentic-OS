/// <reference lib="webworker" />
// Web-Worker für die Kräfte-Simulation (Logik in simHost.ts). Rechnet ~60 Schritte/s und schickt die
// Positionen als übertragbare Float32Arrays zurück; der Hauptthread zeichnet nur noch.
import { createSimHost } from "./simHost";
import type { ToWorker } from "./simulation";

declare const self: DedicatedWorkerGlobalScope;

const handle = createSimHost((msg, transfer) => self.postMessage(msg, transfer));
self.onmessage = (e: MessageEvent<ToWorker>) => handle(e.data);
