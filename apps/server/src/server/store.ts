// Server-Tab. Container kommen über den Socket-Proxy (nur lesen, ./docker.ts), die Revision aus dem
// Abbild (./revision.ts). Deploys meldet ein Deploy-Skript selbst (`POST /api/server/deploys` nach
// grünem `/health`).
import { serverSshHost, t, type DeployRecord, type DockerAccess, type HealthCheckName, type HealthCheckResult, type HealthSnapshot, type PendingStep, type ServerSnapshot } from "@nyxos/shared";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { deploys } from "../db/schema.js";
import type { Check } from "../health.js";
import { DEFAULT_CACHE_TTL_MS, DEFAULT_DOCKER_PROXY_URL, DockerProxyClient, DockerSnapshotCache, type FetchLike } from "./docker.js";
import { readRunningRevision } from "./revision.js";

export async function recordDeploy(db: Db, input: { project: string; containerName: string; imageId: string; gitRev: string | null; source: "deploy.sh" | "docker-events" }): Promise<DeployRecord> {
  const [row] = await db.insert(deploys).values(input).returning();
  if (!row) throw new Error("Deploy konnte nicht gespeichert werden");
  return toDTO(row);
}

function toDTO(r: typeof deploys.$inferSelect): DeployRecord {
  return { id: r.id, project: r.project, containerName: r.containerName, imageId: r.imageId, createdAt: r.createdAt, gitRev: r.gitRev, source: r.source as DeployRecord["source"] };
}

export async function listDeploys(db: Db, project?: string, limit = 20): Promise<DeployRecord[]> {
  const rows = await db
    .select()
    .from(deploys)
    .where(project ? eq(deploys.project, project) : undefined)
    // `id desc` als Tiebreaker: `createdAt` (defaultNow()) kann bei schnell aufeinanderfolgenden
    // Deploys (z. B. in Tests) dieselbe Millisekunde tragen — ohne zweites Kriterium wäre die
    // Reihenfolge unter Gleichstand nicht definiert.
    .orderBy(desc(deploys.createdAt), desc(deploys.id))
    .limit(limit);
  return rows.map(toDTO);
}

function toHealthCheckResult(c: Check): HealthCheckResult {
  return c.error ? { ok: c.ok, ms: c.ms, error: c.error } : { ok: c.ok, ms: c.ms };
}

/** dieselbe `/health`-Prüfung (Datenbank/Schema/Archiv) mit Klartext-Grund je Teil,
 * statt nur des einen Gesamt-Booleans — die Seite kann so "Server-Teil X gestört: <Grund>" zeigen. */
export function toHealthSnapshot(health: { ok: boolean; checks: { database: Check; schema: Check; archive: Check } }): HealthSnapshot {
  return {
    ok: health.ok,
    checks: {
      database: toHealthCheckResult(health.checks.database),
      schema: toHealthCheckResult(health.checks.schema),
      archive: toHealthCheckResult(health.checks.archive),
    } satisfies Record<HealthCheckName, HealthCheckResult>,
  };
}

export interface ServerSourcesOptions {
  env?: NodeJS.ProcessEnv;
  /** Für Tests: Anfragen an den Socket-Proxy (Standard: globales fetch). */
  fetch?: FetchLike;
  now?: () => number;
  cacheTtlMs?: number;
  /** Für Tests: Weiterleitung an Dozzle (Standard: globales fetch). */
  dozzleFetch?: typeof fetch;
}

/**
 * Alles, was der Server-Tab außerhalb der eigenen DB liest (Socket-Proxy, Dozzle),
 * mit EINEM gemeinsamen Zwischenspeicher je Quelle. Einmal je App angelegt (s. routes/server.ts).
 */
export class ServerSources {
  readonly env: NodeJS.ProcessEnv;
  readonly docker: DockerSnapshotCache;
  readonly client: DockerProxyClient;
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly opts: ServerSourcesOptions = {}) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.client = new DockerProxyClient(this.env.NYXOS_DOCKER_PROXY_URL ?? DEFAULT_DOCKER_PROXY_URL, opts.fetch);
    this.docker = new DockerSnapshotCache(this.client, { ttlMs: this.ttl, now: this.now });
  }

  /** Link, den die Web-App für Dozzle zeigt (Server: `/dozzle/` = Weiterleitung durch die API). */
  get dozzleUrl(): string | null {
    return this.env.NYXOS_DOZZLE_URL?.trim() || null;
  }

  get dozzleFetch(): typeof fetch {
    return this.opts.dozzleFetch ?? fetch;
  }

  /** Adresse, unter der die API Dozzle intern erreicht (inkl. Basis-Pfad `/dozzle`). */
  get dozzleInternalUrl(): string {
    return (this.env.NYXOS_DOZZLE_INTERNAL_URL ?? "http://dozzle:8080/dozzle").replace(/\/$/, "");
  }
}

/** Nur was WIRKLICH fehlt, mit genauem Schritt. */
export function pendingSteps(input: { docker: DockerAccess; dozzleUrl: string | null }): PendingStep[] {
  const out: PendingStep[] = [];
  if (!input.docker.available) {
    out.push({ id: "socket-proxy", title: t("Container-Ansicht"), sentence: [input.docker.reason ?? t("Der Docker-Lesezugang fehlt."), input.docker.fix].filter(Boolean).join(" "), command: input.docker.command ?? "docker compose up -d socket-proxy" });
  }
  if (!input.dozzleUrl) {
    out.push({ id: "dozzle", title: t("Live-Logs (Dozzle)"), sentence: t("Dozzle ist nicht eingerichtet. Im Server-Modus startet es mit dem Compose-Projekt; der Link kommt aus NYXOS_DOZZLE_URL (z. B. /dozzle/)."), command: "docker compose up -d dozzle" });
  }
  return out;
}

/** Baut die Server-Snapshot-DTO — alles echte Messwerte oder ein ehrlicher Satz, was fehlt. */
export async function getServerSnapshot(db: Db, opts: { health: { ok: boolean; checks: { database: Check; schema: Check; archive: Check } }; sources: ServerSources; local?: boolean }): Promise<ServerSnapshot> {
  const { sources } = opts;
  const runningRevision = await readRunningRevision(sources.env);
  const [dockerSnap, nyxosDeploys] = await Promise.all([sources.docker.get(), listDeploys(db, "nyxos", 10)]);
  return {
    docker: dockerSnap.access,
    containers: dockerSnap.containers,
    deploys: nyxosDeploys,
    nyxosHealthy: opts.health.ok,
    health: toHealthSnapshot(opts.health),
    runningRevision,
    dozzleUrl: sources.dozzleUrl,
    sshHost: serverSshHost(sources.env),
    // Local mode needs neither Docker nor Dozzle — nothing is "missing" when they are not there.
    pending: opts.local ? [] : pendingSteps({ docker: dockerSnap.access, dozzleUrl: sources.dozzleUrl }),
  };
}
