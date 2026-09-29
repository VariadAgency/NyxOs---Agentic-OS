// Session-Steuerung – was diese Session kann (Modelle, Denkaufwand, Komprimieren) und „setzen“.
// Der Befehl geht NIE blind ins Terminal: immer über die Zustell-Warteschlange – sofort nur,
// wenn Hook UND Bildschirm „wartet“ sagen, sonst „geht raus, sobald sie wartet“. Komprimieren bleibt der
// bestehende Weg des Kontext-Wächters (`/api/context-guard/sessions/:id/compact-now`).
import { buildControlCommand, SessionControlRequestSchema, sessionControlsFor, t, type SessionControlResult } from "@nyxos/shared";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { sessionDeliveries } from "../db/schema.js";
import { cancelDelivery, deliverOrQueue, type DeliveryDeps } from "../delivery/queue.js";
import { findSession } from "../session-panels.js";

type Env = { Variables: { machineId: string } };

/** Modell/Denkaufwand gelten nur zeitnah – danach ist die Wahl womöglich überholt. */
const CONTROL_TTL_HOURS = 2;

const currentModelOf = (row: { lastUsageModel: string | null; models: string[] | null }) => row.lastUsageModel ?? row.models?.at(-1) ?? null;

export function registerSessionControlRoutes(app: Hono<Env>, deps: DeliveryDeps): void {
  app.get("/api/sessions/:id/controls", async (c) => {
    const row = await findSession(deps.db, c.req.param("id"));
    if (!row) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    return c.json(sessionControlsFor(row.tool, currentModelOf(row)));
  });

  app.post("/api/sessions/:id/controls", async (c) => {
    const row = await findSession(deps.db, c.req.param("id"));
    if (!row) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    const parsed = SessionControlRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: t("Unbekannte Einstellung.") }, 400);
    const built = buildControlCommand(row.tool, currentModelOf(row), parsed.data);
    if (!built.ok) return c.json({ error: built.reason }, 400);

    // Eine neue Wahl ersetzt die alte, die noch auf die Pause wartet (nie zwei Modellwechsel hintereinander).
    const dedupeKey = `control:${parsed.data.kind}`;
    const older = await deps.db
      .select({ id: sessionDeliveries.id })
      .from(sessionDeliveries)
      .where(and(eq(sessionDeliveries.sessionKey, row.id), eq(sessionDeliveries.status, "queued"), eq(sessionDeliveries.dedupeKey, dedupeKey)));
    for (const o of older) await cancelDelivery(deps.db, o.id, deps.now?.() ?? Date.now());

    const r = await deliverOrQueue(deps, { sessionKey: row.id, kind: "control", text: built.command, dedupeKey, ttlHours: CONTROL_TTL_HOURS });
    if (r.status === "rejected") return c.json({ error: r.reason }, 409);
    const model = parsed.data.kind === "model";
    const message =
      r.status === "sent"
        ? model
          ? t("Modellwechsel ist unterwegs – der Verlauf zeigt es gleich.")
          : t("Denkaufwand ist unterwegs – der Verlauf zeigt es gleich.")
        : model
          ? t("Modellwechsel kommt, sobald die Session auf dich wartet.")
          : t("Denkaufwand kommt, sobald die Session auf dich wartet.");
    const body: SessionControlResult = { status: r.status, command: built.command, message };
    return c.json(body);
  });
}
