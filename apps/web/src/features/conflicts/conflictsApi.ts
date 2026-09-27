// Aufrufe der Konflikte-Seite. Lesen: kleine Zusammenfassung + Details seitenweise
// (der Server antwortet mit ETag, der Browser fragt dann nur noch „geändert?“). Schreiben über die
// vorhandene Hülle `writeJson` aus `lib/api.ts` (CSRF-Kopf, Anmeldung) — unverändert benutzt.
import { t, type ConflictEntriesPage, type ConflictsSummary, type DecisionDismissal, type FileChangesResponse, type GitCompareResponse, type Reservation } from "@nyxos/shared";
import { ApiError, writeJson } from "../../lib/api";

/** GET mit der Fehlermeldung des Servers (z. B. „Die Brücke ist gerade nicht verbunden …“). */
async function getWithMessage<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // kein JSON
    }
    throw new ApiError(detail || t("Server antwortet mit {status}", { status: res.status }), res.status);
  }
  return (await res.json()) as T;
}

export const fetchConflictSummary = (signal?: AbortSignal) => getWithMessage<ConflictsSummary>("/api/conflicts/summary", signal);

export interface EntriesQuery {
  group?: string;
  q?: string;
  path?: string;
  offset?: number;
  limit?: number;
}

export function fetchConflictEntries(query: EntriesQuery, signal?: AbortSignal): Promise<ConflictEntriesPage> {
  const p = new URLSearchParams();
  if (query.group) p.set("group", query.group);
  if (query.q) p.set("q", query.q);
  if (query.path) p.set("path", query.path);
  p.set("offset", String(query.offset ?? 0));
  p.set("limit", String(query.limit ?? 50));
  return getWithMessage<ConflictEntriesPage>(`/api/conflicts/entries?${p.toString()}`, signal);
}

export function fetchFileChanges(path: string, sessionKeys: string[], signal?: AbortSignal): Promise<FileChangesResponse> {
  const p = new URLSearchParams({ path, sessions: sessionKeys.join(",") });
  return getWithMessage<FileChangesResponse>(`/api/conflicts/file-changes?${p.toString()}`, signal);
}

export function fetchGitCompare(path: string, from: string | null, to: string | null, signal?: AbortSignal): Promise<GitCompareResponse> {
  const p = new URLSearchParams({ path });
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return getWithMessage<GitCompareResponse>(`/api/conflicts/compare?${p.toString()}`, signal);
}

export const dismissDecision = (key: string, status: DecisionDismissal) => writeJson<{ ok: true }>("POST", "/api/conflicts/decisions/dismiss", { key, status });
export const reopenDecision = (key: string) => writeJson<{ ok: true }>("POST", "/api/conflicts/decisions/reopen", { key });
export const reserveDecision = (key: string) => writeJson<{ reservation: Reservation }>("POST", "/api/conflicts/decisions/reserve", { key });

export interface PreferResult {
  reservation: Reservation;
  notified: { sessionKey: string; sent: boolean; reason: string | null }[];
}
export const preferSession = (key: string, sessionKey: string) => writeJson<PreferResult>("POST", "/api/conflicts/decisions/prefer", { key, sessionKey });

export interface PauseResult {
  results: { sessionKey: string; paused: boolean; reason: string | null }[];
}
export const pauseSessions = (sessionKeys: string[]) => writeJson<PauseResult>("POST", "/api/conflicts/pause", { sessionKeys });
