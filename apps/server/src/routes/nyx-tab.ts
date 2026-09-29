// Nyx-Tab (Server-Teil): Live-Stand für einen frisch geöffneten Tab, Meldungen von außerhalb des
// Prozesses (z. B. Brücke) und die Ablage für Bilder/Anhänge. Registrierung in app.ts eine Zeile.
import { NYX_FILE_MAX_BYTES, NyxStateEventSchema, NyxTaskEventSchema, type NyxFileKind, t } from "@nyxos/shared";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Env } from "../app.js";
import type { Db } from "../db/client.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";
import type { LiveHub } from "../live.js";
import { isInlineImage, listNyxFiles, readNyxFile, storeNyxFile } from "../nyx/files.js";
import { nyxLiveSnapshot, publishNyxState, publishNyxTask } from "../nyx/live.js";

export interface NyxTabRouteDeps {
  db: Db;
  hub: LiveHub;
  archiveDir: string;
}

const EventBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state"), event: NyxStateEventSchema }),
  z.object({ kind: z.literal("task"), event: NyxTaskEventSchema }),
]);

/** RFC 6266: ASCII-Ersatz + UTF-8-Fassung, damit Umlaute im Dateinamen beim Herunterladen erhalten bleiben. */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerNyxTabRoutes(app: Hono<Env>, deps: NyxTabRouteDeps): void {
  const { db, hub, archiveDir } = deps;

  app.get("/api/nyx/live", (c) => {
    c.header("cache-control", "no-store");
    return c.json(nyxLiveSnapshot(hub));
  });

  // Für Teile außerhalb des Server-Prozesses (Brücke, Arbeiter-Container). Nur angemeldet (POST unter /api/).
  app.post("/api/nyx/events", async (c) => {
    const body = EventBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: t("Diese Meldung kann Nyx nicht anzeigen.") }, 400);
    const ok = body.data.kind === "state" ? publishNyxState(hub, body.data.event) : publishNyxTask(hub, body.data.event);
    return ok ? c.json({ ok: true }) : c.json({ error: t("Diese Meldung kann Nyx nicht anzeigen.") }, 400);
  });

  app.get("/api/nyx/files", async (c) => {
    const k = c.req.query("kind");
    const kind: NyxFileKind | null = k === "image" || k === "upload" ? k : null;
    c.header("cache-control", "no-store");
    return c.json({ files: await listNyxFiles(db, kind) });
  });

  // der Nutzer gibt Nyx eine Datei (Hochladen/Einfügen im Reiter „Dateien & Links“). Roh-Body, Name im Kopf.
  app.post(
    "/api/nyx/files",
    bodyLimit({ maxSize: NYX_FILE_MAX_BYTES, onError: (c) => c.json({ error: t("Die Datei ist zu groß – höchstens 20 MB.") }, 413) }),
    async (c) => {
      const rawName = c.req.header("x-nyx-file-name");
      if (!rawName) return c.json({ error: t("Der Dateiname fehlt – bitte die Datei noch einmal hineinziehen.") }, 400);
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
      const bytes = Buffer.from(await c.req.arrayBuffer());
      if (bytes.length === 0) return c.json({ error: t("Die Datei ist leer.") }, 400);
      if (bytes.length > NYX_FILE_MAX_BYTES) return c.json({ error: t("Die Datei ist zu groß – höchstens 20 MB.") }, 413);
      const threadId = parseSerialId(c.req.header("x-nyx-thread") ?? null);
      const file = await storeNyxFile(db, archiveDir, hub, { bytes, mime: c.req.header("content-type") ?? "application/octet-stream", name, source: "upload", threadId });
      return c.json({ file });
    },
  );

  app.get("/api/nyx/files/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const found = await readNyxFile(db, archiveDir, id);
    if (!found) return c.json(NOT_FOUND, 404);
    const { row, bytes } = found;
    const inline = isInlineImage(row.mime) && c.req.query("download") !== "1";
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "private, max-age=3600");
    // Nur sichere Bild-Arten mit ihrem echten Typ; alles andere als neutrale Bytes (nie HTML/SVG im Browser ausführen).
    c.header("content-type", isInlineImage(row.mime) ? row.mime : "application/octet-stream");
    c.header("content-disposition", contentDisposition(inline ? "inline" : "attachment", row.name));
    return c.body(new Uint8Array(bytes));
  });
}
