// MCP-Anschluss "nyxos" — stdio-Server (`bridge.js mcp`), leitet an die
// Server-API weiter. Handgeschriebenes, minimales JSON-RPC 2.0 über stdio (MCP-Basisprotokoll:
// initialize/tools.list/tools.call), bewusst OHNE das `@modelcontextprotocol/sdk`-Paket — dieses
// Repo hat keinen npm-Registry-Zugriff aus der Sandbox heraus (pnpm-Lockfile ist eingefroren), das
// Protokoll für die drei gebrauchten Methoden ist aber klein genug, um es selbst robust zu
// implementieren (s. Bericht "Abweichungen").
//
// Session-Zuordnung (GOAL: "automatisch, nie vom Agenten behauptet"): Diese Datei liest NUR
// `process.env.NYXOS_MCP_SESSION_KEY` — kein Werkzeug-Schema unten nimmt eine sessionKey vom
// Modell entgegen. Die Umgebungsvariable wird vom vertrauenswürdigen Start-Prozess gesetzt (die
// tmux-Shell-Funktion aus P3 für manuell gestartete Sessions, `entries/start.ts` für den Ein-Klick-
// Start) — nie vom Agenten selbst. Fehlt sie (z. B. eine Session außerhalb von tmux), läuft der
// Aufruf trotzdem durch, nur ohne Session-Verknüpfung (`sessionKey: null`).
import { createInterface } from "node:readline";
import { t } from "@nyxos/shared";
import { loadConfig, paths } from "./config.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpToolContext {
  serverUrl: string;
  sessionKey: string | null;
  /** P4-Integration: Maschinen-Token (dieselbe Vertrauensstufe wie `/ingest/*`) — der MCP-Anschluss
   * läuft in einem eigenen Prozess ohne Browser-Cookie, `/api/entries/*` akzeptiert deshalb dieses
   * Bearer-Token statt einer Passkey-Sitzung (s. `terminal/auth.ts` `verifyMachineToken`). */
  machineToken?: string | null;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown>;
}

async function callApi(ctx: McpToolContext, method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = body !== undefined ? { "content-type": "application/json" } : {};
  if (ctx.machineToken) headers.authorization = `Bearer ${ctx.machineToken}`;
  const res = await fetch(`${ctx.serverUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`NyxOS-API ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const TOOLS: ToolDef[] = [
  {
    name: "eintrag_suchen",
    description: "Sucht Einträge (Bug/Aufgabe/Audit/Idee/Entscheidung/Frage/Problem) nach Text, Art oder Stufe.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Freitext-Suche in Titel/Beschreibung/Baustelle" },
        kind: { type: "string", enum: ["bug", "aufgabe", "audit", "idee", "entscheidung", "frage", "problem"] },
        stage: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      const qs = new URLSearchParams();
      if (typeof args.q === "string") qs.set("q", args.q);
      if (typeof args.kind === "string") qs.set("kind", args.kind);
      if (typeof args.stage === "string") qs.set("stage", args.stage);
      return callApi(ctx, "GET", `/api/entries?${qs.toString()}`);
    },
  },
  {
    name: "eintrag_lesen",
    description: "Liest die Großansicht-Daten eines Eintrags: Fakten, Teilaufgaben/Reife-Check, Verknüpfungen, Verlauf.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    handler: async (args, ctx) => callApi(ctx, "GET", `/api/entries/${Number(args.id)}`),
  },
  {
    name: "eintrag_anlegen",
    description: "Legt einen neuen Bug, eine Idee, eine Frage oder ein Problem an (keine 'aufgabe'/'audit' — die kommen nur aus dem Import).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["bug", "idee", "frage", "problem"] },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["p0", "p1", "p2", "p3"] },
        fileScope: { type: "array", items: { type: "string" } },
        subtasks: { type: "array", items: { type: "string" }, description: "Teilaufgaben-Titel, gleich mit anlegen" },
      },
      required: ["kind", "title"],
    },
    handler: async (args, ctx) => callApi(ctx, "POST", "/api/entries", { ...args, sessionKey: ctx.sessionKey }),
  },
  {
    name: "fortschritt_melden",
    description: "Meldet einen Fortschritts-Hinweis an einem Eintrag (Freitext-Notiz im Verlauf, hebt die Stufe automatisch auf 'läuft').",
    inputSchema: { type: "object", properties: { entryId: { type: "number" }, note: { type: "string" } }, required: ["entryId", "note"] },
    handler: async (args, ctx) => callApi(ctx, "POST", `/api/entries/${Number(args.entryId)}/progress`, { note: args.note, sessionKey: ctx.sessionKey }),
  },
  {
    name: "teilaufgabe_erledigt",
    description: "Markiert eine Teilaufgabe als erledigt (per subtaskId ODER subtaskTitle). Bewegt den Fortschrittsbalken automatisch.",
    inputSchema: {
      type: "object",
      properties: { entryId: { type: "number" }, subtaskId: { type: "number" }, subtaskTitle: { type: "string" } },
      required: ["entryId"],
    },
    handler: async (args, ctx) =>
      callApi(ctx, "POST", `/api/entries/${Number(args.entryId)}/subtasks/complete`, {
        subtaskId: args.subtaskId,
        subtaskTitle: args.subtaskTitle,
        sessionKey: ctx.sessionKey,
      }),
  },
  {
    name: "frage_stellen",
    description: "Legt eine offene Frage an den Nutzer an, optional mit Verweis auf den Eintrag, den sie blockiert.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, description: { type: "string" }, blocksEntryId: { type: "number" } },
      required: ["title"],
    },
    handler: async (args, ctx) => {
      const created = (await callApi(ctx, "POST", "/api/entries", {
        kind: "frage",
        title: args.title,
        description: args.description,
        sessionKey: ctx.sessionKey,
      })) as { entry: { id: number } };
      if (args.blocksEntryId) {
        await callApi(ctx, "POST", "/api/entries/link", {
          fromType: "entry",
          fromId: String(created.entry.id),
          toType: "entry",
          toId: String(args.blocksEntryId),
          relation: "blockiert",
        });
      }
      return created;
    },
  },
  {
    name: "verknuepfen",
    description: "Verknüpft zwei Objekte (Eintrag/Session/Datei/Commit/Dokument) mit einer benannten Beziehung.",
    inputSchema: {
      type: "object",
      properties: {
        fromType: { type: "string", enum: ["entry", "session", "file", "commit", "doc"] },
        fromId: { type: "string" },
        toType: { type: "string", enum: ["entry", "session", "file", "commit", "doc"] },
        toId: { type: "string" },
        relation: { type: "string" },
      },
      required: ["fromType", "fromId", "toType", "toId", "relation"],
    },
    handler: async (args, ctx) => callApi(ctx, "POST", "/api/entries/link", args),
  },
];

export function toolList() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export async function callTool(name: string, args: Record<string, unknown>, ctx: { serverUrl: string; sessionKey: string | null }) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(t("Unbekanntes Werkzeug: {name}", { name }));
  return tool.handler(args ?? {}, ctx);
}

function send(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** Startet den stdio-MCP-Server. `serverUrlOverride` nur für Tests (kein Server-Neustart nötig). */
export function runMcpServer(serverUrlOverride?: string) {
  const cfg = (() => {
    try {
      return loadConfig(paths().config);
    } catch {
      return null;
    }
  })();
  const serverUrl = serverUrlOverride ?? cfg?.serverUrl ?? "http://127.0.0.1:47801";
  const sessionKey = process.env.NYXOS_MCP_SESSION_KEY ?? null;
  const machineToken = cfg?.token ?? null;

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return; // kaputte Zeile ignorieren, MCP-Client sendet sonst nichts Ungültiges
    }
    void handle(req, { serverUrl, sessionKey, machineToken });
  });
}

async function handle(req: JsonRpcRequest, ctx: McpToolContext) {
  const respond = (result: unknown) => {
    if (req.id !== undefined && req.id !== null) send({ jsonrpc: "2.0", id: req.id, result });
  };
  const respondError = (message: string) => {
    if (req.id !== undefined && req.id !== null) send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message } });
  };
  try {
    switch (req.method) {
      case "initialize":
        respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nyxos", version: "0.1.0" } });
        return;
      case "notifications/initialized":
      case "initialized":
        return; // keine Antwort nötig (Notification)
      case "tools/list":
        respond({ tools: toolList() });
        return;
      case "tools/call": {
        const name = req.params?.name as string;
        const args = (req.params?.arguments as Record<string, unknown>) ?? {};
        const result = await callTool(name, args, ctx);
        respond({ content: [{ type: "text", text: JSON.stringify(result) }] });
        return;
      }
      case "ping":
        respond({});
        return;
      default:
        respondError(`Unbekannte Methode: ${req.method}`);
    }
  } catch (e) {
    respondError(e instanceof Error ? e.message : String(e));
  }
}
