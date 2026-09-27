// „Zuletzt geöffnet“: merkt sich, wann der Nutzer eine Session in der Web-App geöffnet hat,
// und liefert die Liste in dieser Reihenfolge (neueste zuerst), gefiltert nach Werkzeug.
//
// Entscheidung: serverseitig statt nur localStorage – so ist die Liste auf Mac, iPad und Handy
// dieselbe. Eine Zeile je Session (Upsert), kein wachsendes Protokoll. Schreiben braucht die
// Anmeldung (`auth.gate` schützt jede nicht-GET-Anfrage unter `/api/`); ohne Anmeldung merkt sich
// die Web-App das Öffnen still im Browser und reicht es nach (`openedAt` im Body).
import { ToolSchema, t } from "@nyxos/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Db } from "../db/client.js";
import { sessionOpens, sessions } from "../db/schema.js";
import { visibleSession } from "../db/visible.js";

type Env = { Variables: { machineId: string } };

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** Zeitstempel aus dem Body: gültig und nicht in der Zukunft, sonst „jetzt“. */
function clampOpenedAt(raw: unknown): string {
  const now = Date.now();
  if (typeof raw !== "string") return new Date(now).toISOString();
  const t = Date.parse(raw);
  if (Number.isNaN(t) || t > now) return new Date(now).toISOString();
  return new Date(t).toISOString();
}

function iso(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

export function registerRecentRoutes(app: Hono<Env>, ctx: { db: Db }): void {
  const { db } = ctx;

  app.post("/api/sessions/:id/opened", async (c) => {
    const idOrUuid = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as { openedAt?: unknown } | null;
    const openedAt = clampOpenedAt(body?.openedAt);
    // Wie `getSessionDetail`: Schlüssel `<tool>:<id>` oder die nackte Session-ID (Links aus Suche/Gehirn).
    const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
    const [session] = await db.select({ id: sessions.id }).from(sessions).where(where).limit(1);
    if (!session) return c.json({ error: t("Diese Session gibt es nicht mehr.") }, 404);
    await db
      .insert(sessionOpens)
      .values({ sessionKey: session.id, lastOpenedAt: openedAt, openCount: 1 })
      .onConflictDoUpdate({
        target: sessionOpens.sessionKey,
        // Ein nachgereichter, älterer Zeitstempel (aus dem Browser-Speicher) schiebt nichts zurück.
        set: { lastOpenedAt: sql`greatest(${sessionOpens.lastOpenedAt}, excluded.last_opened_at)`, openCount: sql`${sessionOpens.openCount} + 1` },
      });
    return c.json({ ok: true, sessionKey: session.id });
  });

  app.get("/api/recent-sessions", async (c) => {
    const tool = ToolSchema.safeParse(c.req.query("tool"));
    const limitRaw = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const rows = await db
      .select({
        sessionKey: sessions.id,
        sessionId: sessions.sessionId,
        tool: sessions.tool,
        title: sessions.title,
        state: sessions.state,
        art: sessions.categoryArt,
        baustelleSlug: sessions.categoryBaustelleSlug,
        baustelleLabel: sessions.categoryBaustelleLabel,
        lastActivityAt: sessions.lastActivityAt,
        openedAt: sessionOpens.lastOpenedAt,
        openCount: sessionOpens.openCount,
      })
      .from(sessionOpens)
      .innerJoin(sessions, eq(sessions.id, sessionOpens.sessionKey))
      // archivierte Wegwerf-Sessions nicht unter „Zuletzt geöffnet“.
      .where(and(visibleSession, tool.success ? eq(sessions.tool, tool.data) : undefined))
      .orderBy(desc(sessionOpens.lastOpenedAt))
      .limit(limit);
    return c.json({
      items: rows.map(({ baustelleSlug, baustelleLabel, art, openedAt, lastActivityAt, ...rest }) => ({
        ...rest,
        art: art ?? "unsortiert",
        baustelle: baustelleSlug ? { slug: baustelleSlug, label: baustelleLabel ?? baustelleSlug } : null,
        openedAt: iso(openedAt),
        lastActivityAt: iso(lastActivityAt),
      })),
    });
  });
}
