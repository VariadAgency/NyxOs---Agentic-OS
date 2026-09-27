// Info-Karte: Details zu einem Knoten von `GET /api/graph/node/:id` — kurz zwischengespeichert,
// damit Hin- und Herklicken im lokalen Graphen sofort da ist.
import type { GraphNodeDetail } from "@nyxos/shared";
import { useEffect, useState } from "react";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; data: GraphNodeDetail }>();

export type NodeDetailState = { status: "idle" | "loading" } | { status: "ready"; data: GraphNodeDetail } | { status: "error" };

export function useNodeDetail(id: string | null): NodeDetailState {
  const [state, setState] = useState<NodeDetailState>({ status: "idle" });
  useEffect(() => {
    if (!id) {
      setState({ status: "idle" });
      return;
    }
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setState({ status: "ready", data: hit.data });
      return;
    }
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/graph/node/${encodeURIComponent(id)}`, { signal: ctrl.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as GraphNodeDetail;
        cache.set(id, { at: Date.now(), data });
        if (cache.size > 200) cache.delete(cache.keys().next().value ?? "");
        setState({ status: "ready", data });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, [id]);
  return state;
}
