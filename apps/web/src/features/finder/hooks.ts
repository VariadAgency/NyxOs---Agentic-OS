// Abfragen des Finders (TanStack Query). Ordnerinhalte kurz zwischenspeichern — die Spaltenansicht
// fragt beim Hin- und Herwandern dieselben Ordner mehrfach ab.
// Alle Abfragen laufen über die Datenquelle (Brücke oder Server, s. source.tsx) — Schlüssel je Quelle.
import { FINDER_ERR, t, type FinderEntry } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { FinderApiError } from "./api";
import { useFinderSource, type SourceCounts } from "./source";
import { sortEntries, type SortSpec } from "./sort";
import { LoginRequiredError } from "../terminal/authClient";

/** Nicht wiederholen, wenn der Server schon klar „nein“ gesagt hat (Pfad, Anmeldung, gibt es nicht). */
// Fragt macOS nach der Freigabe, übernimmt der Hinweis (ListError) das Nachfragen.
const retry = (n: number, e: unknown) => {
  if (n >= 1 || e instanceof LoginRequiredError) return false;
  if (e instanceof FinderApiError && (e.status < 500 || e.code === FINDER_ERR.macosPermission)) return false;
  const status = (e as { status?: unknown } | null)?.status;
  return !(typeof status === "number" && status < 500);
};

export function useRoots() {
  const src = useFinderSource();
  return useQuery({ queryKey: [src.key, "roots"], queryFn: src.fetchRoots, staleTime: 60_000, retry });
}

export function useList(root: string, rel: string | null) {
  const src = useFinderSource();
  return useQuery({ queryKey: [src.key, "list", root, rel], queryFn: () => src.fetchList(root, rel ?? ""), enabled: rel !== null, staleTime: 5_000, retry });
}

/** Kinderzahlen großer Ordner kommen nach der Liste (die Liste steht schon, Zahlen folgen). */
export function useCounts(root: string, rel: string | null, enabled: boolean) {
  const src = useFinderSource();
  const fetchCounts = src.fetchCounts;
  return useQuery({
    queryKey: [src.key, "counts", root, rel],
    queryFn: () => (fetchCounts ? fetchCounts(root, rel ?? "") : Promise.resolve<SourceCounts>({ rel: rel ?? "", counts: {} })),
    enabled: enabled && rel !== null && fetchCounts !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** Sortierte, gefilterte Einträge eines Ordners (versteckte nur auf Wunsch). */
export function useEntries(root: string, rel: string | null, sort: SortSpec, showHidden: boolean) {
  const q = useList(root, rel);
  const counts = useCounts(root, rel, q.data?.childrenPending === true);
  const entries = useMemo<FinderEntry[]>(() => {
    if (!q.data) return [];
    const byName = counts.data?.counts;
    // Nur eigene Schlüssel — ein Ordner namens „constructor“ darf nicht Object.prototype treffen.
    const all = byName ? q.data.entries.map((e) => (e.isDir && e.children === null && Object.hasOwn(byName, e.name) ? { ...e, children: byName[e.name] ?? null } : e)) : q.data.entries;
    return sortEntries(showHidden ? all : all.filter((e) => !e.hidden), sort);
  }, [q.data, counts.data, sort, showHidden]);
  return { ...q, entries };
}

export function useText(root: string, rel: string | null, enabled = true) {
  const src = useFinderSource();
  return useQuery({ queryKey: [src.key, "text", root, rel], queryFn: () => src.fetchText(root, rel ?? ""), enabled: enabled && rel !== null, staleTime: 0, retry });
}

export function useSearch(root: string, rel: string, q: string) {
  const src = useFinderSource();
  return useQuery({ queryKey: [src.key, "search", root, rel, q], queryFn: () => src.search(root, rel, q), enabled: q.trim().length > 0, staleTime: 10_000, retry });
}

/** Verständlicher Satz zu einem Fehler (der Server formuliert ihn schon; sonst ein allgemeiner). */
export function errorText(e: unknown): string {
  // Technische Standard-Sätze („Server antwortet mit 502“) ersetzt ein allgemeiner Satz.
  if (e instanceof Error && e.message && !/^(Server antwortet|Server respond)/.test(e.message)) return e.message;
  return t("Das hat gerade nicht geklappt. Bitte noch einmal versuchen.");
}
