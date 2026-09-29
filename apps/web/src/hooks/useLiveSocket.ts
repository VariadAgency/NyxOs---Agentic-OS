import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { emitLiveTick, emitNyxLive, type NyxLiveMessage } from "../lib/liveBus";
import { isBrowserPushMessage, showBrowserPush } from "../features/push/browserNotify";

// Exponentieller Backoff 1→2→4→…→30 s statt eines festen 2-s-Takts — bei einem
// gestoppten Server wurden vorher bis zu 79 Konsolenfehler durch dichte Neuverbindungsversuche
// beobachtet. `RECONNECT_MS` bleibt als Startwert, `nextDelay` verdoppelt bis
// `RECONNECT_MAX_MS`.
const RECONNECT_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
// `/live`-Nachrichten bei dichter Aktivität bündeln — höchstens ein Refetch je Query
// alle 300 ms, statt bei jeder einzelnen Nachricht neu anzufragen (und dabei laufende Anfragen
// per `cancelRefetch` immer wieder abzubrechen — das ließ die Liste unter Last verhungern).
const DEBOUNCE_MS = 300;
// Der Server schickt alle 25 s `{type:"ping"}`. Kommt 75 s lang gar nichts (Tunnel/Schlaf hat die
// Verbindung still getötet, der Browser merkt es nicht), wird neu verbunden – sonst kommen Nyx-Befehle nie an.
export const LIVE_SILENCE_MS = 75_000;
const WATCHDOG_MS = 15_000;

/** Form der `/live`-Nachricht aus `app.ts` `publish()` (`hub.broadcast({ type: "session", session })`)
 * bzw. aus `routes/entries.ts` `notify()` (`hub.broadcast({ type: "entry", entryId })`). */
interface LiveMessage {
  type?: string;
  session?: { id?: string };
  entryId?: number;
  /** `{ type: "context_guard", sessionId }` — Hinweis/Erzwingen-Zustand einer Session hat sich geändert. */
  sessionId?: string;
}

/**
 * Hält eine WebSocket-Verbindung zu /live offen und invalidiert gebündelt den
 * Sessions-/Kategorien-Query (Live-Updates invalidieren Query-Keys statt eigenen State zu
 * führen) sowie — wenn die Nachricht eine Session-ID trägt — gezielt deren Detail-Query, statt bei
 * jeder Nachricht alles neu anzufragen.
 */
export function useLiveSocket(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let pendingSessionIds = new Set<string>();
    let pendingEntryIds = new Set<number>();
    // Backoff-Zustand: `delay` verdoppelt sich je fehlgeschlagenem Versuch (Obergrenze
    // `RECONNECT_MAX_MS`), `warned` sorgt für höchstens EINE Konsolen-Warnung je zusammenhängendem
    // Ausfall statt einer Zeile pro Versuch.
    let delay = RECONNECT_MS;
    let warned = false;
    let lastSeen = Date.now();
    /** Erst wenn der Server pingt, gilt Stille als Verbindungsabbruch (ältere Server pingen nicht). */
    let sawPing = false;

    const flush = () => {
      debounce = undefined;
      // `cancelRefetch: false`: eine schon laufende Anfrage zu Ende laufen lassen, statt sie bei
      // jedem Signal neu zu starten (sonst kommt sie unter Last nie an).
      void queryClient.invalidateQueries({ queryKey: ["sessions"] }, { cancelRefetch: false });
      void queryClient.invalidateQueries({ queryKey: ["categories"] }, { cancelRefetch: false });
      // Die Kollisionskarte hängt an `session_files`, das bei jedem Ingest mitwächst
      // — ohne diese Invalidierung bräuchte ein Konflikt bis zu 5 s (Polling), statt < 2 s nach dem
      // Schreiben sichtbar zu werden.
      void queryClient.invalidateQueries({ queryKey: ["conflicts"] }, { cancelRefetch: false });
      for (const id of pendingSessionIds) void queryClient.invalidateQueries({ queryKey: ["session", id] }, { cancelRefetch: false });
      // Nur die Sessions weitergeben, die dieses Bündel wirklich betraf — `size === 0`
      // heißt "kein Signal trug eine Session-ID" (z. B. Verbindungsaufbau), `useLiveTick` behandelt
      // `null` wie "alle" (unverändertes Verhalten dafür).
      emitLiveTick(pendingSessionIds.size > 0 ? pendingSessionIds : null);
      pendingSessionIds = new Set();
      // Aufgaben-/Ideen-Listen und die offene
      // Großansicht ziehen automatisch nach, ohne dass jemand die Seite neu lädt.
      if (pendingEntryIds.size > 0) {
        void queryClient.invalidateQueries({ queryKey: ["entries"] }, { cancelRefetch: false });
        for (const id of pendingEntryIds) void queryClient.invalidateQueries({ queryKey: ["entry", id] }, { cancelRefetch: false });
        pendingEntryIds = new Set();
      }
    };

    const schedule = (sessionId?: string, entryId?: number) => {
      if (sessionId) pendingSessionIds.add(sessionId);
      if (entryId !== undefined) pendingEntryIds.add(entryId);
      if (debounce !== undefined) return;
      debounce = setTimeout(flush, DEBOUNCE_MS);
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/live`);
      ws = sock;
      lastSeen = Date.now();
      ws.onopen = () => {
        // Verbindung steht wieder — Backoff und Warn-Sperre für den NÄCHSTEN Ausfall zurücksetzen.
        delay = RECONNECT_MS;
        warned = false;
        schedule();
      };
      ws.onmessage = (evt) => {
        let sessionId: string | undefined;
        let entryId: number | undefined;
        lastSeen = Date.now();
        try {
          const msg = JSON.parse(String(evt.data)) as LiveMessage;
          // Herzschlag: nur „Verbindung lebt“, kein Refetch.
          if (msg.type === "ping") {
            sawPing = true;
            return;
          }
          // Nyx steuert NyxOS / meldet seinen Zustand – an den Begleiter, kein Refetch nötig.
          if (typeof msg.type === "string" && msg.type.startsWith("nyx.")) {
            emitNyxLive(msg as NyxLiveMessage);
            return;
          }
          // Push-Weg „Browser“ – System-Mitteilung zeigen, kein Refetch nötig.
          if (isBrowserPushMessage(msg)) {
            showBrowserPush(msg);
            return;
          }
          if (msg.type === "session" && typeof msg.session?.id === "string") sessionId = msg.session.id;
          if (msg.type === "bridge") void queryClient.invalidateQueries({ queryKey: ["terminal-status"] }); // Brücke an/aus
          // Telegram-Zustand (verbunden, gekoppelt, Ziel) hat sich geändert.
          if (msg.type === "telegram") void queryClient.invalidateQueries({ queryKey: ["telegram", "status"] }, { cancelRefetch: false });
          // Skill-Bibliothek (neuer Vorschlag, neuer Stand, Auftrag gestartet) → Kacheln/Detail neu laden.
          if (msg.type === "skills") void queryClient.invalidateQueries({ queryKey: ["skills"] }, { cancelRefetch: false });
          if (msg.type === "entry" && typeof msg.entryId === "number") entryId = msg.entryId;
          // Eigener Schlüssel statt "session" — die NyxOS kennt den Kontext-Wächter-Zustand
          // separat von der Session-DTO (kein Doppel-Feld, s. `features/context-guard/api.ts`).
          if (msg.type === "context_guard" && typeof msg.sessionId === "string") {
            void queryClient.invalidateQueries({ queryKey: ["context-guard", "session", msg.sessionId] }, { cancelRefetch: false });
          }
          // Zustell-Warteschlange einer Session hat sich geändert (eingereiht, raus, abgelaufen).
          if (msg.type === "deliveries" && typeof msg.sessionId === "string") {
            void queryClient.invalidateQueries({ queryKey: ["deliveries", msg.sessionId] }, { cancelRefetch: false });
          }
          // „Session zusammenfassen & prüfen“ fertig/gestartet → Ergebnis neu laden.
          if (msg.type === "session_audit" && typeof msg.sessionId === "string") {
            void queryClient.invalidateQueries({ queryKey: ["session-audits", msg.sessionId] }, { cancelRefetch: false });
          }
        } catch {
          // unbekannte/kaputte Nachricht — trotzdem bündeln, nur ohne gezielte ID
        }
        schedule(sessionId, entryId);
      };
      ws.onclose = () => {
        // Eine ersetzte (vom Wächter geschlossene) Verbindung plant keinen zweiten Neuaufbau.
        if (closed || ws !== sock) return;
        // Höchstens EINE Warnung je zusammenhängendem Ausfall (keine Konsolen-
        // Fehlerflut) — der Browser selbst protokolliert die fehlgeschlagene WS-Handshake-Anfrage
        // ohnehin einmal je Versuch (nicht unterdrückbar), das hier ist unsere eigene, gedämpfte Zeile.
        if (!warned) {
          console.warn("[live] Connection lost, reconnecting with increasing delay …");
          warned = true;
        }
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
    };
    connect();

    // Stille Verbindung (kein Ping seit LIVE_SILENCE_MS) → sofort ersetzen. Nicht auf `onclose` warten: bei toter
    // TCP-Verbindung wartet der Browser auf den Schließ-Handschlag (Chrome bis 60 s), `onclose` kommt dann spät.
    const watchdog = setInterval(() => {
      if (!sawPing || !ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastSeen <= LIVE_SILENCE_MS) return;
      const dead = ws;
      clearTimeout(retry);
      connect(); // `ws` zeigt jetzt auf die neue Verbindung → das alte `onclose` plant nichts mehr
      dead.close();
    }, WATCHDOG_MS);
    // Fenster wieder vorne / Netz wieder da: nicht erst den Backoff (bis 30 s) abwarten.
    const wake = () => {
      if (closed || document.visibilityState !== "visible") return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      clearTimeout(retry);
      delay = RECONNECT_MS;
      connect();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);

    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(debounce);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      ws?.close();
    };
  }, [queryClient]);
}
