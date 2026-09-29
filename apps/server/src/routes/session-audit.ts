// „Session zusammenfassen & prüfen“ — Start (POST) und Ergebnisse (GET) je Session.
// Logik in ../session-audit/audit.ts. Schreibender Weg hinter Passkey-Anmeldung + CSRF (auth.gate).
import type { SessionAuditView } from "@nyxos/shared";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { sessionAudits, sessions } from "../db/schema.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { loadHaikuSettings } from "../haiku/settings.js";
import type { LiveHub } from "../live.js";
import { closeStaleAudits, runAudit, runningAudit, toAudit } from "../session-audit/audit.js";
import type { TranscriptCache } from "../transcript.js";
import { t } from "@nyxos/shared";

export interface SessionAuditRouteDeps {
  db: Db;
  hub: LiveHub;
  runtime: HaikuRuntime;
  cache: TranscriptCache;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const LIST_LIMIT = 5;

async function findSessionKey(db: Db, idOrUuid: string): Promise<string | null> {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(where).limit(1);
  return row?.id ?? null;
}

export function registerSessionAuditRoutes(app: Hono<Env>, deps: SessionAuditRouteDeps): void {
  const { db, hub, runtime, cache, log } = deps;
  const onChange = (sessionKey: string) => hub.broadcast({ type: "session_audit", sessionId: sessionKey });

  async function engine(): Promise<SessionAuditView["engine"]> {
    const settings = await loadHaikuSettings(db);
    const view = await runtime.engineView(settings.engine);
    return { ready: view.ok && view.state === "ready", state: view.state, reason: view.ok ? null : view.reason };
  }

  app.get("/api/sessions/:id/audits", async (c) => {
    const key = await findSessionKey(db, c.req.param("id"));
    if (!key) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    await closeStaleAudits(db, key);
    const rows = await db.select().from(sessionAudits).where(eq(sessionAudits.sessionKey, key)).orderBy(desc(sessionAudits.id)).limit(LIST_LIMIT);
    return c.json({ engine: await engine(), audits: rows.map(toAudit) } satisfies SessionAuditView);
  });

  // Sessions, deren Start gerade geprüft wird. Zwei schnelle Klicks kämen sonst beide zwischen
  // Prüfung („läuft schon einer?“) und Eintrag durch. Ein Server-Prozess, daher reicht die Sperre im Speicher.
  const starting = new Set<string>();
  const alreadyRunning = t("Die Prüfung läuft schon – das Ergebnis erscheint gleich hier.");

  app.post("/api/sessions/:id/audits", async (c) => {
    const key = await findSessionKey(db, c.req.param("id"));
    if (!key) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    if (starting.has(key)) return c.json({ error: alreadyRunning }, 409);
    starting.add(key);
    let audit: typeof sessionAudits.$inferSelect;
    try {
      const e = await engine();
      if (!e.ready) return c.json({ error: e.reason ?? t("Nyx ist gerade nicht bereit."), engineState: e.state }, 409);
      await closeStaleAudits(db, key);
      if (await runningAudit(db, key)) return c.json({ error: alreadyRunning }, 409);
      const [row] = await db.insert(sessionAudits).values({ sessionKey: key, status: "running" }).returning();
      audit = row as typeof sessionAudits.$inferSelect;
    } finally {
      starting.delete(key);
    }
    onChange(key);
    // Läuft im Hintergrund (Haiku braucht einige Sekunden); die Web-App erfährt das Ende über `/live`.
    void runAudit({ db, runtime, cache, log, onChange }, audit.id, key);
    return c.json(toAudit(audit), 202);
  });
}
