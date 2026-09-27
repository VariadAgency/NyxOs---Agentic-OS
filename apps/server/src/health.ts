import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { sessions } from "./db/schema.js";
import { checkMigrationsApplied } from "./schema-check.js";
import { t } from "@nyxos/shared";

/** Unter dieser Menge freien Speichers gilt das Archiv als nicht gesund. */
export const MIN_FREE_BYTES = 1024 * 1024 * 1024;
/** Default-Zeitlimit je Prüfung. Über `checkHealth(db, archiveDir, { timeoutMs })` einstellbar —
 * Tests simulieren so eine hängende Abfrage (z. B. Verbindungsverlust in Produktion, postgres-js läuft
 * ins eigene Zeitlimit) ohne 3 s Wartezeit je Testlauf. */
export const DEFAULT_CHECK_TIMEOUT_MS = 3000;

export interface Check {
  ok: boolean;
  ms: number;
  error?: string;
  detail?: Record<string, unknown>;
}

async function timed(fn: () => Promise<Record<string, unknown> | undefined>, timeoutMs: number): Promise<Check> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t("Zeitüberschreitung nach {ms} ms", { ms: timeoutMs }))), timeoutMs);
      }),
    ]);
    return { ok: true, ms: Math.round(performance.now() - start), ...(detail ? { detail } : {}) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - start), error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Prüft echte Abhängigkeiten: DB (Erreichbarkeit), Schema (Migrationen vollständig?) und
 * Schreibbarkeit des Archiv-Volumes. `database` allein prüfte nur, ob
 * die Verbindung + Basistabellen da sind — eine vergessene additive Migration (z. B. `0004`) blieb
 * damit unbemerkt, bis ein Endpunkt, der die fehlende Spalte anfasst, mit 500 abstürzte. `schema`
 * prüft jetzt zusätzlich jede aus `drizzle/meta/_journal.json` bekannte Migration einzeln
 * (s. `schema-check.ts`). */
export async function checkHealth(db: Db, archiveDir: string, opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const [database, schema, archiveCheck] = await Promise.all([
    timed(async () => {
      const [row] = await db.select({ sessions: sql<number>`count(*)::int` }).from(sessions);
      return { sessions: row?.sessions ?? 0 };
    }, timeoutMs),
    timed(async () => {
      const result = await checkMigrationsApplied(db);
      if (!result.ok) throw new Error(t("Migration {name} fehlt", { name: result.missing.join(", ") }));
      return undefined;
    }, timeoutMs),
    timed(async () => {
      await mkdir(archiveDir, { recursive: true });
      // Zufallsteil: zwei gleichzeitige Prüfungen (Kopfleiste + Server-Seite) in derselben Millisekunde
      // dürfen nicht dieselbe Datei beschreiben (sonst sporadisch 503, Endprüfung 25.09.).
      const probe = join(archiveDir, `.health-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
      const payload = randomBytes(32).toString("hex");
      const fh = await open(probe, "w");
      try {
        await fh.writeFile(payload);
        await fh.sync();
      } finally {
        await fh.close();
      }
      const back = await readFile(probe, "utf8");
      await rm(probe, { force: true });
      if (back !== payload) throw new Error(t("Archiv liest nicht zurück, was geschrieben wurde"));
      const fs = await statfs(archiveDir);
      const freeBytes = fs.bavail * fs.bsize;
      if (freeBytes < MIN_FREE_BYTES) throw new Error(t("Nur noch {mb} MB frei", { mb: Math.round(freeBytes / 1e6) }));
      return { freeBytes };
    }, timeoutMs),
  ]);
  return { ok: database.ok && schema.ok && archiveCheck.ok, checks: { database, schema, archive: archiveCheck } };
}
