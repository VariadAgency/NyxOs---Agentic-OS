// Verbindungs-Prüfung des Servers (`GET /api/connections`). Der Server hält das Ergebnis
// 30 s vor; „Jetzt prüfen“ erzwingt mit `?fresh=1` einen neuen Lauf.
import type { ConnectionsReport } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
/** Fehler mit HTTP-Status (404 = Prüfung auf dem Server noch nicht eingespielt). */
export class ConnectionsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const CONNECTIONS_KEY = ["connections"] as const;
const POLL_MS = 30_000;

export async function fetchConnections(fresh = false): Promise<ConnectionsReport> {
  const res = await fetch(fresh ? "/api/connections?fresh=1" : "/api/connections");
  if (!res.ok) throw new ConnectionsError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as ConnectionsReport;
}

export function useConnections() {
  return useQuery({ queryKey: CONNECTIONS_KEY, queryFn: () => fetchConnections(false), refetchInterval: POLL_MS, retry: false });
}

/** „Jetzt prüfen“: frischer Lauf, Ergebnis ersetzt sofort den Stand der Seite. */
export function useRecheckConnections() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => fetchConnections(true),
    onSuccess: (report) => client.setQueryData(CONNECTIONS_KEY, report),
  });
}
