import type { CreateEntryInput, EntryKind, EntryStage } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createEntry, fetchEntries, fetchEntryDetail, fetchImportStatus, fetchStartPlan, promoteIdea, runImport, startEntry } from "./api";

export function useEntries(filter: { q?: string; kind?: EntryKind; stage?: EntryStage } = {}) {
  return useQuery({ queryKey: ["entries", filter], queryFn: () => fetchEntries(filter) });
}

export function useEntryDetail(id: number | null) {
  return useQuery({ queryKey: ["entry", id], queryFn: () => fetchEntryDetail(id as number), enabled: id !== null });
}

export function useStartPlan(id: number | null) {
  return useQuery({ queryKey: ["entry-start-plan", id], queryFn: () => fetchStartPlan(id as number), enabled: id !== null });
}

export function useStartEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => startEntry(id),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ["entries"] });
      void qc.invalidateQueries({ queryKey: ["entry", id] });
    },
  });
}

export function useCreateEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEntryInput) => createEntry(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });
}

export function usePromoteIdea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; kind?: "aufgabe" | "bug" }) => promoteIdea(vars.id, vars.kind),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["entries"] });
      void qc.invalidateQueries({ queryKey: ["entry", vars.id] });
    },
  });
}

/** Import-Stand. Liegt unter ["entries", …], damit die Live-Meldung nach einem Import ihn mit
 * auffrischt; zusätzlich jede Minute (Zeitangaben „vor X Min“ bleiben so ehrlich). */
export function useImportStatus() {
  return useQuery({ queryKey: ["entries", "import-status"], queryFn: fetchImportStatus, refetchInterval: 60_000 });
}

export function useRunImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: runImport,
    onSuccess: (data) => {
      qc.setQueryData(["entries", "import-status"], data.status);
      void qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });
}
