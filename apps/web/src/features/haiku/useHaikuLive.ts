// Eigene `/live`-Verbindung für Haiku-Signale (`{ type: "haiku", what }`). Bewusst getrennt von
// `hooks/useLiveSocket.ts` (wird parallel woanders geändert) — invalidiert nur die Haiku-Query-Keys.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

const RECONNECT_MS = 2000;
const DEBOUNCE_MS = 300;

type What = "inbox" | "approval" | "report" | "status" | "idealink" | "threads";

const KEYS: Record<What, readonly (readonly string[])[]> = {
  inbox: [["inbox"], ["haiku", "light-day"]],
  approval: [["approvals"], ["haiku", "light-day"]],
  report: [["haiku", "report"]],
  status: [["haiku", "status"], ["haiku", "calls"]],
  idealink: [["idealinks"]],
  // Fadenliste (abgelaufene Wegwerf-Fäden gelöscht, Temporär umgeschaltet, Einstellung geändert).
  threads: [["haiku", "threads"]],
};

export function useHaikuLive(): void {
  const qc = useQueryClient();

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let pending = new Set<What>();

    const flush = () => {
      debounce = undefined;
      for (const what of pending) for (const key of KEYS[what]) void qc.invalidateQueries({ queryKey: [...key] }, { cancelRefetch: false });
      pending = new Set();
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      try {
        ws = new WebSocket(`${proto}://${location.host}/live`);
      } catch {
        retry = setTimeout(connect, RECONNECT_MS);
        return;
      }
      ws.onmessage = (evt: MessageEvent) => {
        try {
          const msg = JSON.parse(String(evt.data)) as { type?: unknown; what?: unknown };
          if (msg.type !== "haiku" || typeof msg.what !== "string" || !(msg.what in KEYS)) return;
          pending.add(msg.what as What);
          if (debounce === undefined) debounce = setTimeout(flush, DEBOUNCE_MS);
        } catch {
          // fremde/kaputte Nachricht — nicht unsere
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(debounce);
      ws?.close();
    };
  }, [qc]);
}
