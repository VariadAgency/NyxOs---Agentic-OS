// Routen des Server-Tabs (Registrierung hier, Logik in ../server/*.ts).
//
// Logs: zwei Wege, beide NUR mit Passkey-Anmeldung (`needsAuth` in terminal/auth.ts — Container-Logs der
// Produktion können Personen- und Zugangsdaten enthalten, auch wenn Lesen sonst frei ist):
// - `GET /api/server/containers/:id/logs` — letzte 200 Zeilen über den Socket-Proxy (eigene Ansicht im Tab);
// - `/dozzle/*` — Dozzle zum Live-Mitlesen, durch die API weitergereicht. Entscheidung: Dozzle
//   bekommt KEINEN eigenen Port (auch nicht an 127.0.0.1) und keinen zweiten Tunnel: Er hängt nur im internen
//   Netz `nyxos-docker`, die API reicht `/dozzle/` weiter, nachdem sie die Anmeldung geprüft hat, und
//   meldet den Benutzer per `Remote-User` (Dozzle im Modus `forward-proxy` — ohne diesen Kopf lässt Dozzle
//   niemanden hinein). So gilt EINE Anmeldung, und der Weg ist derselbe Tunnel wie für die Web-App (47801).
//   Nur GET/HEAD: Dozzle bleibt eine reine Leseansicht (der Proxy verweigert Schreibendes ohnehin).
import { finderExt, finderMimeOf, HOST_SAMPLE_MS, type ContainerLogs, type HostDockerInfo, type HostFsRootsResponse, type HostProbe, getLang, t } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import type { Db } from "../db/client.js";
import { checkHealth } from "../health.js";
import { DockerProxyError, fetchContainerLogs } from "../server/docker.js";
import { HostFs, parseHostFsRoots, type HostFsOutcome } from "../server/hostfs.js";
import { HostInfoReader, hostInfoOptionsFromEnv, localHostInfoOptions, type HostInfoOptions } from "../server/hostinfo.js";
import { parseDockerInfo, probeTls } from "../server/hoststats.js";

const PROBE_EVERY_MS = 5 * 60_000;
import { getServerSnapshot, recordDeploy, ServerSources, type ServerSourcesOptions } from "../server/store.js";

type Env = { Variables: { machineId: string } };

/** Container-ID (hex) oder Name — nie ein Pfad. */
const CONTAINER_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_TAIL = 1000;
const DEFAULT_TAIL = 200;

/** Kopfzeilen, die zwischen Browser und Dozzle durchgereicht werden (nie Cookies der NyxOS). */
const FORWARD_REQUEST_HEADERS = ["accept", "accept-language", "cache-control", "last-event-id", "if-none-match", "if-modified-since", "range"];
const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"]);

function dozzleDownPage(): string {
  return `<!doctype html><html lang="${getLang()}"><meta charset="utf-8"><title>Dozzle</title>
<body style="font-family:system-ui;background:#0a0d12;color:#e2e7ee;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:32rem;padding:2rem;border:1px solid #232a36;border-radius:12px;background:#10141b">
<h1 style="font-size:18px;margin:0 0 .5rem">${t("Live-Logs sind gerade nicht erreichbar")}</h1>
<p style="color:#8691a1;font-size:14px;line-height:1.5">${t("Dozzle läuft auf dem Server noch nicht. Im Server-Modus startet es mit {cmd}. Die letzten Zeilen jedes Containers siehst du trotzdem im Server-Tab.", { cmd: "<code>docker compose up -d dozzle</code>" })}</p>
<p><a href="/server" style="color:#45bac2">${t("Zurück zum Server-Tab")}</a></p></div></body></html>`;
}

/** Nur Rasterbilder inline (SVG kann Skript enthalten), alles andere als Download — immer in einer Sandbox. */
const INLINE_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"]);
const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:";

function disposition(kind: "attachment" | "inline", name: string): string {
  return `${kind}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function hostFsFail(c: Context, out: Extract<HostFsOutcome<unknown>, { ok: false }>) {
  return c.json({ error: out.error, code: out.code }, out.status);
}

export function registerServerRoutes(
  app: Hono<Env>,
  ctx: {
    db: Db;
    archiveDir: string;
    sources?: ServerSourcesOptions;
    /** Local mode: the page describes this computer (no container, Docker optional). Tests may inject host options. */
    local?: { dataDir: string; hostInfo?: HostInfoOptions };
  },
): ServerSources {
  const { db, archiveDir } = ctx;
  const sources = new ServerSources(ctx.sources);
  // Server-Finder (nur lesen, s. server/hostfs.ts) und Host-Daten (server/hostinfo.ts). Beides immer mit Anmeldung (auth.ts).
  const hostRoots = parseHostFsRoots(sources.env.NYXOS_HOSTFS_ROOTS);
  const hostFs = new HostFs(hostRoots);
  const hostInfo = new HostInfoReader(ctx.local ? (ctx.local.hostInfo ?? localHostInfoOptions(ctx.local.dataDir)) : hostInfoOptionsFromEnv(sources.env, hostRoots.map((r) => ({ label: r.hostPath, path: r.dir }))));
  let dockerInfo: { at: number; value: HostDockerInfo | null } | null = null;
  // Erreichbarkeit eines eigenen Dienstes — NUR ein TLS-Handshake (nichts wird gesendet), höchstens alle 5 Min,
  // im Hintergrund (die Antwort wartet nie darauf). Nur mit `NYXOS_HOST_PROBE_HOST` (z. B. api.example.com);
  // ohne Angabe prüft NyxOS nichts im Netz.
  const probeHost = (sources.env.NYXOS_HOST_PROBE_HOST ?? "").trim();
  let probe: { at: number; value: HostProbe | null; running: boolean } = { at: 0, value: null, running: false };
  const refreshProbe = () => {
    if (!probeHost || probe.running || Date.now() - probe.at < PROBE_EVERY_MS) return;
    probe = { ...probe, running: true };
    void probeTls(probeHost).then(
      (value) => (probe = { at: Date.now(), value, running: false }),
      () => (probe = { at: Date.now(), value: null, running: false }),
    );
  };
  // Verlauf (CPU, RAM, Last, Platten) auch ohne offene Seite — in Produktion ab dem Start, sonst ab der ersten Abfrage.
  if (!ctx.sources?.env) hostInfo.startSampling(HOST_SAMPLE_MS);

  app.get("/api/server/host", async (c) => {
    hostInfo.startSampling(HOST_SAMPLE_MS);
    refreshProbe();
    const snap = await sources.docker.get();
    if (!dockerInfo || Date.now() - dockerInfo.at > 10 * 60_000) {
      // Nur `/info` (der Lese-Proxy erlaubt INFO, nicht SYSTEM → kein `/system/df`); Rückfall `/version`.
      const value = snap.access.available
        ? await sources.client.json<Record<string, unknown>>("/info").then(parseDockerInfo, () =>
            sources.client.json<{ Version?: string }>("/version").then((v) => ({ version: v.Version ?? null, images: null, storageDriver: null, rootDir: null, architecture: null }), () => null),
          )
        : null;
      dockerInfo = { at: Date.now(), value };
    }
    const docker = snap.access.available
      ? { running: snap.containers.filter((x) => x.state === "running").length, total: snap.containers.length, version: dockerInfo.value?.version ?? null, published: snap.published, info: dockerInfo.value }
      : null;
    return c.json(await hostInfo.read(docker, probe.value));
  });

  app.get("/api/server/files/roots", async (c) => c.json({ roots: await hostFs.roots() } satisfies HostFsRootsResponse));

  app.get("/api/server/files/list", async (c) => {
    const out = await hostFs.list(c.req.query("root") ?? "", c.req.query("p") ?? "");
    return out.ok ? c.json(out.value) : hostFsFail(c, out);
  });

  // Namenssuche unterhalb eines Ordners (rekursiv, mit Grenze; Gesperrtes wird nie gefunden oder betreten).
  app.get("/api/server/files/search", async (c) => {
    const out = await hostFs.search(c.req.query("root") ?? "", c.req.query("p") ?? "", c.req.query("q") ?? "", { signal: c.req.raw.signal });
    return out.ok ? c.json(out.value) : hostFsFail(c, out);
  });

  // `part=head|tail`: Datei über 2 MB (Logs) → nur Anfang bzw. Ende statt 413.
  app.get("/api/server/files/text", async (c) => {
    const part = c.req.query("part");
    if (part !== undefined && part !== "head" && part !== "tail") return c.json({ error: t("Dieser Pfad ist ungültig."), code: "hostfs_badPath" }, 400);
    const out = await hostFs.readText(c.req.query("root") ?? "", c.req.query("p") ?? "", part);
    return out.ok ? c.json(out.value) : hostFsFail(c, out);
  });

  app.get("/api/server/files/raw", async (c) => {
    const out = await hostFs.readRaw(c.req.query("root") ?? "", c.req.query("p") ?? "");
    if (!out.ok) return hostFsFail(c, out);
    const { bytes, name } = out.value;
    const inline = INLINE_IMAGE_EXT.has(finderExt(name)) && c.req.query("download") !== "1";
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": inline ? finderMimeOf(name) : "application/octet-stream",
        "content-disposition": disposition(inline ? "inline" : "attachment", name),
        "content-security-policy": SANDBOX_CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        // nie in fremde Seiten einbettbar, nie von fremden Origins als Ressource ladbar.
        "x-frame-options": "DENY",
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
      },
    });
  });

  app.get("/api/server", async (c) => {
    const health = await checkHealth(db, archiveDir);
    const snapshot = await getServerSnapshot(db, { health, sources, local: !!ctx.local });
    return c.json(snapshot);
  });

  app.get("/api/server/containers/:id/logs", async (c) => {
    const id = c.req.param("id");
    if (!CONTAINER_REF.test(id)) return c.json({ error: t("Diesen Container gibt es nicht.") }, 400);
    const tailRaw = Number(c.req.query("tail") ?? DEFAULT_TAIL);
    const tail = Number.isFinite(tailRaw) ? Math.min(MAX_TAIL, Math.max(1, Math.floor(tailRaw))) : DEFAULT_TAIL;
    try {
      const lines = await fetchContainerLogs(sources.client, id, tail);
      const body: ContainerLogs = { id, name: sources.docker.nameOf(id), lines, tail };
      return c.json(body);
    } catch (e) {
      if (e instanceof DockerProxyError && e.kind === "not_found") return c.json({ error: t("Diesen Container gibt es nicht mehr.") }, 404);
      return c.json({ error: t("Die Logs sind gerade nicht lesbar: Der Docker-Lesezugang antwortet nicht.") }, 503);
    }
  });

  app.on(["GET", "HEAD"], ["/dozzle", "/dozzle/*"], async (c) => {
    const url = new URL(c.req.url);
    const upstream = `${sources.dozzleInternalUrl}${url.pathname.slice("/dozzle".length)}${url.search}`;
    const headers = new Headers();
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = c.req.header(h);
      if (v) headers.set(h, v);
    }
    // Anmeldung ist schon geprüft (auth.gate) — Dozzle (forward-proxy) vertraut genau diesem Kopf.
    headers.set("Remote-User", "nyxos");
    headers.set("Remote-Name", "NyxOS");
    // Fehlt `Remote-Roles`, gibt Dozzle v11 im forward-proxy-Modus ALLE Rollen (shell, actions,
    // notifications, cloud, download). Nur Logs herunterladen ist nötig — der Rest bleibt zu, auch falls
    // jemand später Aktionen in Dozzle einschaltet (der Proxy verweigert Schreibendes zusätzlich).
    headers.set("Remote-Roles", "download");
    let res: Response;
    try {
      res = await sources.dozzleFetch(upstream, { method: c.req.method, headers, redirect: "manual", signal: c.req.raw.signal });
    } catch {
      return c.html(dozzleDownPage(), 502);
    }
    const out = new Headers();
    res.headers.forEach((v, k) => {
      if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v);
    });
    out.set("x-accel-buffering", "no");
    return new Response(c.req.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
  });

  // Ein Deploy-Skript ruft das NACH grünem /health auf (Deploy-Protokoll der NyxOS selbst) — mit dem Maschinen-Token
  // (`Authorization: Bearer …`) oder einer angemeldeten Sitzung, s. `gate` in terminal/auth.ts.
  app.post("/api/server/deploys", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const b = body as Record<string, unknown>;
    if (typeof b.gitRev !== "string" || !b.gitRev) return c.json({ error: t("Feld 'gitRev' fehlt") }, 400);
    const record = await recordDeploy(db, {
      project: "nyxos",
      containerName: "nyxos-api",
      imageId: typeof b.imageId === "string" ? b.imageId : b.gitRev,
      gitRev: b.gitRev,
      source: "deploy.sh",
    });
    return c.json({ deploy: record });
  });

  return sources;
}
