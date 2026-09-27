// Local mode: NyxOS runs completely on this computer. One process serves API and web app on 127.0.0.1,
// the database is embedded (PGlite, a full Postgres compiled to WebAssembly) in the data folder.
// Started by the background service that `nyxos` sets up (launchd on macOS, systemd on Linux).
//
// Data folder (NYXOS_DATA_DIR, default ~/.nyxos/data):
//   db/            database
//   archive/       archived session transcripts
//   secrets.key    key of the encrypted secret store (0600)
//   bridge-token   machine token of the local bridge (0600)
// Optional voice pack (NYXOS_HOME/voice, `nyxos voice install`): started here as a child process, see voice/local-pack.ts.
import { PGlite } from "@electric-sql/pglite";
import { isLang } from "@nyxos/shared";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp, hashToken } from "./app.js";
import { applyStoredLanguage, loadAppSettings } from "./app-info/settings.js";
import { findVersion } from "./app-info/version.js";
import { Updater } from "./app-info/updates.js";
import type { Db } from "./db/client.js";
import { machines, schema } from "./db/schema.js";
import { seedDemoIfEmpty } from "./demo/index.js";
import { detectDemoEngine, enableDemoNyx, type DemoEngineKind } from "./demo/nyx.js";
import { findVoiceFiles, LocalVoicePack } from "./voice/local-pack.js";

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const home = process.env.NYXOS_HOME ?? join(homedir(), ".nyxos");
const dataDir = process.env.NYXOS_DATA_DIR ?? join(home, "data");
const demo = process.env.NYXOS_DEMO === "1";
const port = Number(process.env.PORT ?? (demo ? 47802 : 47800));
// Other modules (Nyx engine, MCP bridge) build their own URL from PORT.
process.env.PORT = String(port);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

/** Reads a secret file or creates it once with fresh random bytes (0600). */
function secretFile(name: string, bytes: number): string {
  const file = join(dataDir, name);
  if (!existsSync(file)) writeFileSync(file, randomBytes(bytes).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

process.env.NYXOS_SECRETS_KEY ??= Buffer.from(secretFile("secrets.key", 32), "base64url").toString("base64");
// Local models (Ollama, LM Studio) and the bridge live on 127.0.0.1 — allowed here, blocked in server mode.
process.env.NYXOS_ALLOW_PRIVATE_URLS ??= "1";
// Reading also needs the sign-in: other users of the same computer must not see transcripts via 127.0.0.1.
process.env.NYXOS_AUTH_READS ??= "1";
process.env.NYXOS_HAIKU_REMOTE ??= "0";

const client = new PGlite(join(dataDir, "db"));
const migrationsFolder = process.env.NYXOS_MIGRATIONS_DIR ?? join(import.meta.dirname, "..", "drizzle");
await migrate(drizzle(client), { migrationsFolder });
const db = drizzle(client, { schema }) as unknown as Db;

// Machine token of the local bridge: the bridge and the `nyxos` command read it from the data folder.
const bridgeToken = secretFile("bridge-token", 32);
await db
  .insert(machines)
  .values({ id: "local", name: "local", tokenHash: hashToken(bridgeToken) })
  .onConflictDoUpdate({ target: machines.id, set: { tokenHash: hashToken(bridgeToken) } });
// Demo mode: an empty demo database gets the invented "Atlas" workspace (language: NYXOS_DEMO_LANG, default German).
// Nyx in the demo: the user's AI when the Claude program here is signed in, else prepared answers (demo/nyx.ts).
let demoEngine: DemoEngineKind = "scripted";
if (demo) {
  const demoLang = process.env.NYXOS_DEMO_LANG;
  const [engine] = await Promise.all([
    detectDemoEngine(),
    seedDemoIfEmpty(db, { archiveDir: join(dataDir, "archive"), now: Date.now(), lang: isLang(demoLang) ? demoLang : "de", log }),
  ]);
  demoEngine = engine;
  await enableDemoNyx(db);
  log("demo-nyx", { engine });
}
await applyStoredLanguage(db);

// Voice pack: never in the demo (invented data, no downloads). Port next to the server (+3) unless taken.
const voicePack = demo
  ? undefined
  : new LocalVoicePack({
      home,
      logsDir: join(home, "logs"),
      ...findVoiceFiles(import.meta.dirname),
      node: process.execPath,
      port: Number(process.env.NYXOS_VOICE_PORT ?? port + 3),
      log,
    });

const version = findVersion(import.meta.dirname);
const updater = new Updater({
  version,
  cli: demo ? null : (process.env.NYXOS_CLI ?? null),
  log,
  autoUpdate: async () => (await loadAppSettings(db)).autoUpdate,
});

const { app, injectWebSocket, tickStates, haikuScheduler, bridgePresence, entriesImport, telegram, demoLastRequestAt, stopDemo, killDemoNow } = createApp({
  db,
  archiveDir: join(dataDir, "archive"),
  webDir: process.env.WEB_DIR ?? join(import.meta.dirname, "..", "web"),
  log,
  appInfo: { version, mode: "local", demo, dataDir, updater },
  ...(voicePack ? { voicePack } : {}),
  // Started from "Demo ansehen": the way back to the user's own installation (null for `nyxos demo`).
  ...(demo ? { demo: { engine: demoEngine, homeUrl: process.env.NYXOS_DEMO_HOME_URL?.trim() || null } } : {}),
});

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => log("bereit", { port: info.port, version, demo }));
injectWebSocket(server);

const stateTicker = setInterval(() => void tickStates().catch((e: unknown) => log("zustands-fehler", { error: String(e) })), 60_000);
stateTicker.unref();
bridgePresence.start();
// The demo has no real bridge: it shows the (invented) computer as connected; actions that need the bridge
// (terminal, live file browser) answer with a clear "not available" instead.
if (demo) {
  bridgePresence.connected("local");
  setInterval(() => bridgePresence.heartbeat(), 15_000).unref();
  // A demo started by a local instance ends with it (even if that one was killed hard) and after an idle hour.
  const parentPid = Number(process.env.NYXOS_DEMO_PARENT_PID);
  const idleMs = Number(process.env.NYXOS_DEMO_IDLE_MINUTES) * 60_000;
  if (parentPid > 0 || idleMs > 0) {
    setInterval(() => {
      if (idleMs > 0 && Date.now() - demoLastRequestAt() > idleMs) return shutdown("idle");
      if (parentPid > 0) {
        try {
          process.kill(parentPid, 0);
        } catch {
          shutdown("parent-gone");
        }
      }
    }, 10_000).unref();
  }
}
// The demo shows invented data: no background AI runs, no Telegram, no update checks.
if (!demo && process.env.NYXOS_HAIKU_SCHEDULER !== "0") haikuScheduler.start();
entriesImport.start();
voicePack?.start();
if (!demo) {
  void telegram.start().catch((e: unknown) => log("telegram-start-fehler", { error: String(e) }));
  updater.start();
}

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("beende", { signal });
  void stopDemo();
  clearInterval(stateTicker);
  bridgePresence.stop();
  haikuScheduler.stop();
  entriesImport.stop();
  updater.stop();
  void telegram.stop();
  server.close();
  void Promise.allSettled([voicePack?.stop(), client.close()]).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Last resort: never leave a demo child behind (e.g. an uncaught error ends this process).
process.on("exit", () => killDemoNow());
process.on("SIGINT", () => shutdown("SIGINT"));

