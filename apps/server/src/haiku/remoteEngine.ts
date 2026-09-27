// Haiku im eigenen Container `nyxos-agent`: Der API-Container hat kein claude-CLI.
// Ein Arbeiter-Prozess im Agent-Container (`haiku-worker.ts`) verbindet sich per WebSocket nach innen
// (`/haiku-worker`, Geheimnis im Unterprotokoll) und führt die Läufe mit dem echten CLI aus. Werkzeuge
// laufen unverändert über `/haiku-mcp` mit dem Einmal-Token – der Arbeiter bekommt keine DB, keinen
// Docker-Socket, nur diese zwei Wege.
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServerSpec, McpTool } from "../mcp/client.js";
import { parseUsageReport, usageReadings, type UsageReport } from "../usage/official.js";
import { ENGINE_REASON, type EngineAvailability, type EngineEvent, type EngineRequest, type HaikuEngine } from "./engine.js";
import { t } from "@nyxos/shared";

export const WORKER_PROTOCOL_PREFIX = "nyxos-worker.";

/** Was über die Leitung geht (ohne Funktionen/Signal). */
export type WorkerJob = Omit<EngineRequest, "callTool" | "signal" | "toolDefs">;
/** Befehls-Konnektoren (stdio) laufen im Agent-Container – der Test („Werkzeuge auflisten“) auch. */
export type ServerToWorker = { type: "job"; id: string; job: WorkerJob } | { type: "cancel"; id: string } | { type: "mcp_list"; id: string; spec: McpServerSpec };
export type WorkerToServer =
  | { type: "event"; id: string; event: EngineEvent }
  | { type: "end"; id: string; error: string | null; timeout?: boolean }
  | { type: "mcp_list_result"; id: string; tools: McpTool[] | null; error: string | null }
  // echte Claude-Nutzung von Anthropic (nur Zahlen, nie das Token), s. usage/official.ts.
  | UsageReport
  | WorkerHello;

/** Erste Nachricht des Arbeiters: welches CLI er hat und ob ein Token gesetzt ist (nie der Token selbst). */
export interface WorkerHello {
  type: "hello";
  version: string;
  /** Version von `claude --version`, `null` = Programm fehlt oder startet nicht. */
  cli?: string | null;
  /** true = CLAUDE_CODE_OAUTH_TOKEN ist im Agent-Container gesetzt. */
  token?: boolean;
}

export interface RemoteEngineOptions {
  /** Steht ein Token in der .env des Servers? Compose setzt NYXOS_HAIKU_TOKEN_SET=1 (`${CLAUDE_CODE_OAUTH_TOKEN:+1}`),
   * der Token selbst bleibt dem API-Container fern. Entscheidet, ob „kein Arbeiter“ heißt „wartet auf Token“ oder „Fehler“. */
  tokenConfigured?: boolean;
  /** Speicher für die echten Nutzungswerte (Standard: der eine im Prozess). */
  usage?: Pick<typeof usageReadings, "recordReport">;
}

export interface WorkerSocket {
  send(data: string): void;
  close(): void;
}

export function workerTokenOk(protocolHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret || !protocolHeader) return false;
  const offered = protocolHeader
    .split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith(WORKER_PROTOCOL_PREFIX));
  if (!offered) return false;
  const a = Buffer.from(offered.slice(WORKER_PROTOCOL_PREFIX.length));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Pending {
  push(e: EngineEvent): void;
  end(err: Error | null): void;
}

export class RemoteEngine implements HaikuEngine {
  readonly kind = "claude-cli" as const;
  private socket: WorkerSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly mcpPending = new Map<string, (r: { tools: McpTool[] | null; error: string | null }) => void>();
  private hello: WorkerHello | null = null;
  private readonly tokenConfigured: boolean;
  private readonly usage: Pick<typeof usageReadings, "recordReport">;
  connectedAt: string | null = null;

  constructor(opts: RemoteEngineOptions = {}) {
    this.tokenConfigured = opts.tokenConfigured ?? process.env.NYXOS_HAIKU_TOKEN_SET === "1";
    this.usage = opts.usage ?? usageReadings;
  }

  /** Wechselt bei jeder neuen Arbeiter-Verbindung (z. B. nach Neustart mit neuem Token). */
  get epoch(): string | null {
    return this.connectedAt;
  }

  attach(socket: WorkerSocket): void {
    this.socket?.close();
    this.socket = socket;
    this.hello = null;
    this.connectedAt = new Date().toISOString();
  }

  detach(socket: WorkerSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.hello = null;
    this.connectedAt = null;
    for (const p of this.pending.values()) p.end(new Error(t("Agent-Container getrennt")));
    this.pending.clear();
    for (const done of this.mcpPending.values()) done({ tools: null, error: t("Der Nyx-Motor wurde getrennt – bitte nochmal testen.") });
    this.mcpPending.clear();
  }

  /** Liefert `"hello"`, wenn sich damit der Motor-Zustand geändert haben kann (Aufrufer stößt dann die Oberfläche an). */
  onMessage(raw: string): "hello" | null {
    let msg: WorkerToServer;
    try {
      msg = JSON.parse(raw) as WorkerToServer;
    } catch {
      return null;
    }
    if (msg.type === "hello") {
      this.hello = msg;
      return "hello";
    }
    if (msg.type === "usage") {
      // auch von der (angemeldeten) Arbeiter-Leitung nur geprüfte Werte übernehmen.
      const report = parseUsageReport(msg);
      if (report) this.usage.recordReport(report);
      return null;
    }
    if (msg.type === "mcp_list_result") {
      const done = this.mcpPending.get(msg.id);
      this.mcpPending.delete(msg.id);
      done?.({ tools: msg.tools, error: msg.error });
      return null;
    }
    if (msg.type === "event") this.pending.get(msg.id)?.push(msg.event);
    else if (msg.type === "end") {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      p?.end(msg.error ? Object.assign(new Error(msg.error), { timeout: msg.timeout === true }) : null);
    }
    return null;
  }

  /** Werkzeuge eines Befehls-Konnektors im Agent-Container auflisten (Test-Knopf). */
  mcpListTools(spec: McpServerSpec, timeoutMs = 90_000): Promise<McpTool[]> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(t("Der Nyx-Motor auf dem Server läuft gerade nicht – Befehle lassen sich erst testen, wenn er läuft.")));
    const id = randomUUID();
    return new Promise<McpTool[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.mcpPending.delete(id)) reject(new Error(t("Keine Antwort in der Zeit – startet der Befehl zu langsam?")));
      }, timeoutMs);
      this.mcpPending.set(id, (r) => {
        clearTimeout(timer);
        if (r.tools) resolve(r.tools);
        else reject(new Error(r.error ?? t("Der Test hat nicht geklappt.")));
      });
      socket.send(JSON.stringify({ type: "mcp_list", id, spec } satisfies ServerToWorker));
    });
  }

  async available(): Promise<EngineAvailability> {
    if (!this.socket) {
      return this.tokenConfigured
        ? { ok: false, state: "error", reason: t(ENGINE_REASON.notConnected), model: null }
        : { ok: false, state: "waiting_token", reason: t(ENGINE_REASON.waitingToken), model: null };
    }
    const h = this.hello;
    // Ältere Arbeiter (ohne cli/token im Hallo) gelten wie bisher als bereit.
    if (h && h.cli === null) return { ok: false, state: "error", reason: t(ENGINE_REASON.cliMissingRemote), model: null, version: null };
    if (h && h.token === false) return { ok: false, state: "waiting_token", reason: t(ENGINE_REASON.waitingToken), model: null, version: h.cli ?? null };
    return { ok: true, state: "ready", reason: null, model: "haiku", version: h?.cli ?? null };
  }

  async *run(req: EngineRequest): AsyncIterable<EngineEvent> {
    const socket = this.socket;
    if (!socket) throw new Error(t("Agent-Container nicht verbunden"));
    const id = randomUUID();
    const queue: EngineEvent[] = [];
    let done = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    this.pending.set(id, {
      push: (e) => {
        queue.push(e);
        wake?.();
      },
      end: (err) => {
        failure = err;
        done = true;
        wake?.();
      },
    });
    const { callTool: _c, signal, toolDefs: _t, ...job } = req;
    const onAbort = () => socket.send(JSON.stringify({ type: "cancel", id } satisfies ServerToWorker));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.send(JSON.stringify({ type: "job", id, job } satisfies ServerToWorker));
    try {
      while (true) {
        if (queue.length) {
          yield queue.shift() as EngineEvent;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      if (failure) {
        const f = failure as Error & { timeout?: boolean };
        if (f.timeout) {
          const { EngineTimeoutError } = await import("./engine.js");
          throw new EngineTimeoutError(req.timeoutMs);
        }
        throw f;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
    }
  }
}
