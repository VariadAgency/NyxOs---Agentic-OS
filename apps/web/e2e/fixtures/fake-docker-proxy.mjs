#!/usr/bin/env node
// Kleiner HTTP-Nachbau der Docker-API (so wie sie der Socket-Proxy NUR LESEND durchreicht) für den
// lokalen Stack — kein Docker auf dem Entwicklungsrechner nötig. Container-Namen/Projekte/Bilder sind
// erfunden (ein Beispiel-Projekt „atlas“ plus NyxOS und ein paar andere), Werte (CPU/RAM/Logs) sind Test-Daten.
// Start: node apps/web/e2e/fixtures/fake-docker-proxy.mjs --port 47930
// Schreibendes (POST …) beantwortet er wie der echte Proxy mit 403.
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "47930" } } });
const PORT = Number(values.port);
const NOW = Date.now();
const H = 3600_000;
const D = 24 * H;

/** name, project, image, state, status, health, restarts, startedAgo, memMB, cpuPerSec (Anteil eines Kerns) */
const SPEC = [
  ["atlas-postgres", "atlas", "postgis/postgis:17-3.4-alpine", "running", "healthy", 0, 56 * D, 780, 0.06],
  ["atlas-caddy", "atlas", "caddy:2-alpine", "running", "healthy", 0, 35 * D, 38, 0.01],
  ["atlas-event-service", "atlas", "atlas/event-service:latest", "running", "healthy", 0, 28 * D, 96, 0.02],
  ["atlas-user-service", "atlas", "atlas/user-service:latest", "running", "healthy", 0, 42 * D, 88, 0.01],
  ["atlas-messenger-service", "atlas", "atlas/messenger-service:latest", "running", "healthy", 0, 42 * D, 72, 0.01],
  ["atlas-media-service", "atlas", "atlas/media-service:latest", "running", "unhealthy", 3, 2 * H, 140, 0.04],
  ["atlas-moments-service", "atlas", "atlas/moments-service:latest", "running", "healthy", 0, 14 * D, 64, 0.01],
  ["atlas-redis", "atlas", "redis:7-alpine", "running", "healthy", 0, 56 * D, 22, 0.005],
  ["atlas-nats", "atlas", "nats:2-alpine", "running", "healthy", 0, 56 * D, 18, 0.004],
  ["atlas-meilisearch", "atlas", "getmeili/meilisearch:v1.7", "running", "healthy", 0, 56 * D, 310, 0.02],
  ["atlas-dashboard", "dashboard", "atlas-dashboard:latest", "running", "healthy", 0, 4 * D, 150, 0.01],
  ["media-worker", "media-pipeline", "media-worker:latest", "exited", null, 0, 0, 0, 0],
  ["nyxos-api", "nyxos", "nyxos-api:latest", "running", "healthy", 0, 2 * H, 190, 0.05],
  ["nyxos-socket-proxy", "nyxos", "lscr.io/linuxserver/socket-proxy:3.4.4", "running", null, 0, 2 * H, 12, 0.002],
  ["nyxos-dozzle", "nyxos", "amir20/dozzle:v11.1.1", "running", "healthy", 0, 2 * H, 34, 0.003],
  ["gateway-main", "gateway", "ghcr.io/example/gateway:latest", "restarting", null, 1432, 0.01 * H, 0, 0],
  ["gateway-sandbox", "gateway-sandbox", "ghcr.io/example/gateway:latest", "running", "healthy", 0, 6 * H, 420, 0.03],
  ["graph-neo4j", "graph", "neo4j:5.26", "running", "healthy", 0, 56 * D, 1400, 0.04],
  ["tracker-api-1", "tracker", "tracker-api", "running", null, 0, 56 * D, 60, 0.01],
  ["tracker-caddy-1", "tracker", "caddy:2-alpine", "created", null, 0, 0, 0, 0],
  ["portainer", null, "portainer/portainer-ce:lts", "running", null, 0, 56 * D, 45, 0.004],
];

const hex = (s) => [...s].reduce((h, ch) => ((h * 31 + ch.charCodeAt(0)) >>> 0), 7).toString(16).padStart(8, "0");
const containers = SPEC.map(([name, project, image, state, health, restarts, ago, memMB, cpu]) => {
  const id = (hex(name) + hex(`${name}!`) + hex(`${name}?`) + hex(`${name}#`)).repeat(2).slice(0, 64);
  return { id, name, project, image, imageId: `sha256:${hex(image)}`, state, health, restarts, startedAt: state === "created" ? "0001-01-01T00:00:00Z" : new Date(NOW - ago).toISOString(), memMB, cpu, total: 1e11 };
});
const images = [...new Set(containers.map((c) => c.image))].map((image, i) => ({ Id: `sha256:${hex(image)}`, Created: Math.floor((NOW - (i * 7 + 2) * D) / 1000), Labels: image.includes("socket-proxy") ? { "org.opencontainers.image.version": "3.4.4-r0-ls98" } : null }));

const status = (c) =>
  c.state === "running" ? `Up ${Math.round((NOW - Date.parse(c.startedAt)) / D)} days${c.health ? ` (${c.health})` : ""}` : c.state === "restarting" ? "Restarting (1) 43 seconds ago" : c.state === "exited" ? "Exited (137) 2 months ago" : "Created";

function mux(lines) {
  const parts = [];
  for (const [stream, text] of lines) {
    const payload = Buffer.from(`${text}\n`);
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(payload.length, 4);
    parts.push(head, payload);
  }
  return Buffer.concat(parts);
}

function logLines(c) {
  const t = (i) => new Date(NOW - (40 - i) * 60_000).toISOString().replace("Z", "000000Z");
  if (c.name === "atlas-media-service") {
    return Array.from({ length: 40 }, (_, i) => (i % 7 === 3 ? [2, `${t(i)} {"level":"error","msg":"Upload fehlgeschlagen: Zeitüberschreitung beim Speichern","request_id":"r-${1000 + i}"}`] : [1, `${t(i)} {"level":"info","msg":"GET /api/v1/media/${i} 200","ms":${12 + i}}`]));
  }
  if (c.name === "atlas-postgres") {
    return Array.from({ length: 30 }, (_, i) => [1, `${t(i)} LOG:  checkpoint ${i % 2 ? "complete: wrote 42 buffers (0.3%)" : "starting: time"}`]);
  }
  return Array.from({ length: 12 }, (_, i) => [i === 5 ? 2 : 1, `${t(i)} ${c.name}: ${i === 5 ? "Warnung: langsame Antwort (1.2 s)" : `Anfrage ${i} bearbeitet`}`]);
}

let measurements = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/^\/v1\.\d+/, "");
  const json = (body, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(403, { "content-type": "text/html" });
    res.end("<html><body><h1>403 Forbidden</h1>Request forbidden by administrative rules.</body></html>");
    return;
  }
  if (path === "/_ping") return res.end("OK");
  if (path === "/containers/json") {
    measurements++;
    return json(
      containers.map((c) => ({ Id: c.id, Names: [`/${c.name}`], Image: c.image, ImageID: c.imageId, Created: Math.floor(Date.parse(c.state === "created" ? new Date(NOW - 30 * D).toISOString() : c.startedAt) / 1000), State: c.state, Status: status(c), Ports: c.name === "nyxos-api" ? [{ IP: "127.0.0.1", PrivatePort: 8080, PublicPort: 47800, Type: "tcp" }] : c.name === "atlas-caddy" ? [{ IP: "0.0.0.0", PrivatePort: 443, PublicPort: 443, Type: "tcp" }, { IP: "::", PrivatePort: 443, PublicPort: 443, Type: "tcp" }, { IP: "0.0.0.0", PrivatePort: 80, PublicPort: 80, Type: "tcp" }] : [], Labels: c.project ? { "com.docker.compose.project": c.project } : {} })),
    );
  }
  if (path === "/images/json") return json(images);
  const m = /^\/containers\/([^/]+)\/(json|stats|logs)$/.exec(path);
  const c = m ? containers.find((x) => x.id.startsWith(m[1]) || x.name === m[1]) : undefined;
  if (!m || !c) return json({ message: "No such container" }, 404);
  if (m[2] === "json") return json({ RestartCount: c.restarts, State: { StartedAt: c.startedAt, Health: c.health ? { Status: c.health } : null } });
  if (m[2] === "stats") {
    // 10 s Wandzeit je Messung × 8 Kerne; Schwankung, damit die Sparklines echte Kurven zeigen.
    const wobble = 0.6 + 0.8 * Math.abs(Math.sin(measurements * 1.3 + c.name.length));
    c.total += c.cpu * 10e9 * wobble;
    return json({
      cpu_stats: { cpu_usage: { total_usage: c.total }, system_cpu_usage: 1e13 + measurements * 80e9, online_cpus: 8 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      memory_stats: { usage: (c.memMB * (0.95 + 0.1 * Math.abs(Math.cos(measurements + c.name.length))) + 20) * 1e6, limit: 1e9, stats: { inactive_file: 20e6 } },
    });
  }
  res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
  res.end(mux(logLines(c).slice(-Number(url.searchParams.get("tail") ?? 200))));
});
server.listen(PORT, "127.0.0.1", () => console.log(`[fake-docker] http://127.0.0.1:${PORT} (${containers.length} Container, nur lesen)`));
