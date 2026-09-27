// Reiter „Dateien“ (nur lesen). Logik in ../files/query.ts.
import { FILE_AREAS, FILE_MODES, type FileAreaId, type FileModeFilter, t } from "@nyxos/shared";
import type { Hono } from "hono";
import type { Db } from "../db/client.js";
import { listTouchedFiles, sessionsForFile } from "../files/query.js";

type Env = { Variables: { machineId: string } };

export function registerFilesRoutes(app: Hono<Env>, ctx: { db: Db }): void {
  const { db } = ctx;

  app.get("/api/files", async (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const modeRaw = c.req.query("mode");
    const areaRaw = c.req.query("area");
    const mode = FILE_MODES.includes(modeRaw as FileModeFilter) ? (modeRaw as FileModeFilter) : "alle";
    const area = FILE_AREAS.some((a) => a.id === areaRaw) ? (areaRaw as FileAreaId) : undefined;
    return c.json(await listTouchedFiles(db, { q, mode, area }));
  });

  app.get("/api/files/sessions", async (c) => {
    const path = c.req.query("path") ?? "";
    // FX: fehlende Angabe ist eine falsche Anfrage (400), kein „gibt es nicht“ — sonst hält die
    // Verbindungs-Prüfung die Route für nicht deployt.
    if (!path || path.length > 2000) return c.json({ error: t("Welche Datei? Bitte eine Datei aus der Liste wählen.") }, 400);
    return c.json({ path, sessions: await sessionsForFile(db, path) });
  });
}
