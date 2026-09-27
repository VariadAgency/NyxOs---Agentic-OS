// Daten des Gehirns: einmal `/api/graph` laden, danach Deltas über eine eigene `/live`-Verbindung
// (nur solange ein Graph offen ist). Kein Neuaufbau im Browser, nur kleine Änderungen.
import { t, type GraphDeltaMessage, type GraphLocalResponse, type GraphResponse, type GraphStats } from "@nyxos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyDelta, type LiveGraph } from "./graphData";

export type GraphLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      graph: LiveGraph;
      stats: GraphStats;
      /** Knoten/Kanten hinzugekommen oder weg → Simulation neu füttern. */
      structureVersion: number;
      /** Nur Eigenschaften geändert (Zustand, Zeit, Grad) → nur neu filtern/zeichnen. */
      dataVersion: number;
    };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(res.status === 404 ? t("Nicht gefunden") : t("Server antwortet {status}", { status: res.status }));
  return (await res.json()) as T;
}

function subscribeGraphDeltas(onDelta: (d: GraphDeltaMessage) => void, onReconnect: () => void): () => void {
  if (typeof WebSocket === "undefined") return () => undefined;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let opened = false;
  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/live`);
    ws.onopen = () => {
      if (opened) onReconnect(); // nach Abbruch: evtl. verpasste Deltas → neu laden
      opened = true;
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as { type?: string };
        if (msg.type === "graph") onDelta(msg as GraphDeltaMessage);
      } catch {
        // fremde Nachricht
      }
    };
    ws.onclose = () => {
      if (!closed) retry = setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  };
}

/** Gesamtgraph (`include=files`, wenn Dateien eingeblendet sind). */
export function useGraph(includeFiles: boolean): GraphLoad & { reload: () => void } {
  const [state, setState] = useState<GraphLoad>({ status: "loading" });
  const graphRef = useRef<LiveGraph | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const includeRef = useRef(includeFiles);
  includeRef.current = includeFiles;
  /** Während eine Anfrage läuft, kommende Deltas puffern und danach anwenden. */
  const loadingRef = useRef(true);
  const bufferRef = useRef<GraphDeltaMessage[]>([]);

  const applyAndPublish = useCallback(
    (d: GraphDeltaMessage) => {
      const g = graphRef.current;
      if (!g) return;
      const r = applyDelta(g, d, { includeFiles: includeRef.current });
      if (r.status === "reload") reload();
      else if (r.status === "applied") {
        const structural = d.addNodes.length + d.removeNodes.length + d.addLinks.length + d.removeLinks.length > 0;
        setState((s) =>
          s.status === "ready"
            ? {
                ...s,
                graph: g,
                stats: { ...s.stats, nodes: g.nodes.length, links: g.links.length },
                structureVersion: s.structureVersion + (structural ? 1 : 0),
                dataVersion: s.dataVersion + 1,
              }
            : s,
        );
      }
    },
    [reload],
  );

  // Erst /live abonnieren, dann laden — so geht zwischen Antwort und Verbindung kein Delta verloren.
  useEffect(
    () =>
      subscribeGraphDeltas((d) => {
        if (loadingRef.current || !graphRef.current) {
          if (bufferRef.current.length < 500) bufferRef.current.push(d);
          return;
        }
        applyAndPublish(d);
      }, reload),
    [reload, applyAndPublish],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    const url = `/api/graph${includeFiles ? "?include=files" : ""}`;
    loadingRef.current = true;
    getJson<GraphResponse>(url, ctrl.signal)
      .then((res) => {
        // Positionen von vorhandenen Knoten übernehmen (Umschalten „Dateien" springt nicht).
        const prev = new Map((graphRef.current?.nodes ?? []).map((n) => [n.id, n]));
        const nodes = res.nodes.map((n) => {
          const p = prev.get(n.id);
          return p ? Object.assign(p, n) : { ...n };
        });
        const graph: LiveGraph = { version: res.version, nodes, links: res.links.map((l) => ({ ...l })) };
        graphRef.current = graph;
        setState((s) => ({ status: "ready", graph, stats: res.stats, structureVersion: (s.status === "ready" ? s.structureVersion : 0) + 1, dataVersion: (s.status === "ready" ? s.dataVersion : 0) + 1 }));
        loadingRef.current = false;
        // Gepufferte Deltas: ältere sind schon enthalten (stale), neuere werden angewendet.
        const buffered = bufferRef.current.sort((a, b) => a.version - b.version);
        bufferRef.current = [];
        for (const d of buffered) applyAndPublish(d);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        loadingRef.current = false;
        bufferRef.current = [];
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [includeFiles, nonce, applyAndPublish]);

  return { ...state, reload };
}

/** Lokaler Graph um einen Knoten (Tiefe 1–3), lädt bei Live-Änderungen gebündelt neu. */
export function useLocalGraph(nodeId: string | null, depth: number): GraphLoad & { center: string | null; reload: () => void } {
  const [state, setState] = useState<GraphLoad & { center: string | null }>({ status: "loading", center: null });
  const [nonce, setNonce] = useState(0);
  const graphRef = useRef<LiveGraph | null>(null);
  const sigRef = useRef("");

  useEffect(() => {
    if (!nodeId) return;
    const ctrl = new AbortController();
    getJson<GraphLocalResponse>(`/api/graph/local/${encodeURIComponent(nodeId)}?depth=${depth}`, ctrl.signal)
      .then((res) => {
        const prev = new Map((graphRef.current?.nodes ?? []).map((n) => [n.id, n]));
        const nodes = res.nodes.map((n) => {
          const p = prev.get(n.id);
          return p ? Object.assign(p, n) : { ...n };
        });
        const sig = `${nodes.map((n) => n.id).join("\n")}|${res.links.map((l) => `${l.kind}${l.source}${l.target}`).join("\n")}`;
        const same = sig === sigRef.current && graphRef.current !== null;
        sigRef.current = sig;
        const graph: LiveGraph = same && graphRef.current ? graphRef.current : { version: res.version, nodes, links: res.links.map((l) => ({ ...l })) };
        graph.version = res.version;
        graphRef.current = graph;
        setState((s) => ({
          status: "ready",
          graph,
          stats: res.stats,
          center: res.center,
          structureVersion: (s.status === "ready" ? s.structureVersion : 0) + (same ? 0 : 1),
          dataVersion: (s.status === "ready" ? s.dataVersion : 0) + 1,
        }));
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ status: "error", message: e instanceof Error ? e.message : String(e), center: null });
      });
    return () => ctrl.abort();
  }, [nodeId, depth, nonce]);

  // Nur neu laden, wenn ein Delta diesen lokalen Graphen berührt; gebündelt, aber spätestens nach
  // 4 s (sonst setzt Dauer-Aktivität den Timer immer wieder zurück).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstAt = 0;
    const fire = () => {
      timer = undefined;
      firstAt = 0;
      setNonce((n) => n + 1);
    };
    const bump = () => {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      clearTimeout(timer);
      timer = setTimeout(fire, now - firstAt > 4000 ? 0 : 1200);
    };
    const touches = (d: GraphDeltaMessage) => {
      const ids = new Set((graphRef.current?.nodes ?? []).map((n) => n.id));
      if (ids.size === 0) return true;
      return (
        d.updateNodes.some((n) => ids.has(n.id)) ||
        d.removeNodes.some((id) => ids.has(id)) ||
        d.addLinks.some((l) => ids.has(l.source) || ids.has(l.target)) ||
        d.removeLinks.some((l) => ids.has(l.source) || ids.has(l.target))
      );
    };
    const unsub = subscribeGraphDeltas((d) => {
      if (touches(d)) bump();
    }, bump);
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
