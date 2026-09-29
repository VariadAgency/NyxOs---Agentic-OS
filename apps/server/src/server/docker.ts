// Container des Servers über den Socket-Proxy (NUR lesend, Compose-Dienst `socket-proxy`).
// Die API spricht NIE den rohen Docker-Socket an — der Proxy lässt nur GET auf Container/Bilder/Info
// durch (s. infra/docker-compose.yml). Ergebnisse werden ≤ 10 s zwischengespeichert, gleichzeitige
// Anfragen teilen sich eine Messung, damit der Proxy nicht bei jedem Seitenaufruf ~100 Anfragen bekommt.
import { CONTAINER_HISTORY_POINTS, isRestartLoop, RESTART_LOOP_WINDOW_MS, type ContainerGroup, type ContainerHealth, type ContainerInfo, type ContainerLogLine, type DockerAccess, type HostListenPort, t } from "@nyxos/shared";

export const DEFAULT_DOCKER_PROXY_URL = "http://socket-proxy:2375";
export const DEFAULT_CACHE_TTL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 4000;
const PARALLEL = 6;

export function classifyContainer(name: string, project: string | null): ContainerGroup {
  if (project === "nyxos" || name.startsWith("nyxos-")) return "nyxos";
  return "andere";
}

// ─────────────────────────────── Docker-API-Formen (nur, was wir lesen) ───────────────────────────────

interface ApiPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}
export interface ApiContainer {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Created: number;
  State: string;
  Status: string;
  Ports?: ApiPort[];
  Labels?: Record<string, string> | null;
}
export interface ApiInspect {
  RestartCount?: number;
  State?: { StartedAt?: string; FinishedAt?: string; Health?: { Status?: string } | null };
}
export interface ApiImage {
  Id: string;
  Created: number;
  Labels?: Record<string, string> | null;
}
export interface ApiStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
}

// ─────────────────────────────── Auswertung (reine Funktionen, getestet) ───────────────────────────────

export interface CpuSample {
  total: number;
  system: number;
  cpus: number;
}

/**
 * CPU in % eines Kerns zwischen zwei Messpunkten (Docker-Formel: Δcontainer / Δsystem × Kerne × 100).
 * `one-shot=true` liefert KEINEN Vorwert (`precpu_stats` leer) — dann rechnen wir gegen unsere eigene
 * letzte Messung; gibt es keine, ist der Wert ehrlich `null` statt 0.
 */
export function cpuPercent(stats: ApiStats, previous: CpuSample | null): { percent: number | null; sample: CpuSample | null } {
  const total = stats.cpu_stats?.cpu_usage?.total_usage;
  const system = stats.cpu_stats?.system_cpu_usage;
  const cpus = stats.cpu_stats?.online_cpus ?? 1;
  if (typeof total !== "number" || typeof system !== "number") return { percent: null, sample: null };
  const sample = { total, system, cpus };
  const preTotal = stats.precpu_stats?.cpu_usage?.total_usage;
  const preSystem = stats.precpu_stats?.system_cpu_usage;
  const base = typeof preTotal === "number" && typeof preSystem === "number" && preSystem > 0 ? { total: preTotal, system: preSystem } : previous;
  if (!base) return { percent: null, sample };
  const dTotal = total - base.total;
  const dSystem = system - base.system;
  if (dSystem <= 0 || dTotal < 0) return { percent: null, sample };
  return { percent: Math.round((dTotal / dSystem) * cpus * 1000) / 10, sample };
}

/** Speicher wie `docker stats`: Nutzung ohne Seiten-Cache (cgroup v2 `inactive_file`, v1 `total_inactive_file`). */
export function memoryUsage(stats: ApiStats): { used: number | null; limit: number | null } {
  const m = stats.memory_stats;
  if (!m || typeof m.usage !== "number") return { used: null, limit: null };
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0;
  const used = Math.max(0, m.usage - (cache < m.usage ? cache : 0));
  return { used, limit: typeof m.limit === "number" && m.limit > 0 ? m.limit : null };
}

export function healthFrom(inspect: ApiInspect | null, status: string): ContainerHealth {
  const s = inspect?.State?.Health?.Status ?? (/\(healthy\)/.test(status) ? "healthy" : /\(unhealthy\)/.test(status) ? "unhealthy" : /health: starting/.test(status) ? "starting" : null);
  if (s === "healthy" || s === "unhealthy" || s === "starting") return s;
  return "none";
}

export function imageTag(image: string): string | null {
  if (image.startsWith("sha256:")) return null;
  const at = image.indexOf("@");
  const ref = at === -1 ? image : image.slice(0, at);
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(colon + 1) : "latest";
}

/** Ports nur zur Anzeige; IPv4/IPv6-Doppel (0.0.0.0 und ::) zu einem Eintrag. */
export function formatPorts(ports: ApiPort[] | undefined): string[] {
  const out = new Set<string>();
  for (const p of ports ?? []) {
    if (p.PublicPort) {
      const ip = !p.IP || p.IP === "::" || p.IP === "0.0.0.0" ? "alle" : p.IP;
      out.add(`${ip === "alle" ? "" : `${ip}:`}${p.PublicPort} → ${p.PrivatePort}/${p.Type}`);
    } else out.add(`${p.PrivatePort}/${p.Type} (intern)`);
  }
  return [...out].sort((a, b) => Number(a.endsWith("(intern)")) - Number(b.endsWith("(intern)")) || a.localeCompare(b));
}

/** Veröffentlichte Ports laufender Container (nur mit PublicPort), IPv4/IPv6-Doppel zusammengefasst, nach Port sortiert. */
export function publishedPorts(containers: Array<{ name: string; state: string; ports: ApiPort[] | undefined }>): HostListenPort[] {
  const seen = new Set<string>();
  const out: HostListenPort[] = [];
  for (const c of containers) {
    if (c.state !== "running") continue;
    for (const p of c.ports ?? []) {
      if (!p.PublicPort) continue;
      const bind = !p.IP || p.IP === "::" || p.IP === "0.0.0.0" ? "alle" : p.IP === "127.0.0.1" || p.IP === "::1" ? "lokal" : p.IP;
      const key = `${c.name}/${p.PublicPort}/${p.Type}/${bind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ port: p.PublicPort, bind, proto: p.Type, target: p.PrivatePort, container: c.name });
    }
  }
  return out.sort((a, b) => a.port - b.port || a.container.localeCompare(b.container));
}

const iso = (unixSeconds: number | undefined): string | null => (typeof unixSeconds === "number" && unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString() : null);
const startedIso = (s: string | undefined): string | null => (s && !s.startsWith("0001-") ? new Date(s).toISOString() : null);

/** Docker-Log-Strom → Zeilen. Ohne TTY ist er gemultiplext (8-Byte-Kopf: Strom, 0,0,0, Länge BE). */
export function demuxDockerLogs(buf: Uint8Array): ContainerLogLine[] {
  const multiplexed = buf.length >= 8 && (buf[0] === 0 || buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  const chunks: Array<{ stream: "out" | "err"; text: string }> = [];
  if (multiplexed) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let i = 0;
    while (i + 8 <= buf.length) {
      const len = view.getUint32(i + 4);
      const stream = buf[i] === 2 ? "err" : "out";
      chunks.push({ stream, text: Buffer.from(buf.subarray(i + 8, i + 8 + len)).toString("utf8") });
      i += 8 + len;
    }
  } else chunks.push({ stream: "out", text: Buffer.from(buf).toString("utf8") });

  const lines: ContainerLogLine[] = [];
  for (const c of chunks) {
    for (const raw of c.text.split("\n")) {
      if (raw === "") continue;
      // `timestamps=1`: „2026-09-25T10:14:43.123456789Z text“
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/.exec(raw);
      const text = stripAnsi(m ? (m[2] ?? "") : raw).replace(/\r$/, "");
      lines.push({ at: m?.[1] ? new Date(m[1]).toISOString() : null, stream: c.stream, text });
    }
  }
  return lines;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

// ─────────────────────────────── Zugriff + Zwischenspeicher ───────────────────────────────

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export class DockerProxyError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "forbidden" | "timeout" | "bad_response" | "not_found",
    readonly status?: number,
  ) {
    super(message);
  }
}

export class DockerProxyClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
  ) {}

  async raw(path: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${path}`, { signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw new DockerProxyError("Zeitüberschreitung", "timeout");
      throw new DockerProxyError(e instanceof Error ? e.message : String(e), "unreachable");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 403 || res.status === 401) throw new DockerProxyError(`Proxy verweigert ${path}`, "forbidden", res.status);
    if (res.status === 404) throw new DockerProxyError(`Nicht vorhanden: ${path}`, "not_found", 404);
    if (!res.ok) throw new DockerProxyError(`Proxy antwortet ${res.status}`, "bad_response", res.status);
    return res;
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.raw(path);
    try {
      return (await res.json()) as T;
    } catch {
      throw new DockerProxyError("Antwort ist kein JSON", "bad_response", res.status);
    }
  }
}

/** Ein Satz + genauer Schritt je Fehlerart (keine erfundene „Freigabe“, sondern was wirklich fehlt). */
export function dockerAccessProblem(e: unknown, baseUrl: string): { reason: string; fix: string; command: string } {
  const kind = e instanceof DockerProxyError ? e.kind : "unreachable";
  switch (kind) {
    case "forbidden":
      return {
        reason: t("Der Docker-Lesezugang (Socket-Proxy) läuft, gibt die Container-Liste aber nicht frei."),
        fix: t("In infra/docker-compose.yml beim Dienst socket-proxy CONTAINERS=1 setzen (bleibt nur lesend) und den Dienst neu starten."),
        command: "docker compose up -d socket-proxy",
      };
    case "timeout":
      return {
        reason: t("Der Docker-Lesezugang (Socket-Proxy) antwortet nicht rechtzeitig."),
        fix: t("Auf dem Server ins Protokoll des Socket-Proxys schauen."),
        command: "docker logs --tail 50 nyxos-socket-proxy",
      };
    case "bad_response":
    case "not_found":
      return {
        reason: t("Unter {url} antwortet etwas, das nicht der Docker-Lesezugang ist.", { url: baseUrl }),
        fix: t("NYXOS_DOCKER_PROXY_URL prüfen (Standard http://socket-proxy:2375) und NyxOS neu starten."),
        command: "docker compose up -d",
      };
    default:
      return {
        reason: t("Der Docker-Lesezugang (Socket-Proxy) läuft noch nicht – deshalb sieht NyxOS keine Container."),
        fix: t("Im Server-Modus socket-proxy (nur lesen) und dozzle im Compose-Projekt „nyxos“ starten."),
        command: "docker compose up -d socket-proxy dozzle",
      };
  }
}

export interface DockerSnapshot {
  access: DockerAccess;
  containers: ContainerInfo[];
  /** Veröffentlichte Ports laufender Container (für „Veröffentlichte Ports“ im Server-Tab). */
  published: HostListenPort[];
}

interface History {
  cpu: number[];
  mem: number[];
  lastCpu: CpuSample | null;
  /** Neustart-Zähler je Messung (Zeit, Zähler) im Fenster — steigt er, ist es eine Schleife,
   * auch wenn Docker gerade alte Start-/Endzeiten liefert (lange Wartezeit zwischen zwei Neustarts). */
  restarts: Array<{ at: number; count: number }>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

const pushCapped = (arr: number[], v: number) => {
  arr.push(v);
  if (arr.length > CONTAINER_HISTORY_POINTS) arr.splice(0, arr.length - CONTAINER_HISTORY_POINTS);
};

/**
 * Misst alle Container (Liste → je Container inspect + stats one-shot, Bilder einmal) und hält das
 * Ergebnis `ttlMs` lang. Parallel eintreffende Anfragen warten auf dieselbe Messung. Die Verlaufswerte
 * (Sparklines) sind echte Messpunkte dieser Messungen, nichts wird erfunden.
 */
export class DockerSnapshotCache {
  private cached: { at: number; value: DockerSnapshot } | null = null;
  private inflight: Promise<DockerSnapshot> | null = null;
  private readonly history = new Map<string, History>();
  /** Nur für Tests/Diagnose: wie oft wirklich beim Proxy gemessen wurde. */
  refreshCount = 0;

  constructor(
    readonly client: DockerProxyClient,
    private readonly opts: { ttlMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get(): Promise<DockerSnapshot> {
    const ttl = this.opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    if (this.cached && this.now() - this.cached.at < ttl) return Promise.resolve(this.cached.value);
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Name zu einer ID aus der letzten Messung (für den Kopf der Log-Ansicht). */
  nameOf(idOrName: string): string | null {
    const list = this.cached?.value.containers ?? [];
    return list.find((c) => c.id === idOrName || idOrName.startsWith(c.id) || c.name === idOrName)?.name ?? null;
  }

  private async refresh(): Promise<DockerSnapshot> {
    this.refreshCount++;
    const at = this.now();
    let value: DockerSnapshot;
    try {
      value = { access: { available: true, reason: null, fix: null, command: null, checkedAt: new Date(at).toISOString() }, ...(await this.measure()) };
    } catch (e) {
      const p = dockerAccessProblem(e, this.client.baseUrl);
      value = { access: { available: false, reason: p.reason, fix: p.fix, command: p.command, checkedAt: new Date(at).toISOString() }, containers: [], published: [] };
    }
    this.cached = { at, value };
    return value;
  }

  private async measure(): Promise<{ containers: ContainerInfo[]; published: HostListenPort[] }> {
    const list = await this.client.json<ApiContainer[]>("/containers/json?all=1");
    if (!Array.isArray(list)) throw new DockerProxyError("Container-Liste ist keine Liste", "bad_response");
    // Bilder: einmal je Messung. Scheitert das (z. B. IMAGES=0 im Proxy), fehlt nur das Alter.
    const images = new Map<string, ApiImage>();
    try {
      for (const img of await this.client.json<ApiImage[]>("/images/json")) images.set(img.Id, img);
    } catch {
      // Alter/Version bleiben leer — die Container-Liste ist trotzdem echt.
    }
    const seen = new Set<string>();
    const out = await mapLimit(list, PARALLEL, async (c) => {
      const id = c.Id.slice(0, 12);
      seen.add(id);
      const name = (c.Names[0] ?? c.Id).replace(/^\//, "");
      const project = c.Labels?.["com.docker.compose.project"] ?? null;
      const inspect = await this.client.json<ApiInspect>(`/containers/${c.Id}/json`).catch(() => null);
      const hist = this.history.get(id) ?? { cpu: [], mem: [], lastCpu: null, restarts: [] };
      this.history.set(id, hist);
      let cpu: number | null = null;
      let mem: { used: number | null; limit: number | null } = { used: null, limit: null };
      if (c.State === "running") {
        const stats = await this.client.json<ApiStats>(`/containers/${c.Id}/stats?stream=false&one-shot=true`).catch(() => null);
        if (stats) {
          const r = cpuPercent(stats, hist.lastCpu);
          cpu = r.percent;
          hist.lastCpu = r.sample;
          mem = memoryUsage(stats);
          if (cpu !== null) pushCapped(hist.cpu, cpu);
          if (mem.used !== null) pushCapped(hist.mem, mem.used);
        }
      } else hist.lastCpu = null;
      const img = images.get(c.ImageID);
      const restartCount = inspect?.RestartCount ?? 0;
      const measuredAt = this.now();
      hist.restarts = hist.restarts.filter((r) => measuredAt - r.at < RESTART_LOOP_WINDOW_MS);
      const rising = c.State !== "exited" && c.State !== "created" && hist.restarts.some((r) => restartCount > r.count);
      hist.restarts.push({ at: measuredAt, count: restartCount });
      const restartLoop =
        rising || isRestartLoop({ state: c.State, restartCount, startedAt: startedIso(inspect?.State?.StartedAt), finishedAt: startedIso(inspect?.State?.FinishedAt) }, measuredAt);
      const info: ContainerInfo = {
        id,
        name,
        group: classifyContainer(name, project),
        project,
        image: c.Image,
        imageTag: imageTag(c.Image),
        imageVersion: img?.Labels?.["org.opencontainers.image.version"] ?? null,
        imageCreatedAt: iso(img?.Created),
        state: c.State,
        health: healthFrom(inspect, c.Status),
        createdAt: iso(c.Created),
        startedAt: startedIso(inspect?.State?.StartedAt),
        restartCount,
        restartLoop,
        ports: formatPorts(c.Ports),
        cpuPercent: cpu,
        memBytes: mem.used,
        memLimitBytes: mem.limit,
        cpuHistory: [...hist.cpu],
        memHistory: [...hist.mem],
      };
      return info;
    });
    for (const id of this.history.keys()) if (!seen.has(id)) this.history.delete(id);
    const order: Record<ContainerGroup, number> = { nyxos: 0, andere: 1 };
    const containers = out.sort((a, b) => order[a.group] - order[b.group] || (a.project ?? "").localeCompare(b.project ?? "") || a.name.localeCompare(b.name));
    const published = publishedPorts(list.map((c) => ({ name: (c.Names[0] ?? c.Id).replace(/^\//, ""), state: c.State, ports: c.Ports })));
    return { containers, published };
  }
}

/** Letzte `tail` Zeilen eines Containers über den Proxy (`/containers/{id}/logs`). */
export async function fetchContainerLogs(client: DockerProxyClient, id: string, tail: number): Promise<ContainerLogLine[]> {
  const res = await client.raw(`/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);
  return demuxDockerLogs(new Uint8Array(await res.arrayBuffer()));
}
