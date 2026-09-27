// Skill-Bibliothek (eigene Routen-Datei). Logik in ../skills/.
//   GET   /api/skills                              Kacheln (Stand von der Brücke, Nutzung inkrementell)
//   POST  /api/skills/sync                         jetzt neu einlesen
//   GET   /api/skills/:key                         Detail: Inhalt, Dateien, Nutzungen, Verlauf, Vorschläge, Aufträge
//   GET   /api/skills/:key/versions/:id            ein Stand + der davor (Vergleich)
//   POST  /api/skills/:key/versions/:id/restore    Rückgängig (Brücke sichert vorher, prüft den Hash)
//   GET   /api/skills/:key/file?rel=…              Zusatzdatei lesen
//   POST  /api/skills/:key/pin                     anpinnen = keine Vorschläge
//   PATCH /api/skills/suggestions/:id              Vorschlag verwerfen / wieder öffnen
//   POST  /api/skills/jobs                         Opus-5.5-Auftrag (Neuer Skill / Verbessern / Vorschlag umsetzen)
import { SkillJobRequestSchema, t } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { startSkillJob } from "../skills/jobs.js";
import { SkillService, SkillServiceError } from "../skills/library.js";
import { haikuSuggestionWriter, type SuggestionWriter } from "../skills/suggest.js";

export interface SkillsRouteOptions {
  /** Tests: eigener Vorschlags-Schreiber statt Haiku (`null` = keiner, dann nur Regel-Text). */
  writer?: SuggestionWriter | null;
}

export interface SkillsRouteDeps extends SkillsRouteOptions {
  db: Db;
  bridgeHub: BridgeHub;
  runtime: HaikuRuntime | null;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  notify: () => void;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const PinSchema = z.object({ pinned: z.boolean() });
const SuggestionPatchSchema = z.object({ status: z.enum(["open", "verworfen"]) });

export function registerSkillsRoutes(app: Hono<Env>, deps: SkillsRouteDeps): SkillService {
  const writer = deps.writer !== undefined ? deps.writer : deps.runtime ? haikuSuggestionWriter(deps.runtime) : null;
  const service = new SkillService({ db: deps.db, bridgeHub: deps.bridgeHub, log: deps.log, writer, notify: deps.notify });

  const fail = (c: Context<Env>, e: unknown) => {
    if (e instanceof SkillServiceError) return c.json({ error: e.message }, e.status);
    deps.log("skills-fehler", { error: e instanceof Error ? e.message : String(e) });
    return c.json({ error: t("Das hat nicht geklappt – bitte gleich noch einmal.") }, 500);
  };

  app.get("/api/skills", async (c) => c.json(await service.overview()));

  app.post("/api/skills/sync", async (c) => {
    const bridge = await service.sync(true);
    return c.json({ bridge });
  });

  app.post("/api/skills/jobs", async (c) => {
    const parsed = SkillJobRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Bitte Name (klein, mit Bindestrichen) und eine kurze Beschreibung angeben.") }, 400);
    try {
      return c.json(await startSkillJob(service, deps.db, parsed.data));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.patch("/api/skills/suggestions/:id", async (c) => {
    const parsed = SuggestionPatchSchema.safeParse(await readJson(c));
    const id = Number(c.req.param("id"));
    if (!parsed.success || !Number.isInteger(id)) return c.json({ error: t("Ungültige Angaben") }, 400);
    if (!(await service.setSuggestionStatus(id, parsed.data.status))) return c.json({ error: t("Diesen Vorschlag gibt es nicht mehr.") }, 404);
    deps.notify();
    return c.json({ id, status: parsed.data.status });
  });

  app.get("/api/skills/:key", async (c) => {
    const detail = await service.detail(c.req.param("key"));
    return detail ? c.json(detail) : c.json({ error: t("Diesen Skill gibt es nicht.") }, 404);
  });

  app.get("/api/skills/:key/versions/:id", async (c) => {
    const v = await service.version(c.req.param("key"), Number(c.req.param("id")));
    return v ? c.json(v) : c.json({ error: t("Diesen Stand gibt es nicht.") }, 404);
  });

  app.post("/api/skills/:key/versions/:id/restore", async (c) => {
    try {
      return c.json({ version: await service.restore(c.req.param("key"), Number(c.req.param("id"))) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/api/skills/:key/file", async (c) => {
    try {
      return c.json(await service.file(c.req.param("key"), c.req.query("rel") ?? ""));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/skills/:key/pin", async (c) => {
    const parsed = PinSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Feld 'pinned' fehlt") }, 400);
    if (!(await service.setPinned(c.req.param("key"), parsed.data.pinned))) return c.json({ error: t("Diesen Skill gibt es nicht.") }, 404);
    deps.notify();
    return c.json({ pinned: parsed.data.pinned });
  });

  return service;
}
