// Arbeiter im Container `nyxos-agent`: verbindet sich zur API (`/haiku-worker`) und führt
// Haiku-Läufe mit dem offiziellen claude-CLI aus (Anmeldung: CLAUDE_CODE_OAUTH_TOKEN aus `claude setup-token`).
// Start im Container: `node dist/haiku-worker.js`. Kein DB-Zugang, kein Docker-Socket.
import { ClaudeCliEngine } from "./haiku/claudeCli.js";
import type { HaikuEngine } from "./haiku/engine.js";
import { listMcpTools } from "./mcp/client.js";
import { startUsagePoller, type FetchLike } from "./usage/official.js";
import { WORKER_PROTOCOL_PREFIX, type ServerToWorker, type WorkerToServer } from "./haiku/remoteEngine.js";

export interface WorkerOptions {
  url: string;
  secret: string;
  engine: HaikuEngine;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  WebSocketImpl?: typeof WebSocket;
  /** Ist ein Token gesetzt? Standard: CLAUDE_CODE_OAUTH_TOKEN in der Umgebung. Nur ja/nein geht über die Leitung. */
  tokenSet?: boolean;
  /** echte Claude-Nutzung abfragen (alle 5 Min, kostenlos). Standard an; Tests schalten ab oder geben fetch vor. */
  usagePoll?: false | { fetchImpl?: FetchLike; token?: () => string | undefined };
}

/** Verbindet sich und hält die Verbindung (Wiederverbindung mit Pause). Liefert eine Stopp-Funktion. */
export function runWorker(o: WorkerOptions): () => void {
  const WS = o.WebSocketImpl ?? WebSocket;
  const log = o.log ?? (() => {});
  let stopped = false;
  let ws: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;
  const jobs = new Map<string, AbortController>();
  let stopPoller: (() => void) | null = null;

  const connect = () => {
    if (stopped) return;
    ws = new WS(o.url, [`${WORKER_PROTOCOL_PREFIX}${o.secret}`]);
    const send = (m: WorkerToServer) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
    ws.onopen = () => {
      // ehrlicher Zustand für die Anzeige – CLI-Version (oder null) und „Token gesetzt ja/nein“.
      void (async () => {
        const a = await o.engine.available().catch(() => null);
        const cli = a?.ok ? (a.version ?? "?") : null;
        const token = o.tokenSet ?? Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
        log("arbeiter-verbunden", { cli, token });
        send({ type: "hello", version: "r1", cli, token });
        // echte Limits von Anthropic. Einmal je Prozess starten; gesendet wird nur bei offener Leitung,
        // und nur Zahlen bzw. die Fehlerart — das Token verlässt diesen Container nie.
        if (o.usagePoll !== false && !stopPoller && token) {
          const poll = o.usagePoll || {};
          stopPoller = startUsagePoller({
            token: poll.token ?? (() => process.env.CLAUDE_CODE_OAUTH_TOKEN),
            send: (r) => {
              if (ws?.readyState === 1) ws.send(JSON.stringify(r));
            },
            log,
            ...(poll.fetchImpl ? { fetchImpl: poll.fetchImpl } : {}),
          });
        }
      })();
    };
    ws.onmessage = (evt) => {
      let msg: ServerToWorker;
      try {
        msg = JSON.parse(String(evt.data)) as ServerToWorker;
      } catch {
        return;
      }
      if (msg.type === "cancel") {
        jobs.get(msg.id)?.abort();
        return;
      }
      if (msg.type === "mcp_list") {
        // Befehls-Konnektor hier im Agent-Container starten und Werkzeuge auflisten (Test-Knopf).
        const { id, spec } = msg;
        void listMcpTools(spec, { timeoutMs: 60_000 }).then(
          (tools) => send({ type: "mcp_list_result", id, tools, error: null }),
          (e: unknown) => send({ type: "mcp_list_result", id, tools: null, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
      const { id, job } = msg;
      const ctrl = new AbortController();
      jobs.set(id, ctrl);
      void (async () => {
        try {
          for await (const event of o.engine.run({ ...job, signal: ctrl.signal, toolDefs: [], callTool: async () => ({ fehler: "nur über MCP" }) })) send({ type: "event", id, event });
          send({ type: "end", id, error: null });
        } catch (e) {
          const timeout = e instanceof Error && e.constructor.name === "EngineTimeoutError";
          send({ type: "end", id, error: e instanceof Error ? e.message : String(e), timeout });
        } finally {
          jobs.delete(id);
        }
      })();
    };
    ws.onclose = () => {
      for (const c of jobs.values()) c.abort();
      jobs.clear();
      if (!stopped) retry = setTimeout(connect, 3000);
    };
    ws.onerror = () => log("arbeiter-verbindungsfehler");
  };
  connect();
  return () => {
    stopped = true;
    stopPoller?.();
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

if (process.argv[1] && /haiku-worker\.(ts|js)$/.test(process.argv[1])) {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Umgebungsvariable ${k} fehlt`);
    return v;
  };
  const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
  runWorker({
    url: need("NYXOS_WORKER_URL"),
    secret: need("NYXOS_WORKER_TOKEN"),
    engine: new ClaudeCliEngine({ apiUrl: need("NYXOS_API_URL") }),
    log,
  });
}
