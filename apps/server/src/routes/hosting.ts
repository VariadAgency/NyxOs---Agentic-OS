// Settings → „Betrieb & Zugriff“ (own file, app.ts only registers it).
// - `GET  /api/hosting/status`            how NyxOS runs right now (mode, addresses, bridge, reachable from the phone?)
// - `GET  /api/hosting/profile`           chosen way + form values + last checks + secrets (only „set“)
// - `PUT  /api/hosting/profile`           save (strict: unknown fields → 400, so never a token in the profile)
// - `POST /api/hosting/check`             check an address (`<origin>/health`, time limit, protection see hosting/check.ts)
// - `PUT/DELETE /api/hosting/secrets/:id` tunnel token / key into the secret store (blocked for Nyx, rules.ts)
// Writes need sign-in and the CSRF header like everything under /api/* (terminal/auth.ts).
import { HostingCheckRequestSchema, HostingProfileInputSchema, HostingSecretIdSchema, HostingSecretInputSchema, t } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import type { Env } from "../app.js";
import { SecretsNotReadyError, type HostingService } from "../hosting/service.js";

async function jsonBody(c: Context<Env>): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function requestHttps(c: Context<Env>): boolean {
  if (c.req.header("x-forwarded-proto") === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function registerHostingRoutes(app: Hono<Env>, hosting: HostingService): void {
  app.get("/api/hosting/status", async (c) => c.json(await hosting.status({ host: c.req.header("host") ?? null, https: requestHttps(c) })));

  app.get("/api/hosting/profile", async (c) => c.json(await hosting.profileView()));

  app.put("/api/hosting/profile", async (c) => {
    const b = await jsonBody(c);
    if (!b.ok) return c.json({ error: t("Kein gültiges JSON") }, 400);
    const parsed = HostingProfileInputSchema.safeParse(b.body);
    if (!parsed.success) return c.json({ error: t("Ungültige Angaben"), issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    return c.json(await hosting.saveProfile(parsed.data));
  });

  app.post("/api/hosting/check", async (c) => {
    const b = await jsonBody(c);
    if (!b.ok) return c.json({ error: t("Kein gültiges JSON") }, 400);
    const parsed = HostingCheckRequestSchema.safeParse(b.body);
    if (!parsed.success) return c.json({ error: t("Ungültige Anfrage"), issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    const result = await hosting.check(parsed.data.target, parsed.data.url);
    if ("error" in result) return c.json({ error: t("Für diesen Weg ist noch keine Adresse eingetragen."), code: result.error }, 400);
    return c.json(result);
  });

  app.put("/api/hosting/secrets/:id", async (c) => {
    const id = HostingSecretIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: t("Unbekanntes Geheimnis") }, 404);
    const b = await jsonBody(c);
    if (!b.ok) return c.json({ error: t("Kein gültiges JSON") }, 400);
    const parsed = HostingSecretInputSchema.safeParse(b.body);
    if (!parsed.success) return c.json({ error: t("Der Wert ist zu kurz oder zu lang.") }, 400);
    try {
      return c.json(await hosting.setSecret(id.data, parsed.data.value));
    } catch (e) {
      if (e instanceof SecretsNotReadyError) return c.json({ error: t("Der Geheimnis-Speicher ist noch nicht eingerichtet."), code: "secrets_key_missing" }, 409);
      throw e;
    }
  });

  app.delete("/api/hosting/secrets/:id", async (c) => {
    const id = HostingSecretIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: t("Unbekanntes Geheimnis") }, 404);
    return c.json({ deleted: await hosting.deleteSecret(id.data) });
  });
}
