import { useQuery } from "@tanstack/react-query";
import { fetchSessions } from "../lib/api";

/** Session-Liste aus /api/sessions. Live-Updates invalidieren diesen Query-Key (siehe useLiveSocket). */
export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
  });
}
