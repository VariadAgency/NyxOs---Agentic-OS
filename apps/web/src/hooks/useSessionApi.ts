import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  type AssignTarget,
  type CategoryCount,
  type RuleDimension,
  assignSession,
  closeSession,
  fetchCategories,
  fetchRelatedSessions,
  fetchSessionDetail,
  fetchSortRules,
  fetchTranscript,
  previewAssign,
  reopenSession,
  searchSessions,
  setSortRuleActive,
  type TranscriptItem,
  type TranscriptResponse,
  unassignSession,
} from "../lib/api";
import { getJson } from "../lib/http";
import type { ToolFilter } from "./useSessionsRoute";

/**
 * Arten/Baustellen mit Zählern. Mit Werkzeug-Filter zählt der Server nur Claude- bzw.
 * Codex-Sessions (`?tool=`), damit Art- UND Baustellen-Zeile zum Filter passen. `keepPreviousData`:
 * beim Umschalten bleiben die alten Zahlen stehen, bis die neuen da sind (kein Lade-Flackern).
 */
export function useCategories(tool: ToolFilter = "alle", enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["categories", tool],
    queryFn: () =>
      tool === "alle" ? fetchCategories() : getJson<{ categories: CategoryCount[] }>(`/api/categories?tool=${tool}`).then((body) => body.categories),
    placeholderData: keepPreviousData,
  });
}

export function useSessionDetail(id: string | null) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => fetchSessionDetail(id as string),
    enabled: id !== null,
  });
}

/** `asRule` default `true` — der Dialog schickt `false` nur, wenn der Nutzer "Nur diese Session" wählt. */
export function useAssignSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; target: AssignTarget; asRule?: boolean }) => assignSession(vars.id, vars.target, vars.asRule ?? true),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["categories"] });
      void queryClient.invalidateQueries({ queryKey: ["sort-rules"] });
    },
  });
}

/** Vorschau vor dem Speichern — schreibt nichts. */
export function usePreviewAssign() {
  return useMutation({
    mutationFn: (vars: { id: string; target: AssignTarget }) => previewAssign(vars.id, vars.target),
  });
}

/** Rückgängig für eine Korrektur (Toast-Knopf, "kein Rückgängig in der UI"). */
export function useUnassignSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; ruleIds: number[]; dims: RuleDimension[] }) => unassignSession(vars.id, vars.ruleIds, vars.dims),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["categories"] });
      void queryClient.invalidateQueries({ queryKey: ["sort-rules"] });
    },
  });
}

/** Regeln-Bereich ("in der UI gibt es kein Rückgängig" / keine Verwaltung).
 * `enabled` default `true`, aber der Regeln-Dialog übergibt `open`, damit ohne geöffneten Dialog
 * keine unnötige Anfrage läuft. */
export function useSortRules(enabled = true) {
  return useQuery({ queryKey: ["sort-rules"], queryFn: fetchSortRules, enabled });
}

export function useSetSortRuleActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; active: boolean }) => setSortRuleActive(vars.id, vars.active),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["categories"] });
      void queryClient.invalidateQueries({ queryKey: ["sort-rules"] });
    },
  });
}

export function useCloseSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => closeSession(id, "user"),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["session", id] });
      // Der Überblick zeigt verwaiste/kritische Sessions – geschlossene sollen dort sofort verschwinden.
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function useReopenSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reopenSession(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["session", id] });
    },
  });
}

/** Reiter „Bezüge": Eltern-/Kind-Session + Sessions mit gemeinsam geschriebenen Dateien. */
export function useRelatedSessions(id: string | null) {
  return useQuery({
    queryKey: ["related", id],
    queryFn: () => fetchRelatedSessions(id as string),
    enabled: id !== null,
  });
}

export function useSearch(query: string, limit = 20) {
  return useQuery({
    queryKey: ["search", query, limit],
    queryFn: () => searchSessions(query, limit),
    enabled: query.trim().length > 0,
    retry: false,
  });
}

const TRANSCRIPT_PAGE_LIMIT = 200;

/**
 * „nicht gefunden“ erkennen, egal aus welcher `ApiError`-Klasse der Fehler kommt.
 * Ursache des roten „Chat konnte nicht geladen werden.“ bei leeren Sessions: `fetchTranscript` (lib/api.ts) wirft
 * die `ApiError` aus `lib/api.ts`, hier wurde aber gegen die gleichnamige Klasse aus `lib/http.ts` geprüft –
 * `instanceof` war nie wahr, ein 404 (noch kein Verlauf) wurde so zum Ladefehler.
 */
export function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "status" in e && (e as { status: unknown }).status === 404;
}

export interface TranscriptState {
  items: TranscriptItem[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  /** Gesetzt bei `around`-Sprung (Suche/`?at=`): Index in `items`, auf den gescrollt werden soll. */
  anchorIndex: number | null;
  archivedAt: string | null;
  /**
   * Das Fenster steht nicht am Ende des Verlaufs (`nextCursor` der
   * letzten Seite war nicht `null` — typischerweise nach einem Such-Sprung), UND ein `/live`-Signal
   * für diese Session kam an. Statt die jüngste Seite blind anzuhängen (das risse eine Lücke
   * zwischen dem Fenster und dem echten Ende), zeigt die UI nur diesen Hinweis; `jumpToLatest()`
   * holt bewusst das Ende nach.
   */
  newerAvailable: boolean;
  /** Verwirft das aktuelle (ggf. mittige) Fenster und lädt die jüngste Seite frisch — wie beim ersten Öffnen. */
  jumpToLatest: () => void;
}

/** Ersetzt bereits bekannte Einträge durch ihre neue Fassung (statt sie zu ignorieren) und hängt
 * wirklich neue ans Ende an. Ein Werkzeug-Aufruf, dessen Status erst
 * SPÄTER eintrifft (ebenso eine wachsende Sub-Agent-Zählung), blieb vorher dauerhaft "ohne Status",
 * weil nur nach unbekannten `id`s gefiltert wurde. */
function mergeKnownAndAppend(prev: TranscriptItem[], fresh: TranscriptItem[]): TranscriptItem[] {
  const freshById = new Map(fresh.map((it) => [it.id, it] as const));
  let changed = false;
  const merged = prev.map((it) => {
    const updated = freshById.get(it.id);
    if (!updated) return it;
    freshById.delete(it.id);
    if (JSON.stringify(updated) !== JSON.stringify(it)) changed = true;
    return updated;
  });
  const appended = [...freshById.values()];
  if (appended.length > 0) changed = true;
  return changed ? [...merged, ...appended] : prev;
}

/**
 * Lädt den Chat-Verlauf einer Session seitenweise (Cursor-Grenzen aus `transcript.ts`). Öffnet
 * unten (jüngste Seite, `direction=backward`), lädt beim Hochscrollen ältere Seiten nach und
 * hängt bei `/live`-Signalen für diese Session neue Einträge hinten an. `around` springt an
 * eine Stelle aus der Suche.
 */
export function useTranscript(id: string | null, opts: { subagent?: string | null; around?: number | null; liveTick?: number } = {}): TranscriptState {
  const { subagent = null, around = null, liveTick } = opts;
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [prevCursor, setPrevCursor] = useState<string | null>(null);
  /** Die Erstladung fand noch kein Archiv (404) — die erste Live-Seite setzt dann den Cursor. */
  const emptyStartRef = useRef(false);
  // `nextCursor` (nicht `null`) heißt: das aktuelle Fenster ist NICHT am Ende des Verlaufs (nur bei
  // `around`-Sprüngen möglich — die normale Erstladung ist immer schon die jüngste Seite). Als Ref
  // gespiegelt, damit der Live-Effekt unten den AKTUELLEN Wert lesen kann, ohne bei jeder Änderung
  // neu zu laufen (er soll nur auf `liveTick` reagieren).
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);
  const [newerAvailable, setNewerAvailable] = useState(false);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [archivedAt, setArchivedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadedKey = useRef<string | null>(null);
  // Eine noch laufende `loadOlder`-Anfrage muss beim Session-/Fenster-Wechsel
  // abgebrochen werden — sonst kann ihre (verspätete) Antwort fremde Einträge/Cursor VORN in den
  // inzwischen neuen Verlauf mischen.
  const olderControllerRef = useRef<AbortController | null>(null);
  // `useLiveTick()` liefert schon beim ersten Rendern einen definierten Wert (0, kein echtes
  // Signal) — ohne diese Markierung würde der Live-Effekt unten bei JEDEM Öffnen einer Session
  // sofort ein zweites Mal dieselbe Seite laden. Merkt sich je Session, ob schon ein `liveTick`
  // gesehen wurde; erst der nächste WIRKLICHE Wechsel (ein echtes `/live`-Signal) lädt nach.
  const primedLiveKey = useRef<string | null>(null);

  const load = (key: string, query: Parameters<typeof fetchTranscript>[1]) => {
    loadedKey.current = key;
    emptyStartRef.current = false;
    olderControllerRef.current?.abort();
    olderControllerRef.current = null;
    setIsLoading(true);
    setIsError(false);
    setNewerAvailable(false);
    fetchTranscript(id as string, query)
      .then((res: TranscriptResponse) => {
        if (loadedKey.current !== key) return;
        setItems(res.items);
        setPrevCursor(res.prevCursor);
        setNextCursor(res.nextCursor);
        setAnchorIndex(res.anchorIndex ?? null);
        setArchivedAt(res.archivedAt);
      })
      .catch((e: unknown) => {
        if (loadedKey.current !== key) return;
        // 404 heißt „noch kein Archiv“ (z. B. gerade in der NyxOS gestartet) — kein Fehler,
        // sondern ein leerer Verlauf; das nächste Live-Signal füllt ihn.
        if (isNotFound(e) && query?.around === undefined) {
          emptyStartRef.current = true;
          setItems([]);
          setPrevCursor(null);
          setNextCursor(null);
          return;
        }
        setIsError(true);
        setError(e);
      })
      .finally(() => {
        if (loadedKey.current === key) setIsLoading(false);
      });
  };

  useEffect(() => {
    if (id === null) return;
    const key = `${id}:${subagent ?? ""}:${around ?? ""}`;
    const query =
      around !== null
        ? { around, limit: TRANSCRIPT_PAGE_LIMIT, subagent }
        : { direction: "backward" as const, limit: TRANSCRIPT_PAGE_LIMIT, subagent };
    load(key, query);
  }, [id, subagent, around]);

  // Live-Nachwachsen: lädt bei jedem `/live`-Signal DIESER Session
  // die JÜNGSTE Seite neu (kein Cursor — ein Cursor-basiertes "weiter vorn" bricht ab, sobald einmal
  // aufgeholt wurde, weil der Server dann `nextCursor: null` liefert) — ABER nur, wenn das aktuelle
  // Fenster ohnehin am Ende steht (`nextCursorRef.current === null`). Steht es das nicht (Such-
  // Sprung mitten im Verlauf), würde ein blindes Anhängen eine Lücke reißen — stattdessen nur
  // `newerAvailable` setzen; `jumpToLatest()` holt bewusst nach. Bekannte `id`s werden ERSETZT statt
  // ignoriert (ein Werkzeug-Status/eine Sub-Agent-Zählung, die erst später eintrifft, blieb
  // sonst dauerhaft veraltet). Prüft vor dem Übernehmen, ob zwischenzeitlich die Session gewechselt
  // wurde (`loadedKey`) und bricht eine noch laufende Anfrage beim Wechsel über `AbortController`
  // ab — eine verspätet eintreffende Antwort hängt so nie fremde Einträge an.
  useEffect(() => {
    if (id === null || liveTick === undefined) return;
    const primeKey = `${id}:${subagent ?? ""}`;
    if (primedLiveKey.current !== primeKey) {
      // Erster Lauf für diese Session: der aktuelle `liveTick` ist nur der Startwert, kein
      // echtes Signal — nichts nachladen (die Erstladung oben hat die Daten schon).
      primedLiveKey.current = primeKey;
      return;
    }
    if (nextCursorRef.current !== null) {
      setNewerAvailable(true);
      return;
    }
    const key = loadedKey.current;
    const controller = new AbortController();
    fetchTranscript(id, { direction: "backward", limit: TRANSCRIPT_PAGE_LIMIT, subagent }, controller.signal)
      .then((res: TranscriptResponse) => {
        if (loadedKey.current !== key) return; // Session zwischenzeitlich gewechselt
        setItems((prev) => mergeKnownAndAppend(prev, res.items));
        setNextCursor(res.nextCursor);
        // Ein erfolgreiches Nachladen heilt einen früheren Ladefehler.
        setIsError(false);
        setError(null);
        // Start ohne Archiv (404): erst mit dieser ersten echten Seite gibt es ältere Seiten zum Nachladen.
        if (emptyStartRef.current) {
          emptyStartRef.current = false;
          setPrevCursor(res.prevCursor);
        }
      })
      .catch(() => {
        // Live-Nachladen ist eine Zusatzfunktion — ein Fehler (oder ein Abbruch beim
        // Session-Wechsel) hier darf den Chat nicht kaputt machen.
      });
    return () => controller.abort();
  }, [id, subagent, liveTick]);

  const loadOlder = () => {
    if (id === null || prevCursor === null || loadingOlder) return;
    const key = loadedKey.current;
    setLoadingOlder(true);
    const controller = new AbortController();
    olderControllerRef.current = controller;
    fetchTranscript(id, { direction: "backward", cursor: prevCursor, limit: TRANSCRIPT_PAGE_LIMIT, subagent }, controller.signal)
      .then((res: TranscriptResponse) => {
        if (loadedKey.current !== key) return; // Session/Fenster zwischenzeitlich gewechselt
        setItems((prev) => {
          const known = new Set(prev.map((it) => it.id));
          return [...res.items.filter((it) => !known.has(it.id)), ...prev];
        });
        setPrevCursor(res.prevCursor);
      })
      .catch(() => {
        // Fehler beim Nachladen (oder Abbruch beim Wechsel): Nutzer kann es per erneutem
        // Hochscrollen wieder versuchen.
      })
      .finally(() => {
        if (olderControllerRef.current === controller) olderControllerRef.current = null;
        if (loadedKey.current === key) setLoadingOlder(false);
      });
  };

  const jumpToLatest = () => {
    if (id === null) return;
    load(`${id}:${subagent ?? ""}:`, { direction: "backward", limit: TRANSCRIPT_PAGE_LIMIT, subagent });
  };

  return {
    items,
    isLoading,
    isError,
    error,
    hasOlder: prevCursor !== null,
    loadingOlder,
    loadOlder,
    anchorIndex,
    archivedAt,
    newerAvailable,
    jumpToLatest,
  };
}
