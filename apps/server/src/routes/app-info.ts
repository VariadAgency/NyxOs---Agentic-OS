// `GET /api/app/info` (version, mode, settings, update state), `PUT /api/app/settings`,
// `POST /api/app/update/check`, `POST /api/app/update/install`. Writes need login + CSRF (global gate).
import { AppSettingsPatchSchema, NYXOS_REPO, t, type AppInfo, type AppMode } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import type { Db } from "../db/client.js";
import { loadAppSettings, saveAppSettings } from "../app-info/settings.js";
import type { Updater } from "../app-info/updates.js";

type Env = { Variables: { machineId: string } };

export interface AppInfoContext {
  db: Db;
  version: string;
  mode: AppMode;
  demo: boolean;
  dataDir: string | null;
  updater: Updater;
  /** Demo instance: the real installation to go back to (null: standalone demo or no demo). */
  demoHomeUrl?: string | null;
  /** Demo instance: how Nyx answers (null outside a demo). */
  demoEngine?: "ai" | "scripted" | null;
  /** May this request see personal fields (data folder = home path, user name)? Default: yes. */
  canSeePrivate?: (c: Context) => Promise<boolean>;
}

export function registerAppInfoRoutes(app: Hono<Env>, ctx: AppInfoContext): void {
  const info = async (): Promise<AppInfo> => ({
    name: "NyxOS",
    version: ctx.version,
    mode: ctx.mode,
    demo: ctx.demo,
    demoHomeUrl: ctx.demo ? (ctx.demoHomeUrl ?? null) : null,
    demoEngine: ctx.demo ? (ctx.demoEngine ?? "scripted") : null,
    repo: ctx.updater.repo ?? NYXOS_REPO,
    settings: await loadAppSettings(ctx.db),
    update: ctx.updater.snapshot(),
    dataDir: ctx.dataDir,
  });

  // Public (the web app needs version, language and onboarding state before sign-in) — but the data folder
  // reveals the home path and the name is personal: both only for the signed-in user.
  app.get("/api/app/info", async (c) => {
    const full = await info();
    if (!ctx.canSeePrivate || (await ctx.canSeePrivate(c))) return c.json(full);
    return c.json({ ...full, dataDir: null, settings: { ...full.settings, userName: "" } });
  });

  app.put("/api/app/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const parsed = AppSettingsPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültige Einstellungen"), issues: parsed.error.issues.slice(0, 5) }, 400);
    await saveAppSettings(ctx.db, parsed.data);
    return c.json(await info());
  });

  app.post("/api/app/update/check", async (c) => {
    await ctx.updater.check();
    return c.json(await info());
  });

  app.post("/api/app/update/install", async (c) => {
    if (ctx.demo) return c.json({ error: t("Im Demo-Modus gibt es keine Updates.") }, 409);
    ctx.updater.install();
    return c.json(await info());
  });
}
