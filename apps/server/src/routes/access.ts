// Einstellungen → Zugänge. Keine Route gibt je einen gespeicherten Wert zurück (nur Zustand + letzte 4).
import { AccessBulkSchema, AccessIdSchema, AccessValueSchema, t } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import type { Env } from "../app.js";
import { AccessError, type AccessService } from "../access/service.js";
import { ProviderError } from "../models/chat.js";
import { UnsafeUrlError } from "../net/safeFetch.js";
import { SecretsKeyError } from "../secrets/store.js";

type Log = (msg: string, extra?: Record<string, unknown>) => void;

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function fail(c: Context, e: unknown, log: Log) {
  if (e instanceof SecretsKeyError) return c.json({ error: e.message, code: `key_${e.state}` }, 409);
  if (e instanceof AccessError || e instanceof ProviderError || e instanceof UnsafeUrlError) return c.json({ error: e.message }, 400);
  // Nie die Meldung loggen – sie könnte einen Wert enthalten.
  log("zugaenge-fehler", { error: e instanceof Error ? e.name : "unbekannt" });
  return c.json({ error: t("Das hat nicht geklappt – bitte noch einmal versuchen.") }, 500);
}

export function registerAccessRoutes(app: Hono<Env>, access: AccessService, log: Log): void {
  app.get("/api/access", async (c) => c.json(await access.list()));

  app.post("/api/access/bulk", async (c) => {
    const parsed = AccessBulkSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Bitte mindestens einen Zugang ausfüllen.") }, 400);
    try {
      return c.json(await access.bulk(parsed.data.entries, parsed.data.check ?? true));
    } catch (e) {
      return fail(c, e, log);
    }
  });

  app.put("/api/access/:id", async (c) => {
    const id = AccessIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: t("Diesen Zugang gibt es nicht.") }, 404);
    const body = AccessValueSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: t("Bitte einen Wert einfügen.") }, 400);
    try {
      await access.save(id.data, body.data.value);
      return c.json(await access.get(id.data));
    } catch (e) {
      return fail(c, e, log);
    }
  });

  app.post("/api/access/:id/check", async (c) => {
    const id = AccessIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: t("Diesen Zugang gibt es nicht.") }, 404);
    try {
      const check = await access.check(id.data);
      return c.json({ check, status: await access.get(id.data) });
    } catch (e) {
      return fail(c, e, log);
    }
  });

  app.delete("/api/access/:id", async (c) => {
    const id = AccessIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: t("Diesen Zugang gibt es nicht.") }, 404);
    try {
      await access.remove(id.data);
      return c.json(await access.get(id.data));
    } catch (e) {
      return fail(c, e, log);
    }
  });
}
