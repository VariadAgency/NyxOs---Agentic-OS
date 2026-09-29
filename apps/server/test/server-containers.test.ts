// Server-Tab mit echten Daten über den Socket-Proxy (hier: nachgebaute Docker-API) und KEIN erfundener
// Freigabe-Text.
import type { ContainerLogs, ServerSnapshot } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { needsAuth } from "../src/terminal/auth.js";
import { classifyContainer, cpuPercent, demuxDockerLogs, DockerProxyClient, DockerSnapshotCache, formatPorts, imageTag, memoryUsage } from "../src/server/docker.js";
import { FAKE_NOW, fakeDocker, muxLogs } from "./fixtures/fakeDocker.js";
import { setup } from "./helpers.js";

describe("Container über den Socket-Proxy", () => {
  it("gruppiert NyxOS und andere Projekte", () => {
    expect(classifyContainer("shop-postgres", "backend")).toBe("andere");
    expect(classifyContainer("nyxos-socket-proxy", "nyxos")).toBe("nyxos");
    expect(classifyContainer("nyxos-api", null)).toBe("nyxos");
    expect(classifyContainer("openclaw-atlas-gateway", "openclaw-atlas")).toBe("andere");
    expect(classifyContainer("portainer", null)).toBe("andere");
  });

  it("rechnet CPU aus zwei Messpunkten (one-shot hat keinen Vorwert) und RAM ohne Seiten-Cache", () => {
    const first = cpuPercent({ cpu_stats: { cpu_usage: { total_usage: 1e9 }, system_cpu_usage: 1e12, online_cpus: 8 }, precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 } }, null);
    expect(first.percent).toBeNull(); // ehrlich: noch kein zweiter Punkt
    const second = cpuPercent({ cpu_stats: { cpu_usage: { total_usage: 1e9 + 4e8 }, system_cpu_usage: 1e12 + 8e9, online_cpus: 8 } }, first.sample);
    expect(second.percent).toBe(40); // 0,4 s CPU in 1 s Wandzeit = 40 % eines Kerns
    // Docker liefert einen Vorwert (stream=false ohne one-shot) → der zählt.
    expect(cpuPercent({ cpu_stats: { cpu_usage: { total_usage: 3e8 }, system_cpu_usage: 2e9, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 1e8 }, system_cpu_usage: 1e9 } }, null).percent).toBe(40);
    expect(memoryUsage({ memory_stats: { usage: 300e6, limit: 1e9, stats: { inactive_file: 100e6 } } })).toEqual({ used: 200e6, limit: 1e9 });
    expect(memoryUsage({ memory_stats: { usage: 300e6, limit: 1e9, stats: { total_inactive_file: 50e6 } } }).used).toBe(250e6);
    expect(memoryUsage({})).toEqual({ used: null, limit: null });
  });

  it("liest Tag, Ports (IPv4/IPv6 zusammengefasst) und Log-Ströme", () => {
    expect(imageTag("postgis/postgis:17-3.4-alpine")).toBe("17-3.4-alpine");
    expect(imageTag("localhost:5000/foo")).toBe("latest");
    expect(imageTag("sha256:abc")).toBeNull();
    expect(
      formatPorts([
        { IP: "0.0.0.0", PrivatePort: 443, PublicPort: 443, Type: "tcp" },
        { IP: "::", PrivatePort: 443, PublicPort: 443, Type: "tcp" },
        { PrivatePort: 2375, Type: "tcp" },
        { IP: "127.0.0.1", PrivatePort: 8080, PublicPort: 47800, Type: "tcp" },
      ]),
    ).toEqual(["127.0.0.1:47800 → 8080/tcp", "443 → 443/tcp", "2375/tcp (intern)"]);
    const lines = demuxDockerLogs(muxLogs([{ stream: 1, text: "2026-09-25T09:00:00.123456789Z hallo \u001b[31mrot\u001b[0m" }, { stream: 2, text: "2026-09-25T09:00:01Z fehler" }]));
    expect(lines).toEqual([
      { at: "2026-09-25T09:00:00.123Z", stream: "out", text: "hallo rot" },
      { at: "2026-09-25T09:00:01.000Z", stream: "err", text: "fehler" },
    ]);
    // TTY-Container: kein Kopf, roher Text.
    expect(demuxDockerLogs(new TextEncoder().encode("eins\nzwei\n")).map((l) => l.text)).toEqual(["eins", "zwei"]);
  });

  it("Zwischenspeicher: höchstens eine Messung je 10 s, parallele Anfragen teilen sie, Verlauf wächst mit echten Punkten", async () => {
    const fake = fakeDocker();
    let now = FAKE_NOW;
    const cache = new DockerSnapshotCache(new DockerProxyClient("http://proxy", fake.fetch), { ttlMs: 10_000, now: () => now });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a).toBe(b);
    expect(fake.listCalls()).toBe(1);
    now += 5_000;
    await cache.get();
    expect(fake.listCalls()).toBe(1);
    now += 6_000;
    const later = await cache.get();
    expect(fake.listCalls()).toBe(2);
    const pg = later.containers.find((c) => c.name === "shop-postgres");
    expect(pg?.cpuPercent).toBe(40); // 4e8 / 8e9 × 8 Kerne × 100
    expect(pg?.cpuHistory).toEqual([40]);
    expect(pg?.memBytes).toBe(512e6);
    // Nicht laufende Container werden nicht nach Stats gefragt.
    expect(fake.calls.some((c) => c.includes(`/containers/${"c2".repeat(32)}/stats`))).toBe(false);
  });
});

describe("GET /api/server", () => {
  it("liefert ALLE Container mit Zustand, Health, Bild-Alter, Neustarts, Ports — und keinen Freigabe-Text", async () => {
    const fake = fakeDocker();
    const { app } = await setup({ server: { env: { NYXOS_DOZZLE_URL: "/dozzle/" }, fetch: fake.fetch, now: () => FAKE_NOW } });
    const res = await app.request("/api/server");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/Freigabe/);
    const body = JSON.parse(text) as ServerSnapshot;
    expect(body.docker.available).toBe(true);
    expect(body.containers).toHaveLength(8);
    const byName = Object.fromEntries(body.containers.map((c) => [c.name, c]));
    expect(byName["shop-postgres"]).toMatchObject({ group: "andere", health: "healthy", state: "running", imageTag: "17-3.4-alpine", imageVersion: "17.4", restartCount: 0 });
    expect(byName["shop-postgres"]?.imageCreatedAt).toBe(new Date(FAKE_NOW - 90 * 24 * 3600_000).toISOString());
    expect(byName["nyxos-api"]).toMatchObject({ group: "nyxos", ports: ["127.0.0.1:47800 → 8080/tcp"] });
    expect(byName["openclaw-atlas-gateway"]).toMatchObject({ group: "andere", state: "restarting", restartCount: 1432, health: "none" });
    expect(byName["tracker-caddy-1"]?.startedAt).toBeNull();
    // Reihenfolge: NyxOS zuerst, dann andere.
    expect(body.containers.map((c) => c.group)).toEqual([...body.containers.map((c) => c.group)].sort((a, b) => ["nyxos", "andere"].indexOf(a) - ["nyxos", "andere"].indexOf(b)));
    expect(body.pending.map((p) => p.id)).not.toContain("socket-proxy");
    expect(body.pending.map((p) => p.id)).not.toContain("dozzle");
  });

  it("Proxy fehlt → ehrlicher Satz + genauer Befehl statt „wartet auf Freigabe“", async () => {
    const { app } = await setup();
    const body = (await (await app.request("/api/server")).json()) as ServerSnapshot;
    expect(body.docker.available).toBe(false);
    expect(body.docker.reason).toMatch(/Socket-Proxy/);
    expect(body.docker.reason).not.toMatch(/Freigabe/);
    expect(body.docker.command).toBe("docker compose up -d socket-proxy dozzle");
    expect(body.docker.fix).toMatch(/socket-proxy \(nur lesen\) und dozzle/);
    expect(body.containers).toEqual([]);
    const step = body.pending.find((p) => p.id === "socket-proxy");
    expect(step?.command).toMatch(/docker compose/);
    // Ohne Dozzle-Link: je ein genauer Schritt; ohne SSH-Host kein Server-Terminal.
    expect(body.pending.map((p) => p.id).sort()).toEqual(["dozzle", "socket-proxy"]);
    expect(body.sshHost).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/wartet auf Freigabe/);
  });

  it("Proxy verweigert Container (CONTAINERS=0) → sagt genau das, mit Schritt", async () => {
    const fake = fakeDocker({ mode: "forbidden" });
    const { app } = await setup({ server: { env: {}, fetch: fake.fetch } });
    const body = (await (await app.request("/api/server")).json()) as ServerSnapshot;
    expect(body.docker.available).toBe(false);
    expect(body.docker.reason).toMatch(/gibt die Container-Liste aber nicht frei/);
    expect(body.docker.fix).toMatch(/CONTAINERS=1/);
  });
});

describe("Logs je Container", () => {
  it("nur mit Anmeldung (auch wenn Lesen sonst frei ist) — Logs und Dozzle", () => {
    expect(needsAuth("GET", "/api/server", false)).toBe(false);
    expect(needsAuth("GET", `/api/server/containers/${"b1".repeat(6)}/logs`, false)).toBe(true);
    expect(needsAuth("GET", "/dozzle/", false)).toBe(true);
    expect(needsAuth("GET", "/dozzle", false)).toBe(true);
  });

  it("GET /api/server/containers/:id/logs liefert die letzten Zeilen, entmischt und ohne Farbcodes", async () => {
    const fake = fakeDocker();
    const { app } = await setup({ server: { env: {}, fetch: fake.fetch } });
    await app.request("/api/server"); // Name aus der Messung
    const id = "b1".repeat(6);
    const res = await app.request(`/api/server/containers/${id}/logs?tail=200`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContainerLogs;
    expect(body.name).toBe("nyxos-api");
    expect(body.tail).toBe(200);
    expect(body.lines.map((l) => l.text)).toEqual(['{"msg":"nyxos läuft"}', "grün fertig"]);
    expect(fake.calls).toContain(`/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=200`);
  });

  it("ohne Anmeldung 401, ungültige ID 400, unbekannter Container 404", async () => {
    const fake = fakeDocker();
    const anon = await setup({ signedIn: false, server: { env: {}, fetch: fake.fetch } });
    expect((await anon.app.request(`/api/server/containers/${"b1".repeat(6)}/logs`)).status).toBe(401);
    const { app } = await setup({ server: { env: {}, fetch: fake.fetch } });
    expect((await app.request("/api/server/containers/..%2Fetc/logs")).status).toBe(400);
    expect((await app.request("/api/server/containers/ffffffffffff/logs")).status).toBe(404);
  });

  it("/dozzle/ wird mit Remote-User weitergereicht, nur GET, ohne NyxOS-Cookie; ohne Dozzle eine verständliche Seite", async () => {
    const seen: Array<{ url: string; headers: Headers; method: string }> = [];
    const dozzleFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
      return new Response("<html>dozzle</html>", { headers: { "content-type": "text/html", "set-cookie": "x=1" } });
    }) as typeof fetch;
    const { app } = await setup({ server: { env: { NYXOS_DOZZLE_INTERNAL_URL: "http://dozzle:8080/dozzle" }, dozzleFetch } });
    const res = await app.request("/dozzle/container/abc?x=1", { headers: { "remote-user": "angreifer", "remote-roles": "all", "remote-filter": "name=x", "remote-email": "a@b.c" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>dozzle</html>");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen[0]?.url).toBe("http://dozzle:8080/dozzle/container/abc?x=1");
    expect(seen[0]?.headers.get("remote-user")).toBe("nyxos");
    // Ohne `Remote-Roles` gibt Dozzle (forward-proxy) ALLE Rollen (shell, actions, notifications,
    // cloud, download). Die API setzt deshalb fest nur `download` — Kopfzeilen des Browsers kommen nie durch.
    expect(seen[0]?.headers.get("remote-roles")).toBe("download");
    expect(seen[0]?.headers.get("remote-filter")).toBeNull();
    expect(seen[0]?.headers.get("remote-email")).toBeNull();
    expect(seen[0]?.headers.get("cookie")).toBeNull();
    expect((await app.request("/dozzle/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);

    const down = await setup({ server: { env: {}, dozzleFetch: (() => Promise.reject(new Error("ENOTFOUND"))) as unknown as typeof fetch } });
    const page = await down.app.request("/dozzle/");
    expect(page.status).toBe(502);
    expect(await page.text()).toMatch(/docker compose up -d dozzle/);
  });
});

