// Abruf der Session-Seitenpanels. Eigene Datei statt `lib/api.ts`.
import {
  t,
  type SessionAgentDetail,
  type SessionAgentsResponse,
  type SessionChangesResponse,
  type SessionFileChangesResponse,
  type SessionOutcomesResponse,
} from "@nyxos/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t("Server antwortet mit {status}", { status: res.status }));
  return (await res.json()) as T;
}

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;
/** Ein Panel darf sich 20 s lang auf den geladenen Stand verlassen (der Digest ändert sich nur mit dem Archiv). */
const STALE_MS = 20_000;

export function useSessionChanges(sessionId: string, query = "") {
  const q = query.trim();
  return useQuery({
    queryKey: ["session-panels", sessionId, "changes", q],
    queryFn: () => getJson<SessionChangesResponse>(`${base(sessionId)}/changes${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    staleTime: STALE_MS,
    // Beim Tippen bleibt die alte Trefferliste stehen, bis die neue da ist (kein Flackern).
    placeholderData: keepPreviousData,
  });
}

/** `agent`: nur die Änderungen eines Sub-Agenten (`"main"` = nur die Haupt-Session). */
export function useFileChanges(sessionId: string, path: string | null, agent: string | null = null) {
  return useQuery({
    queryKey: ["session-panels", sessionId, "file", path, agent],
    queryFn: () => getJson<SessionFileChangesResponse>(`${base(sessionId)}/changes/file?path=${encodeURIComponent(path ?? "")}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`),
    enabled: path !== null,
    staleTime: STALE_MS,
  });
}

export function useSessionAgents(sessionId: string) {
  return useQuery({
    queryKey: ["session-panels", sessionId, "agents"],
    queryFn: () => getJson<SessionAgentsResponse>(`${base(sessionId)}/agents`),
    staleTime: STALE_MS,
  });
}

export function useSessionAgent(sessionId: string, agentId: string | null) {
  return useQuery({
    queryKey: ["session-panels", sessionId, "agent", agentId],
    queryFn: () => getJson<SessionAgentDetail>(`${base(sessionId)}/agents/${encodeURIComponent(agentId ?? "")}`),
    enabled: agentId !== null,
    staleTime: STALE_MS,
  });
}

export function useSessionOutcomes(sessionId: string) {
  return useQuery({
    queryKey: ["session-panels", sessionId, "outcomes"],
    queryFn: () => getJson<SessionOutcomesResponse>(`${base(sessionId)}/outcomes`),
    staleTime: STALE_MS,
  });
}
