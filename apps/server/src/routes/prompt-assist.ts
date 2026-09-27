// Prompt verbessern (Sessions-Tab): `POST /api/sessions/:id/prompt-assist`. Schreibender Weg hinter
// Passkey-Anmeldung + CSRF (auth.gate in app.ts), weil er Geld kostet. Logik in ../prompt-assist/assist.ts.
// Das Abschicken selbst geht NICHT hier, sondern über den bestehenden Chat-Weg (`POST /api/sessions/:id/message`).
import { PromptAssistRequestSchema, t } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { runPromptAssist } from "../prompt-assist/assist.js";
import type { DigestService } from "../session-digest.js";
import type { TranscriptCache } from "../transcript.js";

export interface PromptAssistRouteDeps {
  db: Db;
  runtime: HaikuRuntime;
  cache: TranscriptCache;
  digests?: DigestService | null;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const BODY_MAX = 256 * 1024;

async function findSessionKey(db: Db, idOrUuid: string): Promise<string | null> {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(where).limit(1);
  return row?.id ?? null;
}

export function registerPromptAssistRoutes(app: Hono<Env>, deps: PromptAssistRouteDeps): void {
  app.post("/api/sessions/:id/prompt-assist", bodyLimit({ maxSize: BODY_MAX, onError: (c) => c.json({ error: t("Der Entwurf ist zu lang.") }, 413) }), async (c) => {
    const key = await findSessionKey(deps.db, c.req.param("id"));
    if (!key) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: t("Die Anfrage war unvollständig. Bitte noch einmal versuchen.") }, 400);
    }
    const parsed = PromptAssistRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Schreib zuerst einen Entwurf." }, 400);
    const out = await runPromptAssist(deps, key, parsed.data, c.req.raw.signal);
    if (!out.ok) return c.json({ error: out.error }, out.status);
    deps.log("prompt-verbessert", { session: key, modus: parsed.data.modus, fragen: out.result.fragen.length, ms: out.result.durationMs });
    return c.json(out.result);
  });
}
