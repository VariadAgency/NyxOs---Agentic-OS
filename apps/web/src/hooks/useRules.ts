import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchRules, setRuleActive } from "../lib/api";

export function useRules() {
  return useQuery({ queryKey: ["rules"], queryFn: fetchRules, refetchInterval: 30_000 });
}

export function useSetRuleActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: number; active: boolean }) => setRuleActive(input.id, input.active),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}
