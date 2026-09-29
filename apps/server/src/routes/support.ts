// "Feedback & Unterstützen" (open-source edition): `/api/support/*`. Logic in ../support/service.ts,
// contract of the support service in docs/support-api.md. All routes need sign-in (terminal/auth.ts `needsAuth`),
// writes also CSRF. Nyx (app_api): drafts yes, sending only after the user's confirmation, donating and the
// address never (nyx/appApi/rules.ts).
import {
  SUPPORT_LIMITS,
  SupportBugInputSchema,
  SupportDonateInputSchema,
  SupportDraftInputSchema,
  SupportIdeaInputSchema,
  SupportSettingsInputSchema,
  t,
} from "@nyxos/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { NOT_FOUND, parseSerialId } from "../ids.js";
import type { SupportService } from "../support/service.js";

type Env = { Variables: { machineId: string } };

const tooLarge = (c: Context) => c.json({ error: t("Die Meldung ist zu groß – bitte ein kleineres Bildschirmfoto nehmen."), code: "payload_too_large" }, 413);

async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<{ ok: true; data: z.output<S> } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: t("Kein gültiges JSON") }, 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, res: c.json({ error: t("Bitte die markierten Felder prüfen."), code: "invalid_request", issues: parsed.error.issues.slice(0, 5) }, 400) };
  return { ok: true, data: parsed.data };
}

export function registerSupportRoutes(app: Hono<Env>, support: SupportService, background: { run(task: Promise<unknown>): void }): void {
  const limit = bodyLimit({ maxSize: SUPPORT_LIMITS.requestBytes, onError: tooLarge });
  const small = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });

  app.get("/api/support/state", async (c) => c.json(await support.state()));

  app.post("/api/support/bug", limit, async (c) => {
    const p = await parseBody(c, SupportBugInputSchema);
    if (!p.ok) return p.res;
    const { httpStatus, result } = await support.submit("bug", p.data);
    return httpStatus === 502 ? c.json({ error: result.message, code: "rejected", ...result }, 502) : c.json(result, httpStatus);
  });

  app.post("/api/support/idea", small, async (c) => {
    const p = await parseBody(c, SupportIdeaInputSchema);
    if (!p.ok) return p.res;
    const { httpStatus, result } = await support.submit("idea", p.data);
    return httpStatus === 502 ? c.json({ error: result.message, code: "rejected", ...result }, 502) : c.json(result, httpStatus);
  });

  app.post("/api/support/donate", small, async (c) => {
    const p = await parseBody(c, SupportDonateInputSchema);
    if (!p.ok) return p.res;
    const r = await support.donate(p.data);
    return r.ok ? c.json(r.result) : c.json({ error: r.error, code: r.code }, r.status);
  });

  app.put("/api/support/draft", small, async (c) => {
    const p = await parseBody(c, SupportDraftInputSchema);
    if (!p.ok) return p.res;
    return c.json({ id: await support.saveDraft(p.data) });
  });

  app.delete("/api/support/outbox/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    return (await support.remove(id)) ? c.json({ ok: true }) : c.json(NOT_FOUND, 404);
  });

  app.post("/api/support/flush", async (c) => c.json({ sent: await support.retryNow() }));

  app.put("/api/support/settings", small, async (c) => {
    const p = await parseBody(c, SupportSettingsInputSchema);
    if (!p.ok) return p.res;
    const r = await support.saveSettings(p.data.url);
    if (!r.ok) return c.json({ error: r.error, code: "invalid_url" }, 400);
    // Waiting reports go out now that an address is there (in the background — the answer does not wait).
    background.run(support.flush());
    return c.json(await support.state());
  });
}
