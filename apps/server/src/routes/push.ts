// Push — Routen. Registrierung in app.ts ist eine einzige Zeile. Der geheime Topic-
// Name geht NIE über `GET /api/push/settings` hinaus (Token-Prinzip wie bei Maschinen, s. `/api/machines`).
import { NTFY_SH_URL, PushNotifySchema, PushSettingsPatchSchema, type PushChannelResult, type PushSettings, type PushSubscribeInfo, type PushTestResponse, t } from "@nyxos/shared";
import { desc } from "drizzle-orm";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { pushLog } from "../db/schema.js";
import { notify } from "../push/dispatcher.js";
import type { NtfySender } from "../push/ntfy.js";
import { loadOrInitSettings, patchSettings } from "../push/settings.js";

export interface PushRouteDeps {
  db: Db;
  sender: NtfySender;
  /** Adresse des eigenen ntfy-Dienstes, wie das iPhone sie erreicht (Tailscale, env `NTFY_PUBLIC_URL`);
   * `null` = noch keine — dann erreicht das iPhone den eigenen Dienst nicht (kein öffentlicher Port). */
  ntfyPublicUrl: string | null;
}

/** ehrliche Antwort auf „Wie abonniere ich das auf dem iPhone?“ je ntfy-Ziel. */
export function subscribeInfo(settings: Pick<PushSettings, "topic" | "ntfyTarget">, ntfyPublicUrl: string | null): PushSubscribeInfo {
  if (settings.ntfyTarget === "ntfy_sh") {
    return {
      target: "ntfy_sh",
      serverUrl: NTFY_SH_URL,
      topic: settings.topic,
      reachable: true,
      note: t("Geht sofort, ohne Tailscale. Titel und Text laufen dabei über den öffentlichen Dienst ntfy.sh – mitlesen kann nur, wer das geheime Thema kennt."),
    };
  }
  if (ntfyPublicUrl) {
    return { target: "own", serverUrl: ntfyPublicUrl, topic: settings.topic, reachable: true, note: t("Eigener ntfy-Dienst auf dem Server, erreichbar über Tailscale. Das iPhone muss dafür in Tailscale angemeldet sein.") };
  }
  return {
    target: "own",
    serverUrl: null,
    topic: settings.topic,
    reachable: false,
    note: t("Der eigene ntfy-Dienst läuft, ist aber nur auf dem Server selbst erreichbar (kein öffentlicher Port). Das iPhone kommt erst mit Tailscale dran – bis dahin „ntfy.sh“ wählen."),
  };
}

export function registerPushRoutes(app: Hono<Env>, deps: PushRouteDeps): void {
  const { db, sender, ntfyPublicUrl } = deps;

  app.get("/api/push/settings", async (c) => {
    const settings = await loadOrInitSettings(db);
    // Thema/Zugriffs-Geheimnis bleibt serverseitig (GOAL: "geheim") — die Web-App braucht es nicht,
    // Versand läuft immer über den Server.
    const { topic: _topic, ...rest } = settings;
    return c.json(rest);
  });

  app.patch("/api/push/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = PushSettingsPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültige Einstellungen"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const updated = await patchSettings(db, parsed.data);
    const { topic: _topic, ...rest } = updated;
    return c.json(rest);
  });

  // Test über ALLE eingeschalteten Wege, ohne Ruhezeit/Bündelung und ohne `push_log` (ein Test soll
  // keine echte „wartet"-Meldung wegbündeln). Antwort: Ergebnis je Weg (✓/✗ mit Grund).
  app.post("/api/push/test", async (c) => {
    const settings = await loadOrInitSettings(db);
    const res = await sender.send({
      topic: settings.topic,
      kind: "test",
      title: t("Test-Mitteilung"),
      message: t("NyxOS: Mitteilungen kommen an."),
      priority: "default",
      clickUrl: null,
      path: "/settings",
      channels: settings.channels,
      ntfyTarget: settings.ntfyTarget,
    });
    const results: PushChannelResult[] = res.channels ?? [{ channel: "ntfy", ok: res.ok, detail: res.ok ? t("Übergeben.") : t("Fehlgeschlagen ({status}).", { status: res.status }) }];
    return c.json({ results } satisfies PushTestResponse);
  });

  // alles zum Abonnieren in der iPhone-App ntfy. Das Thema ist das Geheimnis — deshalb nur hier, hinter
  // der Anmeldung, und nicht in `GET /api/push/settings`.
  app.get("/api/push/subscribe", async (c) => {
    const settings = await loadOrInitSettings(db);
    return c.json(subscribeInfo(settings, ntfyPublicUrl));
  });

  app.post("/api/push/notify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = PushNotifySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiger Anlass"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const settings = await loadOrInitSettings(db);
    const result = await notify(parsed.data, { db, sender, settings });
    return c.json(result);
  });

  app.get("/api/push/log", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const rows = await db.select().from(pushLog).orderBy(desc(pushLog.sentAt)).limit(limit);
    return c.json({ rows });
  });
}
