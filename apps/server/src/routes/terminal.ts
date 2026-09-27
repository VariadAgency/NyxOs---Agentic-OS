// Terminal-Routen (eigene Datei, in app.ts nur eine Registrierungszeile).
//
// - `WS /bridge`            Brücke (Maschinen-Token), trägt Terminal-Kanäle und Befehle (RPC).
// - `WS /terminal/:id`      Browser-Terminal einer Session (Anmeldung nötig, s. terminal/auth.ts).
// - `POST /api/terminal/start`           neue Session in tmux starten.
// - `POST /api/sessions/:id/resume`      „In NyxOS fortsetzen" / „Neu starten" (`--resume`).
// - `POST /api/sessions/:id/kill`        „Prozess beenden" (mit Bestätigung in der Web-App).
// - `POST /api/sessions/:id/takeover/preview`  was hängt an der Session? (Daten für den Dialog)
// - `POST /api/sessions/:id/takeover`    „In der NyxOS übernehmen" (altes Fenster nur mit Freigabe beenden).
// - `GET  /api/terminal/status`          ist die Brücke verbunden?
// - `GET  /api/terminal/folders`         Ordner-Auswahl für „+ Neue Session".
// - Server-SSH (`/api/server/ssh*`, `WS /terminal/ssh/:name`) liegt in routes/server-ssh.ts.
import {
  KillRequestSchema,
  ResumeRequestSchema,
  StartRequestSchema,
  TakeoverRequestSchema,
  TermClientMsgSchema,
  TMUX_NAME_RE,
  codexFallbackContextWindow,
  pctToTokenLimit,
  type StartRequest,
  type StartResult,
  type TakeoverInfo,
  type TermServerMsg,
  type Tool, t } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { Db } from "../db/client.js";
import { entries, machines, sessions } from "../db/schema.js";
import { linkObjects } from "../entries/store.js";
import type { GraphService } from "../graph/service.js";
import { resolveForSession } from "../context-guard/store.js";
import type { LiveHub } from "../live.js";
import { recordStartedSession } from "../terminal/started.js";
import { registerServerSshRoutes } from "./server-ssh.js";
import { BridgeHub, type BridgeSocket, type TerminalChannel } from "../terminal/bridgeHub.js";
import { classifyClose, HeartbeatWatch, PING_EVERY_MS, type BridgePresence, type PingableSocket } from "../bridge/presence.js";

/**
 * Kontext-Wächter: für Sessions, die die NyxOS selbst startet (P3 "Starten"/"Fortsetzen"),
 * eine Auto-Compact-Grenze im Werkzeug selbst setzen (Erzwingen-Schwelle) — zusätzlich zum
 * laufenden `/compact`-Erzwingen aus `context-guard/tick.ts` (das trifft nur schon laufende
 * Sessions). Liefert `null`/`{}`, wenn Erzwingen abgeschaltet ist — dann bleibt das Werkzeug beim
 * eigenen Standardverhalten. Codex braucht eine Token-Zahl statt Prozent (`codexFallbackContextWindow`,
 * Übergangslösung bis P6s echte, teils live gemeldete Fenstergrößen in main sind, s. Bericht).
 */
async function resolveAutoCompactStart(db: Db, tool: Tool, model: string | null): Promise<{ env: Record<string, string> | null; args: string[] | null }> {
  const thresholds = await resolveForSession(db, { sessionKey: null, model, isHaiku: false });
  if (!thresholds.erzwingenEnabled || thresholds.erzwingenPct === null) return { env: null, args: null };
  if (tool === "claude") return { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(thresholds.erzwingenPct) }, args: null };
  const window = codexFallbackContextWindow(model);
  if (window === null) return { env: null, args: null }; // unbekanntes Modell/Fenster → nie geraten
  return { env: null, args: ["-c", `model_auto_compact_token_limit=${pctToTokenLimit(thresholds.erzwingenPct, window)}`] };
}

export interface TerminalRouteDeps {
  db: Db;
  hub: LiveHub;
  bridgeHub: BridgeHub;
  /** Anwesenheit der Brücke (Statuszeile, Verlauf). */
  bridgePresence: BridgePresence;
  /** Ping-Takt des Brücken-Kanals (Standard 15 s, Tests kürzer). */
  bridgePingMs?: number;
  // Roh-Socket von @hono/node-ws ist ein `ws`-WebSocket; wir brauchen nur `bufferedAmount`.
  upgradeWebSocket: UpgradeWebSocket<unknown>;
  hashToken: (t: string) => string;
  publish: (keys: Set<string>) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Aufgaben-Ansicht auffrischen, wenn eine Session an einem Auftrag startet. */
  graph?: Pick<GraphService, "markDirty">;
}

const RPC_STATUS: Record<string, 400 | 404 | 409 | 503 | 504> = {
  process_running: 409,
  process_changed: 409,
  process_stuck: 409,
  bad_folder: 400,
  not_found: 404,
  tmux_missing: 503,
  bridge_offline: 503,
  timeout: 504,
};

/** Satz für den Nutzer, wenn eine Session (noch) nicht in der NyxOS läuft — nie „tmux“. */
export const NOT_IN_NYXOS_MSG = "Diese Session läuft in einem eigenen Fenster auf dem Rechner. Damit du hier tippen kannst, übernimm sie in NyxOS.";

/** Fehler der Brücke in einfachen Worten (die Brücke meldet technisch, die Web-App zeigt diesen Text). */
const FRIENDLY_RPC_ERROR: Record<string, string> = {
  process_running: "Das alte Fenster arbeitet noch an dieser Session. Wähle „Altes Fenster beenden“ oder schließe es selbst, dann klappt es.",
  process_changed: "Am alten Fenster hat sich gerade etwas geändert. Bitte noch einmal auf „In NyxOS übernehmen“ klicken.",
  // D-c: SIGTERM kam an, aber das Programm lief weiter — die Brücke beendet nie hart.
  process_stuck: "Das alte Fenster ließ sich nicht sauber beenden. Schließ es bitte selbst auf dem Rechner und klick dann noch einmal auf „In NyxOS übernehmen“.",
  bad_folder: "Der Arbeitsordner dieser Session liegt nicht mehr im Projektordner (vielleicht gelöscht). Darum lässt sie sich nicht fortsetzen.",
  not_found: "Diese Session läuft gerade nirgends mehr, es gibt nichts zu beenden.",
  tmux_missing: "Auf dem Rechner fehlt das Terminal-Werkzeug von NyxOS. Die Brücke muss neu eingerichtet werden.",
  bridge_offline: "Der Rechner ist gerade nicht verbunden. Sobald die Brücke wieder da ist, klappt es.",
  timeout: "Der Rechner hat nicht rechtzeitig geantwortet. Bitte gleich noch einmal versuchen.",
};
const friendly = (code: string | undefined) => {
  const text = FRIENDLY_RPC_ERROR[code ?? ""];
  return text ? t(text) : t("Das hat auf dem Rechner nicht geklappt. Bitte gleich noch einmal versuchen.");
};

/** Übernehmen: altes Programm beenden (bis 8 s warten) + neu starten braucht länger als ein normaler Befehl. */
const TAKEOVER_RPC_TIMEOUT_MS = 30_000;

const TakeoverBodySchema = z.object({
  endPids: z.array(z.number().int().positive()).max(8).default([]),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});

async function findSession(db: Db, idOrUuid: string) {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db.select().from(sessions).where(where).limit(1);
  return row ?? null;
}

const clampInt = (v: string | undefined, min: number, max: number, dflt: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : dflt;
};

/**
 * (WICHTIG 2): SameSite=Strict schützt nicht vor einer Seite auf einem ANDEREN localhost-Port
 * (gleiche „Site"). Darum muss jeder Terminal-Handschlag einen Origin tragen, der genau zum Host passt.
 */
export const sameOriginOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  const host = c.req.header("host");
  const same = (() => {
    try {
      return !!origin && !!host && new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  })();
  if (!same) return c.json({ error: t("Origin passt nicht zum Host") }, 403);
  return next();
};

/** Modus + Feldgröße aus der Adresse des Handschlags (`?mode=rw&cols=…&rows=…`). Ohne `mode=rw`: nur ansehen. */
export function terminalQuery(c: Context<AppEnv>): { readOnly: boolean; cols: number; rows: number } {
  return {
    readOnly: c.req.query("mode") !== "rw",
    cols: clampInt(c.req.query("cols"), 20, 500, 120),
    rows: clampInt(c.req.query("rows"), 5, 200, 36),
  };
}

/** Wohin der Kanal andockt — oder warum nicht (Satz für den Nutzer, nie „tmux“). */
export type TerminalTarget = { tmuxName: string } | { status: "not_attachable"; msg: string };

/**
 * EIN Weg für jedes Browser-Terminal (Claude-/Codex-Session, Server-SSH): Ziel bestimmen, Brücke prüfen,
 * Kanal öffnen, Eingabe/Größe nur im Schreib-Modus weiterreichen.
 */
export function bridgeTerminalSocket(bridgeHub: BridgeHub, q: { readOnly: boolean; cols: number; rows: number }, resolveTarget: () => Promise<TerminalTarget>): WSEvents<unknown> {
  const { readOnly, cols, rows } = q;
  let channel: TerminalChannel | null = null;
  let closed = false;
  return {
    async onOpen(_evt, ws) {
      const send = (m: TermServerMsg) => {
        if (!closed) ws.send(JSON.stringify(m));
      };
      const target = await resolveTarget();
      if ("status" in target) {
        send({ t: "status", s: target.status, msg: target.msg });
        ws.close(4004, "not_attachable");
        return;
      }
      if (!bridgeHub.online) {
        send({ t: "status", s: "bridge_offline", msg: t("Brücke offline") });
        ws.close(4003, "bridge_offline");
        return;
      }
      const raw = ws.raw as { bufferedAmount?: number } | undefined;
      channel = bridgeHub.open(
        { tmuxName: target.tmuxName, cols, rows, readOnly },
        {
          send: (m) => send(m.t === "snapshot" ? { ...m, readOnly } : m),
          buffered: () => raw?.bufferedAmount ?? 0,
          close: () => {
            if (!closed) ws.close(1000);
          },
        },
      );
      if (!channel) {
        send({ t: "status", s: "bridge_offline", msg: t("Brücke offline") });
        ws.close(4003, "bridge_offline");
        return;
      }
      send({ t: "status", s: "connected" });
    },
    onMessage(evt, ws) {
      if (typeof evt.data !== "string") return;
      let parsed;
      try {
        parsed = TermClientMsgSchema.safeParse(JSON.parse(evt.data));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong", id: msg.id } satisfies TermServerMsg));
      else if (msg.t === "resize" && !readOnly) channel?.resize(msg.cols, msg.rows); // Zuschauer stellen nie die Größe für alle um
      else if (msg.t === "in" && !readOnly) channel?.input(msg.d);
    },
    onClose() {
      closed = true;
      channel?.close();
    },
  };
}

/**
 * Neue Session in tmux starten — EIN Weg für „+ Neue Session“ im Web und `/neu` in Telegram.
 * Claude bekommt die Session-ID vorab (`--session-id`) → die Session erscheint sofort in der Liste.
 */
export async function startTerminalSession(
  deps: Pick<TerminalRouteDeps, "db" | "bridgeHub" | "publish">,
  input: StartRequest,
  temporary: boolean,
): Promise<{ ok: true; started: StartResult; sessionKey: string | null } | { ok: false; error: string; code?: string }> {
  const { db, bridgeHub } = deps;
  const autoCompact = await resolveAutoCompactStart(db, input.tool, input.model);
  // `addDirs` nur für Skill-Aufträge des Servers (skills/jobs.ts), nie aus Browser oder Telegram.
  const r = await bridgeHub.rpc("start", { ...input, addDirs: null, autoCompactEnv: autoCompact.env, autoCompactArgs: autoCompact.args });
  if (!r.ok) return { ok: false, error: r.error ?? "Start fehlgeschlagen", code: r.code };
  const started = r.result as StartResult;
  // Codex erscheint erst mit seiner ersten Zeile (gemeinsamer Weg `recordStartedSession`).
  const key = await recordStartedSession(db, { started, cwd: input.cwd, machineId: bridgeHub.status().machineId, temporary });
  if (key) await deps.publish(new Set([key]));
  return { ok: true, started, sessionKey: key };
}

const EntryIdSchema = z.number().int().positive().max(2_147_483_647);

/**
 * Session am Auftrag festmachen (`startedSessionKey` + Verknüpfung „gestartet“). Die Stufe bleibt —
 * die setzt nur Reife-Check/Automatik. Dass es den Auftrag gibt, prüft die Route schon vor dem Start.
 */
async function linkStartedToEntry(deps: Pick<TerminalRouteDeps, "db" | "hub" | "graph">, entryId: number, sessionKey: string): Promise<void> {
  const [row] = await deps.db.update(entries).set({ startedSessionKey: sessionKey, updatedAt: new Date().toISOString() }).where(eq(entries.id, entryId)).returning({ id: entries.id });
  if (!row) return;
  await linkObjects(deps.db, { fromType: "entry", fromId: String(entryId), toType: "session", toId: sessionKey, relation: "gestartet", source: "nyxos" });
  deps.hub.broadcast({ type: "entry", entryId });
  deps.graph?.markDirty(["entries"]);
}

export function registerTerminalRoutes(app: Hono<AppEnv>, deps: TerminalRouteDeps): void {
  const { db, bridgeHub, upgradeWebSocket, log } = deps;

  // ── Brücke ────────────────────────────────────────────────────────────────────────────
  app.get(
    "/bridge",
    async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) return c.json({ error: t("Token fehlt") }, 401);
      const [m] = await db.select({ id: machines.id }).from(machines).where(eq(machines.tokenHash, deps.hashToken(token))).limit(1);
      if (!m) return c.json({ error: "Token unbekannt" }, 401);
      c.set("machineId", m.id);
      return next();
    },
    upgradeWebSocket((c) => {
      const machineId = c.get("machineId");
      const presence = deps.bridgePresence;
      let socket: BridgeSocket | null = null;
      let pingTimer: NodeJS.Timeout | null = null;
      let silent = false;
      return {
        onOpen(_evt, ws) {
          socket = { send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) };
          bridgeHub.attach(socket, machineId);
          presence.connected(machineId); // schreibt auch machines.last_seen_at
          log("bruecke-verbunden", { machineId });
          // Lebenszeichen über den offenen Kanal. Ping/Pong beantwortet jeder WebSocket-Client selbst —
          // auch eine noch nicht neu installierte Brücke. Vorher kam „zuletzt gesehen" nur aus HTTP-Ingest.
          const raw = ws.raw as Partial<PingableSocket> | undefined;
          if (raw && typeof raw.ping === "function" && typeof raw.on === "function" && typeof raw.terminate === "function") {
            const watch = new HeartbeatWatch(raw as PingableSocket, {
              now: () => presence.nowMs(),
              onBeat: () => presence.heartbeat(),
              lastBeat: () => presence.lastHeartbeatAt(),
              onSilent: () => {
                silent = true;
                log("bruecke-stumm", { machineId });
              },
            });
            pingTimer = setInterval(() => watch.tick(), deps.bridgePingMs ?? PING_EVERY_MS);
            pingTimer.unref();
          }
        },
        onMessage(evt) {
          presence.heartbeat();
          if (typeof evt.data === "string") bridgeHub.handle(evt.data);
          else if (evt.data instanceof ArrayBuffer) bridgeHub.handle(Buffer.from(evt.data).toString("utf8"));
        },
        onClose(evt) {
          if (pingTimer) clearInterval(pingTimer);
          const current = socket ? bridgeHub.detach(socket) : false;
          // Ersetzt durch eine neuere Verbindung → die Brücke ist weiter da, kein Wechsel.
          if (current) presence.disconnected(silent ? "silent" : classifyClose(evt.code));
          log("bruecke-getrennt", { machineId, code: evt.code, ersetzt: !current });
        },
      };
    }),
  );

  // ── Browser-Terminal ──────────────────────────────────────────────────────────────────────
  app.get(
    "/terminal/:id",
    sameOriginOnly,
    upgradeWebSocket((c) =>
      bridgeTerminalSocket(bridgeHub, terminalQuery(c), async () => {
        const session = await findSession(db, c.req.param("id") ?? "");
        if (!session || !session.tmuxName || !session.attachable || !TMUX_NAME_RE.test(session.tmuxName)) return { status: "not_attachable", msg: t(NOT_IN_NYXOS_MSG) };
        return { tmuxName: session.tmuxName };
      }),
    ),
  );

  // Server-SSH: Terminal zum eigenen Server (routes/server-ssh.ts, nur mit NYXOS_SERVER_SSH_HOST), gleicher Kanal-Weg wie oben.
  registerServerSshRoutes(app, { bridgeHub, upgradeWebSocket, log });

  // ── Steuerung ─────────────────────────────────────────────────────────────────────────────
  app.get("/api/terminal/status", (c) => c.json(bridgeHub.status()));

  app.get("/api/terminal/folders", async (c) => {
    const r = await bridgeHub.rpc("list_folders", {});
    if (!r.ok) return c.json({ error: r.error, code: r.code }, RPC_STATUS[r.code ?? ""] ?? 502);
    return c.json(r.result);
  });

  app.post("/api/terminal/start", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = StartRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültige Angaben"), issues: parsed.error.issues.slice(0, 5) }, 400);
    // Schalter „Temporär“ – bleibt beim Server (die Brücke muss davon nichts wissen).
    const temporary = typeof body === "object" && body !== null && (body as { temporary?: unknown }).temporary === true;
    // „Agent starten“ aus dem Aufgaben-Tab — die Session hängt danach am Auftrag. Bleibt beim Server.
    // vor dem Start prüfen — sonst läuft eine Session, die der Dialog „am Auftrag“ versprochen hat,
    // still ohne Auftrag. Ungültige Nummer → 400, unbekannter Auftrag → 404, beides ohne Start.
    const rawEntryId = typeof body === "object" && body !== null ? (body as { entryId?: unknown }).entryId : undefined;
    let entryId: number | null = null;
    if (rawEntryId !== undefined && rawEntryId !== null) {
      const p = EntryIdSchema.safeParse(rawEntryId);
      if (!p.success) return c.json({ error: t("Ungültige Auftrags-Nummer") }, 400);
      const [found] = await db.select({ id: entries.id }).from(entries).where(eq(entries.id, p.data)).limit(1);
      if (!found) return c.json({ error: t("Diesen Auftrag gibt es nicht mehr.") }, 404);
      entryId = p.data;
    }
    const r = await startTerminalSession(deps, parsed.data, temporary);
    if (!r.ok) return c.json({ error: r.error, code: r.code }, RPC_STATUS[r.code ?? ""] ?? 502);
    if (entryId !== null && r.sessionKey) {
      // Die Session läuft schon: ein Fehler beim Verknüpfen darf kein 500 werden (sonst startet der Nutzer doppelt).
      await linkStartedToEntry(deps, entryId, r.sessionKey).catch((e: unknown) => log("auftrag-verknuepfen-fehlgeschlagen", { entryId, error: String(e) }));
    }
    return c.json(r.started);
  });

  app.post("/api/sessions/:id/resume", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json({ error: "Nicht gefunden" }, 404);
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { cols?: unknown; rows?: unknown };
    const parsed = ResumeRequestSchema.safeParse({
      tool: session.tool,
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...(typeof body.cols === "number" ? { cols: body.cols } : {}),
      ...(typeof body.rows === "number" ? { rows: body.rows } : {}),
    });
    if (!parsed.success) return c.json({ error: t("Ungültige Angaben") }, 400);
    const autoCompact = await resolveAutoCompactStart(db, session.tool as Tool, session.models[session.models.length - 1] ?? null);
    const r = await bridgeHub.rpc("resume", { ...parsed.data, autoCompactEnv: autoCompact.env, autoCompactArgs: autoCompact.args });
    if (!r.ok) return c.json({ error: friendly(r.code), code: r.code }, RPC_STATUS[r.code ?? ""] ?? 502);
    const started = r.result as StartResult;
    const now = new Date().toISOString();
    await db
      .update(sessions)
      .set({ tmuxName: started.tmuxName, attachable: true, startedVia: "nyxos", terminalObservedAt: now, status: "running", stateObservedAt: now, updatedAt: sql`now()` })
      .where(eq(sessions.id, session.id));
    await deps.publish(new Set([session.id]));
    return c.json(started);
  });

  // ── „In der NyxOS übernehmen" ───────────────────────────────────────────────
  app.post("/api/sessions/:id/takeover/preview", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json({ error: t("Diese Session gibt es nicht (mehr).") }, 404);
    if (session.attachable && session.tmuxName && TMUX_NAME_RE.test(session.tmuxName)) return c.json({ attachable: true });
    const r = await bridgeHub.rpc("takeover_info", { tool: session.tool, sessionId: session.sessionId });
    if (!r.ok) return c.json({ error: friendly(r.code), code: r.code }, RPC_STATUS[r.code ?? ""] ?? 502);
    const info = r.result as TakeoverInfo;
    // Empfehlung (vorausgewählt, aber nie ohne Klick): arbeitet Claude/Codex gerade, lieber nichts
    // unterbrechen („nur mitlesen“); wartet die Session, ist „altes Fenster beenden“ das Sinnvolle.
    const working = session.state === "running";
    const recommended = info.inNyxOS || info.processes.length === 0 ? "resume" : working ? "watch" : "end_old";
    return c.json({ attachable: false, tool: session.tool, processes: info.processes, inNyxOS: info.inNyxOS, working, recommended });
  });

  app.post("/api/sessions/:id/takeover", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json({ error: t("Diese Session gibt es nicht (mehr).") }, 404);
    const body = TakeoverBodySchema.safeParse((await c.req.json().catch(() => null)) ?? {});
    if (!body.success) return c.json({ error: t("Ungültige Angaben") }, 400);
    const parsed = TakeoverRequestSchema.safeParse({
      tool: session.tool,
      sessionId: session.sessionId,
      cwd: session.cwd,
      endPids: body.data.endPids,
      ...(body.data.cols !== undefined ? { cols: body.data.cols } : {}),
      ...(body.data.rows !== undefined ? { rows: body.data.rows } : {}),
    });
    if (!parsed.success) return c.json({ error: t("Ungültige Angaben") }, 400);
    const autoCompact = await resolveAutoCompactStart(db, session.tool as Tool, session.models[session.models.length - 1] ?? null);
    const r = await bridgeHub.rpc("takeover", { ...parsed.data, autoCompactEnv: autoCompact.env, autoCompactArgs: autoCompact.args }, TAKEOVER_RPC_TIMEOUT_MS);
    if (!r.ok) return c.json({ error: friendly(r.code), code: r.code }, RPC_STATUS[r.code ?? ""] ?? 502);
    const started = r.result as StartResult;
    const now = new Date().toISOString();
    await db
      .update(sessions)
      .set({ tmuxName: started.tmuxName, attachable: true, startedVia: "nyxos", terminalObservedAt: now, status: "running", stateObservedAt: now, updatedAt: sql`now()` })
      .where(eq(sessions.id, session.id));
    await deps.publish(new Set([session.id]));
    log("session-uebernommen", { id: session.id, tmuxName: started.tmuxName, beendet: parsed.data.endPids.length });
    return c.json(started);
  });

  app.post("/api/sessions/:id/kill", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json({ error: "Nicht gefunden" }, 404);
    const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (body?.confirm !== true) return c.json({ error: t("Bestätigung fehlt") }, 400);
    const parsed = KillRequestSchema.safeParse({
      tool: session.tool as Tool,
      sessionId: session.sessionId,
      tmuxName: session.tmuxName && TMUX_NAME_RE.test(session.tmuxName) ? session.tmuxName : null,
    });
    if (!parsed.success) return c.json({ error: t("Ungültige Angaben") }, 400);
    const r = await bridgeHub.rpc("kill", parsed.data);
    if (!r.ok) return c.json({ error: r.error, code: r.code }, RPC_STATUS[r.code ?? ""] ?? 502);
    await db.update(sessions).set({ attachable: false, updatedAt: sql`now()` }).where(eq(sessions.id, session.id));
    await deps.publish(new Set([session.id]));
    return c.json(r.result ?? { ok: true });
  });
}
