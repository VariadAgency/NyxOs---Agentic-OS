// Statuszeile „Brücke" (eigene Datei, in app.ts nur eine Registrierungszeile).
// - `GET /api/bridge/presence`          Zustand fertig gerechnet (Server-Uhr), s. bridge/presence.ts.
// - `GET /api/bridge/presence/history`  Verlauf der Verbindung (Standard: 24 h, mit Dauer).
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import type { BridgePresence } from "../bridge/presence.js";
import type { Db } from "../db/client.js";
import { machines } from "../db/schema.js";

export function registerBridgePresenceRoutes(app: Hono<AppEnv>, deps: { db: Db; presence: BridgePresence }): void {
  const { db, presence } = deps;

  app.get("/api/bridge/presence", async (c) => {
    const v = presence.view();
    const id = presence.currentMachineId;
    let machine: { id: string; name: string } | null = null;
    if (id) {
      const [m] = await db.select({ id: machines.id, name: machines.name }).from(machines).where(eq(machines.id, id)).limit(1);
      machine = m ?? null;
    }
    return c.json({
      state: v.state,
      reason: v.reason,
      since: new Date(v.since).toISOString(),
      heartbeatAgeMs: v.heartbeatAgeMs,
      channelOpen: v.channelOpen,
      machine,
      // Die Web-App rechnet „seit …" relativ zu dieser Zeit, nie gegen die eigene Uhr (Uhren-Versatz).
      serverNow: new Date(presence.nowMs()).toISOString(),
    });
  });

  app.get("/api/bridge/presence/history", async (c) => {
    const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 24) || 24, 1), 24 * 7);
    await presence.tick(); // aktueller Abschnitt ist sicher schon eingetragen, auch zwischen zwei Takten
    return c.json({ events: await presence.history(hours) });
  });
}
