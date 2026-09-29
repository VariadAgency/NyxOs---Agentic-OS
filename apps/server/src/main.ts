// Server-Modus: NyxOS mit eigener Postgres-Datenbank (infra/docker-compose.yml). Der Start spielt alle
// ausstehenden Migrationen selbst ein (wie `local.ts` mit PGlite) — kein psql-Schritt von Hand.
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { applyStoredLanguage } from "./app-info/settings.js";
import { Updater } from "./app-info/updates.js";
import { findVersion } from "./app-info/version.js";
import { createApp } from "./app.js";
import { connect } from "./db/client.js";
import { assertAuthReadsWithAllowedHosts } from "./security.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// niemals mit NYXOS_ALLOWED_HOSTS (Tailscale-Name) starten, ohne dass
// NYXOS_AUTH_READS=1 mitgesetzt ist — s. security.ts.
assertAuthReadsWithAllowedHosts(process.env.NYXOS_ALLOWED_HOSTS, process.env.NYXOS_AUTH_READS);

const databaseUrl = env("DATABASE_URL");

/** Migrationen über eine eigene, kurzlebige Verbindung (eine Sitzung, Hinweise wie „existiert schon“ still). */
async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: process.env.NYXOS_MIGRATIONS_DIR ?? join(import.meta.dirname, "..", "drizzle") });
  } finally {
    await client.end({ timeout: 5 });
  }
}

// Die Datenbank kann beim ersten Start noch hochfahren: ein paar Versuche statt sofort abzubrechen.
for (let attempt = 1; ; attempt++) {
  try {
    await runMigrations(databaseUrl);
    log("migrationen-ok");
    break;
  } catch (e) {
    if (attempt >= 10) throw e;
    log("migrationen-warten", { attempt, error: String(e).slice(0, 200) });
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const { db, close } = connect(databaseUrl);
const version = findVersion(import.meta.dirname);
await applyStoredLanguage(db);
const { app, injectWebSocket, tickStates, haikuScheduler, bridgePresence, entriesImport, telegram } = createApp({
  db,
  archiveDir: env("ARCHIVE_DIR", "/archive"),
  webDir: process.env.WEB_DIR,
  log,
  // Server mode: updates come through Docker Compose (no `nyxos` command), no local sign-in links.
  appInfo: { version, mode: "server", demo: false, dataDir: null, updater: new Updater({ version, cli: null, log }) },
});

const port = Number(env("PORT", "8080"));
const server = serve({ fetch: app.fetch, port, hostname: env("HOST", "0.0.0.0") }, (info) =>
  log("bereit", { port: info.port }),
);
injectWebSocket(server);

// Server-Ticker: erkennt „ruht" nach 30 Min Stille, wofür sonst kein Ereignis eintrifft.
const stateTicker = setInterval(() => void tickStates().catch((e: unknown) => log("zustands-fehler", { error: String(e) })), 60_000);
stateTicker.unref();
// Brücke — Wechsel (online / verbindet neu / offline) alle 5 s erkennen und protokollieren.
bridgePresence.start();
// Haiku-Takt (Briefing, Recap, Rundgang). Abschaltbar mit NYXOS_HAIKU_SCHEDULER=0.
if (process.env.NYXOS_HAIKU_SCHEDULER !== "0") haikuScheduler.start();
// Import von Aufgaben/Audits — beim Start einmal (danach liefert die Brücke die Dateien).
entriesImport.start();
// Telegram-Bot per Long-Polling — startet nur, wenn ein Token da ist (Geheimnis-Speicher bzw. .env).
void telegram.start().catch((e: unknown) => log("telegram-start-fehler", { error: String(e) }));

function shutdown(signal: string) {
  log("beende", { signal });
  clearInterval(stateTicker);
  bridgePresence.stop();
  haikuScheduler.stop();
  entriesImport.stop();
  void telegram.stop();
  server.close();
  void close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
