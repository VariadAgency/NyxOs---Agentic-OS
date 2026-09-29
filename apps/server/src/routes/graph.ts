// PG „Gehirn": Graph-API + Vault-Einlesen. In `app.ts` nur eine Registrierungszeile.
import { GRAPH_NODE_TYPES, isGraphNodeType, VaultIngestSchema, type GraphNodeType, t } from "@nyxos/shared";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "../db/client.js";
import { entriesSource, type EntriesProvider } from "../graph/sources/entries.js";
import { gitSource, type GitProvider } from "../graph/sources/git.js";
import { sessionsSource } from "../graph/sources/sessions.js";
import { vaultSessionLinksSource, vaultSource } from "../graph/sources/vault.js";
import { nodeDetail } from "../graph/detail.js";
import { resolveCenter, type GraphService } from "../graph/service.js";
import { ingestVault } from "../graph/vault-store.js";
import type { GraphSource } from "../graph/build.js";

/** Optionale Quellen aus anderen Phasen — der Zusammenbau reicht sie über `AppDeps.graphProviders` herein. */
export interface GraphProviders {
  entries?: EntriesProvider;
  git?: GitProvider;
}

export function defaultGraphSources(db: Db, providers: GraphProviders = {}): GraphSource[] {
  const sources = [sessionsSource(db), vaultSource(db), vaultSessionLinksSource(db)];
  if (providers.entries) sources.push(entriesSource(providers.entries));
  if (providers.git) sources.push(gitSource(providers.git));
  return sources;
}

type Env = { Variables: { machineId: string } };

const DETAIL_TTL_MS = 30_000;
const DETAIL_CACHE_MAX = 300;

export interface GraphRouteDeps {
  db: Db;
  graph: GraphService;
  auth: MiddlewareHandler<Env>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export function registerGraphRoutes(app: Hono<Env>, { db, graph, auth, log }: GraphRouteDeps): void {
  app.post("/ingest/vault", auth, bodyLimit({ maxSize: 32 * 1024 * 1024 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = VaultIngestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiges Paket"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const outcome = await ingestVault(db, c.get("machineId"), parsed.data);
    log("vault", { mode: parsed.data.mode, notes: parsed.data.notes.length, deleted: outcome.deleted, done: parsed.data.done });
    if (outcome.upserted > 0 || outcome.deleted > 0) graph.markDirty(["vault", "vault-links"]);
    return c.json({ ok: true, ...outcome });
  });

  app.get("/api/graph", async (c) => {
    const typesRaw = c.req.query("types");
    let types: Set<GraphNodeType> | null = null;
    if (typesRaw) {
      const list = typesRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = list.filter((t) => !isGraphNodeType(t));
      if (bad.length > 0) return c.json({ error: t("Unbekannte Knotenart: {types}", { types: bad.join(", ") }), known: GRAPH_NODE_TYPES }, 400);
      types = new Set(list as GraphNodeType[]);
    }
    const sinceRaw = c.req.query("since");
    let since: string | null = null;
    if (sinceRaw) {
      const ts = Date.parse(sinceRaw);
      if (Number.isNaN(ts)) return c.json({ error: t("Ungültiges since") }, 400);
      since = new Date(ts).toISOString();
    }
    const includeFiles = (c.req.query("include") ?? "").split(",").includes("files");
    const body = await graph.queryJson({ types, since, includeFiles });
    return c.body(body, 200, { "content-type": "application/json; charset=utf-8" });
  });

  // Info-Karte zu einem Knoten (lokaler Graph, Gehirn). Klein, begrenzt, kurz gecacht
  // (je Graph-Version, höchstens DETAIL_TTL_MS alt — Sessions ändern ihre letzte Nachricht laufend).
  const detailCache = new Map<string, { at: number; body: string }>();
  app.get("/api/graph/node/:nodeId{.+}", async (c) => {
    const g = await graph.get();
    const id = resolveCenter(g, c.req.param("nodeId"));
    if (!id) return c.json({ error: t("Nicht gefunden") }, 404);
    const key = `${g.version}|${id}`;
    const hit = detailCache.get(key);
    if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return c.body(hit.body, 200, { "content-type": "application/json; charset=utf-8", "x-cache": "hit" });
    const detail = await nodeDetail(db, g, id);
    if (!detail) return c.json({ error: t("Nicht gefunden") }, 404);
    const body = JSON.stringify(detail);
    if (detailCache.size >= DETAIL_CACHE_MAX) detailCache.delete(detailCache.keys().next().value ?? "");
    detailCache.set(key, { at: Date.now(), body });
    return c.body(body, 200, { "content-type": "application/json; charset=utf-8", "x-cache": "miss" });
  });

  app.get("/api/graph/local/:nodeId{.+}", async (c) => {
    const depthRaw = c.req.query("depth") ?? "1";
    const depth = Number(depthRaw);
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) return c.json({ error: t("depth muss 1, 2 oder 3 sein") }, 400);
    const includeFiles = (c.req.query("include") ?? "").split(",").includes("files");
    const nodeId = c.req.param("nodeId"); // Hono dekodiert Parameter selbst
    const local = await graph.local(nodeId, depth, includeFiles);
    if (!local) return c.json({ error: t("Nicht gefunden") }, 404);
    return c.json(local);
  });
}
