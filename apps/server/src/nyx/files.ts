// Ablage des Nyx-Tabs im Archiv-Volume (`<ARCHIVE_DIR>/nyx/`). Hier landen Bilder, die Nyx zeigt
// (`show_image`, `screenshot_simulator` aus N1), und Dateien, die der Nutzer Nyx gibt (Reiter „Dateien & Links“).
// Der Dateiname auf der Platte ist die Prüfsumme (kein Pfad aus der Anfrage erreicht je das Dateisystem),
// der Anzeigename steht nur in der DB. Ausgeliefert wird nur mit Anmeldung (`needsAuth`), Bilder nur in den
// sicheren Arten inline, alles andere immer als Download.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { NYX_INLINE_IMAGE_MIMES, type NyxFile, type NyxFileKind, type NyxFileSource } from "@nyxos/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { nyxFiles } from "../db/schema.js";
import type { LiveHub } from "../live.js";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
};

export function isInlineImage(mime: string): boolean {
  return (NYX_INLINE_IMAGE_MIMES as readonly string[]).includes(mime);
}

/** Anzeigename ohne Pfad und Steuerzeichen, höchstens 200 Zeichen. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- genau die Steuerzeichen sollen raus
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return clean.slice(0, 200) || "datei";
}

function nyxDir(archiveDir: string): string {
  return join(resolve(archiveDir), "nyx");
}

export function toNyxFile(r: typeof nyxFiles.$inferSelect): NyxFile {
  return {
    id: r.id,
    kind: r.kind as NyxFileKind,
    source: r.source as NyxFileSource,
    name: r.name,
    title: r.title,
    mime: r.mime,
    size: r.size,
    createdAt: r.createdAt,
    url: `/api/nyx/files/${r.id}`,
    downloadUrl: `/api/nyx/files/${r.id}?download=1`,
  };
}

export interface StoreNyxFileInput {
  bytes: Buffer;
  mime: string;
  name: string;
  title?: string | null;
  source: NyxFileSource;
  threadId?: number | null;
}

/**
 * Legt eine Datei ab (atomar: erst `.tmp`, dann umbenennen) und meldet sie live (`nyx.file`), damit die
 * Galerie und „Aufgaben live“ sie sofort zeigen. `show_image`/`screenshot_simulator` rufen genau das auf.
 */
export async function storeNyxFile(db: Db, archiveDir: string, hub: LiveHub | null, input: StoreNyxFileInput): Promise<NyxFile> {
  const mime = input.mime.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  const kind: NyxFileKind = isInlineImage(mime) ? "image" : "upload";
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const ext = EXT_BY_MIME[mime] ?? "bin";
  const rel = `${sha256.slice(0, 32)}.${ext}`;
  const dir = nyxDir(archiveDir);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  try {
    await writeFile(tmp, input.bytes, { mode: 0o600 });
    await rename(tmp, join(dir, rel));
  } finally {
    await rm(tmp, { force: true });
  }
  const [row] = await db
    .insert(nyxFiles)
    .values({
      kind,
      source: input.source,
      name: cleanFileName(input.name),
      title: input.title?.slice(0, 200) ?? null,
      mime,
      size: input.bytes.length,
      sha256,
      storedPath: rel,
      threadId: input.threadId ?? null,
    })
    .returning();
  const file = toNyxFile(row as typeof nyxFiles.$inferSelect);
  hub?.broadcast({ type: "nyx.file", file });
  return file;
}

export async function listNyxFiles(db: Db, kind: NyxFileKind | null, limit = 200): Promise<NyxFile[]> {
  const rows = await db
    .select()
    .from(nyxFiles)
    .where(kind ? and(eq(nyxFiles.kind, kind)) : undefined)
    .orderBy(desc(nyxFiles.id))
    .limit(limit);
  return rows.map(toNyxFile);
}

/** Nur die Beschreibung (ohne Bytes); `null`, wenn es die Datei nicht gibt. */
export async function getNyxFile(db: Db, id: number): Promise<NyxFile | null> {
  const [row] = await db.select().from(nyxFiles).where(eq(nyxFiles.id, id)).limit(1);
  return row ? toNyxFile(row) : null;
}

/** Datei + Bytes; `null`, wenn es die Zeile oder die Datei nicht (mehr) gibt. */
export async function readNyxFile(db: Db, archiveDir: string, id: number): Promise<{ row: typeof nyxFiles.$inferSelect; bytes: Buffer } | null> {
  const [row] = await db.select().from(nyxFiles).where(eq(nyxFiles.id, id)).limit(1);
  if (!row) return null;
  const dir = nyxDir(archiveDir);
  const path = resolve(dir, row.storedPath);
  if (!path.startsWith(dir + sep)) return null;
  try {
    return { row, bytes: await readFile(path) };
  } catch {
    return null;
  }
}
