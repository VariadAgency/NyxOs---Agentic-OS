// Routes for the settings page "Mitteilungen" (and Nyx' `app_api`: read/change like the user).
//   GET   /api/notifications/settings                rules + channels/quiet hours + away + example session + Nyx ready
//   PATCH /api/notifications/settings                { rules?, push?, away? } – quiet hours are set equally for both systems
//   GET   /api/notifications/history?limit=50        last notifications with reason + rule suggestions
//   POST  /api/notifications/history/:id/feedback    { value: "passt" | "unnoetig" } → maybe a rule suggestion
//   POST  /api/notifications/preview                 example occasion with the current settings (optionally with Nyx)
import {
  NOTIFY_OCCASIONS,
  NotifyFeedbackSchema,
  NotifyPreviewRequestSchema,
  NotifySettingsPatchSchema,
  renderNotification,
  t,
  type NotifyFeedbackResponse,
  type NotifyHistoryResponse,
  type NotifyPreviewResponse,
  type NotifySample,
  type NotifySettingsResponse,
} from "@nyxos/shared";
import { and, desc, isNotNull, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { AwayService } from "../away/service.js";
import { patchAwaySettings } from "../away/settings.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { countedSession } from "../db/visible.js";
import { computeSuggestions, listHistory, recordFeedback } from "../notifications/history.js";
import { askNyxAboutNotification, type NyxRunner } from "../notifications/nyx.js";
import { clockTime } from "../notifications/pipeline.js";
import { loadNotifyRules, patchNotifyRules } from "../notifications/rules.js";
import { detailsFrom, loadSessionInfo, type NotifySessionInfo } from "../notifications/session-info.js";
import { loadOrInitSettings, patchSettings } from "../push/settings.js";

export interface NotificationRouteDeps {
  db: Db;
  away: AwayService;
  /** Nyx runtime for "Mit Nyx ausprobieren" (available only after setup). */
  runtime: () => NyxRunner | null;
  /** Is a model for Nyx set up and reachable (without budget check)? Without it: never ready. */
  nyxReady?: () => Promise<boolean>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Example for the preview while there is no session yet (translated when used). */
function fallbackSample(): NotifySample {
  return { session: t("Anmeldung umbauen"), baustelle: t("Beispiel-Projekt") };
}

/** The last active real session (no sub-agents, no test runs) – so the preview shows real names. */
async function sampleSession(db: Db): Promise<NotifySessionInfo | null> {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(isNull(sessions.parentId), countedSession, isNotNull(sessions.lastActivityAt)))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(1);
  return row ? loadSessionInfo(db, row.id) : null;
}

async function readAll(deps: NotificationRouteDeps): Promise<NotifySettingsResponse> {
  const [rules, push, status, sample, nyxReady] = await Promise.all([
    loadNotifyRules(deps.db),
    loadOrInitSettings(deps.db),
    deps.away.status(),
    sampleSession(deps.db),
    deps.nyxReady ? deps.nyxReady().catch(() => false) : Promise.resolve(false),
  ]);
  const { topic: _topic, ...publicPush } = push;
  return {
    rules,
    push: publicPush,
    away: status.settings,
    presence: { away: status.away, lastSeenAt: status.lastSeenAt },
    sample: sample ? { session: sample.name, baustelle: sample.baustelle } : fallbackSample(),
    nyxReady: nyxReady && deps.runtime() !== null,
  };
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function registerNotificationRoutes(app: Hono<Env>, deps: NotificationRouteDeps): void {
  const { db } = deps;

  app.get("/api/notifications/settings", async (c) => c.json(await readAll(deps)));

  app.patch("/api/notifications/settings", async (c) => {
    const parsed = NotifySettingsPatchSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: t("Ungültige Einstellungen"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const { rules, push, away } = parsed.data;
    if (rules) await patchNotifyRules(db, rules);
    if (push) await patchSettings(db, push);
    if (away) deps.away.setCached(await patchAwaySettings(db, away));
    return c.json(await readAll(deps));
  });

  app.get("/api/notifications/history", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const [items, rules] = await Promise.all([listHistory(db, limit), loadNotifyRules(db)]);
    return c.json({ items, suggestions: await computeSuggestions(db, rules) } satisfies NotifyHistoryResponse);
  });

  app.post("/api/notifications/history/:id/feedback", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: t("Unbekannte Mitteilung") }, 404);
    const body = (await jsonBody(c)) as { value?: unknown } | undefined;
    const value = NotifyFeedbackSchema.safeParse(body?.value);
    if (!value.success) return c.json({ error: t("Rückmeldung muss „passt“ oder „unnoetig“ sein") }, 400);
    const res = await recordFeedback(db, id, value.data, await loadNotifyRules(db));
    if (!res) return c.json({ error: t("Unbekannte Mitteilung") }, 404);
    return c.json({ ok: true, suggestion: res.suggestion } satisfies NotifyFeedbackResponse);
  });

  app.post("/api/notifications/preview", async (c) => {
    const parsed = NotifyPreviewRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: t("Ungültige Vorschau"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const req = parsed.data;
    const rules = await loadNotifyRules(db);
    const meta = NOTIFY_OCCASIONS[req.kind];
    const info = meta.session ? await sampleSession(db) : null;
    const now = new Date();
    const fallback = fallbackSample();
    const values = {
      session: meta.session ? (info?.name ?? fallback.session) : null,
      baustelle: meta.session ? (info ? info.baustelle : fallback.baustelle) : null,
      was: t(meta.sample.was),
      wann: clockTime(now),
      details: detailsFrom(info) ?? t(meta.sample.details),
    };
    const style = req.style ?? rules.style;
    const template = req.template === undefined ? (rules.templates[req.kind] ?? null) : req.template;
    let text = renderNotification(req.kind, style, values, template);
    let nyx: NotifyPreviewResponse["nyx"] = null;
    const runner = req.withNyx ? deps.runtime() : null;
    if (req.withNyx && !runner) nyx = { note: t("Nyx ist gerade nicht erreichbar") };
    if (runner) {
      // Trial: check AND write, so the user sees what Nyx would make of this occasion.
      const out = await askNyxAboutNotification(
        { runner, log: deps.log },
        { kind: req.kind, kindLabel: t(meta.label), priority: "default", away: false, time: values.wann, style, title: text.title, body: text.body, was: values.was, details: values.details, session: info, important: rules.important, examples: [], review: true, write: true },
      );
      nyx = {};
      if (out.review) {
        if ("decision" in out.review) {
          nyx.decision = out.review.decision;
          nyx.review = out.review.decision;
          nyx.note = out.review.reason;
        } else {
          nyx.review = out.review.failed;
          nyx.note = out.review.note;
        }
      }
      if (out.text) {
        if ("title" in out.text) {
          text = out.text;
          nyx.wrote = "nyx";
        } else {
          nyx.wrote = "vorlage";
          nyx.note = nyx.note ?? t("Eigener Text verworfen ({reason})", { reason: out.text.failed });
        }
      }
    }
    return c.json({ ...text, time: values.wann, nyx } satisfies NotifyPreviewResponse);
  });
}
