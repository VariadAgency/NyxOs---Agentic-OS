import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { schema, type Schema } from "./schema.js";

/** Treiber-unabhängiger DB-Typ (Produktion: postgres-js, Tests: PGlite). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export function connect(url: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, {
    max: 5,
    connect_timeout: 3,
    idle_timeout: 30,
    // Ohne Zeitlimit hinge /health bei einer weggebrochenen DB ewig.
    connection: { statement_timeout: 10_000 },
  });
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.end({ timeout: 2 }) };
}
