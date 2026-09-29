/// <reference lib="webworker" />
// Web-Worker für die 3D-Kräfte-Simulation (Logik in sim3d.ts).
import { createSim3dHost, type ToSim3d } from "./sim3d";

declare const self: DedicatedWorkerGlobalScope;

const handle = createSim3dHost((msg, transfer) => self.postMessage(msg, transfer));
self.onmessage = (e: MessageEvent<ToSim3d>) => handle(e.data);
