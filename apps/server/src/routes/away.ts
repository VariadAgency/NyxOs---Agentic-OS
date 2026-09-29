// Abwesenheit — Routen. Schreibende Anfragen (Herzschlag, Einstellungen) laufen wie alle unter /api/* nur
// angemeldet und mit CSRF-Kopf (terminal/auth.ts).
import { AwaySettingsPatchSchema, t } from "@nyxos/shared";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import type { AwayService } from "../away/service.js";
import { patchAwaySettings } from "../away/settings.js";
import { changedToggles, mirrorLegacyKinds } from "../notifications/rules.js";

export function registerAwayRoutes(app: Hono<Env>, deps: { db: Db; away: AwayService }): void {
  const { db, away } = deps;

  app.post("/api/away/heartbeat", (c) => {
    away.presence.beat();
    return c.json({ ok: true });
  });

  app.get("/api/away/status", async (c) => c.json(await away.status()));

  app.get("/api/away/settings", async (c) => c.json(await away.settings()));

  app.patch("/api/away/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = AwaySettingsPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültige Einstellungen"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const before = (await away.settings()).events;
    const next = await patchAwaySettings(db, parsed.data);
    away.setCached(next);
    // The old event switches keep working – as level "never" or the default of the notification rules.
    const ev = parsed.data.events ? changedToggles(before, parsed.data.events) : null;
    if (ev) await mirrorLegacyKinds(db, { session_done: ev.session_done, auftrag_done: ev.auftrag_done, bug_new: ev.bug_new, night_run_done: ev.night_done });
    return c.json(next);
  });
}
