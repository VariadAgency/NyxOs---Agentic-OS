// `GET /api/connections` — alle Verbindungen der NyxOS echt geprüft, mit Antwortzeit.
// Ergebnis 30 s zwischengespeichert (die Einstellungs-Seite fragt regelmäßig), `?fresh=1` prüft neu —
// aber höchstens alle 10 s (sonst wäre `?fresh=1` ein Last-Hebel ohne Anmeldung: jeder Lauf öffnet
// eine DB-Verbindung zum Dashboard, fragt die Brücke auf dem Rechner und legt eine Probe-Anmeldung an).
// Gleichzeitige Anfragen teilen sich denselben laufenden Prüflauf.
import { BRIDGE_CAP_SETUP, getLang, SETUP_RPC_STATE, SetupStateSchema, type AppMode, type ConnectionsReport, type Lang, type SetupState } from "@nyxos/shared";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { checkHealth } from "../health.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { defaultConnectionChecks, findBinInPath, type ConnectionsContext, type HealthResult } from "./checks.js";
import { checksForMode, DEFAULT_CONNECTION_TIMEOUT_MS, runConnectionChecks, type CheckDef } from "./runner.js";

export const CONNECTIONS_CACHE_MS = 30_000;
/** Mindestabstand zwischen zwei erzwungenen Läufen (`?fresh=1`). */
export const CONNECTIONS_FRESH_MIN_MS = 10_000;

export interface ConnectionsRouteOptions {
  /** Betriebsart (lokal: ein Rechner, keine Server-Technik). Ohne Angabe: Server-Modus mit allen Prüfungen. */
  mode?: AppMode;
  /** Zwischenspeicher-Dauer (Default 30 s). */
  cacheMs?: number;
  /** Zeitlimit je Prüfung (Default 4 s, einzelne Prüfungen legen eigene fest). */
  timeoutMs?: number;
  /** Tests: eigene Prüfungen statt der echten Liste. */
  checks?: CheckDef<ConnectionsContext>[];
  /** Tests: einzelne Kontext-Teile ersetzen (Netz, Ideen-DB, PATH, Umgebung, Uhr). */
  overrides?: Partial<Pick<ConnectionsContext, "fetch" | "findBin" | "env" | "now" | "worker" | "bridge" | "haiku">>;
}

export interface ConnectionsRouteDeps extends ConnectionsRouteOptions {
  db: Db;
  archiveDir: string;
  bridgeHub: BridgeHub;
  haiku: ConnectionsContext["haiku"];
  worker: ConnectionsContext["worker"];
  /** Anfrage an die eigene App, ohne Netz (CSRF-Probe). */
  selfFetch: (req: Request) => Response | Promise<Response>;
  /** Zustand des Telegram-Bots. */
  telegram?: ConnectionsContext["telegram"];
  /** Lokales Stimmen-Paket (lokaler Modus). */
  voice?: ConnectionsContext["voice"];
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

export function registerConnectionsRoutes(app: Hono<Env>, deps: ConnectionsRouteDeps): void {
  const cacheMs = deps.cacheMs ?? CONNECTIONS_CACHE_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const mode: AppMode = deps.mode ?? "server";
  const checks = checksForMode(deps.checks ?? defaultConnectionChecks(), mode);
  const o = deps.overrides ?? {};
  const now = o.now ?? Date.now;
  let cache: { at: number; lang: Lang; report: Omit<ConnectionsReport, "cached"> } | null = null;
  let inflight: Promise<Omit<ConnectionsReport, "cached">> | null = null;

  const runAll = (requestHost: string | null, requestProto: "http" | "https") => {
    const env = o.env ?? process.env;
    const bridge = o.bridge ?? deps.bridgeHub;
    const ctx: ConnectionsContext = {
      db: deps.db,
      archiveDir: deps.archiveDir,
      env,
      bridge,
      haiku: o.haiku !== undefined ? o.haiku : deps.haiku,
      worker: o.worker !== undefined ? o.worker : deps.worker,
      // Ohne Host-Kopf (wie `app.request` in Tests): die Host-Prüfung greift nur bei echtem Transport.
      selfRequest: async (path, init) => deps.selfFetch(new Request(`http://localhost${path}`, init)),
      requestHost,
      requestProto,
      fetch: o.fetch ?? fetch,
      now,
      findBin: o.findBin ?? ((name) => findBinInPath(name, env)),
      health: once<HealthResult>(() => checkHealth(deps.db, deps.archiveDir, { timeoutMs })),
      bridgeStatus: once(() => bridge.rpc("status", {}, 3000)),
      bridgeSetup: once(async (): Promise<SetupState | null> => {
        if (!bridge.status().online || (bridge.supports && !bridge.supports(BRIDGE_CAP_SETUP))) return null;
        const r = await bridge.rpc(SETUP_RPC_STATE, {}, 3000);
        const parsed = r.ok ? SetupStateSchema.safeParse(r.result) : null;
        return parsed?.success ? parsed.data : null;
      }),
      telegram: deps.telegram ?? null,
      voice: deps.voice ?? null,
      mode,
    };
    return runConnectionChecks(checks, ctx, { timeoutMs, now }).then((report) => ({ ...report, mode }));
  };

  app.get("/api/connections", async (c) => {
    const fresh = c.req.query("fresh") === "1";
    // Nach einem Sprachwechsel nicht den Bericht in der alten Sprache ausliefern.
    const age = cache && cache.lang === getLang() ? now() - cache.at : Infinity;
    if (age < (fresh ? Math.min(CONNECTIONS_FRESH_MIN_MS, cacheMs) : cacheMs) && cache) return c.json({ ...cache.report, cached: true } satisfies ConnectionsReport);
    if (!inflight) {
      const proto = c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:" ? "https" : "http";
      inflight = runAll(c.req.header("host") ?? null, proto).finally(() => {
        inflight = null;
      });
    }
    const report = await inflight;
    cache = { at: now(), lang: getLang(), report };
    return c.json({ ...report, cached: false } satisfies ConnectionsReport);
  });
}
