// „Nyx fasst zusammen“ — Start (POST) und letzte Zusammenfassung (GET) je Session.
// Logik in ../session-summary/summary.ts. Schreibender Weg hinter Passkey-Anmeldung + CSRF (auth.gate).
import { t, type NyxSessionSummaryView } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { sessions, sessionSummaries } from "../db/schema.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { loadHaikuSettings } from "../haiku/settings.js";
import type { LiveHub } from "../live.js";
import { closeStaleSummaries, latestSummary, newMessagesSince, runningSummary, runSummary, toSummary } from "../session-summary/summary.js";
import type { TranscriptCache } from "../transcript.js";
import { loadMainTranscriptItems } from "../transcript.js";

export interface SessionSummaryRouteDeps {
  db: Db;
  hub: LiveHub;
  runtime: HaikuRuntime;
  cache: TranscriptCache;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

async function findSessionKey(db: Db, idOrUuid: string): Promise<string | null> {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(where).limit(1);
  return row?.id ?? null;
}

export function registerSessionSummaryRoutes(app: Hono<Env>, deps: SessionSummaryRouteDeps): void {
  const { db, hub, runtime, cache, log } = deps;
  const onChange = (sessionKey: string) => hub.broadcast({ type: "session_summary", sessionId: sessionKey });

  async function engine(): Promise<NyxSessionSummaryView["engine"]> {
    const settings = await loadHaikuSettings(db);
    const view = await runtime.engineView(settings.engine);
    return { ready: view.ok && view.state === "ready", state: view.state, reason: view.ok ? null : view.reason };
  }

  app.get("/api/sessions/:id/summary", async (c) => {
    const key = await findSessionKey(db, c.req.param("id"));
    if (!key) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    await closeStaleSummaries(db, key);
    const row = await latestSummary(db, key);
    let newMessages = 0;
    // „N neue Nachrichten seit der Zusammenfassung“: gemessen an der letzten FERTIGEN.
    const done = row?.status === "done" ? row : row ? await latestSummary(db, key, "done") : null;
    if (done) {
      const t = await loadMainTranscriptItems(db, cache, key).catch(() => null);
      if (t) newMessages = newMessagesSince(t.items, done);
    }
    return c.json({ engine: await engine(), summary: row ? toSummary(row) : null, newMessages } satisfies NyxSessionSummaryView);
  });

  // Zwei schnelle Klicks kämen sonst beide zwischen „läuft schon eine?“ und Eintrag durch (wie „Session prüfen“).
  const starting = new Set<string>();
  const alreadyRunning = () => t("Nyx schreibt die Zusammenfassung schon – sie erscheint gleich oben im Chat.");

  app.post("/api/sessions/:id/summary", async (c) => {
    const key = await findSessionKey(db, c.req.param("id"));
    if (!key) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    if (starting.has(key)) return c.json({ error: alreadyRunning() }, 409);
    starting.add(key);
    let row: typeof sessionSummaries.$inferSelect;
    try {
      const e = await engine();
      if (!e.ready) return c.json({ error: e.reason ?? t("Nyx ist gerade nicht bereit."), engineState: e.state }, 409);
      await closeStaleSummaries(db, key);
      if (await runningSummary(db, key)) return c.json({ error: alreadyRunning() }, 409);
      const [inserted] = await db.insert(sessionSummaries).values({ sessionKey: key, status: "running" }).returning();
      row = inserted as typeof sessionSummaries.$inferSelect;
    } finally {
      starting.delete(key);
    }
    onChange(key);
    // Läuft im Hintergrund; der Text strömt in die Zeile, die Web-App erfährt jeden Schritt über `/live`.
    void runSummary({ db, runtime, cache, log, onChange }, row.id, key);
    return c.json(toSummary(row), 202);
  });
}
