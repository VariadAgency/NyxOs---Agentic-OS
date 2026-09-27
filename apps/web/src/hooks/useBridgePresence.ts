import { useQuery } from "@tanstack/react-query";
import { fetchBridgeHistory, fetchBridgePresence } from "../lib/api";

const POLL_MS = 5_000;

/** Zustand der Brücke alle 5 s (der Server rechnet, die Browser-Uhr spielt keine Rolle). */
export function useBridgePresence() {
  return useQuery({
    queryKey: ["bridge-presence"],
    queryFn: fetchBridgePresence,
    refetchInterval: POLL_MS,
    retry: false,
  });
}

/** Verlauf der Verbindung (letzte 24 h), nur solange das Popover offen ist. */
export function useBridgeHistory(enabled: boolean) {
  return useQuery({
    queryKey: ["bridge-presence-history"],
    queryFn: () => fetchBridgeHistory(24),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
    retry: false,
  });
}
