// kleiner Nachbau der Docker-API, so wie sie der Socket-Proxy (nur lesen) durchreicht — für Tests
// ohne Docker (harte Regel: nie Docker auf dem Rechner). Form wie Docker Engine API 1.4x.

const HOUR = 3600;

export interface FakeContainer {
  id: string;
  name: string;
  image: string;
  imageId: string;
  project: string | null;
  state: string;
  status: string;
  health?: "healthy" | "unhealthy" | "starting";
  restartCount: number;
  startedAt: string;
  /** Docker `State.FinishedAt` (letztes Ende); fehlt = nie beendet. */
  finishedAt?: string;
  ports?: Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type: string }>;
  cpuPerCall?: number;
  memUsage?: number;
  logs?: string[];
}

export const FAKE_NOW = Date.parse("2026-09-25T10:00:00Z");

export function defaultFakeContainers(): FakeContainer[] {
  const t = (h: number) => new Date(FAKE_NOW - h * HOUR * 1000).toISOString();
  return [
    { id: "a1".repeat(32), name: "shop-postgres", image: "postgis/postgis:17-3.4-alpine", imageId: "sha256:img-pg", project: "backend", state: "running", status: "Up 8 weeks (healthy)", health: "healthy", restartCount: 0, startedAt: t(24 * 56), cpuPerCall: 4e8, memUsage: 512e6, logs: ["LOG:  checkpoint starting: time", "LOG:  checkpoint complete"] },
    { id: "a2".repeat(32), name: "shop-caddy", image: "caddy:2-alpine", imageId: "sha256:img-caddy", project: "backend", state: "running", status: "Up 5 weeks (healthy)", health: "healthy", restartCount: 0, startedAt: t(24 * 35), ports: [{ IP: "0.0.0.0", PrivatePort: 443, PublicPort: 443, Type: "tcp" }, { IP: "::", PrivatePort: 443, PublicPort: 443, Type: "tcp" }], cpuPerCall: 1e8, memUsage: 40e6 },
    { id: "a3".repeat(32), name: "shop-dashboard", image: "shop-dashboard:latest", imageId: "sha256:img-dash", project: "dashboard", state: "running", status: "Up 4 days (healthy)", health: "healthy", restartCount: 0, startedAt: t(96), cpuPerCall: 5e7, memUsage: 120e6 },
    { id: "b1".repeat(32), name: "nyxos-api", image: "nyxos-api:latest", imageId: "sha256:img-zapi", project: "nyxos", state: "running", status: "Up 2 hours (healthy)", health: "healthy", restartCount: 0, startedAt: t(2), ports: [{ IP: "127.0.0.1", PrivatePort: 8080, PublicPort: 47800, Type: "tcp" }], cpuPerCall: 2e8, memUsage: 180e6, logs: ["{\"msg\":\"nyxos läuft\"}", "\u001b[32mgrün\u001b[0m fertig"] },
    { id: "b2".repeat(32), name: "nyxos-socket-proxy", image: "lscr.io/linuxserver/socket-proxy:3.4.4", imageId: "sha256:img-proxy", project: "nyxos", state: "running", status: "Up 2 hours", restartCount: 0, startedAt: t(2), ports: [{ PrivatePort: 2375, Type: "tcp" }], cpuPerCall: 1e6, memUsage: 12e6 },
    { id: "c1".repeat(32), name: "openclaw-atlas-gateway", image: "ghcr.io/openclaw/openclaw:latest", imageId: "sha256:img-oc", project: "openclaw-atlas", state: "restarting", status: "Restarting (1) 43 seconds ago", restartCount: 1432, startedAt: t(0.01) },
    { id: "c2".repeat(32), name: "tracker-caddy-1", image: "caddy:2-alpine", imageId: "sha256:img-caddy", project: "tracker", state: "created", status: "Created", restartCount: 0, startedAt: "0001-01-01T00:00:00Z" },
    { id: "c3".repeat(32), name: "portainer", image: "portainer/portainer-ce:lts", imageId: "sha256:img-port", project: null, state: "running", status: "Up 8 weeks", restartCount: 0, startedAt: t(24 * 56), ports: [{ IP: "127.0.0.1", PrivatePort: 9000, PublicPort: 9000, Type: "tcp" }], cpuPerCall: 1e7, memUsage: 30e6 },
  ];
}

const IMAGES = [
  { Id: "sha256:img-pg", Created: FAKE_NOW / 1000 - 90 * 24 * HOUR, Labels: { "org.opencontainers.image.version": "17.4" } },
  { Id: "sha256:img-caddy", Created: FAKE_NOW / 1000 - 40 * 24 * HOUR, Labels: null },
  { Id: "sha256:img-dash", Created: FAKE_NOW / 1000 - 5 * 24 * HOUR, Labels: null },
  { Id: "sha256:img-zapi", Created: FAKE_NOW / 1000 - 3 * HOUR, Labels: null },
  { Id: "sha256:img-proxy", Created: FAKE_NOW / 1000 - 4 * 24 * HOUR, Labels: { "org.opencontainers.image.version": "3.4.4-r0-ls98" } },
  { Id: "sha256:img-oc", Created: FAKE_NOW / 1000 - 10 * 24 * HOUR, Labels: null },
  { Id: "sha256:img-port", Created: FAKE_NOW / 1000 - 60 * 24 * HOUR, Labels: null },
];

/** Gemultiplexter Log-Strom wie von Docker ohne TTY (8-Byte-Kopf je Block). */
export function muxLogs(lines: Array<{ stream: 1 | 2; text: string }>): Uint8Array {
  const parts: Buffer[] = [];
  for (const l of lines) {
    const payload = Buffer.from(`${l.text}\n`, "utf8");
    const head = Buffer.alloc(8);
    head[0] = l.stream;
    head.writeUInt32BE(payload.length, 4);
    parts.push(head, payload);
  }
  return new Uint8Array(Buffer.concat(parts));
}

export interface FakeDocker {
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  calls: string[];
  /** Wie viele Container-Listen abgefragt wurden (= echte Messungen). */
  listCalls: () => number;
  containers: FakeContainer[];
}

/** `mode`: `ok` = normal, `forbidden` = Proxy verweigert Container (CONTAINERS=0). */
export function fakeDocker(opts: { containers?: FakeContainer[]; mode?: "ok" | "forbidden" } = {}): FakeDocker {
  const containers = opts.containers ?? defaultFakeContainers();
  const calls: string[] = [];
  const cpuTotals = new Map<string, number>();
  let listCalls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = async (url: string) => {
    const u = new URL(url);
    const path = u.pathname;
    calls.push(`${path}${u.search}`);
    if (path === "/_ping") return new Response("OK");
    if (opts.mode === "forbidden" && path.startsWith("/containers")) return new Response("Forbidden", { status: 403 });
    if (path === "/containers/json") {
      listCalls++;
      return json(
        containers.map((c) => ({
          Id: c.id,
          Names: [`/${c.name}`],
          Image: c.image,
          ImageID: c.imageId,
          Created: Math.floor(Date.parse(c.startedAt.startsWith("0001") ? "2026-09-01T00:00:00Z" : c.startedAt) / 1000),
          State: c.state,
          Status: c.status,
          Ports: c.ports ?? [],
          Labels: c.project ? { "com.docker.compose.project": c.project } : {},
        })),
      );
    }
    if (path === "/images/json") return json(IMAGES);
    const m = /^\/containers\/([^/]+)\/(json|stats|logs)$/.exec(path);
    const c = m ? containers.find((x) => x.id === m[1] || x.id.startsWith(m[1] ?? "~") || x.name === m[1]) : undefined;
    if (!m || !c) return json({ message: "No such container" }, 404);
    if (m[2] === "json") return json({ RestartCount: c.restartCount, State: { StartedAt: c.startedAt, FinishedAt: c.finishedAt ?? "0001-01-01T00:00:00Z", Health: c.health ? { Status: c.health } : null } });
    if (m[2] === "stats") {
      const system = 1e12 + listCalls * 8e9; // je Messung 1 s Wandzeit × 8 Kerne
      const total = (cpuTotals.get(c.id) ?? 1e11) + (c.cpuPerCall ?? 0);
      cpuTotals.set(c.id, total);
      return json({
        cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: 8 },
        precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        memory_stats: { usage: (c.memUsage ?? 0) + 20e6, limit: 1e9, stats: { inactive_file: 20e6 } },
      });
    }
    const lines = (c.logs ?? ["keine Ausgabe"]).map((text, i) => ({ stream: (i % 3 === 2 ? 2 : 1) as 1 | 2, text: `2026-09-25T09:5${i % 10}:00.000000000Z ${text}` }));
    return new Response(muxLogs(lines), { headers: { "content-type": "application/vnd.docker.multiplexed-stream" } });
  };
  return { fetch: fetchFn, calls, containers, listCalls: () => calls.filter((c) => c.startsWith("/containers/json")).length };
}
