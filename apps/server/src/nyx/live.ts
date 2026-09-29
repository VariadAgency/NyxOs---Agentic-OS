// (einzige Quelle für beide Ereignisse, auch der Kern N1 sendet nur hierüber): Nyx meldet live, was er tut — `nyx.state` (Zustand fürs Netz) und `nyx.task` (Aufgaben-Karten im
// Reiter „Aufgaben live“, Telegram-Fortschritt). Der Nyx-Kern ruft nur diese zwei Funktionen auf; jede
// Meldung wird geprüft, bevor sie über `/live` an alle offenen Tabs geht. Der jüngste Zustand und die letzten
// Aufgaben bleiben im Speicher, damit ein frisch geöffneter Tab (`GET /api/nyx/live`) sofort den Stand sieht.
import {
  NyxStateEventSchema,
  NyxTaskEventSchema,
  type NyxLiveSnapshot,
  type NyxStateEvent,
  type NyxTaskEvent,
  type NyxTaskEventOut,
} from "@nyxos/shared";
import type { LiveHub } from "../live.js";

/** So viele Aufgaben-Ereignisse hält der Server für neu geöffnete Tabs vor. */
export const NYX_TASK_MEMORY = 50;

interface NyxLiveMemory {
  state: NyxStateEvent & { at: string };
  tasks: NyxTaskEventOut[];
  /** Zuhörer im Server-Prozess (Telegram schickt Bilder aus seinem Faden als Foto). */
  taskListeners: Set<(ev: NyxTaskEventOut) => void>;
}

// Je Hub ein Gedächtnis: Tests bauen je App einen eigenen Hub, der echte Server genau einen.
const memory = new WeakMap<LiveHub, NyxLiveMemory>();

function memoryOf(hub: LiveHub): NyxLiveMemory {
  let m = memory.get(hub);
  if (!m) {
    m = { state: { state: "idle", at: new Date(0).toISOString() }, tasks: [], taskListeners: new Set() };
    memory.set(hub, m);
  }
  return m;
}

/** Zustand melden (idle/listening/thinking/speaking/tool). `false` = ungültig, nichts verteilt. */
export function publishNyxState(hub: LiveHub, event: NyxStateEvent): boolean {
  const parsed = NyxStateEventSchema.safeParse(event);
  if (!parsed.success) return false;
  const at = new Date().toISOString();
  memoryOf(hub).state = { ...parsed.data, at };
  hub.broadcast({ type: "nyx.state", ...parsed.data, at });
  return true;
}

/** Aufgabe begonnen / Schritt / fertig melden. `false` = ungültig, nichts verteilt. */
export function publishNyxTask(hub: LiveHub, event: NyxTaskEvent): boolean {
  const parsed = NyxTaskEventSchema.safeParse(event);
  if (!parsed.success) return false;
  const out: NyxTaskEventOut = { ...parsed.data, at: parsed.data.at ?? new Date().toISOString() };
  const m = memoryOf(hub);
  m.tasks.push(out);
  if (m.tasks.length > NYX_TASK_MEMORY) m.tasks.splice(0, m.tasks.length - NYX_TASK_MEMORY);
  hub.broadcast({ type: "nyx.task", ...out });
  for (const fn of m.taskListeners) {
    try {
      fn(out);
    } catch {
      // Ein Zuhörer darf das Verteilen nie stören.
    }
  }
  return true;
}

/** Aufgaben-Ereignisse im Server-Prozess mithören; gibt die Abmelde-Funktion zurück. */
export function onNyxTask(hub: LiveHub, fn: (ev: NyxTaskEventOut) => void): () => void {
  const m = memoryOf(hub);
  m.taskListeners.add(fn);
  return () => void m.taskListeners.delete(fn);
}

export function nyxLiveSnapshot(hub: LiveHub): NyxLiveSnapshot {
  const m = memoryOf(hub);
  return { state: m.state, tasks: [...m.tasks] };
}
