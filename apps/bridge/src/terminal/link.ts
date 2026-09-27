// Eine ausgehende, dauerhafte Verbindung der Brücke zum Server (`WS /bridge`). Wiederverbindung mit
// wachsendem Abstand (1 s … 10 s). Bricht sie ab, lösen sich nur die Steuer-Clients — die tmux-Sessions
// (und damit Claude/Codex) laufen ungestört weiter.
//
// Wächter gegen halb offene Verbindungen: Über einen SSH-Tunnel kommt ein Schließen manchmal nie an, die
// Brücke hielte den Kanal dann beliebig lange für offen. Jeder Server-Ping (alle 15 s) und jede Nachricht
// zählt als Lebenszeichen; bleibt es länger als `LINK_SILENT_MS` aus, gibt die Brücke den Kanal auf und
// verbindet neu. Ebenso, wenn ein Handschlag nicht fertig wird.
import dc from "node:diagnostics_channel";
import { BRIDGE_CAP_SETUP, BRIDGE_CAP_SETUP_BROWSE, BRIDGE_CAP_CHAT, BRIDGE_CAP_RUN_BUILD, BRIDGE_CAP_SERVER_SSH, BRIDGE_CAP_VAULT_NOTE, BRIDGE_CAP_LOCAL_PROXY, BRIDGE_CAP_SIMULATOR, BRIDGE_CAP_SKILLS, BRIDGE_CAP_FINDER, BRIDGE_CAP_NOTIFY, BRIDGE_CAP_VOICE, BRIDGE_CAP_VOICE_AUTO, type BridgeToServer } from "@nyxos/shared";
import type { TerminalManager } from "./manager.js";

const MIN_MS = 1000;
/** Höchstens 10 s zwischen zwei Versuchen — der Kanal läuft über localhost (lokaler Server oder offener
 * Tunnel), kostet also keine neue Anmeldung; so ist ein Server-Neustart schnell wieder verbunden. */
const MAX_MS = 10_000;
/** Server pingt alle 15 s. Zwei verpasste Pings sind noch kein Ausfall, der dritte schon. */
export const LINK_SILENT_MS = 40_000;
/** Prüftakt des Wächters. */
export const LINK_CHECK_MS = 5_000;
/** Ein Handschlag, der so lange nicht fertig ist, wird aufgegeben (Tunnel hängt). */
export const LINK_CONNECT_TIMEOUT_MS = 15_000;
/** Selbst gewählter Schließcode (3000–4999 sind für Anwendungen frei). */
const WATCHDOG_CLOSE_CODE = 4001;

export interface LinkOptions {
  serverUrl: string;
  token: string;
  manager: TerminalManager;
  tmuxSocket: string;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Für Tests verkürzbar. */
  silentMs?: number;
  checkMs?: number;
  connectTimeoutMs?: number;
  /** Der Wächter hat den Kanal aufgegeben — z. B. den Tunnel sofort mitprüfen. */
  onStale?: () => void;
  /** Für Tests: Quelle der Server-Pings (Standard `onServerPing`). */
  pingSource?: (ws: WebSocket, fn: () => void) => () => void;
}

const UNDICI_PING = "undici:websocket:ping";

/**
 * Meldet eingehende Pings des Servers. Der Browser-Standard kennt kein Ping-Ereignis; Node meldet sie über
 * den Diagnosekanal von undici, samt Socket. Liefert eine Abmelde-Funktion.
 */
export function onServerPing(ws: WebSocket, fn: () => void): () => void {
  const handler = (m: unknown) => {
    if ((m as { websocket?: unknown } | null)?.websocket === ws) fn();
  };
  dc.subscribe(UNDICI_PING, handler);
  return () => dc.unsubscribe(UNDICI_PING, handler);
}

export class BridgeLink {
  private ws: WebSocket | null = null;
  private delay = MIN_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Aufräumen der laufenden Verbindung (Wächter-Timer, Ping-Abo). */
  private cleanup: (() => void) | null = null;
  connected = false;
  /** Letztes Lebenszeichen des Servers (Ping oder Nachricht), Wanduhr in ms — nur zur Anzeige. */
  lastBeatAt: number | null = null;
  /**
   * Dasselbe auf der monotonen Uhr. Nur damit rechnet der Wächter — ein Sprung der Wanduhr
   * (Zeitabgleich, Zeitzone) darf keinen gesunden Kanal kappen.
   */
  private lastBeatMono: number | null = null;
  /**
   * Hat diese Laufzeit überhaupt schon einen Server-Ping gemeldet? Solange nicht, ist Stille kein Beweis für
   * einen toten Kanal (Laufzeit ohne Ping-Meldung) — sonst verbände die Brücke alle 40 s neu und würfe jedes Mal
   * die Terminal-Steuer-Clients raus. Dann bleibt der Tunnel-Wächter zuständig.
   */
  pingSeen = false;
  private warnedNoPing = false;

  constructor(private readonly o: LinkOptions) {}

  /** Wie lange der Server schon schweigt (null = kein offener Kanal). Monotone Uhr. */
  beatAgeMs(): number | null {
    return this.connected && this.lastBeatMono !== null ? performance.now() - this.lastBeatMono : null;
  }

  start(): void {
    if (this.stopped) return;
    this.timer = null;
    const url = this.o.serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/bridge";
    let ws: WebSocket;
    try {
      // Node (undici) erlaubt Kopfzeilen am WebSocket-Handschlag (nicht im Browser-Standard).
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.o.token}` } } as unknown as string[]);
    } catch (e) {
      this.o.log("bruecke-kanal-fehler", { error: String(e) });
      this.retry();
      return;
    }
    this.ws = ws;
    const startedAt = Date.now();
    const beat = () => {
      this.lastBeatAt = Date.now();
      this.lastBeatMono = performance.now();
    };
    const unsubscribePing = (this.o.pingSource ?? onServerPing)(ws, () => {
      this.pingSeen = true;
      beat();
    });
    let check: ReturnType<typeof setInterval> | null = null;
    const connectTimer = setTimeout(() => {
      if (this.ws !== ws || this.connected) return;
      this.o.log("kanal-watchdog", { grund: "verbindungsaufbau", wartetMs: Date.now() - startedAt });
      this.abandon(ws);
    }, this.o.connectTimeoutMs ?? LINK_CONNECT_TIMEOUT_MS);
    this.cleanup = () => {
      clearTimeout(connectTimer);
      if (check) clearInterval(check);
      unsubscribePing();
    };
    const send = (m: BridgeToServer) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      clearTimeout(connectTimer);
      this.connected = true;
      this.delay = MIN_MS;
      beat();
      this.o.log("bruecke-kanal-offen", { url });
      send({ op: "hello", version: "p3", tmuxSocket: this.o.tmuxSocket, caps: [BRIDGE_CAP_RUN_BUILD, BRIDGE_CAP_VOICE, BRIDGE_CAP_VOICE_AUTO, BRIDGE_CAP_CHAT, BRIDGE_CAP_VAULT_NOTE, BRIDGE_CAP_LOCAL_PROXY, BRIDGE_CAP_SIMULATOR, BRIDGE_CAP_SKILLS, BRIDGE_CAP_FINDER, BRIDGE_CAP_NOTIFY, BRIDGE_CAP_SERVER_SSH, BRIDGE_CAP_SETUP, BRIDGE_CAP_SETUP_BROWSE] });
      const silentMs = this.o.silentMs ?? LINK_SILENT_MS;
      // Erst beim ZWEITEN Takt in Folge aufgeben. Hing die Ereignisschleife (Last, Swap), laufen
      // danach die fälligen Timer VOR dem Lesen der Sockets — die inzwischen angekommenen Pings wären noch
      // gar nicht gezählt. Zwischen zwei Takten liegt immer ein Lesedurchlauf.
      let suspect = false;
      check = setInterval(() => {
        const age = this.beatAgeMs();
        if (age === null || age <= silentMs) {
          suspect = false;
          return;
        }
        if (!this.pingSeen) {
          if (!this.warnedNoPing) this.o.log("kanal-ohne-ping", { stilleMs: Math.round(age) });
          this.warnedNoPing = true;
          return;
        }
        if (!suspect) {
          suspect = true;
          return;
        }
        this.o.log("kanal-watchdog", { grund: "kein-ping", stilleMs: Math.round(age) });
        this.abandon(ws);
      }, this.o.checkMs ?? LINK_CHECK_MS);
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      beat();
      const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      void this.o.manager.handle(data, send);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return; // vom Wächter schon aufgegeben — dort wurde bereits neu verbunden
      const was = this.connected;
      this.detach();
      if (was) this.o.log("bruecke-kanal-zu", {});
      this.retry();
    });
    ws.addEventListener("error", () => {
      // „close" folgt immer — dort wird neu verbunden
    });
  }

  /** Laufende Verbindung vergessen: Timer weg, Steuer-Clients lösen. */
  private detach(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.connected = false;
    this.ws = null;
    this.o.manager.closeAll();
  }

  /**
   * Der Wächter gibt eine Verbindung auf, von der nie ein „close" kommen wird (halb offen). Nicht auf das
   * Schließen warten — sofort neu verbinden; spätere Ereignisse des alten Sockets werden ignoriert.
   */
  private abandon(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.detach();
    try {
      // Höflich schließen, ohne auf Antwort zu warten.
      ws.close(WATCHDOG_CLOSE_CODE, "kanal-watchdog");
    } catch {
      // Socket ist schon kaputt — egal, er wird nicht mehr benutzt
    }
    this.o.onStale?.();
    this.delay = MIN_MS;
    this.retry();
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => this.start(), this.delay);
    this.delay = Math.min(this.delay * 2, MAX_MS);
  }

  /** Eine Nachricht von der Brücke aus an den Server (z. B. Nutzungswerte). `false`, wenn der Kanal gerade zu ist. */
  send(m: BridgeToServer): boolean {
    const ws = this.ws;
    if (!ws || !this.connected || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }

  /** Nach „Tunnel wieder offen" sofort neu versuchen statt den Abstand abzuwarten. */
  nudge(): void {
    if (this.connected || this.stopped || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.delay = MIN_MS;
    this.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.cleanup?.();
    this.cleanup = null;
    this.connected = false;
    this.ws = null;
    this.o.manager.closeAll();
    // Sauber mit 1000 schließen → der Server zeigt „Dienst gestoppt" statt „Tunnel zu".
    ws?.close(1000, "beende");
  }
}
