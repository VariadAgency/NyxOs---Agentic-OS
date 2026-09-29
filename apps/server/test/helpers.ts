import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll } from "vitest";
import type { AppDeps } from "../src/app.js";
import { createApp, hashToken } from "../src/app.js";
import type { BackgroundTasks } from "../src/background.js";
import type { Db } from "../src/db/client.js";
import { machines, schema } from "../src/db/schema.js";
import { createAuthSession, CSRF_HEADER, SESSION_COOKIE } from "../src/terminal/auth.js";

export const TOKEN = "test-token-123";

/** Hülle um eine `Db`, deren Abfragen wie ein echter Verbindungsverlust reagieren — ohne die
 * echte Test-DB zu schließen (ein geschlossener PGlite-Client hängt
 * unter Last statt zu werfen und blockiert dabei die Event-Loop, sodass selbst das Zeitlimit in
 * `checkHealth` nicht mehr greift; in Produktion, postgres-js, wirft ein Verbindungsverlust dagegen
 * sofort bzw. läuft ins eigene Zeitlimit).
 * - `"reject"`: jede Abfrage lehnt sofort mit einem Verbindungsfehler ab.
 * - `"hang"`: jede Abfrage bleibt für immer offen (ein gewöhnliches, nie erfülltes Promise — blockiert
 *   NICHT die Event-Loop, anders als ein geschlossener PGlite-Client) — nur `checkHealth`s eigenes
 *   Zeitlimit (`opts.timeoutMs`) löst dann noch aus.
 * Deckt genau die beiden Formen ab, die `checkHealth` intern nutzt: `db.select(...).from(...)`
 * (database-Prüfung) und `db.execute(...)` (schema-Prüfung, s. `schema-check.ts`). */
export function brokenDb(mode: "reject" | "hang"): Db {
  const fail = () => (mode === "reject" ? Promise.reject(new Error("Verbindung zur Datenbank verloren")) : new Promise<never>(() => {}));
  return { select: () => ({ from: fail }), execute: fail } as unknown as Db;
}

/** Früher legte jeder `setup()`-Aufruf ein eigenes In-Memory-Postgres (PGlite, WASM) an.
 * Ungeschlossen häuften sich davon je nach Datei Dutzende an (server.test.ts allein rief `setup()` ~39
 * Mal auf) — WASM-Speicher/GC-Druck machte die Erzeugung des nächsten Clients irgendwann beliebig
 * langsam bis hängend. Schließen in `afterEach` reichte unter CPU-Last nicht zuverlässig (Livelock
 * beim Erzeugen der nächsten Instanz, nicht beim Schließen der alten).
 *
 * **eine** geteilte PGlite-Instanz je Testdatei (Vitest isoliert Module normalerweise je Datei,
 * `getShared()` ist darum faktisch ein Singleton pro Worker-Ausführung dieser Datei). Migration läuft
 * einmal beim ersten `setup()`-Aufruf; jeder weitere Aufruf setzt die Tabellen per
 * `TRUNCATE … RESTART IDENTITY CASCADE` zurück und legt die Grunddaten (Maschine `m1`) neu an, statt
 * eine neue Instanz zu erzeugen. Die App-Instanz selbst (Caches, Ticker, Hubs) bleibt weiterhin pro
 * Test frisch, weil `createApp` bei jedem `setup()`-Aufruf neu läuft — nur die DB nicht.
 *
 * Opt-in `setup({ isolated: true })` für Tests, die die DB bewusst schließen oder das Schema
 * verändern (nicht nur Zeilen) — ein `TRUNCATE` stellt eine gedropte Spalte/Tabelle nicht wieder her
 * und eine geschlossene Verbindung ist für den Rest der Datei verloren. Diese Tests bekommen wie vor
 * eine eigene, unabhängige Instanz, die `afterEach` wie gehabt schließt. */
const openClients: PGlite[] = [];
/** Hintergrund-Arbeit jeder `setup()`-App (Kontext-Wächter + Zustellung nach jedem Ingest, Preis-Saat …,
 * s. src/background.ts). Lief die beim Testende noch, schloss `afterAll` die geteilte PGlite mitten in
 * ihre Abfrage (bzw. der nächste Test leerte die Tabellen darunter) — PGlite drehte dann endlos, die
 * Leistungstests hingen nach dem letzten Ingest. Darum vor Leeren/Schließen immer erst abwarten. */
const appBackgrounds: BackgroundTasks[] = [];
async function drainBackgrounds(): Promise<void> {
  await Promise.all(appBackgrounds.splice(0).map((b) => b.idle()));
}
afterEach(async () => {
  await drainBackgrounds();
  const clients = openClients.splice(0);
  await Promise.all(
    clients.map((c) =>
      c.close().catch(() => {
        // bereits geschlossen (z. B. Test simuliert "DB weg") — kein Fehler wert.
      }),
    ),
  );
});

let shared: { client: PGlite; db: Db; tables: string[] } | null = null;

async function getShared(): Promise<{ client: PGlite; db: Db; tables: string[] }> {
  if (shared) return shared;
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: join(import.meta.dirname, "..", "drizzle") });
  // Migrationsprotokoll liegt in einem eigenen Schema (`drizzle.__drizzle_migrations`, Drizzle-
  // Vorgabe) — `pg_tables` mit `schemaname = 'public'` erfasst darum nur unsere eigenen Tabellen.
  const result = (await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { rows: { tablename: string }[] };
  const tables = result.rows.map((r) => r.tablename);
  shared = { client, db, tables };
  return shared;
}

async function resetShared(s: { db: Db; tables: string[] }): Promise<void> {
  if (s.tables.length > 0) {
    const list = s.tables.map((t) => `"${t}"`).join(", ");
    await s.db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
  }
  await s.db.insert(machines).values({ id: "m1", name: "macbook", tokenHash: hashToken(TOKEN) });
}

/** FX: Frist für die einmalige Migration der geteilten DB (allein ≈ 1,2 s, unter Volllast ein Vielfaches). */
export const MIGRATE_TIMEOUT_MS = 120_000;

// FX: Die Migration lief bisher im ERSTEN DB-Test jeder Datei und fraß dessen Zeitlimit (20 s) —
// unter Last wurde genau dieser Test rot (z. B. bridge-presence „protokolliert Wechsel“: 1,2 s statt
// 35 ms wie die übrigen). Jetzt vorab, mit eigener großzügiger Frist; die Tests messen nur sich selbst.
beforeAll(async () => {
  await getShared();
}, MIGRATE_TIMEOUT_MS);

/**
 * FX: die geteilte, schon migrierte Test-DB, frisch geleert (wie `setup()`), für Tests, die ihre App
 * selbst bauen (z. B. assistant/worker.test.ts) — statt je Test eine eigene PGlite-Instanz zu migrieren.
 */
export async function sharedDb(): Promise<Db> {
  const s = await getShared();
  await resetShared(s);
  return s.db;
}

afterAll(async () => {
  await drainBackgrounds();
  if (shared) {
    await shared.client.close().catch(() => {});
    shared = null;
  }
});

/**
 * Schreibende Endpunkte brauchen eine Anmeldung. `setup()` meldet deshalb standardmäßig an: jede
 * Anfrage über `app.request` bekommt Cookie + CSRF-Kopf dazu, sofern der Test sie nicht selbst setzt.
 * Tests der Anmeldung selbst rufen `setup({ signedIn: false })` und bekommen die rohe App.
 */
export async function setup(
  opts: {
    webDir?: string;
    allowedHosts?: string | null;
    log?: AppDeps["log"];
    transcriptCache?: AppDeps["transcriptCache"];
    // eigene Fakes für Push/Build-Wächter/Nachtmodus statt der echten Standard-Implementierungen.
    pushSender?: AppDeps["pushSender"];
    buildQueue?: AppDeps["buildQueue"];
    buildsDir?: AppDeps["buildsDir"];
    nightSettings?: AppDeps["nightSettings"];
    signedIn?: boolean;
    bridgeHub?: AppDeps["bridgeHub"];
    // Uhr + Ping-Takt der Brücken-Anwesenheit (bridge/presence.ts) für Tests steuerbar.
    bridgeNow?: AppDeps["bridgeNow"];
    bridgePingMs?: AppDeps["bridgePingMs"];
    // injizierbarer Kontext-Anteil für Ingest-/Ticker-Tests über den vollen App-Weg (statt
    // direkt `runContextGuardTicker` aufzurufen, s. context-guard.test.ts).
    getContextPct?: AppDeps["getContextPct"];
    // eigene PGlite-Instanz statt der geteilten — für Tests, die die DB schließen oder das
    // Schema verändern (s. Kommentar über `getShared`/`resetShared`).
    isolated?: boolean;
    // eigener DB-Handle nur für `/health` + dessen Zeitlimit — s. `brokenDb` oben.
    healthDb?: AppDeps["healthDb"];
    healthCheckTimeoutMs?: AppDeps["healthCheckTimeoutMs"];
    // Verbindungs-Prüfung — Netz/Uhr bzw. Prüf-Liste ersetzen.
    connections?: AppDeps["connections"];
    // Server-Tab-Quellen (Fake-Proxy …) und Sprache.
    server?: AppDeps["server"];
    voice?: AppDeps["voice"];
    // Modelle/Konnektoren (Schlüssel-Umgebung, fetch der Anbieter).
    models?: AppDeps["models"];
    haiku?: AppDeps["haiku"];
    // Telegram (Token-Quelle, Fake-Bot, Stimme, Nyx).
    telegram?: AppDeps["telegram"];
    // Vorschlags-Schreiber der Skill-Bibliothek (statt Haiku).
    skills?: AppDeps["skills"];
    // Abwesenheit: Uhr für Anwesenheit/Bündelung.
    away?: AppDeps["away"];
    // Betrieb & Zugriff (mode, network of the check, clock, computer name).
    hosting?: AppDeps["hosting"];
    // Demo: run mode (e.g. a demo instance), how Nyx answers there, a fake demo launcher.
    appInfo?: AppDeps["appInfo"];
    demo?: AppDeps["demo"];
    demoLauncher?: AppDeps["demoLauncher"];
    // Lokales Stimmen-Paket (Knopf „installieren“, Sätze ohne Docker).
    voicePack?: AppDeps["voicePack"];
    // Feedback & Unterstützen: Attrappe der Meldestelle, Umgebung, DNS, Uhr.
    support?: AppDeps["support"];
  } = {},
) {
  let client: PGlite;
  let db: Db;
  if (opts.isolated) {
    client = new PGlite();
    openClients.push(client);
    db = drizzle(client, { schema }) as unknown as Db;
    await migrate(drizzle(client), { migrationsFolder: join(import.meta.dirname, "..", "drizzle") });
    await db.insert(machines).values({ id: "m1", name: "macbook", tokenHash: hashToken(TOKEN) });
  } else {
    const s = await getShared();
    client = s.client;
    db = s.db;
    await resetShared(s);
  }
  const archiveDir = mkdtempSync(join(tmpdir(), "nyxos-archiv-"));
  const built = createApp({
    db,
    archiveDir,
    webDir: opts.webDir,
    allowedHosts: opts.allowedHosts,
    log: opts.log,
    transcriptCache: opts.transcriptCache,
    pushSender: opts.pushSender,
    buildQueue: opts.buildQueue,
    buildsDir: opts.buildsDir,
    nightSettings: opts.nightSettings,
    bridgeHub: opts.bridgeHub,
    bridgeNow: opts.bridgeNow,
    bridgePingMs: opts.bridgePingMs,
    getContextPct: opts.getContextPct,
    healthDb: opts.healthDb,
    healthCheckTimeoutMs: opts.healthCheckTimeoutMs,
    connections: opts.connections,
    // Ohne eigene Angabe: kein Proxy erreichbar (sofortiger Fehlschlag statt DNS-Wartezeit).
    server: opts.server ?? { env: {}, fetch: () => Promise.reject(new Error("kein Socket-Proxy im Test")) },
    voice: opts.voice,
    models: opts.models,
    haiku: opts.haiku,
    telegram: opts.telegram,
    skills: opts.skills,
    away: opts.away,
    // Without an own value: never the real network, fixed computer name.
    hosting: opts.hosting ?? { fetchImpl: () => Promise.reject(new Error("no network in tests")), hostName: null },
    appInfo: opts.appInfo,
    demo: opts.demo,
    demoLauncher: opts.demoLauncher,
    ...(opts.voicePack ? { voicePack: opts.voicePack } : {}),
    ...(opts.support ? { support: opts.support } : {}),
  });
  appBackgrounds.push(built.background);
  const login = await createAuthSession(db, null);
  const authHeaders = { cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf };
  if (opts.signedIn !== false) {
    const raw = built.app.request.bind(built.app);
    built.app.request = ((input: string | Request | URL, init?: RequestInit, ...rest: unknown[]) => {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(authHeaders)) if (!headers.has(k)) headers.set(k, v);
      return (raw as (...a: unknown[]) => ReturnType<typeof raw>)(input, { ...init, headers }, ...rest);
    }) as typeof built.app.request;
  }
  const auth = { authorization: `Bearer ${TOKEN}` };
  const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
    built.app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return { client, db, archiveDir, ...built, auth, post, login, authHeaders };
}
