// Agents in the session chat (own route file): live list, detail per agent, manage.
// Reading is free (behind the sign-in like everything under /api), writing needs sign-in + CSRF (auth.gate).
import { AgentHideSchema, t, type SessionAgentsLiveResponse } from "@nyxos/shared";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import { agentToTask, loadSessionAgentLiveDetail, loadSessionAgentsLive, setAgentHidden } from "../agents/session-live.js";
import type { Db } from "../db/client.js";
import type { GraphService } from "../graph/service.js";
import type { LiveHub } from "../live.js";
import type { DigestService } from "../session-digest.js";
import { findSession } from "../session-panels.js";

const noSession = () => ({ error: t("Diese Session gibt es nicht (mehr).") });
const noAgent = () => ({ error: t("Diesen Agenten gibt es in der Session nicht.") });

/** A running session sends live signals every few seconds — every open browser then asks again. Within this window
 * all requests for the same session share ONE computation (the list reads many events). */
const LIVE_CACHE_MS = 1_500;
const LIVE_CACHE_MAX = 64;

export function registerSessionAgentsRoutes(app: Hono<Env>, deps: { db: Db; digests: DigestService; hub: LiveHub; graph?: GraphService }): void {
  const { db, digests, hub } = deps;
  const cache = new Map<string, { at: number; value: Promise<SessionAgentsLiveResponse> }>();

  app.get("/api/sessions/:id/agents-live", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(noSession(), 404);
    const now = Date.now();
    const hit = cache.get(session.id);
    if (hit && now - hit.at < LIVE_CACHE_MS) return c.json(await hit.value);
    const value = loadSessionAgentsLive(db, digests, session, now);
    cache.set(session.id, { at: now, value });
    if (cache.size > LIVE_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    try {
      return c.json(await value);
    } catch (e) {
      cache.delete(session.id);
      throw e;
    }
  });

  app.get("/api/sessions/:id/agents-live/:agentId", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(noSession(), 404);
    const detail = await loadSessionAgentLiveDetail(db, digests, session, c.req.param("agentId"));
    return detail ? c.json(detail) : c.json(noAgent(), 404);
  });

  // Hide in the archive or show again — nothing is deleted.
  app.post("/api/sessions/:id/agents/:agentId/hide", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(noSession(), 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = AgentHideSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiger Körper") }, 400);
    const ok = await setAgentHidden(db, digests, session, c.req.param("agentId"), parsed.data.hidden);
    if (!ok) return c.json(noAgent(), 404);
    cache.delete(session.id);
    return c.json({ ok: true, hidden: parsed.data.hidden });
  });

  // Add to tasks (task + result of the agent); a second time shows the same task.
  app.post("/api/sessions/:id/agents/:agentId/task", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(noSession(), 404);
    const r = await agentToTask(db, digests, session, c.req.param("agentId"));
    if (r.kind === "not_found") return c.json(noAgent(), 404);
    if (r.created) {
      hub.broadcast({ type: "entry", entryId: r.entry.id });
      deps.graph?.markDirty(["entries"]);
    }
    return c.json({ entry: r.entry, existing: !r.created }, r.created ? 201 : 200);
  });
}
