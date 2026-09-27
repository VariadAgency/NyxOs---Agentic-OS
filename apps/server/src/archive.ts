import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import type { ArchiveMeta } from "@nyxos/shared";

/** Obergrenze für eine komprimierte Verlaufsdatei. Der größte Verlauf am 24.09. hatte 78 MB roh. */
export const MAX_GZ_BYTES = 512 * 1024 * 1024;

export class ArchiveError extends Error {
  constructor(
    readonly status: 400 | 413 | 422,
    message: string,
  ) {
    super(message);
  }
}

function limitBytes(max: number, counter: { n: number }): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      counter.n += chunk.length;
      if (counter.n > max) cb(new ArchiveError(413, `Archiv größer als ${max} Bytes`));
      else cb(null, chunk);
    },
  });
}

/**
 * Zielpfad im Archiv-Volume; verlässt das Volume nie. Jede Fassung bekommt die
 * Prüfsumme in den Namen: die DB-Zeile zeigt so immer auf eine Datei, deren
 * Inhalt zu ihr passt, auch während eine neuere Fassung hochgeladen wird.
 */
export function archivePath(root: string, meta: Pick<ArchiveMeta, "tool" | "path" | "sha256">): string {
  const base = resolve(root);
  const dest = resolve(base, meta.tool, `${meta.path}.${meta.sha256.slice(0, 16)}.gz`);
  if (!dest.startsWith(base + sep)) throw new ArchiveError(400, "Pfad außerhalb des Archivs");
  return dest;
}

/**
 * Speichert eine gzip-Datei atomar im Archiv. Die Prüfsumme wird über den
 * entpackten Inhalt gebildet und muss der vom Mac gemeldeten entsprechen.
 */
export async function storeArchive(root: string, meta: ArchiveMeta, body: WebReadableStream<Uint8Array>): Promise<{ storedPath: string; gzSize: number }> {
  const dest = archivePath(root, meta);
  const tmpDir = join(resolve(root), ".tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, randomUUID());
  const gz = { n: 0 };
  try {
    await pipeline(Readable.fromWeb(body), limitBytes(MAX_GZ_BYTES, gz), createWriteStream(tmp));
    const hash = createHash("sha256");
    const raw = { n: 0 };
    try {
      await pipeline(createReadStream(tmp), createGunzip(), limitBytes(Number.MAX_SAFE_INTEGER, raw), hash);
    } catch {
      throw new ArchiveError(422, "Keine gültige gzip-Datei");
    }
    const sha = hash.digest("hex");
    if (sha !== meta.sha256) throw new ArchiveError(422, `Prüfsumme stimmt nicht (Server ${sha})`);
    if (raw.n !== meta.size) throw new ArchiveError(422, `Größe stimmt nicht (Server ${raw.n}, Mac ${meta.size})`);
    await mkdir(dirname(dest), { recursive: true });
    await rename(tmp, dest);
    return { storedPath: dest, gzSize: gz.n };
  } finally {
    await rm(tmp, { force: true });
  }
}
