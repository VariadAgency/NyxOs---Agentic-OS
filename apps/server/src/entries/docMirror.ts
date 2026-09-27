// Doku-Spiegel: Markdown aus dem Projektordner auf dem Server (Aufträge, Berichte, Audit-Dateien, die
// die Brücke schickt oder der Server frisch vom Mac liest), damit Großansicht und Nyx sie lesen
// können, auch wenn der Rechner zu ist. Diese Datei ist die SERVER-Seite (Schreiben + Ausschluss-Prüfung).
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ENTRY_SOURCE_SKIP_DIRS, t } from "@nyxos/shared";
import type { Db } from "../db/client.js";
import { docs } from "../db/schema.js";

/** Nie spiegeln — Geheimnisse jeder Art (keine .env- oder Schlüsseldateien). Bewusst breiter als nur
 * `.env`: jede Datei, die nach Zugangsdaten aussieht. */
const SECRET_PATTERNS = [/(^|\/)\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /id_(rsa|ed25519|ecdsa)(\.pub)?$/i, /(^|\/)secrets?[./]/i, /token/i, /credentials/i, /\.p12$/i, /\.pfx$/i];

/** Markdown relativ zum Projektordner — kein absoluter Pfad, kein `..`, nichts aus Abhängigkeiten,
 * Git-Interna oder Worktrees (`ENTRY_SOURCE_SKIP_DIRS`), nie etwas, das nach Zugangsdaten aussieht. */
export function isMirrorable(path: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(path))) return false;
  if (!path.endsWith(".md") && !path.endsWith(".mdx")) return false;
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !ENTRY_SOURCE_SKIP_DIRS.has(part));
}

export interface MirrorDocInput {
  path: string;
  content: string;
}

export interface MirrorOutcome {
  written: string[];
  skippedUnchanged: string[];
  rejected: { path: string; reason: string }[];
}

/** Schreibt eine Menge Dokumente idempotent (nur bei geänderter Prüfsumme). Geheimnis-Pfade werden
 * abgelehnt, nie geschrieben — auch wenn der Aufrufer (Brücke) sie fälschlich mitschickt. */
export async function mirrorDocs(db: Db, inputs: MirrorDocInput[]): Promise<MirrorOutcome> {
  const written: string[] = [];
  const skippedUnchanged: string[] = [];
  const rejected: { path: string; reason: string }[] = [];
  for (const input of inputs) {
    if (!isMirrorable(input.path)) {
      rejected.push({ path: input.path, reason: t("außerhalb der erlaubten Wurzeln oder Geheimnis-Muster") });
      continue;
    }
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const [existing] = await db.select({ sha256: docs.sha256 }).from(docs).where(eq(docs.path, input.path));
    if (existing?.sha256 === sha256) {
      skippedUnchanged.push(input.path);
      continue;
    }
    await db
      .insert(docs)
      .values({ path: input.path, content: input.content, sha256, sizeBytes: Buffer.byteLength(input.content) })
      .onConflictDoUpdate({ target: docs.path, set: { content: input.content, sha256, sizeBytes: Buffer.byteLength(input.content), updatedAt: new Date().toISOString() } });
    written.push(input.path);
  }
  return { written, skippedUnchanged, rejected };
}

export async function getDoc(db: Db, path: string) {
  const [row] = await db.select().from(docs).where(eq(docs.path, path));
  return row ?? null;
}
