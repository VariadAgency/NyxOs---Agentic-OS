// Einrichtung (Onboarding): `GET/POST /api/setup` reichen an die Brücke durch (RPC `setup.state`/`setup.apply`).
// Ohne Brücke gibt es einen leeren Stand; Fehler der Brücke werden zu klaren HTTP-Status.
import { BRIDGE_CAP_SETUP, BRIDGE_CAP_SETUP_BROWSE, emptySetupState, type SetupState } from "@nyxos/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/app.js";
import { registerSetupRoutes, type SetupHub } from "../src/routes/setup.js";
import type { RpcOutcome } from "../src/terminal/bridgeHub.js";

const STATE: SetupState = {
  bridgeOnline: true,
  os: "linux",
  projectRoots: ["/home/alex/code"],
  vaultDir: null,
  vaultExists: false,
  hooks: { claude: true, codex: false },
  shellIntegration: false,
  tools: { tmux: true, git: true, claude: true, codex: false, node: "v24.0.0" },
  suggestions: { projectRoots: ["/home/alex/Projects"], vaults: [] },
};

function fakeHub(o: { online?: boolean; caps?: string[]; reply?: (method: string, params: unknown) => RpcOutcome }) {
  const calls: { method: string; params: unknown }[] = [];
  const hub: SetupHub = {
    get online() {
      return o.online ?? true;
    },
    supports: (cap: string) => (o.caps ?? [BRIDGE_CAP_SETUP]).includes(cap),
    rpc: async (method, params) => {
      calls.push({ method, params });
      return o.reply ? o.reply(method, params) : { ok: true, result: STATE };
    },
  };
  return { hub, calls };
}

function appWith(hub: SetupHub) {
  const app = new Hono<AppEnv>();
  registerSetupRoutes(app, { bridgeHub: hub, platform: "linux" });
  return app;
}

const post = (app: Hono<AppEnv>, body: unknown) => app.request("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET /api/setup", () => {
  it("ohne Brücke: leerer Stand mit bridgeOnline false, ohne RPC", async () => {
    const { hub, calls } = fakeHub({ online: false });
    const res = await appWith(hub).request("/api/setup");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(emptySetupState("linux"));
    expect(calls).toHaveLength(0);
  });

  it("alte Brücke ohne Einrichtung: ebenfalls leerer Stand", async () => {
    const { hub, calls } = fakeHub({ caps: [] });
    expect(await (await appWith(hub).request("/api/setup")).json()).toMatchObject({ bridgeOnline: false });
    expect(calls).toHaveLength(0);
  });

  it("mit Brücke: Stand der Brücke per setup.state", async () => {
    const { hub, calls } = fakeHub({});
    const res = await appWith(hub).request("/api/setup");
    expect(await res.json()).toEqual(STATE);
    expect(calls).toEqual([{ method: "setup.state", params: {} }]);
  });

  it("unbrauchbare Antwort der Brücke: leerer Stand statt Absturz", async () => {
    const { hub } = fakeHub({ reply: () => ({ ok: true, result: { kaputt: true } }) });
    expect(await (await appWith(hub).request("/api/setup")).json()).toMatchObject({ bridgeOnline: false });
  });
});

describe("POST /api/setup", () => {
  it("reicht gültige Änderungen durch und liefert den neuen Stand", async () => {
    const { hub, calls } = fakeHub({});
    const body = { projectRoots: ["/home/alex/code"], installHooks: true, shellIntegration: false, vaultDir: null };
    const res = await post(appWith(hub), body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATE);
    expect(calls).toEqual([{ method: "setup.apply", params: body }]);
  });

  it("lehnt unbekannte Felder und falsche Typen ab (strikt), ohne RPC", async () => {
    const { hub, calls } = fakeHub({});
    expect((await post(appWith(hub), { projectRoots: "/x" })).status).toBe(400);
    expect((await post(appWith(hub), { foo: 1 })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("ohne Brücke: 503 bridge_offline", async () => {
    const { hub } = fakeHub({ online: false });
    const res = await post(appWith(hub), { installHooks: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "bridge_offline" });
  });

  it("Fehler der Brücke: fehlender Ordner → 400 mit ihrem Satz, Zeitüberschreitung → 504", async () => {
    const missing = fakeHub({ reply: () => ({ ok: false, error: "Diese Ordner gibt es nicht: /nope", code: "setup_missing_folder" }) });
    const r1 = await post(appWith(missing.hub), { projectRoots: ["/nope"] });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: "Diese Ordner gibt es nicht: /nope", code: "setup_missing_folder" });
    const slow = fakeHub({ reply: () => ({ ok: false, error: "Brücke antwortet nicht", code: "timeout" }) });
    expect((await post(appWith(slow.hub), { installHooks: false })).status).toBe(504);
  });
});

describe("GET /api/setup/browse", () => {
  const LIST = { path: "/home/alex", parent: "/home", home: "/home/alex", isRepo: false, entries: [{ name: "code", path: "/home/alex/code", isRepo: false, repoCount: 3 }], truncated: false };
  const caps = [BRIDGE_CAP_SETUP, BRIDGE_CAP_SETUP_BROWSE];

  it("reicht den Pfad an setup.browse durch; ohne Pfad: Home-Ordner", async () => {
    const { hub, calls } = fakeHub({ caps, reply: () => ({ ok: true, result: LIST }) });
    const app = appWith(hub);
    const res = await app.request("/api/setup/browse");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIST);
    await app.request(`/api/setup/browse?path=${encodeURIComponent("~/code")}`);
    expect(calls).toEqual([
      { method: "setup.browse", params: {} },
      { method: "setup.browse", params: { path: "~/code" } },
    ]);
  });

  it("ohne Brücke 503 bridge_offline, alte Brücke 503 bridge_outdated – jeweils ohne RPC", async () => {
    const off = fakeHub({ online: false, caps });
    expect(await (await appWith(off.hub).request("/api/setup/browse")).json()).toMatchObject({ code: "bridge_offline" });
    const old = fakeHub({ caps: [BRIDGE_CAP_SETUP] });
    const res = await appWith(old.hub).request("/api/setup/browse");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "bridge_outdated" });
    expect([...off.calls, ...old.calls]).toHaveLength(0);
  });

  it("Fehler der Brücke: fehlt → 400, keine Freigabe → 403 mit ihrem Satz, kaputte Antwort → 502", async () => {
    const missing = fakeHub({ caps, reply: () => ({ ok: false, error: "Diese Ordner gibt es nicht: /x", code: "setup_missing_folder" }) });
    expect((await appWith(missing.hub).request("/api/setup/browse?path=/x")).status).toBe(400);
    const denied = fakeHub({ caps, reply: () => ({ ok: false, error: "Bitte „Erlauben“ wählen.", code: "setup_denied" }) });
    const r = await appWith(denied.hub).request("/api/setup/browse?path=/Users/alex/Documents");
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "Bitte „Erlauben“ wählen.", code: "setup_denied" });
    const broken = fakeHub({ caps, reply: () => ({ ok: true, result: { entries: "nein" } }) });
    expect((await appWith(broken.hub).request("/api/setup/browse")).status).toBe(502);
  });

  it("zu langer Pfad: 400 ohne RPC", async () => {
    const { hub, calls } = fakeHub({ caps });
    expect((await appWith(hub).request(`/api/setup/browse?path=/${"a".repeat(5000)}`)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
