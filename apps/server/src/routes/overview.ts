// Route des Überblick-Dashboards (Registrierung hier, Logik in ../overview/aggregate.ts).
// dazu die Einstellung „abgestürzt gilt bis … Stunden“ (wirkt auf Zähler, Kritische Sessions,
// Briefing und Rundgang — deshalb hier beim Überblick).
import { DEFAULT_GREETING_NAME, SessionStateSettingsSchema, t } from "@nyxos/shared";
import type { Hono } from "hono";
import { getChanges, resolveSince } from "../changes.js";
import type { Db } from "../db/client.js";
import { greetingNameOf } from "../nyx/profile.js";
import { getOverviewSnapshot } from "../overview/aggregate.js";
import { countOpenQuestions } from "../overview/snapshot.js";
import { loadStateSettings, saveStateSettings } from "../state-settings.js";
import { retickIdleStates } from "../store.js";

type Env = { Variables: { machineId: string } };

export function registerOverviewRoutes(app: Hono<Env>, ctx: { db: Db; onStatesChanged?: (keys: Set<string>) => Promise<void> }): void {
  // gegrüßt wird mit dem Namen aus dem Nyx-Profil (Einstellungen → Nyx), sonst dem Standardnamen.
  app.get("/api/overview", async (c) => c.json(await getOverviewSnapshot(ctx.db, (await greetingNameOf(ctx.db)) ?? DEFAULT_GREETING_NAME)));
  // „Seit du weg warst“: nur lesend, `since` = ISO, „8h“, „7d“, „heute“, „gestern“ (Standard 24 h, höchstens 7 Tage).
  app.get("/api/changes", async (c) => {
    const now = new Date();
    const resolved = resolveSince(c.req.query("since"), now);
    if (!resolved) return c.json({ error: t("Diesen Zeitpunkt verstehe ich nicht. Beispiele: 8h, 7d, gestern oder ein Datum.") }, 400);
    return c.json(await getChanges(ctx.db, { since: resolved.since, now, capped: resolved.capped }));
  });
  // dieselbe Zahl „offene Fragen“ für Entscheidungen-Tab, Leisten-Zähler und Konflikte-Kopf.
  app.get("/api/open-questions", async (c) => c.json(await countOpenQuestions(ctx.db)));

  app.get("/api/settings/session-state", async (c) => c.json(await loadStateSettings(ctx.db)));
  app.patch("/api/settings/session-state", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = SessionStateSettingsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Bitte eine ganze Zahl zwischen 1 und 2160 Stunden (90 Tage) angeben.") }, 400);
    const saved = await saveStateSettings(ctx.db, parsed.data);
    // Sofort wirksam (nicht erst beim nächsten 60-s-Takt): Zustände mit der neuen Grenze neu berechnen.
    const changed = await retickIdleStates(ctx.db, Date.now());
    await ctx.onStatesChanged?.(new Set(changed));
    return c.json(saved);
  });
}
