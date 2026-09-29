// Focus button — routes. Writing only when signed in and with the CSRF header (like all /api/*, terminal/auth.ts).
// Nyx sets the focus through `app_api` ("Nyx, I'm away until 18:00") – recognisable by the internal request.
import { FocusPutSchema, t, type FocusResponse } from "@nyxos/shared";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import { FocusError, type FocusService } from "../focus/service.js";
import { isInternalRequest } from "../nyx/appApi/internal.js";

export function registerFocusRoutes(app: Hono<Env>, deps: { focus: FocusService; now: () => number }): void {
  const { focus, now } = deps;
  const response = (): FocusResponse => ({ state: focus.current(), now: new Date(now()).toISOString() });

  app.get("/api/focus", async (c) => {
    await focus.load();
    return c.json(response());
  });

  app.put("/api/focus", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = FocusPutSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiger Fokus"), issues: parsed.error.issues.slice(0, 5) }, 400);
    try {
      await focus.set(parsed.data, isInternalRequest(c.req.raw) ? "nyx" : "user");
    } catch (e) {
      if (e instanceof FocusError) return c.json({ error: e.message }, 400);
      throw e;
    }
    return c.json(response());
  });
}
