import { useQuery } from "@tanstack/react-query";
import { fetchOverview } from "../lib/api";

/** Überblick-Dashboard. Live-Updates invalidieren `["overview"]` (s. useLiveSocket). */
export function useOverview() {
  return useQuery({ queryKey: ["overview"], queryFn: fetchOverview, refetchInterval: 30_000 });
}
