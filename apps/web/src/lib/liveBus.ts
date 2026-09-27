// Winziger Event-Bus für /live-Nachrichten, zusätzlich zur TanStack-Query-Invalidierung
// (useLiveSocket). Der Chat (useTranscript) kann keinen Query-Key sauber invalidieren — er hält
// seinen Verlauf selbst (Cursor-Seiten) — deshalb hier ein einfacher Zähler zum Abonnieren.
//
// `emitLiveTick()` zählte JEDES `/live`-Signal, egal welche Session es
// betraf — der offene Chat einer ANDEREN Session bekam trotzdem einen Tick und lud (ohne Cursor)
// die jüngste Seite der SELBEN Session nach, was nach einem Such-Sprung (`?at=`, Fenster mitten im
// Verlauf) eine Lücke ohne Hinweis riss. `sessionIds` trägt jetzt mit, welche Session(en) das
// Signal betrifft — `null` heißt "unbekannt" (z. B. beim Verbindungsaufbau) und wird wie "alle"
// behandelt (bisheriges Verhalten), ein gefülltes Set grenzt gezielt ein.
type Listener = (sessionIds: ReadonlySet<string> | null) => void;
const listeners = new Set<Listener>();

export function emitLiveTick(sessionIds: ReadonlySet<string> | null = null): void {
  for (const l of listeners) l(sessionIds);
}

export function subscribeLiveTick(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ───────────── Nyx-Nachrichten (`nyx.ui`, `nyx.state`, `nyx.task`, `nyx.file`) ─────────────
// Eine `/live`-Verbindung für alles, keine zweite WebSocket je Tab; Abonnenten filtern selbst nach `type`.
// Der Begleiter hört hier mit, statt einen eigenen WebSocket zu öffnen. Antworten an den Server
// (`nyx.ui.result`/`nyx.ui.screen`) gehen bewusst NICHT über `/live`, sondern über `POST /api/nyx/ui/reply`.
export interface NyxLiveMessage {
  type: string;
  [key: string]: unknown;
}
type NyxListener = (msg: NyxLiveMessage) => void;
const nyxListeners = new Set<NyxListener>();

export function emitNyxLive(msg: NyxLiveMessage): void {
  for (const l of nyxListeners) l(msg);
}

export function subscribeNyxLive(listener: NyxListener): () => void {
  nyxListeners.add(listener);
  return () => nyxListeners.delete(listener);
}
