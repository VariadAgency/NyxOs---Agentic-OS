// Einstellungen → Nyx. `GET/PUT /api/nyx/profile`, `GET/POST /api/nyx/presets`,
// `DELETE /api/nyx/presets/:id`. Schreiben nur mit Anmeldung + CSRF (globales `auth.gate` für /api/*).
import { DEFAULT_NYX_PROFILE, NYX_CUSTOM_PRESETS_MAX, NyxPresetCreateSchema, NyxPresetIdSchema, NyxProfilePutSchema, type NyxPresetsResponse, type NyxProfileResponse, t } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import type { Db } from "../db/client.js";
import { createNyxPreset, deleteNyxPreset, listNyxPresets, loadNyxProfile, saveNyxProfile } from "../nyx/profile.js";

type Env = { Variables: { machineId: string } };

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function registerNyxProfileRoutes(app: Hono<Env>, ctx: { db: Db }): void {
  const { db } = ctx;

  app.get("/api/nyx/profile", async (c) => {
    const { profile, updatedAt } = await loadNyxProfile(db);
    return c.json({ profile, defaults: DEFAULT_NYX_PROFILE, updatedAt } satisfies NyxProfileResponse);
  });

  app.put("/api/nyx/profile", async (c) => {
    const parsed = NyxProfilePutSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Profil unvollständig oder ungültig – bitte die markierten Felder prüfen."), issues: parsed.error.issues.slice(0, 5) }, 400);
    const { profile, updatedAt } = await saveNyxProfile(db, parsed.data);
    return c.json({ profile, defaults: DEFAULT_NYX_PROFILE, updatedAt } satisfies NyxProfileResponse);
  });

  app.get("/api/nyx/presets", async (c) => c.json({ presets: await listNyxPresets(db) } satisfies NyxPresetsResponse));

  app.post("/api/nyx/presets", async (c) => {
    const parsed = NyxPresetCreateSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Die Vorlage braucht einen Namen (höchstens 40 Zeichen)."), issues: parsed.error.issues.slice(0, 5) }, 400);
    const res = await createNyxPreset(db, parsed.data);
    if (!res.ok && res.reason === "full") return c.json({ error: t("Es gibt schon {n} eigene Vorlagen (höchstens {n}) – bitte erst eine löschen.", { n: NYX_CUSTOM_PRESETS_MAX }) }, 409);
    if (!res.ok) return c.json({ error: t("Eine Vorlage „{label}“ gibt es schon – bitte einen anderen Namen wählen.", { label: parsed.data.label }) }, 409);
    return c.json({ preset: res.preset }, 201);
  });

  app.delete("/api/nyx/presets/:id", async (c) => {
    const id = NyxPresetIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: t("Diese Vorlage gibt es nicht (mehr).") }, 404);
    const res = await deleteNyxPreset(db, id.data);
    if (res === "builtin") return c.json({ error: t("Eingebaute Vorlagen lassen sich nicht löschen.") }, 400);
    if (res === "missing") return c.json({ error: t("Diese Vorlage gibt es nicht (mehr).") }, 404);
    return c.json({ ok: true });
  });
}
