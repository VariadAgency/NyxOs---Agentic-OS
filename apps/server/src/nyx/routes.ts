// API des Nyx-Kerns für den Nyx-Tab, den Begleiter und Telegram. Nur hinter der
// Passkey-Anmeldung (alles unter /api, s. terminal/auth.ts). Die UI baut N2 – hier nur Daten und Befehle.
import { NyxMemoryCreateSchema, NyxMemoryPatchSchema, NyxScheduleCreateSchema, NyxSchedulePatchSchema, NyxSuggestionDecisionSchema, t } from "@nyxos/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";
import type { LiveHub } from "../live.js";
import type { NyxCore } from "./index.js";
import { applyMemoryOps, decideSuggestion, deleteMemoryEntry, memoryView, updateMemoryEntry } from "./memory.js";
import { createSchedule, deleteSchedule, listSchedules, patchSchedule } from "./schedules.js";
import { searchChats } from "./sessionSearch.js";
import { getTodos } from "./todo.js";

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function registerNyxRoutes(app: Hono<Env>, deps: { db: Db; hub: LiveHub; core: NyxCore }): void {
  const { db, hub, core } = deps;
  const changed = (what: string) => hub.broadcast({ type: "nyx.memory", what });

  // ─── Gedächtnis (Tab: Liste, hinzufügen, bearbeiten, vergessen; Vorschläge abhaken) ───
  app.get("/api/nyx/memory", async (c) => c.json(await memoryView(db)));

  app.post("/api/nyx/memory", async (c) => {
    const body = NyxMemoryCreateSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: t("Bitte Bereich und einen Satz (mindestens 3 Zeichen) angeben.") }, 400);
    const r = await applyMemoryOps(db, [{ action: "add", category: body.data.category, content: body.data.fact }], { createdBy: "user" });
    if (!r.ok) return c.json({ error: r.error }, 400);
    changed("entries");
    return c.json(await memoryView(db));
  });

  app.patch("/api/nyx/memory/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const body = NyxMemoryPatchSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: t("Nichts zu ändern.") }, 400);
    const r = await updateMemoryEntry(db, id, body.data);
    if ("error" in r) return c.json({ error: r.error }, r.status);
    changed("entries");
    return c.json(r);
  });

  app.delete("/api/nyx/memory/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    if (!(await deleteMemoryEntry(db, id))) return c.json({ error: t("Diesen Eintrag gibt es nicht mehr.") }, 404);
    changed("entries");
    return c.json({ ok: true });
  });

  app.post("/api/nyx/memory/suggestions/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const body = NyxSuggestionDecisionSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: t("Annehmen oder ablehnen?") }, 400);
    const r = await decideSuggestion(db, id, body.data.accept);
    if ("error" in r) return c.json({ error: r.error }, r.status);
    changed("suggestions");
    return c.json(r);
  });

  // ─── Plan / To-do eines Fadens (Aufgaben live) ───
  app.get("/api/nyx/todos/:threadId", async (c) => {
    const id = parseSerialId(c.req.param("threadId"));
    if (id === null) return c.json(NOT_FOUND, 404);
    return c.json(await getTodos(db, id));
  });

  // ─── Chat-Suche (auch für die Suche im Tab) ───
  app.get("/api/nyx/search", async (c) => {
    const thread = c.req.query("thread") ? parseSerialId(c.req.query("thread") ?? "") : null;
    const around = c.req.query("around") ? parseSerialId(c.req.query("around") ?? "") : null;
    return c.json(await searchChats(db, { query: c.req.query("q") ?? undefined, threadId: thread ?? undefined, aroundMessageId: around ?? undefined, after: c.req.query("after") ?? undefined, before: c.req.query("before") ?? undefined }));
  });

  // ─── Verdichten (Knopf im Tab, Telegram `/compact`) ───
  app.post("/api/nyx/threads/:id/compact", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const body = z.object({ focus: z.string().trim().max(200).optional() }).safeParse((await readJson(c)) ?? {});
    const r = await core.compact(id, body.success ? (body.data.focus ?? null) : null);
    if (!r.ok) return c.json({ error: t("Diesen Chat gibt es nicht.") }, 404);
    hub.broadcast({ type: "haiku", what: "threads" });
    return c.json(r);
  });

  // ─── Geplante Aufgaben ───
  app.get("/api/nyx/schedules", async (c) => c.json({ schedules: await listSchedules(db) }));

  app.post("/api/nyx/schedules", async (c) => {
    const body = NyxScheduleCreateSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: t("Name, Auftrag und Zeitpunkt fehlen oder passen nicht."), issues: body.error.issues.slice(0, 5) }, 400);
    const r = await createSchedule(db, body.data, { createdBy: "user" });
    if (!r.ok) return c.json({ error: r.error }, 400);
    hub.broadcast({ type: "nyx.schedule", id: r.schedule.id });
    return c.json({ schedule: r.schedule });
  });

  app.patch("/api/nyx/schedules/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const body = NyxSchedulePatchSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: t("Ungültige Änderung.") }, 400);
    const s = await patchSchedule(db, id, body.data);
    if (!s) return c.json(NOT_FOUND, 404);
    hub.broadcast({ type: "nyx.schedule", id });
    return c.json({ schedule: s });
  });

  app.delete("/api/nyx/schedules/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    if (!(await deleteSchedule(db, id))) return c.json(NOT_FOUND, 404);
    hub.broadcast({ type: "nyx.schedule", id });
    return c.json({ ok: true });
  });

  app.post("/api/nyx/schedules/:id/run", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const r = await core.runner.runNow(id);
    if (!r) return c.json(NOT_FOUND, 404);
    hub.broadcast({ type: "nyx.schedule", id });
    return c.json(r);
  });

  // ─── Simulator-Screenshot per Knopf (gleicher Weg wie das Werkzeug) ───
  app.post("/api/nyx/screenshot", async (c) => {
    const r = await core.callTool("screenshot_simulator", {});
    return c.json(r as object);
  });
}
