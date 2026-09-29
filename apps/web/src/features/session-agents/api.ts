// Fetching the agents of a session. Keys under ["session", id, …]: `useLiveSocket` invalidates exactly this prefix on
// every live signal of this session — new events of a sub-agent reload the list right away. Codex teammates send
// their signals under their OWN session id → for that `subscribeLiveTick` here as well.
import type { SessionAgentLiveDetail, SessionAgentsLiveResponse } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getJson, postJson } from "../../lib/http";
import { subscribeLiveTick } from "../../lib/liveBus";

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;
export const agentsLiveKey = (sessionId: string) => ["session", sessionId, "agents-live"] as const;
export const agentLiveKey = (sessionId: string, agentId: string | null) => ["session", sessionId, "agent-live", agentId] as const;

/** While an agent runs, ask even without a signal: "running" also ends by silence (no event). */
const RUNNING_POLL_MS = 15_000;
const DETAIL_POLL_MS = 5_000;

/**
 * Live signals: `useLiveSocket` already invalidates the prefix ["session", id] on signals of THIS session. In addition
 * via `subscribeLiveTick` here — for Codex teammates (signals under their own session id) and so the view does not
 * silently depend on how the socket picks its keys. TanStack Query bundles duplicate triggers.
 */
function useLiveRefetch(sessionId: string, childKeys: string[] | undefined, queryKey: readonly unknown[]) {
  const qc = useQueryClient();
  const joined = [sessionId, ...(childKeys ?? [])].join("\n");
  const keyJson = JSON.stringify(queryKey);
  useEffect(() => {
    const watched = new Set(joined.split("\n"));
    const key = JSON.parse(keyJson) as unknown[];
    return subscribeLiveTick((ids) => {
      if (ids && ![...ids].some((id) => watched.has(id))) return;
      void qc.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
    });
  }, [joined, keyJson, qc]);
}

/** Unexpected answer (e.g. an older server version during an update) → empty view instead of a crash. */
function normalizeLive(raw: unknown): SessionAgentsLiveResponse {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<SessionAgentsLiveResponse>;
  return {
    agents: Array.isArray(o.agents) ? o.agents : [],
    runs: Array.isArray(o.runs) ? o.runs : [],
    currentRunId: typeof o.currentRunId === "string" ? o.currentRunId : null,
    childKeys: Array.isArray(o.childKeys) ? o.childKeys : [],
    now: typeof o.now === "string" ? o.now : new Date().toISOString(),
  };
}

export function useSessionAgentsLive(sessionId: string) {
  const q = useQuery({
    queryKey: agentsLiveKey(sessionId),
    queryFn: async () => normalizeLive(await getJson<unknown>(`${base(sessionId)}/agents-live`)),
    staleTime: 3_000,
    refetchInterval: (query) => (query.state.data?.agents.some((a) => a.status === "running") ? RUNNING_POLL_MS : false),
  });
  useLiveRefetch(sessionId, q.data?.childKeys, agentsLiveKey(sessionId));
  return q;
}

export function useSessionAgentLive(sessionId: string, agentId: string | null, childKeys?: string[]) {
  const q = useQuery({
    queryKey: agentLiveKey(sessionId, agentId),
    queryFn: () => getJson<SessionAgentLiveDetail>(`${base(sessionId)}/agents-live/${encodeURIComponent(agentId ?? "")}`),
    enabled: agentId !== null,
    staleTime: 2_000,
    refetchInterval: (query) => (query.state.data?.agent.status === "running" ? DETAIL_POLL_MS : false),
  });
  useLiveRefetch(sessionId, childKeys, agentLiveKey(sessionId, agentId));
  return q;
}

export function useHideAgent(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, hidden }: { agentId: string; hidden: boolean }) => postJson<{ ok: true; hidden: boolean }>(`${base(sessionId)}/agents/${encodeURIComponent(agentId)}/hide`, { hidden }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["session", sessionId] }),
  });
}

export function useAgentToTask(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => postJson<{ entry: { id: number; title: string; href: string }; existing: boolean }>(`${base(sessionId)}/agents/${encodeURIComponent(agentId)}/task`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["session", sessionId] });
      void qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });
}

/** Clock for ticking elapsed times: only while `active` (else no timer, no needless re-renders). */
export function useNow(active: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
