// Nutzung (eigene Routen-Datei, in app.ts nur eine Registrierungszeile).
import { UsageIngestBatchSchema, UsageSettingsPatchSchema, t } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { prices } from "../db/schema.js";
import { ingestUsage, recomputeModelCost } from "../usage/ingest.js";
import { extractOtelUsageRows, withSessionProjects } from "../usage/otel.js";
import { seedPrices, updatePrice } from "../usage/pricing.js";
import { getDailyUsage, getExpensiveSessions, getLimits, getModelUsage, type Range } from "../usage/query.js";
import { getHourlyHeatmap, getUsageWindows } from "../usage/window.js";
import { getForecasts } from "../usage/forecast.js";
import { usageReadings } from "../usage/official.js";
import { getBaustellenUsage, getModelTrend, getUsageComparison } from "../usage/compare.js";
import { getGoalStatus } from "../usage/goals.js";
import { loadUsageSettings, patchUsageSettings } from "../usage/settings.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";

function parseRange(v: string | undefined): Range {
  return v === "7" || v === "30" || v === "all" ? v : "30";
}

export function registerUsageRoutes(app: Hono<Env>, db: Db, auth: MiddlewareHandler<Env>): void {
  // Von der Brücke (Bestand-Scan ALLER Projekte "Alle Projekte, aber ohne
  // Inhalte") — dasselbe Token wie /ingest/events, aber eigener Pfad, damit ein Fehler hier nie
  // den Session-Ingest blockiert.
  app.post("/ingest/usage", auth, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = UsageIngestBatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiges Paket"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const result = await ingestUsage(db, parsed.data.items);
    return c.json(result);
  });

  // OTel-Empfänger — gebaut + lokal getestet, aber NICHT eingeschaltet
  // (s. BETRIEB.md "Nutzung + Agenten & Skills"). Dasselbe Brücken-Token wie /ingest/usage.
  app.post("/ingest/otel/v1/metrics", auth, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const rows = await withSessionProjects(db, extractOtelUsageRows(body as Parameters<typeof extractOtelUsageRows>[0]));
    const result = await ingestUsage(db, rows);
    return c.json(result);
  });

  app.get("/api/usage/daily", async (c) => {
    const range = parseRange(c.req.query("range"));
    const toolRaw = c.req.query("tool");
    const tool = toolRaw === "claude" || toolRaw === "codex" ? toolRaw : undefined;
    return c.json({ days: await getDailyUsage(db, range, tool) });
  });

  app.get("/api/usage/models", async (c) => {
    const range = parseRange(c.req.query("range"));
    return c.json({ models: await getModelUsage(db, range) });
  });

  app.get("/api/usage/sessions", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 10) || 10, 1), 50);
    return c.json({ sessions: await getExpensiveSessions(db, limit) });
  });

  // Heatmap Tag × Stunde (Zeitzone des Nutzers) für den gewählten Zeitraum/Werkzeug.
  app.get("/api/usage/hourly", async (c) => {
    const range = parseRange(c.req.query("range"));
    const toolRaw = c.req.query("tool");
    const tool = toolRaw === "claude" || toolRaw === "codex" ? toolRaw : undefined;
    return c.json({ cells: await getHourlyHeatmap(db, range, tool) });
  });

  // Fenster-Stand je Werkzeug (5 Std/7 Tage + Spitzenwert + Anbieter-Meldung) für die Ringe.
  app.get("/api/usage/window", async (c) => {
    // dazu die Hochrechnung je Werkzeug und Fenster (Limit-Wecker), ehrlich ohne Daten.
    const now = new Date();
    const [windows, forecast] = await Promise.all([getUsageWindows(db, now), getLimits(db).then((l) => getForecasts(db, l, now))]);
    // woher die echten Claude-Werte gerade kommen — und wenn keine aktuell sind, warum (statt still).
    return c.json({ windows, forecast, official: usageReadings.status(now) });
  });

  // Vergleiche (Woche/Woche, Monat/Monat, Claude/Codex), Modelle im Verlauf, Baustellen.
  app.get("/api/usage/compare", async (c) => c.json(await getUsageComparison(db)));

  app.get("/api/usage/model-trend", async (c) => {
    const weeks = Math.min(Math.max(Number(c.req.query("weeks") ?? 12) || 12, 2), 52);
    return c.json(await getModelTrend(db, weeks));
  });

  app.get("/api/usage/baustellen", async (c) => c.json(await getBaustellenUsage(db, parseRange(c.req.query("range")))));

  // Einstellungen (Standard-Zeitraum, Ziele, Warnschwellen). Lesen offen wie alle GETs;
  // Schreiben schützt `auth.gate` (Anmeldung + CSRF-Kopf, s. terminal/auth.ts `needsAuth`).
  app.get("/api/usage/settings", async (c) => c.json(await loadUsageSettings(db)));

  app.patch("/api/usage/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Einstellungen nicht lesbar. Bitte noch einmal speichern.") }, 400);
    }
    const parsed = UsageSettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return c.json({ error: typeof field === "string" ? t("Einstellung „{field}\" hat einen ungültigen Wert.", { field }) : t("Einstellung hat einen ungültigen Wert."), issues: parsed.error.issues.slice(0, 5) }, 400);
    }
    return c.json(await patchUsageSettings(db, parsed.data));
  });

  app.get("/api/usage/goals", async (c) => c.json(await getGoalStatus(db, await loadUsageSettings(db))));

  app.get("/api/usage/limits", async (c) => {
    return c.json({ limits: await getLimits(db) });
  });

  app.get("/api/usage/prices", async (c) => {
    await seedPrices(db); // no-op, falls schon gesät (s. pricing.ts) — nie eine leere Liste knapp nach dem Start
    return c.json({ prices: await db.select().from(prices).orderBy(prices.model) });
  });

  app.patch("/api/usage/prices/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: Record<string, number | null> = {};
    for (const key of ["inputPerToken", "outputPerToken", "cacheReadPerToken", "cacheCreation5mPerToken", "cacheCreation1hPerToken", "contextWindow"] as const) {
      if (key in b) {
        const v = b[key];
        if (v !== null && typeof v !== "number") return c.json({ error: t("Feld '{key}' muss eine Zahl oder null sein", { key }) }, 400);
        patch[key] = v as number | null;
      }
    }
    if (Object.keys(patch).length === 0) return c.json({ error: t("Kein änderbares Feld angegeben") }, 400);
    const row = await updatePrice(db, id, patch);
    if (!row) return c.json({ error: "Nicht gefunden" }, 404);
    const recomputed = await recomputeModelCost(db, row.model);
    return c.json({ price: row, recomputedBuckets: recomputed });
  });

  app.get("/api/usage/prices/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const [row] = await db.select().from(prices).where(eq(prices.id, id)).limit(1);
    return row ? c.json({ price: row }) : c.json({ error: "Nicht gefunden" }, 404);
  });
}
