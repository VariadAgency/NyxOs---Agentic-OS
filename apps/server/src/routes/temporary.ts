// Wegwerf-Chats: Einstellung „nach X Stunden“ (1–72) und der Knopf an einer Session
// („temporär machen“ / „Behalten“). Ablauf und Auto-Regeln: `../temporary.ts`.
import { SessionTemporaryPatchSchema, TemporarySettingsSchema, t } from "@nyxos/shared";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { listArchived, loadTemporaryHours, saveTemporaryHours, setSessionTemporary } from "../temporary.js";

export interface TemporaryRouteDeps {
  db: Db;
  publish: (keys: Set<string>) => Promise<void>;
  /** Listen neu laden lassen: Restzeiten von Sessions und Fäden hängen an der Einstellung. */
  notifyChanged: () => void;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function registerTemporaryRoutes(app: Hono<Env>, deps: TemporaryRouteDeps): void {
  const { db } = deps;

  app.get("/api/temporary/settings", async (c) => c.json({ hours: await loadTemporaryHours(db) }));

  app.patch("/api/temporary/settings", async (c) => {
    const parsed = TemporarySettingsSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Bitte eine ganze Zahl von 1 bis 72 Stunden angeben.") }, 400);
    await saveTemporaryHours(db, parsed.data.hours);
    deps.notifyChanged();
    return c.json({ hours: parsed.data.hours });
  });

  // das Archiv – ohne diese Liste gäbe es für archivierte Sessions keinen Weg zurück.
  app.get("/api/temporary/archive", async (c) => c.json({ sessions: await listArchived(db) }));

  app.post("/api/sessions/:id/temporary", async (c) => {
    const parsed = SessionTemporaryPatchSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Feld 'temporary' fehlt") }, 400);
    const row = await setSessionTemporary(db, c.req.param("id"), parsed.data.temporary);
    if (!row) return c.json({ error: "Nicht gefunden" }, 404);
    await deps.publish(new Set([row.id]));
    return c.json({ id: row.id, temporary: parsed.data.temporary });
  });
}
