import type { ConflictEntriesPage, DecisionDismissal } from "@nyxos/shared";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  dismissDecision,
  fetchConflictEntries,
  fetchConflictSummary,
  fetchFileChanges,
  fetchGitCompare,
  pauseSessions,
  preferSession,
  reopenDecision,
  reserveDecision,
} from "../features/conflicts/conflictsApi";
import { createReservation, deleteReservation } from "../lib/api";

/** Seitengröße der Details (nie tausende Zeilen auf einmal ins DOM). */
export const ENTRY_PAGE = 50;

/**
 * Nur noch die kleine Zusammenfassung (Gruppen + Entscheidungen). Frisch hält sie der
 * Live-Socket (`useLiveSocket` invalidiert `["conflicts"]` — gilt für alle Schlüssel darunter);
 * unverändert antwortet der Server mit 304 (ETag). Kein 5-s-Vollabruf der ganzen Karte mehr —
 * genau der ließ die Seite hängen (3.322 Einträge, 1,57 MB, alle 5 s).
 */
export function useConflictSummary() {
  return useQuery({ queryKey: ["conflicts", "summary"], queryFn: ({ signal }) => fetchConflictSummary(signal), refetchInterval: 60_000 });
}

/** Details einer Gruppe bzw. einer Suche — erst beim Aufklappen, seitenweise. */
export function useConflictEntries(query: { group?: string; q?: string }, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["conflicts", "entries", query.group ?? null, query.q ?? null],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => fetchConflictEntries({ ...query, offset: pageParam, limit: ENTRY_PAGE }, signal),
    getNextPageParam: (last: ConflictEntriesPage) => (last.offset + last.entries.length < last.total ? last.offset + last.entries.length : undefined),
    placeholderData: keepPreviousData,
  });
}

/** Genau eine Datei (Großansicht `?path=`). */
export function useConflictEntry(path: string | null) {
  return useQuery({
    queryKey: ["conflicts", "entry", path],
    enabled: Boolean(path),
    queryFn: ({ signal }) => fetchConflictEntries({ path: path ?? "", limit: 1 }, signal).then((p) => p.entries[0] ?? null),
  });
}

/** Änderungen der Sessions an einer Datei — bewusst NICHT unter `["conflicts"]` (sonst würde
 * jede Live-Nachricht die Verläufe neu durchsuchen). */
export function useFileChanges(path: string, sessionKeys: string[], enabled: boolean) {
  return useQuery({
    queryKey: ["conflict-compare", "changes", path, sessionKeys],
    enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => fetchFileChanges(path, sessionKeys, signal),
  });
}

export function useGitCompare(path: string, from: string | null, to: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["conflict-compare", "git", path, from, to],
    enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => fetchGitCompare(path, from, to, signal),
  });
}

function useInvalidating<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => void qc.invalidateQueries({ queryKey: ["conflicts"] }) });
}

export const useDismissDecision = () => useInvalidating(({ key, status }: { key: string; status: DecisionDismissal }) => dismissDecision(key, status));
export const useReopenDecision = () => useInvalidating((key: string) => reopenDecision(key));
export const useReserveDecision = () => useInvalidating((key: string) => reserveDecision(key));
export const usePreferSession = () => useInvalidating(({ key, sessionKey }: { key: string; sessionKey: string }) => preferSession(key, sessionKey));
export const usePauseSessions = () => useInvalidating((keys: string[]) => pauseSessions(keys));
export const useCreateReservation = () => useInvalidating(createReservation);
export const useReleaseReservation = () => useInvalidating((id: number) => deleteReservation(id));
