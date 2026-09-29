// Lokaler Probe-Server ohne Docker: eingebettete Postgres (PGlite) + fester Test-Token.
// Nur für Entwicklung und Probeläufe der Brücke, nie in Produktion.
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp, hashToken } from "./app.js";
import type { Db } from "./db/client.js";
import { authCredentials, machines, schema } from "./db/schema.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createAuthSession, createSetupCode } from "./terminal/auth.js";

const port = Number(process.env.PORT ?? 47890);
const archiveDir = process.env.ARCHIVE_DIR ?? join(process.cwd(), ".dev-archive");
// eigener Probe-Schlüssel für den Geheimnis-Speicher (0600 neben dem Archiv), nie der des Servers.
if (!process.env.NYXOS_SECRETS_KEY) {
  const keyFile = join(archiveDir, "..", "secrets.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  process.env.NYXOS_SECRETS_KEY = readFileSync(keyFile, "utf8").trim();
}
// Probe/Entwicklung laufen auf dem Rechner – lokale Endpunkte (127.0.0.1) sind hier gewollt; in Produktion gesperrt.
process.env.NYXOS_ALLOW_PRIVATE_URLS ??= "1";
const client = new PGlite(process.env.PGLITE_DIR);
await migrate(drizzle(client), { migrationsFolder: join(import.meta.dirname, "..", "drizzle") });
const db = drizzle(client, { schema }) as unknown as Db;
await db.insert(machines).values({ id: "dev", name: "dev", tokenHash: hashToken("dev-token") }).onConflictDoNothing();
const { app, injectWebSocket, tickStates, haikuScheduler, bridgePresence, entriesImport } = createApp({
  db,
  archiveDir,
  webDir: process.env.WEB_DIR,
  log: (m, e) => console.log(m, JSON.stringify(e ?? {})),
});
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`Probe-Server auf http://127.0.0.1:${port}`));
injectWebSocket(server);
// Einrichtungs-Code für einen (weiteren) Passkey ausgeben — nur Probe; auf dem Server per `cli.js passkey-setup`.
const hasPasskey = (await db.select({ id: authCredentials.id }).from(authCredentials).limit(1)).length > 0;
console.log(`Passkey-Einrichtung${hasPasskey ? " (weiteres Gerät)" : ""}: Code ${await createSetupCode(db)} (15 Min gültig) — http://localhost:${port}`);
// Probe-Anmeldung für Skripte/Playwright (Cookie + CSRF) – NUR Probe, Datei 0600 unter .probe/.
const probeLogin = await createAuthSession(db, null);
writeFileSync(join(archiveDir, "..", "probe-login.json"), JSON.stringify(probeLogin), { mode: 0o600 });
setInterval(() => void tickStates(), 60_000).unref();
bridgePresence.start();
entriesImport.start(); // Dateien liefert die Probe-Brücke
// Haiku-Takt auch auf der Probe (echter claude-CLI-Aufruf; NYXOS_HAIKU_SCHEDULER=0 schaltet ab).
if (process.env.NYXOS_HAIKU_SCHEDULER !== "0") haikuScheduler.start();
