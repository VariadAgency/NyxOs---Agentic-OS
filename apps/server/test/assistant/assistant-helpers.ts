// Test-Helfer für die Assistenten-Tests: App mit eigener Haiku-/Nyx-Laufzeit (Fake-Motor) auf PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { HaikuStreamEvent } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createApp, hashToken } from "../../src/app.js";
import type { BackgroundTasks } from "../../src/background.js";
import type { Db } from "../../src/db/client.js";
import { machines, schema } from "../../src/db/schema.js";
import type { EngineAvailability, EngineEvent, EngineRequest, HaikuEngine } from "../../src/haiku/engine.js";
import type { DeliveryDeps } from "../../src/haiku/inbox.js";
import { HaikuRuntime } from "../../src/haiku/runtime.js";
import { buildDefaultRegistry, type IdeaRepo } from "../../src/haiku/tools.js";
import { createAuthSession, CSRF_HEADER, SESSION_COOKIE } from "../../src/terminal/auth.js";

export const TOKEN = "assistant-test-token";

/** Fake-Motor: führt ein Skript je Lauf aus; kann über `req.callTool` Werkzeuge aufrufen (wie MCP). */
export class FakeEngine implements HaikuEngine {
  readonly kind = "claude-cli" as const;
  requests: EngineRequest[] = [];
  ok = true;
  constructor(public script: (req: EngineRequest) => AsyncIterable<EngineEvent>) {}
  async available(): Promise<EngineAvailability> {
    return this.ok ? { ok: true, reason: null, model: "fake-haiku" } : { ok: false, reason: "fake aus", model: null };
  }
  run(req: EngineRequest): AsyncIterable<EngineEvent> {
    this.requests.push(req);
    return this.script(req);
  }
}

export function answer(text: string, cost = 0.001): (req: EngineRequest) => AsyncIterable<EngineEvent> {
  return async function* () {
    yield { type: "session", sessionId: "11111111-1111-4111-8111-111111111111", model: "fake-haiku" };
    for (const part of text.match(/.{1,7}/gs) ?? []) yield { type: "delta", text: part };
    yield { type: "result", text, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: cost }, model: "fake-haiku", sessionId: "11111111-1111-4111-8111-111111111111", isError: false, error: null };
  };
}

export class MemoryIdeas implements IdeaRepo {
  items: { id: number; title: string; description: string; origin: string; sourceKey: string; stage: string; createdAt: string }[] = [];
  async search(text: string, limit: number) {
    const q = text.toLowerCase();
    return this.items.filter((i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)).slice(0, limit);
  }
  async create(input: { title: string; description: string; origin: string; sourceKey: string }) {
    const item = { id: this.items.length + 1, ...input, stage: "eingang", createdAt: new Date().toISOString() };
    this.items.push(item);
    return { id: item.id, title: item.title, stage: item.stage };
  }
}

// Wie in apps/server/test/helpers.ts: legte jeder `setupAssistant()`-Aufruf ein eigenes PGlite an,
// häufte sich das ungeschlossen über eine Testdatei an (WASM-Speicher/GC-Druck → irgendwann hängender
// Testlauf). Darum eine geteilte Instanz je Testdatei. `setupAssistant({ isolated: true })` für Tests,
// die die DB schließen oder das Schema verändern (aktuell keiner in diesem Verzeichnis, Opt-in für später).
const openClients: PGlite[] = [];
// Nebenläufe des Nyx-Kerns (Verdichtung/Lernprüfung nach einer Antwort) laufen im Hintergrund
// weiter, wenn der Test schon fertig ist. Lief dann `resetShared` (nächster Test) bzw. `client.close()` (Dateiende)
// mitten in ihre Abfrage, drehte PGlite endlos (ein Benchmark mit über 400 Nachrichten hing bei 100 % CPU).
// Darum nach jedem Test: Nebenlauf abbrechen und (≤ 2 s) auf sein Ende warten.
const runtimes: HaikuRuntime[] = [];
// Ebenso die Hintergrund-Arbeit der App selbst (Ingest-Nachläufe, Preis-Saat …, s. src/background.ts).
const appBackgrounds: BackgroundTasks[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.nyx?.lane.yieldToUser().catch(() => {})));
  await Promise.all(appBackgrounds.splice(0).map((b) => b.idle()));
  const clients = openClients.splice(0);
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
});

let shared: { client: PGlite; db: Db; tables: string[] } | null = null;

async function getShared(): Promise<{ client: PGlite; db: Db; tables: string[] }> {
  if (shared) return shared;
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: join(import.meta.dirname, "..", "..", "drizzle") });
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

// Migration vorab mit eigener Frist statt im ersten DB-Test (s. MIGRATE_TIMEOUT_MS in ../helpers.ts).
beforeAll(async () => {
  await getShared();
}, 120_000);

/** Geteilte, migrierte DB frisch geleert — für Tests, die ihre App selbst bauen (z. B. worker.test.ts). */
export async function sharedAssistantDb(): Promise<Db> {
  const s = await getShared();
  await resetShared(s);
  return s.db;
}

afterAll(async () => {
  if (shared) {
    await shared.client.close().catch(() => {});
    shared = null;
  }
});

export async function setupAssistant(
  opts: {
    engine?: HaikuEngine;
    ideas?: IdeaRepo;
    delivery?: Partial<DeliveryDeps>;
    concurrency?: number;
    signedIn?: boolean;
    isolated?: boolean;
  } = {},
) {
  let db: Db;
  if (opts.isolated) {
    const client = new PGlite();
    openClients.push(client);
    db = drizzle(client, { schema }) as unknown as Db;
    await migrate(drizzle(client), { migrationsFolder: join(import.meta.dirname, "..", "..", "drizzle") });
    await db.insert(machines).values({ id: "m1", name: "macbook", tokenHash: hashToken(TOKEN) });
  } else {
    const s = await getShared();
    db = s.db;
    await resetShared(s);
  }
  const archiveDir = mkdtempSync(join(tmpdir(), "nyxos-assistant-"));
  const engine = opts.engine ?? new FakeEngine(answer("Hallo."));
  const runtime = new HaikuRuntime({ db, tools: buildDefaultRegistry(), cliEngine: engine, apiEngine: null, ideas: opts.ideas ?? null, concurrency: opts.concurrency ?? 1 });
  runtimes.push(runtime);
  const built = createApp({ db, archiveDir, haiku: { runtime, delivery: opts.delivery } });
  appBackgrounds.push(built.background);
  // schreibende /api-Aufrufe brauchen Anmeldung (Passkey-Sitzung + CSRF) – wie apps/server/test/helpers.ts.
  const login = await createAuthSession(db, null);
  const authHeaders: Record<string, string> = { cookie: `${SESSION_COOKIE}=${login.token}`, [CSRF_HEADER]: login.csrf };
  if (opts.signedIn !== false) {
    const raw = built.app.request.bind(built.app);
    built.app.request = ((input: string | Request | URL, init?: RequestInit, ...rest: unknown[]) => {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(authHeaders)) if (!headers.has(k)) headers.set(k, v);
      return (raw as (...a: unknown[]) => ReturnType<typeof raw>)(input, { ...init, headers }, ...rest);
    }) as typeof built.app.request;
  }
  const json = (path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) =>
    built.app.request(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return { db, runtime, engine, ...built, json, authHeaders, archiveDir };
}

export async function readNdjson(res: Response): Promise<HaikuStreamEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HaikuStreamEvent);
}

export const CTX = { path: "/sessions/coding/nyxos", tab: "sessions", filters: { art: "coding", baustelle: "nyxos" }, openSessionId: null, openEntryId: null };
