import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { computeDeployPlan } from "../src/deploy-plan.js";
import { schema } from "../src/db/schema.js";
import journal from "../drizzle/meta/_journal.json" with { type: "json" };

const DRIZZLE_DIR = join(import.meta.dirname, "..", "drizzle");
const ALL_TAGS = (journal.entries as { tag: string }[]).map((e) => e.tag);

/** Wendet die Migrationsdateien bis (ausschließlich) `stopBeforeTag` roh an — simuliert einen
 * Server-Stand, auf dem nur ein Teil der Migrationen schon lief ("0000 sicher, der
 * Rest nicht"). Keine Drizzle-Migrationstabelle nötig — genau wie auf dem echten Server, wo
 * Migrationen von Hand per `psql` laufen (s. schema-check.ts, Kommentar oben). */
async function applyMigrationsUpTo(client: PGlite, stopBeforeTag: string): Promise<void> {
  for (const entry of journal.entries as { tag: string }[]) {
    if (entry.tag === stopBeforeTag) break;
    const sqlText = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
}

describe("computeDeployPlan (DEPLOY: Grundlage für scripts/deploy-all.sh)", () => {
  // PGlite ungeschlossen lassen häuft sich an (s. helpers.ts) — hier lokal, da diese Datei ihre
  // Clients direkt anlegt statt über setup().
  const clients: PGlite[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  });

  it("meldet auf einer ganz leeren DB alle Migrationen ab 0001 als fehlend", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client, { schema }) as unknown as Db;
    const plan = await computeDeployPlan(db);
    // 0000_init hat keine Leit-Spalte (schema-check.ts prüft sie nicht) — "0000 sicher" laut
    // die Erstinstallation legt sie immer als ersten Schritt an.
    expect(plan.applied).toEqual(["0000_init"]);
    expect(plan.missing).toEqual(ALL_TAGS.filter((t) => t !== "0000_init"));
    expect(plan.missingFiles).toEqual(plan.missing.map((t) => `${t}.sql`));
  });

  it("erkennt einen teilweise migrierten Server-Stand (0000-0002 angewendet, Rest fehlt) in Journal-Reihenfolge", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client, { schema }) as unknown as Db;
    await applyMigrationsUpTo(client, "0003_search");
    const plan = await computeDeployPlan(db);
    // "0000 sicher": 0000_init hat keine Leit-Spalte, gilt immer als angewendet.
    expect(plan.applied).toEqual(["0000_init", "0001_session_state", "0002_sort_rules"]);
    expect(plan.missing).toEqual(ALL_TAGS.filter((t) => !["0000_init", "0001_session_state", "0002_sort_rules"].includes(t)));
    // Reihenfolge ist die Anwendungsreihenfolge: erstes fehlendes Element ist die nächste Migration.
    expect(plan.missing[0]).toBe("0003_search");
    expect(plan.missingFiles[0]).toBe("0003_search.sql");
  });

  it("meldet nichts fehlend, wenn alle Migrationen angewendet sind", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client, { schema }) as unknown as Db;
    await applyMigrationsUpTo(client, "__ende__"); // kein Tag passt, also alle anwenden
    const plan = await computeDeployPlan(db);
    expect(plan.missing).toEqual([]);
    expect(plan.applied).toEqual(ALL_TAGS);
  });
});

describe("Journal-Zeitstempel", () => {
  // Drizzles Migrator (Probe mit PGLITE_DIR, dev.ts) überspringt jede Migration, deren `when` nicht NACH der zuletzt
  // angewendeten liegt. Ein Zeitstempel in der Zukunft würde also jede heute erzeugte nächste Migration still verschlucken.
  it("steigen streng und liegen nicht in der Zukunft", () => {
    const whens = (journal.entries as { when: number }[]).map((e) => e.when);
    for (let i = 1; i < whens.length; i++) expect(whens[i]).toBeGreaterThan(whens[i - 1] ?? 0);
    expect(Math.max(...whens)).toBeLessThanOrEqual(Date.now());
  });
});
