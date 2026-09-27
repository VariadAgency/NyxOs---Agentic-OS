// Routen des Lernbuchs (Einstellungen → Lernbuch). Logik in ../lessons/learn.ts.
import type { Hono } from "hono";
import type { Db } from "../db/client.js";
import { listRules, setRuleActive } from "../lessons/learn.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";
import { t } from "@nyxos/shared";

type Env = { Variables: { machineId: string } };

export function registerLessonRoutes(app: Hono<Env>, ctx: { db: Db }): void {
  const { db } = ctx;

  app.get("/api/rules", async (c) => c.json({ rules: await listRules(db) }));

  app.patch("/api/rules/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    if (!body || typeof body !== "object" || typeof (body as { active?: unknown }).active !== "boolean") {
      return c.json({ error: t("Feld 'active' fehlt") }, 400);
    }
    const ok = await setRuleActive(db, id, (body as { active: boolean }).active);
    return ok ? c.json({ ok: true }) : c.json({ error: "Nicht gefunden" }, 404);
  });
}
