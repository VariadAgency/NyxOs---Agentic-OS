import { t } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { fetchHealth } from "../lib/api";

const POLL_MS = 10_000;
/** Während eines Aussetzers öfter nachfragen, damit gelb schnell wieder grün wird. */
const RETRY_POLL_MS = 3_000;
/**
 * Kurze Aussetzer bis 90 s (wie bei der Brücke) sind gelb „Verbindung wird neu
 * aufgebaut …“, nicht rot. Typischer Fall: die Brücke startet neu, ihr Tunnel (47801) ist 2–5 s weg —
 * der Server war die ganze Zeit gesund.
 */
export const SERVER_GRACE_MS = 90_000;

/** Fragt /health alle 10 s ab (bei Aussetzern alle 3 s). Echte Prüfung, kein erfundener Status. */
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: (q) => (q.state.status === "error" || q.state.data?.ok === false ? RETRY_POLL_MS : POLL_MS),
    retry: false,
  });
}

export type ServerTone = "ok" | "wait" | "bad" | "unknown";
/** `network` = gar keine Antwort (Tunnel/Netz weg), `http` = Antwort mit Fehler-Status, `unhealthy` = /health meldet eine Störung. */
export type ServerFailure = "network" | "http" | "unhealthy";

export interface ServerInput {
  /** `true` gesund, `false` gestört/nicht erreichbar, `null` noch keine Antwort und kein Fehler. */
  ok: boolean | null;
  lastOkAt: number | null;
  /** Seit wann es (ohne Unterbrechung) nicht geht. */
  failingSince: number | null;
  failure: ServerFailure | null;
  now: number;
  /** Seite läuft über den lokalen Tunnel der Brücke (localhost/127.0.0.1). */
  viaLocalTunnel: boolean;
}

/** Rein: Anzeige der Server-Zeile. */
export function describeServer(i: ServerInput): { tone: ServerTone; text: string; detail: string | null } {
  if (i.ok === true) return { tone: "ok", text: t("Server verbunden"), detail: null };
  if (i.ok === null || i.failingSince === null) return { tone: "unknown", text: t("Server: prüfe …"), detail: null };
  if (i.now - i.failingSince < SERVER_GRACE_MS) return { tone: "wait", text: t("Verbindung wird neu aufgebaut …"), detail: null };
  if (i.failure === "unhealthy") return { tone: "bad", text: t("Server meldet eine Störung"), detail: t("Datenbank oder Archiv antworten nicht – Einstellungen → Verbindungen zeigt, was genau.") };
  if (i.failure === "http") return { tone: "bad", text: t("Server antwortet nicht"), detail: t("Die Verbindung steht, aber der Server liefert Fehler.") };
  return i.viaLocalTunnel
    ? { tone: "bad", text: t("Server nicht erreichbar"), detail: t("Brücke/Tunnel weg – die Brücke baut ihn normalerweise von selbst wieder auf.") }
    : { tone: "bad", text: t("Server nicht erreichbar"), detail: t("Keine Antwort über das Netz.") };
}

function isLocalTunnel(): boolean {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

/** Server-Zeile mit Aussetzer-Toleranz. Tickt jede Sekunde, damit gelb nach 90 s ehrlich rot wird. */
export function useServerStatus() {
  const health = useHealth();
  const failingSince = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const failed = health.isError || health.data?.ok === false;
  if (!failed) failingSince.current = null;
  else if (failingSince.current === null) failingSince.current = health.isError ? health.errorUpdatedAt || Date.now() : health.dataUpdatedAt || Date.now();

  useEffect(() => {
    if (!failed) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [failed]);

  const failure: ServerFailure | null = !failed ? null : health.data?.ok === false && !health.isError ? "unhealthy" : health.error instanceof TypeError ? "network" : "http";
  const ok = health.isLoading ? null : !failed;
  return describeServer({
    ok,
    lastOkAt: health.dataUpdatedAt || null,
    failingSince: failingSince.current,
    failure,
    now: Math.max(now, failingSince.current ?? 0),
    viaLocalTunnel: isLocalTunnel(),
  });
}
