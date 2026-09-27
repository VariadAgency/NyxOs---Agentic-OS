// Die Zustell-Warteschlange sichtbar machen — je Session, was noch auf eine Pause wartet
// (und was zuletzt rausging/ablief), plus „Zurückziehen“.
import type { Hono } from "hono";
import { findSession } from "../session-panels.js";
import { cancelDelivery, listDeliveries, type DeliveryDeps } from "./queue.js";
import { t } from "@nyxos/shared";

type Env = { Variables: { machineId: string } };

export function registerDeliveryRoutes(app: Hono<Env>, deps: DeliveryDeps): void {
  app.get("/api/sessions/:id/deliveries", async (c) => {
    const row = await findSession(deps.db, c.req.param("id"));
    if (!row) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    return c.json({ deliveries: await listDeliveries(deps.db, row.id) });
  });

  app.delete("/api/deliveries/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: t("Unbekannter Eintrag") }, 400);
    const done = await cancelDelivery(deps.db, id, deps.now?.() ?? Date.now());
    if (!done) return c.json({ error: t("Zu spät: Die Nachricht ist schon unterwegs, raus oder abgelaufen.") }, 409);
    deps.hub?.broadcast({ type: "deliveries", sessionId: done.sessionKey });
    return c.json({ cancelled: true });
  });
}
