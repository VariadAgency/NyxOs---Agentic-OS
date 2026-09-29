import { useQuery } from "@tanstack/react-query";
import { fetchServer } from "../lib/api";

export function useServerSnapshot() {
  return useQuery({ queryKey: ["server"], queryFn: fetchServer, refetchInterval: 10_000 });
}
