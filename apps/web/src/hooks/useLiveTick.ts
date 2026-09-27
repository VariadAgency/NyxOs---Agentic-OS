import { useEffect, useState } from "react";
import { subscribeLiveTick } from "../lib/liveBus";

/**
 * Zählt /live-Nachrichten hoch, die DIESE Session betreffen — für Ansichten, die selbst nachladen
 * müssen (Chat), statt über einen Query-Key zu invalidieren.
 *
 * Ohne die Session-Prüfung hängte ein Signal für eine FREMDE Session
 * blind die jüngste Seite dieser gerade offenen Session an. `sessionId: null` (keine Session
 * offen) zählt nie.
 */
export function useLiveTick(sessionId: string | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (sessionId === null) return;
    return subscribeLiveTick((ids) => {
      if (ids === null || ids.has(sessionId)) setTick((t) => t + 1);
    });
  }, [sessionId]);
  return tick;
}
