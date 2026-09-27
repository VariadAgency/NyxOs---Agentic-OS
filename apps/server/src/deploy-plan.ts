// Datengetriebener Migrationsplan: welche Migrationen aus `apps/server/drizzle/meta/_journal.json`
// fehlen der DB noch? Dieselbe Quelle wie `schema-check.ts`; jede neue additive Migration bekommt dort
// einen Eintrag in `MIGRATION_SENTINELS`, dann braucht dieses Modul keine Änderung.
//
// Getestet mit PGlite (apps/server/test/deploy-plan.test.ts). Im Betrieb per `node dist/cli.js
// deploy-plan` in einem Einweg-Container (`docker compose run --rm --no-deps api …`) mit dem NEU gebauten
// Abbild, bevor der laufende `nyxos-api`-Dienst ersetzt wird — reine Lese-Prüfung, die eigentlichen
// Migrationen spielt der Start der API ein (s. main.ts).
import type { Db } from "./db/client.js";
import { checkMigrationsApplied } from "./schema-check.js";
import journal from "../drizzle/meta/_journal.json" with { type: "json" };

export interface DeployPlan {
  /** Migrations-Tags, deren Leit-Spalte/-Tabelle in der DB schon existiert (Reihenfolge = Journal). */
  applied: string[];
  /** Migrations-Tags, die noch fehlen — GENAU diese Reihenfolge ist die Anwendungsreihenfolge. */
  missing: string[];
  /** Dateinamen der fehlenden Migrationen unter `apps/server/drizzle/`, gleiche Reihenfolge wie `missing`. */
  missingFiles: string[];
}

export async function computeDeployPlan(db: Db): Promise<DeployPlan> {
  const { missing } = await checkMigrationsApplied(db);
  const missingSet = new Set(missing);
  const allTags = (journal.entries as { tag: string }[]).map((e) => e.tag);
  const applied = allTags.filter((t) => !missingSet.has(t));
  return { applied, missing, missingFiles: missing.map((t) => `${t}.sql`) };
}
