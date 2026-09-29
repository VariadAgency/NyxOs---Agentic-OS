// Die Kontext-Wächter-Migration (ursprünglich `0010_w1_context_guard`, später umnummeriert zu
// `0013_context_guard`, weil die Nummer 0010 schon vergeben war) hatte keinen Eintrag in `MIGRATION_SENTINELS`
// (schema-check.ts) — eine Migration ohne Eintrag bleibt für `checkMigrationsApplied` unsichtbar,
// sie wird stillschweigend übersprungen (`continue`) statt als fehlend gemeldet, selbst wenn ihre
// Tabellen in der DB komplett fehlen. `/health` hätte eine vergessene Migration also NIE gemeldet.
// Test simuliert genau das: Tabellen weg, trotzdem migriert laut Journal → `checkMigrationsApplied`
// MUSS das als fehlend erkennen.
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { checkMigrationsApplied } from "../src/schema-check.js";
import { setup } from "./helpers.js";

describe("schema-check — 0013_context_guard braucht einen MIGRATION_SENTINELS-Eintrag", () => {
  it("fehlt die Kontext-Wächter-Tabelle `context_guard_state` in der DB, meldet checkMigrationsApplied 0013_context_guard als fehlend", async () => {
    // eigene Instanz — dropt eine Tabelle, ein `TRUNCATE` stellt sie nicht wieder her (s. helpers.ts).
    const t = await setup({ isolated: true });
    // Vorher: die frisch migrierte Test-DB hat die Tabelle, nichts fehlt.
    expect((await checkMigrationsApplied(t.db)).missing).not.toContain("0013_context_guard");

    // Migration "rückgängig machen" (wie ein Server, auf dem sie nie lief) — nur die Leit-Tabelle
    // des Sentinels muss weg sein, das genügt, um die Lücke sichtbar zu machen.
    await t.db.execute(sql`drop table if exists context_guard_state cascade`);

    const result = await checkMigrationsApplied(t.db);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("0013_context_guard");
  });
});
