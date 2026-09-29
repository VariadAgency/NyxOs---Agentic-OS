// Einstellungen → Telegram (Registrierung in app.ts eine Zeile). Anmeldung + CSRF gelten wie für alle
// schreibenden /api-Wege. Das Bot-Token geht nur hinein, nie heraus (Antwort: „gesetzt“ + letzte 4 Zeichen).
//   GET    /api/telegram/status     Zustand (verbunden als @bot / wartet auf Token + Anleitung), Kopplung, Ziel
//   PUT    /api/telegram/token      Token eintragen (Geheimnis-Speicher) → Bot startet neu
//   DELETE /api/telegram/token      Token entfernen → Bot aus
//   POST   /api/telegram/pairing    Kopplungs-Code erzeugen (8 Zeichen, 1 h)
//   DELETE /api/telegram/pairing    Entkoppeln
//   PATCH  /api/telegram/settings   Sprache, Echo, Meldungen, Ruhezeiten
//   POST   /api/telegram/test       Test-Nachricht an den Nutzer
import { TelegramSettingsPatchSchema, TelegramTokenBodySchema, t } from "@nyxos/shared";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import { PairingLockedError, type TelegramService } from "../telegram/service.js";

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function registerTelegramRoutes(app: Hono<Env>, telegram: TelegramService): void {
  app.get("/api/telegram/status", async (c) => c.json(await telegram.status()));

  app.put("/api/telegram/token", async (c) => {
    const parsed = TelegramTokenBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Das sieht nicht wie ein Bot-Token aus. Es hat die Form 123456789:ABC… – bitte bei @BotFather kopieren.") }, 400);
    const st = await telegram.status();
    if (!st.token.canEdit) return c.json({ error: st.token.editHint ?? t("Das Token kann hier gerade nicht gespeichert werden.") }, 409);
    try {
      await telegram.setToken(parsed.data.token);
    } catch {
      return c.json({ error: t("Das Token konnte nicht sicher gespeichert werden. Der Schlüssel-Speicher ist noch nicht bereit.") }, 503);
    }
    return c.json(await telegram.status());
  });

  app.delete("/api/telegram/token", async (c) => {
    await telegram.clearToken();
    return c.json(await telegram.status());
  });

  app.post("/api/telegram/pairing", async (c) => {
    if (!telegram.isConnected) return c.json({ error: t("Erst das Bot-Token eintragen – sobald der Bot verbunden ist, gibt es hier den Code.") }, 409);
    try {
      return c.json(await telegram.createPairing());
    } catch (e) {
      if (e instanceof PairingLockedError) return c.json({ error: t("Zu viele falsche Codes – die Kopplung ist für eine Stunde gesperrt."), lockedUntil: e.lockedUntil }, 423);
      throw e;
    }
  });

  app.delete("/api/telegram/pairing", async (c) => {
    await telegram.unpair();
    return c.json(await telegram.status());
  });

  app.patch("/api/telegram/settings", async (c) => {
    const parsed = TelegramSettingsPatchSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Ungültige Einstellung") }, 400);
    await telegram.patchSettings(parsed.data);
    return c.json(await telegram.status());
  });

  app.post("/api/telegram/test", async (c) => {
    const r = await telegram.notifyUser({ text: t("👋 Test aus NyxOS – Telegram ist verbunden."), urgent: true });
    if (r.sent) return c.json(r);
    const why = { no_bot: t("Der Bot ist nicht verbunden."), not_paired: t("Noch nicht gekoppelt – erst den Code an den Bot schicken."), quiet_hours: "Ruhezeit.", send_failed: t("Telegram hat die Nachricht nicht angenommen.") }[r.reason];
    return c.json({ ...r, error: why }, 409);
  });
}
