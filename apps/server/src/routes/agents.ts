// Agenten & Skills (eigene Routen-Datei).
import { CatalogBatchSchema, t } from "@nyxos/shared";
import type { Hono, MiddlewareHandler } from "hono";
import { detectAnomalies, getSkillUsage7d, listCatalog, replaceCatalogSource } from "../agents/catalog.js";
import { listAgentRuns } from "../agents/runs.js";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";

export function registerAgentsRoutes(app: Hono<Env>, db: Db, auth: MiddlewareHandler<Env>): void {
  app.post("/ingest/catalog", auth, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = CatalogBatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiges Paket"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const bySource = new Map<string, typeof parsed.data.items>();
    for (const item of parsed.data.items) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item]);
    for (const [source, items] of bySource) await replaceCatalogSource(db, c.get("machineId"), source, items);
    return c.json({ ok: true, sources: [...bySource.keys()] });
  });

  app.get("/api/agents/runs", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200) || 200, 1), 1000);
    const runs = await listAgentRuns(db, limit);
    const filter = c.req.query("filter");
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const filtered =
      filter === "running"
        ? runs.filter((r) => r.running)
        : filter === "today"
          ? runs.filter((r) => r.endedAt && new Date(r.endedAt).getTime() >= todayStart.getTime())
          : runs;
    return c.json({ runs: filtered, generatedAt: new Date(now).toISOString() });
  });

  app.get("/api/agents/runs/:id", async (c) => {
    const id = c.req.param("id");
    const runs = await listAgentRuns(db, 1000);
    const run = runs.find((r) => r.id === id);
    return run ? c.json({ run }) : c.json({ error: t("Nicht gefunden") }, 404);
  });

  app.get("/api/agents/catalog", async (c) => {
    return c.json({ catalog: await listCatalog(db) });
  });

  app.get("/api/agents/skills/usage", async (c) => {
    return c.json({ skills: await getSkillUsage7d(db) });
  });

  app.get("/api/agents/anomalies", async (c) => {
    return c.json({ anomalies: await detectAnomalies(db) });
  });
}
