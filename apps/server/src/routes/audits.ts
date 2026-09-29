// `GET /api/audits/:entryId` — Audit-Detail (Plan-Werte, Originaltext, Verwandte, Aufträge, Sessions).
// Lesend wie die übrigen Einträge (Anmeldung nur mit NYXOS_AUTH_READS). Logik in ../audits/detail.ts.
import { t } from "@nyxos/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { auditDetail } from "../audits/detail.js";
import type { Db } from "../db/client.js";
import type { FinderHub } from "../finder/service.js";

export function registerAuditRoutes(app: Hono<AppEnv>, deps: { db: Db; bridgeHub: FinderHub }): void {
  app.get("/api/audits/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: t("Welcher Befund? Bitte einen aus der Liste wählen.") }, 400);
    const detail = await auditDetail(deps.db, deps.bridgeHub, id);
    if (!detail) return c.json({ error: t("Diesen Befund gibt es nicht (mehr).") }, 404);
    return c.json(detail);
  });
}
