// Verbindungs-Prüfung: `GET /api/connections` prüft jede Verbindung echt, parallel, mit
// Zeitlimit je Prüfung. Eine kaputte Quelle wird `fail` mit Ursache, eine hängende läuft ins
// Zeitlimit — die Antwort kommt trotzdem, und die übrigen Prüfungen bleiben unberührt.
import type { BridgeStatusReport, ConnectionCheck, ConnectionsReport } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { defaultConnectionChecks, type ConnectionsContext } from "../src/connections/checks.js";
import { CONNECTIONS_FRESH_MIN_MS } from "../src/connections/route.js";
import type { CheckDef } from "../src/connections/runner.js";
import type { RpcOutcome } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type Overrides = NonNullable<NonNullable<Parameters<typeof setup>[0]>["connections"]>["overrides"];

/** Kein echtes Netz in Tests: jede Adresse antwortet wie ein nicht laufender Dienst. */
const offlineFetch = (async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } });
}) as unknown as typeof fetch;

const baseOverrides: Overrides = {
  fetch: offlineFetch,
  findBin: () => null,
  env: { PATH: "/nirgends" },
  worker: null,
};

async function report(t: Awaited<ReturnType<typeof setup>>, query = "?fresh=1"): Promise<ConnectionsReport> {
  const res = await t.app.request(`/api/connections${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ConnectionsReport;
}

function byId(r: ConnectionsReport, id: string): ConnectionCheck {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`Prüfung ${id} fehlt`);
  return c;
}

function fakeBridge(status: (method: string) => RpcOutcome) {
  return {
    status: () => ({ online: true, machineId: "m1", since: new Date(Date.now() - 60_000).toISOString(), tmuxSocket: "nyxos" }),
    rpc: async (method: string) => status(method),
  };
}

const bridgeReport: BridgeStatusReport = {
  at: Date.now(),
  version: "r1",
  queued: 3,
  dead: 0,
  lastOkAt: Date.now() - 5_000,
  lastError: null,
  archiveError: null,
  watchedFiles: 42,
  tmux: { ok: true, sessions: 2, error: null },
  scans: { usage: Date.now() - 10_000, git: Date.now() - 60_000, vault: Date.now() - 60_000, catalog: null },
  vaultError: null,
};

describe("GET /api/connections", () => {
  it("prüft jede Verbindung aus der Liste und meldet je Eintrag Zustand, Antwortzeit und Gruppe", async () => {
    const t = await setup({ connections: { overrides: baseOverrides } });
    const r = await report(t);
    expect(r.checks.map((c) => c.id)).toEqual(defaultConnectionChecks().map((d) => d.id));
    for (const c of r.checks) {
      expect(["ok", "warn", "fail", "user"]).toContain(c.state);
      expect(typeof c.ms).toBe("number");
      expect(c.ok).toBe(c.state === "ok" || c.state === "warn");
      if (c.state !== "ok") expect(c.cause, `${c.id} ohne Ursache`).toBeTruthy();
      if (c.state !== "ok") expect(c.fix, `${c.id} ohne Lösung`).toBeTruthy();
    }
    expect(r.summary.ok + r.summary.warn + r.summary.fail + r.summary.user).toBe(r.checks.length);
    // Echte Prüfungen gegen die Test-DB/das Test-Archiv:
    expect(byId(r, "db")).toMatchObject({ state: "ok", result: "0 Sessions" });
    expect(byId(r, "schema").state).toBe("ok");
    expect(byId(r, "archive").state).toBe("ok");
    // CSRF-Mechanik echt durchgespielt (401 → 403 → durchgelassen), Probe-Anmeldung wieder weg.
    expect(byId(r, "csrf")).toMatchObject({ state: "ok" });
    const { rows } = (await t.db.execute(sql`select count(*)::int as n from auth_sessions`)) as unknown as { rows: { n: number }[] };
    const n = rows[0]?.n;
    expect(n).toBe(1); // nur die Anmeldung aus setup()
  });

  it("Fehler einer Quelle → fail mit Ursache (Brücke weg, ntfy aus, pnpm fehlt)", async () => {
    const t = await setup({ connections: { overrides: baseOverrides } });
    const r = await report(t);
    expect(byId(r, "bridge-channel")).toMatchObject({ state: "fail", ok: false, command: "nyxos restart" });
    expect(byId(r, "bridge-channel").cause).toMatch(/keine Verbindung/);
    const ntfy = byId(r, "ntfy");
    expect(ntfy.state).toBe("fail");
    expect(ntfy.cause).toMatch(/127\.0\.0\.1 auf den Server selbst/);
    // Builds laufen auf dem Rechner — ohne Brücke ist genau DAS der Grund, nicht „pnpm fehlt“.
    expect(byId(r, "build-guard")).toMatchObject({ state: "fail", cause: expect.stringContaining("Brücke ist gerade nicht verbunden") });
    expect(byId(r, "build-guard").cause).not.toMatch(/pnpm/);
    expect(byId(r, "socket-proxy").cause).toMatch(/Dienst läuft nicht/);
  });

  it("eine werfende Quelle wird fail mit ihrer Fehlermeldung, die anderen bleiben unberührt", async () => {
    const t = await setup({
      connections: {
        overrides: {
          ...baseOverrides,
          findBin: () => {
            throw new Error("Suchpfad nicht lesbar");
          },
        },
      },
    });
    const r = await report(t);
    expect(byId(r, "haiku-cli")).toMatchObject({ state: "fail", cause: expect.stringContaining("Suchpfad nicht lesbar") });
    expect(byId(r, "db").state).toBe("ok");
  });

  it("Zeitlimit greift: eine hängende Prüfung blockiert weder die Antwort noch die anderen (parallel)", async () => {
    const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const checks: CheckDef<ConnectionsContext>[] = [
      { id: "haengt", group: "betrieb", label: "Hängt", expected: "antwortet", timeoutMs: 80, fix: "Dienst neu starten.", run: () => new Promise(() => {}) },
      { id: "a", group: "server", label: "A", expected: "ok", run: async () => (await slow(150), { state: "ok" }) },
      { id: "b", group: "server", label: "B", expected: "ok", run: async () => (await slow(150), { state: "ok" }) },
    ];
    const t = await setup({ connections: { checks, overrides: baseOverrides } });
    const started = Date.now();
    const r = await report(t);
    const took = Date.now() - started;
    expect(byId(r, "haengt")).toMatchObject({ state: "fail", ok: false, fix: "Dienst neu starten." });
    expect(byId(r, "haengt").cause).toMatch(/Zeitlimit/);
    expect(byId(r, "haengt").ms).toBeLessThan(1000);
    expect(byId(r, "a").state).toBe("ok");
    expect(byId(r, "b").state).toBe("ok");
    // parallel: 2 × 150 ms nacheinander wären ≥ 300 ms
    expect(took).toBeLessThan(290);
  });

  it("Ergebnis wird zwischengespeichert, ?fresh=1 prüft neu", async () => {
    let runs = 0;
    let clock = 1_000_000;
    const checks: CheckDef<ConnectionsContext>[] = [{ id: "zaehler", group: "server", label: "Zähler", expected: "läuft", run: async () => (runs++, { state: "ok" }) }];
    const t = await setup({ connections: { checks, overrides: { ...baseOverrides, now: () => clock } } });
    expect((await report(t, "")).cached).toBe(false);
    expect((await report(t, "")).cached).toBe(true);
    expect(runs).toBe(1);
    clock += CONNECTIONS_FRESH_MIN_MS;
    expect((await report(t, "?fresh=1")).cached).toBe(false);
    expect(runs).toBe(2);
  });

  it("?fresh=1 ist kein Last-Hebel: kurz nach einem Lauf kommt der gespeicherte Stand", async () => {
    let runs = 0;
    let clock = 1_000_000;
    const checks: CheckDef<ConnectionsContext>[] = [{ id: "zaehler", group: "server", label: "Zähler", expected: "läuft", run: async () => (runs++, { state: "ok" }) }];
    const t = await setup({ connections: { checks, overrides: { ...baseOverrides, now: () => clock } } });
    await report(t, "?fresh=1");
    for (let i = 0; i < 20; i++) expect((await report(t, "?fresh=1")).cached).toBe(true);
    expect(runs).toBe(1);
    clock += CONNECTIONS_FRESH_MIN_MS - 1;
    expect((await report(t, "?fresh=1")).cached).toBe(true);
    clock += 1;
    expect((await report(t, "?fresh=1")).cached).toBe(false);
    expect(runs).toBe(2);
  });

  it("Socket-Proxy zählt nur, wenn er die Container-Liste liefert; Dozzle nur mit gesundem Healthcheck", async () => {
    const fetchWith = (containers: Response, dozzle: Response) =>
      (async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/_ping")) return new Response("OK", { status: 200 });
        if (u.endsWith("/containers/json")) return containers.clone();
        if (u.endsWith("/healthcheck")) return dozzle.clone();
        throw new Error(`unerwartet ${u}`);
      }) as unknown as typeof fetch;
    const env = { PATH: "/nirgends", NYXOS_DOZZLE_URL: "http://localhost:47802" };
    const bad = await setup({ connections: { overrides: { ...baseOverrides, env, fetch: fetchWith(new Response("Forbidden", { status: 403 }), new Response("not found", { status: 404 })) } } });
    const r = await report(bad);
    expect(byId(r, "socket-proxy")).toMatchObject({ state: "fail" });
    expect(byId(r, "socket-proxy").cause).toMatch(/Container-Liste/);
    expect(byId(r, "dozzle")).toMatchObject({ state: "fail" });
    const good = await setup({ connections: { overrides: { ...baseOverrides, env, fetch: fetchWith(new Response(JSON.stringify([{ Id: "a" }, { Id: "b" }]), { status: 200 }), new Response("", { status: 200 })) } } });
    const r2 = await report(good);
    expect(byId(r2, "socket-proxy")).toMatchObject({ state: "ok", result: expect.stringContaining("2 Container") });
    expect(byId(r2, "dozzle").state).toBe("ok");
  });

  it("Namen und Erwartungen sind ohne Technik-Wörter (UI-Regel)", () => {
    for (const d of defaultConnectionChecks()) {
      expect(`${d.label} ${d.expected}`, d.id).not.toMatch(/CSRF|tmux|WebAuthn|RP-ID|\b40[13]\b/);
    }
  });

  it("verbundene Brücke: Puffer, tmux, Scans aus dem status-Befehl", async () => {
    const bridge = fakeBridge((m) => (m === "status" ? { ok: true, result: bridgeReport } : { ok: true, result: { folders: [{ label: "demo", path: "/x" }] } }));
    const t = await setup({ connections: { overrides: { ...baseOverrides, bridge } } });
    const r = await report(t);
    expect(byId(r, "bridge-channel").state).toBe("ok");
    expect(byId(r, "bridge-rpc")).toMatchObject({ state: "ok", result: "1 Projekt-Ordner gemeldet" });
    expect(byId(r, "bridge-buffer")).toMatchObject({ state: "ok" });
    expect(byId(r, "bridge-buffer").result).toContain("3 wartend · 0 abgelehnt");
    expect(byId(r, "bridge-tmux")).toMatchObject({ state: "ok", result: "2 Terminal-Sitzungen" });
    expect(byId(r, "bridge-vault").state).toBe("ok");
  });

  it("ältere Brücke ohne status-Befehl: warn mit ehrlicher Ursache statt Absturz", async () => {
    const bridge = fakeBridge((m) => (m === "status" ? { ok: false, error: "Brücke antwortet nicht", code: "timeout" } : { ok: true, result: { folders: [] } }));
    const t = await setup({ connections: { overrides: { ...baseOverrides, bridge } } });
    const r = await report(t);
    expect(byId(r, "bridge-buffer")).toMatchObject({ state: "warn", cause: expect.stringContaining("ältere Fassung") });
    expect(byId(r, "bridge-tmux")).toMatchObject({ state: "ok", result: "Brücke meldet den Sitzungs-Dienst" });
  });

  it("fehlender Haiku-Token ist ein Alex-Punkt mit fertigem Befehl", async () => {
    const t = await setup({ connections: { overrides: { ...baseOverrides, worker: { connectedAt: null } } } });
    const r = await report(t);
    expect(byId(r, "haiku-token")).toMatchObject({ state: "user", ok: false, command: expect.stringContaining("claude setup-token") });
    expect(byId(r, "haiku-worker").state).toBe("user");
    const withToken = await setup({ connections: { overrides: { ...baseOverrides, env: { PATH: "/nirgends", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz" } } } });
    const r2 = await report(withToken);
    expect(byId(r2, "haiku-token")).toMatchObject({ state: "ok", result: "gesetzt" });
    expect(JSON.stringify(r2)).not.toContain("sk-ant-oat01"); // der Token selbst verlässt den Server nie
  });

  it("ohne Token warten Motor, CLI und Arbeiter auf Alex (nicht rot), ohne Container-Technik", async () => {
    const t = await setup({ connections: { overrides: { ...baseOverrides, worker: { connectedAt: null } } } });
    const r = await report(t);
    for (const id of ["haiku-cli", "haiku-worker"]) {
      expect(byId(r, id)).toMatchObject({ state: "user", cause: expect.stringContaining("Wartet auf deinen Nyx-Token"), command: expect.stringContaining("claude setup-token") });
    }
    const engine = byId(r, "haiku-engine");
    if (engine.state !== "ok") expect(engine).toMatchObject({ state: "user", cause: expect.stringContaining("Wartet auf deinen Nyx-Token") });
    expect(r.checks.filter((c) => c.group === "haiku" && c.state === "fail")).toEqual([]);
    const text = JSON.stringify(r.checks.filter((c) => c.group === "haiku"));
    expect(text).not.toMatch(/nyxos-agent|Profil|Agent-Container|NYXOS_HAIKU_REMOTE/);
  });

  it("Build-Wächter: grün, wenn die Brücke run_build kann (kein pnpm im Server nötig); alte Brücke → Update-Befehl", async () => {
    const withCaps = { ...fakeBridge(() => ({ ok: true, result: { folders: [] } })), supports: (cap: string) => cap === "run_build" };
    const t = await setup({ connections: { overrides: { ...baseOverrides, bridge: withCaps } } });
    await t.db.execute(sql`insert into build_runs (kind, command, status, trigger, started_at) values ('nyxos', 'pnpm -r typecheck', 'green', 'manual', now() - interval '5 minutes')`);
    const r = await report(t);
    expect(byId(r, "build-guard")).toMatchObject({ state: "ok" });
    expect(byId(r, "build-guard").result).toMatch(/Brücke bereit · letzter Build grün vor 5 Min/);

    const old = await setup({ connections: { overrides: { ...baseOverrides, bridge: fakeBridge(() => ({ ok: true, result: { folders: [] } })) } } });
    const r2 = await report(old);
    expect(byId(r2, "build-guard")).toMatchObject({ state: "fail", command: "nyxos update" });
  });

  it("Reserve-API ohne Schlüssel ist optional → grün mit Hinweis, keine Warnung", async () => {
    const t = await setup({ connections: { overrides: baseOverrides } });
    const r = await report(t);
    expect(byId(r, "haiku-reserve")).toMatchObject({ state: "ok", result: "optional, nicht eingerichtet" });
  });

  it("ntfy-Dienst läuft nicht (Name im Netz unbekannt) → fertiger Befehl zum Starten mit dem Deploy", async () => {
    const dnsFetch = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND ntfy" } });
    }) as unknown as typeof fetch;
    const t = await setup({ connections: { overrides: { ...baseOverrides, fetch: dnsFetch, env: { PATH: "/nirgends", NTFY_BASE_URL: "http://ntfy:80" } } } });
    const ntfy = byId(await report(t), "ntfy");
    expect(ntfy).toMatchObject({ state: "fail", command: "docker compose --profile push up -d" });
    expect(ntfy.cause).not.toMatch(/127\.0\.0\.1/);
  });

  it("gesunder ntfy und Socket-Proxy werden grün", async () => {
    const healthyFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v1/health")) return new Response(JSON.stringify({ healthy: true }), { status: 200 });
      if (u.endsWith("/_ping")) return new Response("OK", { status: 200 });
      if (u.endsWith("/containers/json")) return new Response("[]", { status: 200 });
      if (u.endsWith("/healthcheck")) return new Response("", { status: 200 });
      throw new Error(`unerwartet ${u}`);
    }) as unknown as typeof fetch;
    const t = await setup({ connections: { overrides: { ...baseOverrides, fetch: healthyFetch, env: { PATH: "/nirgends", NYXOS_DOZZLE_URL: "http://localhost:47802" } } } });
    const r = await report(t);
    expect(byId(r, "ntfy").state).toBe("ok");
    expect(byId(r, "socket-proxy").state).toBe("ok");
    expect(byId(r, "dozzle")).toMatchObject({ state: "ok", result: "http://localhost:47802" });
  });
});

// Vertrag für Werkzeuge, die ein Maschinen-Token prüfen: das Token lässt
// sich über den MCP-Weg beweisen, ohne dass der Server etwas schreibt (auch nicht das Lebenszeichen).
describe("Token-Probe des Skripts (PATCH /api/entries/<ungültig>)", () => {
  it("gültiges Token → 404 (ungültige ID), ungültiges → 401, und das Lebenszeichen der Brücke bleibt unberührt", async () => {
    const t = await setup({ signedIn: false });
    const lastSeen = async () => ((await t.db.execute(sql`select last_seen_at from machines where id = 'm1'`)) as unknown as { rows: { last_seen_at: unknown }[] }).rows[0]?.last_seen_at ?? null;
    const before = await lastSeen();
    const probe = (token: string) => t.app.request("/api/entries/probe-token", { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
    expect((await probe(t.auth.authorization.slice(7))).status).toBe(404);
    expect((await probe("falsch")).status).toBe(401);
    expect(await lastSeen()).toEqual(before);
    // Gegenprobe: der alte Weg über /ingest/events schreibt das Lebenszeichen sehr wohl.
    await t.app.request("/ingest/events", { method: "POST", headers: { "content-type": "application/json", ...t.auth }, body: "{}" });
    expect(await lastSeen()).not.toEqual(before);
  });
});
