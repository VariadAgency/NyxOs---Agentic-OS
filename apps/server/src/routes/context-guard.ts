// Kontext-Wächter — Routen (eigene Datei, in app.ts nur eine Registrierungszeile).
// Schreibende Wege brauchen keine eigene Anmelde-Prüfung: `auth.gate` (terminal/auth.ts) schützt
// automatisch jeden nicht-GET-Pfad unter /api/* (Passkey-Cookie + CSRF-Kopf), s. `needsAuth`.
import { ContextGuardThresholdsInputSchema, TMUX_NAME_RE, t } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import type { Db } from "../db/client.js";
import { contextGuardEvents, contextGuardState, sessions } from "../db/schema.js";
import type { LiveHub } from "../live.js";
import {
  deleteModelOverride,
  deleteSessionOverride,
  loadSnapshot,
  resolveForSession,
  saveDefault,
  saveHaiku,
  saveModelOverride,
  saveSessionOverride,
} from "../context-guard/store.js";
import type { ContextPctSource } from "../context-guard/tick.js";
import { claimSend, COMPACT_TTL_HOURS, deliverOrQueue, releaseSend } from "../delivery/queue.js";

export interface ContextGuardRouteDeps {
  db: Db;
  hub: LiveHub;
  bridgeHub: BridgeHub;
  /** Dieselbe Quelle wie der Ticker (s. `context-guard/tick.ts` `ContextPctSource`) — injiziert, damit
   * Server und Ticker nie zwei verschiedene Werte für dieselbe Session zeigen. */
  getContextPct: ContextPctSource;
  isHaiku?: (session: { models: string[] }) => boolean;
}

async function findSession(db: Db, idOrUuid: string) {
  const where = idOrUuid.includes(":") ? eq(sessions.id, idOrUuid) : eq(sessions.sessionId, idOrUuid);
  const [row] = await db.select().from(sessions).where(where).limit(1);
  return row ?? null;
}

/** `decodeURIComponent` wirft bei ungültiger %-Kodierung (z. B. ein einzelnes `%`)
 * einen `URIError` — ungefangen würde daraus ein 500er statt einer sauberen 400-Antwort. */
function decodeModelParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function parseThresholds(c: { req: { json: () => Promise<unknown> } }) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false as const, error: t("Kein gültiges JSON") };
  }
  const parsed = ContextGuardThresholdsInputSchema.safeParse(body);
  if (!parsed.success) return { ok: false as const, error: t("Ungültige Schwellen"), issues: parsed.error.issues.slice(0, 5) };
  return { ok: true as const, value: parsed.data };
}

export function registerContextGuardRoutes(app: Hono<AppEnv>, deps: ContextGuardRouteDeps): void {
  const { db, bridgeHub } = deps;
  const isHaiku = deps.isHaiku ?? ((s: { models: string[] }) => s.models.some((m) => /haiku/i.test(m)));

  app.get("/api/context-guard/settings", async (c) => c.json(await loadSnapshot(db)));

  app.put("/api/context-guard/settings/default", async (c) => {
    const parsed = await parseThresholds(c);
    if (!parsed.ok) return c.json({ error: parsed.error, issues: "issues" in parsed ? parsed.issues : undefined }, 400);
    return c.json(await saveDefault(db, parsed.value));
  });

  app.put("/api/context-guard/settings/haiku", async (c) => {
    const parsed = await parseThresholds(c);
    if (!parsed.ok) return c.json({ error: parsed.error, issues: "issues" in parsed ? parsed.issues : undefined }, 400);
    return c.json(await saveHaiku(db, parsed.value));
  });

  app.put("/api/context-guard/settings/model/:model", async (c) => {
    const model = decodeModelParam(c.req.param("model"));
    if (model === null) return c.json({ error: t("Ungültiger Modellname") }, 400);
    const parsed = await parseThresholds(c);
    if (!parsed.ok) return c.json({ error: parsed.error, issues: "issues" in parsed ? parsed.issues : undefined }, 400);
    return c.json(await saveModelOverride(db, model, parsed.value));
  });

  app.delete("/api/context-guard/settings/model/:model", async (c) => {
    const model = decodeModelParam(c.req.param("model"));
    if (model === null) return c.json({ error: t("Ungültiger Modellname") }, 400);
    const deleted = await deleteModelOverride(db, model);
    return c.json({ ok: deleted });
  });

  app.put("/api/context-guard/settings/session/:id", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json({ error: t("Nicht gefunden") }, 404);
    const parsed = await parseThresholds(c);
    if (!parsed.ok) return c.json({ error: parsed.error, issues: "issues" in parsed ? parsed.issues : undefined }, 400);
    const row = await saveSessionOverride(db, session.id, parsed.value);
    deps.hub.broadcast({ type: "context_guard", sessionId: session.id });
    return c.json(row);
  });

  app.delete("/api/context-guard/settings/session/:id", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json({ error: t("Nicht gefunden") }, 404);
    const deleted = await deleteSessionOverride(db, session.id);
    deps.hub.broadcast({ type: "context_guard", sessionId: session.id });
    return c.json({ ok: deleted });
  });

  // Live-Zustand einer Session fürs Badge/Ring im Vollbild-Kopf.
  app.get("/api/context-guard/sessions/:id", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json({ error: t("Nicht gefunden") }, 404);
    const model = session.models[session.models.length - 1] ?? null;
    const thresholds = await resolveForSession(db, { sessionKey: session.id, model, isHaiku: isHaiku(session) });
    const pct = deps.getContextPct(session);
    const [state] = await db.select().from(contextGuardState).where(eq(contextGuardState.sessionKey, session.id)).limit(1);
    return c.json({
      sessionKey: session.id,
      thresholds,
      pct,
      hint: !!state?.hinweisNotifiedAt,
      forced: !!state?.erzwingenAttemptedAt,
      attachable: session.attachable && !!session.tmuxName && TMUX_NAME_RE.test(session.tmuxName),
      state: session.state,
    });
  });

  // "Jetzt komprimieren" — nur bei einer Session in der NyxOS (sonst gibt es keinen Weg, ihr Text zu
  // schicken). nie blind tippen, `/compact` + Enter könnte sonst in einer offenen
  // Freigabe-Frage oder in des Nutzers angefangenem Text landen.
  // - Badge „Jetzt komprimieren“ (ohne Angabe): sofort, wenn Hook UND Bildschirm „wartet“ sagen, sonst
  //   in die Zustell-Warteschlange („geht raus, sobald sie wartet“, höchstens einmal je Session).
  // - D3 Knopf „Kontext komprimieren“ (`{ onlyWhenWaiting: true }`): ehrliche Absage statt Warten.
  app.post("/api/context-guard/sessions/:id/compact-now", async (c) => {
    const session = await findSession(db, c.req.param("id"));
    if (!session) return c.json({ error: t("Nicht gefunden") }, 404);
    let onlyWhenWaiting = false;
    try {
      const body = (await c.req.json()) as { onlyWhenWaiting?: unknown } | null;
      onlyWhenWaiting = body?.onlyWhenWaiting === true;
    } catch {
      // kein Körper: bisheriges Verhalten
    }
    if (!session.attachable || !session.tmuxName || !TMUX_NAME_RE.test(session.tmuxName)) {
      // kein „tmux“ in der Meldung — sagen, was los ist und was der Nutzer tun kann.
      return c.json({ error: t("Diese Session läuft in einem eigenen Fenster auf dem Rechner. Übernimm sie in NyxOS, dann geht das auch von hier.") }, 409);
    }
    if (onlyWhenWaiting && session.state !== "waiting") {
      return c.json({ error: t("Die Session arbeitet gerade. Komprimieren geht, sobald sie auf dich wartet.") }, 409);
    }
    if (!onlyWhenWaiting) {
      const r = await deliverOrQueue({ db, bridge: bridgeHub, hub: deps.hub }, { sessionKey: session.id, kind: "compact", text: "/compact", dedupeKey: "compact", ttlHours: COMPACT_TTL_HOURS });
      await db.insert(contextGuardEvents).values({
        sessionKey: session.id,
        kind: "manuell",
        pctAtTrigger: deps.getContextPct(session),
        action: r.status === "sent" ? "compact_sent" : r.status === "queued" ? "compact_queued" : "compact_failed",
        detail: { reason: r.status === "sent" ? null : r.reason },
      });
      deps.hub.broadcast({ type: "context_guard", sessionId: session.id });
      if (r.status === "rejected") return c.json({ error: r.reason }, 409);
      return c.json(r.status === "sent" ? { sent: true } : { sent: false, queued: true, reason: r.reason });
    }
    // Hook-Zustand als zweite Quelle, die Brücke prüft zusätzlich den Bildschirm (Eingabe-Block unten).
    // nie gleichzeitig mit einer Zustellung aus der Warteschlange (20-s-Sperre je Session).
    if (!claimSend(bridgeHub, session.id, Date.now())) return c.json({ error: t("Gerade ging schon etwas an die Session. Versuch es in ein paar Sekunden noch einmal.") }, 409);
    const outcome = await bridgeHub.rpc("send_text", { tmuxName: session.tmuxName, text: "/compact", submit: true, onlyWhenWaiting: true, hookWaiting: session.state === "waiting" });
    const result = outcome.result as { sent?: boolean; reason?: string } | undefined;
    releaseSend(bridgeHub, session.id, (outcome.ok && result?.sent === true) || (!outcome.ok && outcome.code === "timeout"), Date.now());
    await db.insert(contextGuardEvents).values({
      sessionKey: session.id,
      kind: "manuell",
      pctAtTrigger: deps.getContextPct(session),
      action: outcome.ok && result?.sent ? "compact_sent" : outcome.ok ? "compact_skipped_not_waiting" : "compact_failed",
      detail: { reason: result?.reason ?? outcome.error ?? null },
    });
    deps.hub.broadcast({ type: "context_guard", sessionId: session.id });
    if (!outcome.ok) return c.json({ error: outcome.error ?? "Fehlgeschlagen", code: outcome.code }, 502);
    return c.json(result ?? { sent: false });
  });
}
