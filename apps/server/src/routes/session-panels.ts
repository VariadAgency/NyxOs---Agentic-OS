// Session-Seitenpanels (eigene Routen-Datei). Nur lesend.
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import type { DigestService } from "../session-digest.js";
import { findSession, getFileChanges, getSessionAgent, getSessionChanges, getSessionOutcomes, listSessionAgents } from "../session-panels.js";
import { t } from "@nyxos/shared";

const notFound = () => ({ error: t("Diese Session gibt es nicht (mehr).") });
const QUERY_MAX = 200;

export function registerSessionPanelsRoutes(app: Hono<Env>, deps: { db: Db; digests: DigestService }): void {
  const { db, digests } = deps;

  // geschriebene Dateien mit Anzahl Änderungen und +/−; `?q=` filtert nach Pfad und Inhalt.
  app.get("/api/sessions/:id/changes", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(notFound(), 404);
    const q = (c.req.query("q") ?? "").slice(0, QUERY_MAX);
    return c.json(await getSessionChanges(db, digests, session, q));
  });

  // Klick auf eine Datei — ihre einzelnen Änderungen mit den geänderten Zeilen.
  app.get("/api/sessions/:id/changes/file", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(notFound(), 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: t("Welche Datei? Der Pfad fehlt.") }, 400);
    return c.json(await getFileChanges(db, digests, session, path, c.req.query("agent") ?? null));
  });

  // Agenten-Kacheln (klein) und die große Kachel je Agent.
  app.get("/api/sessions/:id/agents", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(notFound(), 404);
    return c.json({ agents: await listSessionAgents(db, digests, session) });
  });

  app.get("/api/sessions/:id/agents/:agentId", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(notFound(), 404);
    const agent = await getSessionAgent(db, digests, session, c.req.param("agentId"));
    return agent ? c.json(agent) : c.json({ error: t("Diesen Agenten gibt es in der Session nicht.") }, 404);
  });

  // erledigt / erfolgreich behoben / offen geblieben / vergleichbare Sessions.
  app.get("/api/sessions/:id/outcomes", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json(notFound(), 404);
    return c.json(await getSessionOutcomes(db, digests, session));
  });
}
