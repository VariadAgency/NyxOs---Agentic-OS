// Betrieb & Zugriff: honest state, save/read the profile (strict, without secrets), secrets only through the secret
// store (never returned in plain text, blocked for Nyx), checks with a time limit + protection against internal targets,
// and the proof „reachable from the phone“ from a real access through an allowed outside address.
import { DEFAULT_HOSTING_FORMS, type HostingCheckResult, type HostingProfileView, type HostingStatus } from "@nyxos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHealthUrl, parseCheckUrl, parseNyxHealth } from "../src/hosting/check.js";
import { markInternalRequest } from "../src/nyx/appApi/internal.js";
import { classifyApiRequest } from "../src/nyx/appApi/rules.js";
import { secrets } from "../src/db/schema.js";
import { Updater } from "../src/app-info/updates.js";
import { setup } from "./helpers.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tZm9yLXRlc3RzLTEyMzQ1Njc4OTAifQ==WXYZ";
const NYX_HEALTH = { ok: true, checks: { database: { ok: true, ms: 3 }, schema: { ok: true, ms: 5 }, archive: { ok: true, ms: 2 } } };
const PUBLIC_IP = ["203.0.113.10"]; // documentation address, counts as "public" here

let prevKey: string | undefined;
beforeEach(() => {
  prevKey = process.env.NYXOS_SECRETS_KEY;
  process.env.NYXOS_SECRETS_KEY = KEY;
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.NYXOS_SECRETS_KEY;
  else process.env.NYXOS_SECRETS_KEY = prevKey;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake network: remembers every requested address. */
function fakeNet(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const publicPolicy = { allowPrivate: false, resolve: async () => PUBLIC_IP };

async function app(opts: { allowedHosts?: string; fetchImpl?: typeof fetch; resolve?: (h: string) => Promise<string[]>; timeoutMs?: number; mode?: "local" | "server" | "probe" } = {}) {
  return setup({
    allowedHosts: opts.allowedHosts ?? null,
    hosting: {
      mode: opts.mode ?? "server",
      hostName: "nyxos-server",
      fetchImpl: opts.fetchImpl ?? (() => Promise.reject(new Error("no network in tests"))),
      policy: { allowPrivate: false, resolve: opts.resolve ?? (async () => PUBLIC_IP) },
      checkTimeoutMs: opts.timeoutMs ?? 2000,
    },
  });
}

const put = (t: Awaited<ReturnType<typeof app>>, path: string, body: unknown) =>
  t.app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const profile = (over: Partial<{ way: string | null; phoneWay: string | null; forms: unknown }> = {}) => ({
  way: "server",
  phoneWay: "tailscale",
  forms: { ...DEFAULT_HOSTING_FORMS, tailscale: { name: "nyxos.tail1234.ts.net", httpsPort: 443 } },
  ...over,
});

describe("Status", () => {
  it("sagt ehrlich: Server-Modus, Rechnername, keine Adresse von außen, Brücke offline, Handy noch nicht eingerichtet", async () => {
    const t = await app();
    const res = await t.app.request("/api/hosting/status", { headers: { host: "127.0.0.1:47801" } });
    expect(res.status).toBe(200);
    const s = (await res.json()) as HostingStatus;
    expect(s.mode).toBe("server");
    expect(s.hostName).toBe("nyxos-server");
    expect(s.allowedHosts).toEqual([]);
    expect(s.request).toEqual({ host: "127.0.0.1:47801", https: false, remote: false });
    expect(s.bridge.state).not.toBe("online");
    expect(s.phone.state).toBe("not_setup");
    expect(s.phone.url).toBeNull();
  });

  it("Handy-Weg eingetragen, aber nie geprüft → „noch nicht geprüft“, nie „erreichbar“", async () => {
    const t = await app();
    expect((await put(t, "/api/hosting/profile", profile())).status).toBe(200);
    const s = (await (await t.app.request("/api/hosting/status")).json()) as HostingStatus;
    expect(s.phone.state).toBe("not_checked");
    expect(s.phone.url).toBe("https://nyxos.tail1234.ts.net");
    expect(s.phone.check).toBeNull();
  });

  it("ein echter Zugriff über die erlaubte Tailscale-Adresse (vom iPhone) zählt als Beweis – mit Zeitpunkt", async () => {
    const t = await app({ allowedHosts: "nyxos.tail1234.ts.net" });
    await put(t, "/api/hosting/profile", profile());
    const r = await t.app.request("/api/overview", { headers: { host: "nyxos.tail1234.ts.net", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", "x-forwarded-proto": "https" } });
    expect(r.status).not.toBe(421);
    const s = (await (await t.app.request("/api/hosting/status", { headers: { host: "nyxos.tail1234.ts.net", "x-forwarded-proto": "https" } })).json()) as HostingStatus;
    expect(s.request).toEqual({ host: "nyxos.tail1234.ts.net", https: true, remote: true });
    expect(s.phone.state).toBe("reachable");
    expect(s.phone.lastRemote).toMatchObject({ host: "nyxos.tail1234.ts.net", mobile: true });
    expect(Date.parse(s.phone.lastRemote?.at ?? "")).toBeGreaterThan(0);
  });

  it("ein nicht erlaubter Host wird abgewiesen (421) und zählt nie als Zugriff von außen", async () => {
    const t = await app();
    await put(t, "/api/hosting/profile", profile());
    expect((await t.app.request("/api/overview", { headers: { host: "nyxos.tail1234.ts.net" } })).status).toBe(421);
    const s = (await (await t.app.request("/api/hosting/status")).json()) as HostingStatus;
    expect(s.phone.lastRemote).toBeNull();
    expect(s.phone.state).toBe("not_checked");
  });
});

describe("Local mode", () => {
  it("takes the mode from appInfo (local.ts): „on this computer“, with the port of the local server", async () => {
    const prevPort = process.env.PORT;
    process.env.PORT = "47810";
    try {
      const t = await setup({
        appInfo: { version: "1.0.0", mode: "local", demo: false, dataDir: null, updater: new Updater({ version: "1.0.0", cli: null }) },
        hosting: { hostName: "my-laptop", fetchImpl: () => Promise.reject(new Error("no network in tests")) },
      });
      const s = (await (await t.app.request("/api/hosting/status", { headers: { host: "127.0.0.1:47810" } })).json()) as HostingStatus;
      expect(s).toMatchObject({ mode: "local", hostName: "my-laptop", port: 47810 });
      // The self check is real in local mode (database + archive of this process).
      const r = (await (await t.post("/api/hosting/check", { target: "local" }, {})).json()) as HostingCheckResult;
      expect(r).toMatchObject({ code: "self_ok", verdict: "ok" });
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });

  it("server mode shows the published port from NYXOS_PORT (default 47800)", async () => {
    const prev = process.env.NYXOS_PORT;
    delete process.env.NYXOS_PORT;
    try {
      const t = await app({ mode: "server" });
      const s = (await (await t.app.request("/api/hosting/status")).json()) as HostingStatus;
      expect(s.port).toBe(47800);
    } finally {
      if (prev !== undefined) process.env.NYXOS_PORT = prev;
    }
  });
});

describe("Profil", () => {
  it("speichert und liest Weg + Formularwerte (ein Datensatz)", async () => {
    const t = await app();
    const empty = (await (await t.app.request("/api/hosting/profile")).json()) as HostingProfileView;
    expect(empty.way).toBeNull();
    expect(empty.forms).toEqual(DEFAULT_HOSTING_FORMS);
    const forms = { ...DEFAULT_HOSTING_FORMS, server: { address: "203.0.113.10", sshUser: "ubuntu", sshPort: 2222, sshAlias: "nyx", domain: "nyxos.example.com" } };
    const res = await put(t, "/api/hosting/profile", { way: "server", phoneWay: "domain", forms });
    expect(res.status).toBe(200);
    const again = (await (await t.app.request("/api/hosting/profile")).json()) as HostingProfileView;
    expect(again.way).toBe("server");
    expect(again.phoneWay).toBe("domain");
    expect(again.forms.server).toEqual(forms.server);
    expect(again.updatedAt).not.toBeNull();
  });

  it("lehnt unbekannte Felder ab – so landet nie ein Token im Profil", async () => {
    const t = await app();
    const bad = profile({ forms: { ...DEFAULT_HOSTING_FORMS, cloudflare: { hostname: "nyx.example.com", token: TOKEN } } });
    const res = await put(t, "/api/hosting/profile", bad);
    expect(res.status).toBe(400);
    const extra = await put(t, "/api/hosting/profile", { ...profile(), tunnelToken: TOKEN });
    expect(extra.status).toBe(400);
    const view = await (await t.app.request("/api/hosting/profile")).text();
    expect(view).not.toContain(TOKEN);
  });

  it("lehnt gefährliche Werte ab (Befehle, Zeilenumbrüche, Leerzeichen)", async () => {
    const t = await app();
    for (const address of ["x; rm -rf ~", "host\nProxyCommand evil", "$(whoami).example.com", "a b"]) {
      const res = await put(t, "/api/hosting/profile", { way: "server", phoneWay: null, forms: { ...DEFAULT_HOSTING_FORMS, server: { ...DEFAULT_HOSTING_FORMS.server, address } } });
      expect(res.status, address).toBe(400);
    }
  });

  it("schreiben braucht die Anmeldung", async () => {
    const t = await setup({ signedIn: false, hosting: { mode: "server" } });
    const res = await t.app.request("/api/hosting/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(profile()) });
    expect(res.status).toBe(401);
  });
});

describe("Geheimnisse", () => {
  it("Tunnel-Token geht in den Geheimnis-Speicher, zurück kommt nur „gesetzt“ + letzte 4 Zeichen", async () => {
    const t = await app();
    const res = await put(t, "/api/hosting/secrets/cloudflare-tunnel-token", { value: TOKEN });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(TOKEN);
    expect(JSON.parse(body)).toMatchObject({ id: "cloudflare-tunnel-token", set: true, last4: "WXYZ" });

    const view = await (await t.app.request("/api/hosting/profile")).text();
    expect(view).not.toContain(TOKEN);
    const parsed = JSON.parse(view) as HostingProfileView;
    expect(parsed.secrets.find((s) => s.id === "cloudflare-tunnel-token")).toMatchObject({ set: true, last4: "WXYZ" });
    expect(parsed.secretsReady).toBe(true);

    // In der DB verschlüsselt (kein Klartext), unter dem Namen hosting.*.
    const rows = await t.db.select().from(secrets);
    expect(rows.map((r) => r.name)).toContain("hosting.cloudflare-tunnel-token");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);

    const status = await (await t.app.request("/api/hosting/status")).text();
    expect(status).not.toContain(TOKEN);

    expect((await t.app.request("/api/hosting/secrets/cloudflare-tunnel-token", { method: "DELETE", headers: { "content-type": "application/json" } })).status).toBe(200);
    const after = (await (await t.app.request("/api/hosting/profile")).json()) as HostingProfileView;
    expect(after.secrets.find((s) => s.id === "cloudflare-tunnel-token")?.set).toBe(false);
  });

  it("unbekannte Geheimnisse gibt es nicht; ohne Speicher-Schlüssel ehrlich 409", async () => {
    const t = await app();
    expect((await put(t, "/api/hosting/secrets/ssh-password", { value: "geheim-geheim" })).status).toBe(404);
    delete process.env.NYXOS_SECRETS_KEY;
    const t2 = await app();
    const res = await put(t2, "/api/hosting/secrets/cloudflare-tunnel-token", { value: TOKEN });
    expect(res.status).toBe(409);
  });

  it("Nyx darf lesen, prüfen und das Formular speichern – die Geheimnisse nie", async () => {
    expect(classifyApiRequest("GET", "/api/hosting/status").access).toBe("direkt");
    expect(classifyApiRequest("GET", "/api/hosting/profile").access).toBe("direkt");
    expect(classifyApiRequest("PUT", "/api/hosting/profile").access).toBe("direkt");
    expect(classifyApiRequest("POST", "/api/hosting/check").access).toBe("direkt");
    expect(classifyApiRequest("PUT", "/api/hosting/secrets/cloudflare-tunnel-token").access).toBe("gesperrt");
    expect(classifyApiRequest("DELETE", "/api/hosting/secrets/tailscale-auth-key").access).toBe("gesperrt");

    // Zweite Sperre im Anmelde-Tor: auch eine als „von Nyx“ markierte Anfrage kommt nicht durch.
    const t = await setup({ signedIn: false, hosting: { mode: "server" } });
    const secret = new Request("http://localhost/api/hosting/secrets/cloudflare-tunnel-token", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: TOKEN }) });
    markInternalRequest(secret);
    expect((await t.app.fetch(secret)).status).toBe(403);
    const form = new Request("http://localhost/api/hosting/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(profile()) });
    markInternalRequest(form);
    expect((await t.app.fetch(form)).status).toBe(200);
  });
});

describe("Prüfen", () => {
  it("NyxOS antwortet über HTTPS und die Adresse ist erlaubt → ok, gespeichert mit Zeitpunkt; Status sagt „erreichbar“", async () => {
    const net = fakeNet(() => jsonResponse(NYX_HEALTH));
    const t = await app({ allowedHosts: "nyxos.tail1234.ts.net", fetchImpl: net.fetchImpl });
    await put(t, "/api/hosting/profile", profile());
    const res = await t.post("/api/hosting/check", { target: "tailscale", url: "https://nyxos.tail1234.ts.net/irgendwas?x=1#y" }, {});
    expect(res.status).toBe(200);
    const r = (await res.json()) as HostingCheckResult;
    expect(net.calls).toEqual(["https://nyxos.tail1234.ts.net/health"]);
    expect(r).toMatchObject({ target: "tailscale", verdict: "ok", code: "ok", reachable: true, isNyx: true, hostAccepted: true, https: true, status: 200, url: "https://nyxos.tail1234.ts.net" });
    expect(Date.parse(r.at)).toBeGreaterThan(0);
    const s = (await (await t.app.request("/api/hosting/status")).json()) as HostingStatus;
    expect(s.phone.state).toBe("reachable");
    expect(s.phone.check?.at).toBe(r.at);
    const view = (await (await t.app.request("/api/hosting/profile")).json()) as HostingProfileView;
    expect(view.checks.tailscale?.code).toBe("ok");
  });

  it("antwortet, aber NyxOS lässt die Adresse noch nicht zu → Warnung „Host nicht erlaubt“, nicht „erreichbar“", async () => {
    const net = fakeNet(() => jsonResponse(NYX_HEALTH));
    const t = await app({ fetchImpl: net.fetchImpl });
    await put(t, "/api/hosting/profile", profile());
    const r = (await (await t.post("/api/hosting/check", { target: "tailscale" }, {})).json()) as HostingCheckResult;
    expect(r).toMatchObject({ verdict: "warn", code: "host_not_allowed", hostAccepted: false, reachable: true });
    const s = (await (await t.app.request("/api/hosting/status")).json()) as HostingStatus;
    expect(s.phone.state).toBe("unreachable");
  });

  it("hängt die Gegenseite, bricht das Zeitlimit die Prüfung ab (timeout)", async () => {
    const hang = ((_: string, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    const t = await app({ fetchImpl: hang, timeoutMs: 150 });
    const t0 = Date.now();
    const r = (await (await t.post("/api/hosting/check", { target: "domain", url: "https://nyxos.example.com" }, {})).json()) as HostingCheckResult;
    expect(r).toMatchObject({ verdict: "fail", code: "timeout", reachable: false });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("ungültige Adressen und fremde Protokolle werden nie aufgerufen", async () => {
    const net = fakeNet(() => jsonResponse(NYX_HEALTH));
    const t = await app({ fetchImpl: net.fetchImpl });
    for (const url of ["ftp://nyxos.example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@nyxos.example.com", "https://nyx os.example.com", ""]) {
      const res = await t.post("/api/hosting/check", { target: "domain", url }, {});
      if (url === "") {
        expect(res.status, "leer + kein Profil").toBe(400);
        continue;
      }
      const r = (await res.json()) as HostingCheckResult;
      expect(r.code, url).toBe("invalid_url");
    }
    expect(net.calls).toEqual([]);
  });

  it("interne Ziele (Loopback, privat, Docker-Namen) sperrt der Schutz – auch nach DNS", async () => {
    const net = fakeNet(() => jsonResponse(NYX_HEALTH));
    const t = await app({ fetchImpl: net.fetchImpl, resolve: async (h) => (h === "intern.example.com" ? ["10.0.0.5"] : PUBLIC_IP) });
    for (const url of ["http://127.0.0.1:47800", "http://localhost:47800", "http://192.168.1.20", "http://postgres:5432", "http://169.254.169.254", "https://intern.example.com"]) {
      const r = (await (await t.post("/api/hosting/check", { target: "domain", url }, {})).json()) as HostingCheckResult;
      expect(r.code, url).toBe("blocked");
    }
    expect(net.calls).toEqual([]);
  });

  it("Tailscale-Adressen (100.64/10) sind erlaubt; unbekannter Name → „nicht zu finden“", async () => {
    const net = fakeNet(() => jsonResponse(NYX_HEALTH));
    const t = await app({
      fetchImpl: net.fetchImpl,
      resolve: async (h) => {
        if (h === "fehlt.tail1234.ts.net") throw new Error("ENOTFOUND");
        return ["100.111.87.23"];
      },
    });
    const ok = (await (await t.post("/api/hosting/check", { target: "tailscale", url: "https://nyxos.tail1234.ts.net" }, {})).json()) as HostingCheckResult;
    expect(ok.reachable).toBe(true);
    const dns = (await (await t.post("/api/hosting/check", { target: "tailscale", url: "https://fehlt.tail1234.ts.net" }, {})).json()) as HostingCheckResult;
    expect(dns.code).toBe("dns");
    // „Server kennt den Namen nicht“ ist kein Beweis, dass das Handy nicht hinkommt → nie „nicht erreichbar“.
    await put(t, "/api/hosting/profile", profile({ forms: { ...DEFAULT_HOSTING_FORMS, tailscale: { name: "fehlt.tail1234.ts.net", httpsPort: 443 } } }));
    const s = (await (await t.app.request("/api/hosting/status")).json()) as HostingStatus;
    expect(s.phone.state).toBe("not_checked");
    expect(s.phone.check?.code).toBe("dns");
  });

  it("erkennt: antwortet, ist aber nicht NyxOS / NyxOS meldet ein Problem / kein HTTPS", async () => {
    const t1 = await app({ fetchImpl: fakeNet(() => new Response("<html>Willkommen</html>", { status: 200 })).fetchImpl });
    expect(((await (await t1.post("/api/hosting/check", { target: "domain", url: "https://nyxos.example.com" }, {})).json()) as HostingCheckResult).code).toBe("not_nyx");
    const sick = { ok: false, checks: { database: { ok: false, ms: 3000, error: "GEHEIM-INTERN" }, schema: { ok: true }, archive: { ok: true } } };
    const t2 = await app({ fetchImpl: fakeNet(() => jsonResponse(sick, 503)).fetchImpl });
    const r2 = await (await t2.post("/api/hosting/check", { target: "domain", url: "https://nyxos.example.com" }, {})).text();
    expect(JSON.parse(r2)).toMatchObject({ code: "nyx_unhealthy", detail: "database", isNyx: true });
    expect(r2).not.toContain("GEHEIM-INTERN"); // nie Inhalte der Gegenseite
    const t3 = await app({ allowedHosts: "nyxos.example.com", fetchImpl: fakeNet(() => jsonResponse(NYX_HEALTH)).fetchImpl });
    expect(((await (await t3.post("/api/hosting/check", { target: "domain", url: "http://nyxos.example.com" }, {})).json()) as HostingCheckResult).code).toBe("no_https");
  });

  it("„Auf diesem Rechner“: im Server-Modus ehrlich „läuft woanders“, im Lokal-/Probe-Modus echte Selbstprüfung", async () => {
    const srv = await app({ mode: "server" });
    expect(((await (await srv.post("/api/hosting/check", { target: "local" }, {})).json()) as HostingCheckResult).code).toBe("self_elsewhere");
    const probe = await app({ mode: "probe" });
    const r = (await (await probe.post("/api/hosting/check", { target: "local" }, {})).json()) as HostingCheckResult;
    expect(r).toMatchObject({ code: "self_ok", verdict: "ok", isNyx: true });
  });
});

describe("Bausteine", () => {
  it("parseCheckUrl nimmt nur den Ursprung", () => {
    expect(parseCheckUrl("nyxos.example.com/pfad?x#y")?.toString()).toBe("https://nyxos.example.com/");
    expect(parseCheckUrl("http://a.example.com:8443/x")?.origin).toBe("http://a.example.com:8443");
    expect(parseCheckUrl("https://a@b.example.com")).toBeNull();
    expect(parseCheckUrl("gopher://x")).toBeNull();
  });

  it("parseNyxHealth erkennt nur die NyxOS-Form", () => {
    expect(parseNyxHealth(JSON.stringify(NYX_HEALTH))).toEqual({ ok: true, failing: [] });
    expect(parseNyxHealth('{"ok":true}')).toBeNull();
    expect(parseNyxHealth("kein json")).toBeNull();
  });

  it("checkHealthUrl folgt keiner Weiterleitung ins interne Netz", async () => {
    const net = fakeNet((url) => (url.endsWith("/health") && url.startsWith("https://nyxos") ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/health" } }) : jsonResponse(NYX_HEALTH)));
    const r = await checkHealthUrl("https://nyxos.example.com", { fetchImpl: net.fetchImpl, policy: publicPolicy, allowedHosts: new Set() }, { hostMatters: false });
    expect(r.code).toBe("blocked");
    expect(net.calls).toEqual(["https://nyxos.example.com/health"]);
  });
});
