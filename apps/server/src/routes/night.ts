// Nachtmodus — Routen. Registrierung in app.ts eine Zeile. Die eigentliche Tick-Schleife
// läuft server-seitig (s. main.ts) — hier nur Einstellungen + Verlauf für die Web-App.
import { DEFAULT_NIGHT_BUDGET, DEFAULT_NIGHT_WINDOW, NightBudgetSchema, NightWindowSchema, type NightSettings, t } from "@nyxos/shared";
import { desc } from "drizzle-orm";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { nightRuns } from "../db/schema.js";

export interface NightRouteDeps {
  db: Db;
  /** In-Memory-Einstellungen (kein eigenes Schema — änderbar über PATCH, mit festen Vorgaben). */
  getSettings: () => NightSettings;
  setSettings: (next: NightSettings) => void;
}

export function registerNightRoutes(app: Hono<Env>, deps: NightRouteDeps): void {
  const { db, getSettings, setSettings } = deps;

  app.get("/api/night/settings", (c) => c.json(getSettings()));

  app.patch("/api/night/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const current = getSettings();
    const window = b.window !== undefined ? NightWindowSchema.safeParse(b.window) : { success: true as const, data: current.window };
    const budget = b.budget !== undefined ? NightBudgetSchema.safeParse(b.budget) : { success: true as const, data: current.budget };
    if (!window.success || !budget.success) return c.json({ error: t("Ungültige Einstellungen") }, 400);
    const allApproved = typeof b.allApproved === "boolean" ? b.allApproved : current.allApproved;
    const next: NightSettings = { window: window.data, budget: budget.data, allApproved };
    setSettings(next);
    return c.json(next);
  });

  app.get("/api/night/runs", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const rows = await db.select().from(nightRuns).orderBy(desc(nightRuns.createdAt)).limit(limit);
    return c.json({ runs: rows });
  });
}

export const defaultNightSettings = (): NightSettings => ({ window: DEFAULT_NIGHT_WINDOW, budget: DEFAULT_NIGHT_BUDGET, allApproved: false });
