// Einstellung „Nach wie vielen Stunden ohne Prozess gilt eine Session nicht mehr als abgestürzt?“.
// Eine Zeile (`id = 1`); fehlt sie, gilt der Standard. Gelesen wird in jeder Zustands-Berechnung (Ingest,
// Takt, Rückrechnung, Wieder-Öffnen) — eine winzige Abfrage, dafür gilt eine Änderung sofort überall.
import { DEFAULT_CRASHED_MAX_HOURS, type SessionStateSettings } from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { sessionStateSettings } from "./db/schema.js";

type Reader = Pick<Db, "select">;

export async function loadStateSettings(db: Reader): Promise<SessionStateSettings> {
  const [row] = await db.select({ crashedMaxHours: sessionStateSettings.crashedMaxHours }).from(sessionStateSettings).where(eq(sessionStateSettings.id, 1)).limit(1);
  return { crashedMaxHours: row?.crashedMaxHours ?? DEFAULT_CRASHED_MAX_HOURS };
}

export async function saveStateSettings(db: Db, next: SessionStateSettings): Promise<SessionStateSettings> {
  await db
    .insert(sessionStateSettings)
    .values({ id: 1, crashedMaxHours: next.crashedMaxHours })
    .onConflictDoUpdate({ target: sessionStateSettings.id, set: { crashedMaxHours: next.crashedMaxHours, updatedAt: sql`now()` } });
  return loadStateSettings(db);
}

/** Optionen für `computeSessionState` aus der Einstellung. */
export async function stateOptions(db: Reader): Promise<{ crashedMaxMs: number }> {
  const s = await loadStateSettings(db);
  return { crashedMaxMs: s.crashedMaxHours * 3_600_000 };
}
