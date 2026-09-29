// Verbindungs-Prüfung im LOKALEN Modus (install.sh: ein Prozess auf 127.0.0.1, Brücke auf demselben Rechner).
// Eine frische, gesunde Installation darf nicht rot aussehen: reine Server-Technik (Socket-Proxy, Dozzle,
// Deploy-Protokoll, Token/Arbeiter im Container, Passkeys über einen Namen) fehlt ganz, Freiwilliges ohne
// Einrichtung ist grün „optional“, und „noch nichts angekommen“ ist `idle` statt `fail` — solange die Brücke
// gesund ist. Was lief und stehen geblieben ist, bleibt rot.
import { emptySetupState, type BridgeStatusReport, type ConnectionCheck, type ConnectionsReport, type HaikuStatus, type SetupState } from "@nyxos/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Updater } from "../src/app-info/updates.js";
import type { RpcOutcome } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type Overrides = NonNullable<NonNullable<Parameters<typeof setup>[0]>["connections"]>["overrides"];

const offlineFetch = (async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } });
}) as unknown as typeof fetch;

const MIN = 60_000;

function statusReport(over: Partial<BridgeStatusReport> = {}): BridgeStatusReport {
  return {
    at: Date.now(),
    version: "r1",
    queued: 0,
    dead: 0,
    lastOkAt: Date.now() - 5_000,
    lastError: null,
    archiveError: null,
    watchedFiles: 0,
    tmux: { ok: true, sessions: 0, error: null },
    scans: { usage: Date.now() - 10_000, git: Date.now() - 20_000, vault: null, catalog: null },
    vaultError: null,
    ...over,
  };
}

function setupState(over: Partial<SetupState> = {}): SetupState {
  const base = emptySetupState("darwin");
  return { ...base, bridgeOnline: true, hooks: { claude: true, codex: false }, tools: { ...base.tools, tmux: true, git: true, claude: false, codex: false, node: "24.0.0" }, ...over };
}

/** Brücke auf diesem Rechner, verbunden seit `connectedMs`. */
function localBridge(opts: { connectedMs?: number; online?: boolean; status?: BridgeStatusReport; setup?: SetupState } = {}) {
  const online = opts.online ?? true;
  return {
    status: () => ({ online, machineId: online ? "local" : null, since: online ? new Date(Date.now() - (opts.connectedMs ?? MIN)).toISOString() : null, tmuxSocket: "nyxos" }),
    rpc: async (method: string): Promise<RpcOutcome> => {
      if (!online) return { ok: false, error: "offline", code: "bridge_offline" };
      if (method === "status") return { ok: true, result: opts.status ?? statusReport() };
      if (method === "setup.state") return { ok: true, result: opts.setup ?? setupState() };
      if (method === "list_folders") return { ok: true, result: { folders: [{ label: "~", path: "/home/demo" }, { label: "notes", path: "/home/demo/notes" }] } };
      return { ok: false, error: "unbekannt", code: "failed" };
    },
    supports: (cap: string) => cap === "setup" || cap === "run_build",
  };
}

/** Nyx-Motor ohne Claude-Programm (frischer Rechner). */
const haikuWithoutClaude = {
  status: async () =>
    ({
      engine: { kind: "claude-cli", state: "waiting_token", available: false, reason: "Das Claude-Programm ist auf diesem Rechner nicht installiert.", model: "haiku" },
      reserve: { configured: false, baseUrl: null, model: null },
    }) as unknown as HaikuStatus,
};

function localOverrides(over: Overrides = {}): Overrides {
  return { fetch: offlineFetch, findBin: () => null, env: { PATH: "/nirgends" }, worker: null, bridge: localBridge(), haiku: haikuWithoutClaude, ...over };
}

async function report(t: Awaited<ReturnType<typeof setup>>): Promise<ConnectionsReport> {
  const res = await t.app.request("/api/connections?fresh=1");
  expect(res.status).toBe(200);
  return (await res.json()) as ConnectionsReport;
}

function byId(r: ConnectionsReport, id: string): ConnectionCheck {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`Prüfung ${id} fehlt`);
  return c;
}

const SERVER_ONLY = ["socket-proxy", "dozzle", "deploy-log", "haiku-cli", "haiku-token", "haiku-worker", "webauthn"];

describe("GET /api/connections — lokaler Modus", () => {
  it("frische, gesunde Installation: nichts rot, keine Server-Technik, „wartet“ statt „gestört“", async () => {
    const t = await setup({ connections: { mode: "local", overrides: localOverrides() } });
    await t.db.execute(sql`update machines set last_seen_at = now()`); // die Brücke meldet sich laufend
    const r = await report(t);
    expect(r.mode).toBe("local");
    const ids = r.checks.map((c) => c.id);
    for (const id of SERVER_ONLY) expect(ids, id).not.toContain(id);
    // Kein Vault eingerichtet → kein Vault-Scan; Codex nicht installiert → keine Codex-Erkennung.
    expect(ids).not.toContain("bridge-vault");
    expect(ids).not.toContain("codex");

    expect(r.checks.filter((c) => c.state === "fail").map((c) => c.id)).toEqual([]);
    expect(r.summary.fail).toBe(0);
    for (const id of ["bridge-ingest", "bridge-watcher", "bridge-usage"]) {
      expect(byId(r, id), id).toMatchObject({ state: "idle", ok: true, cause: "Kommt, sobald du eine Claude-Session startest." });
    }
    expect(byId(r, "bridge-git")).toMatchObject({ state: "idle", ok: true });
    expect(byId(r, "import-source").state).toBe("ok");
    expect(byId(r, "vault")).toMatchObject({ state: "ok", result: "optional, kein Vault eingerichtet" });
    expect(byId(r, "ntfy")).toMatchObject({ state: "ok", result: "optional, nicht eingerichtet" });
    expect(byId(r, "nyx-voice")).toMatchObject({ state: "ok", result: "optional, nicht eingerichtet" });
    expect(byId(r, "telegram").state).toBe("ok");
    // Die Ordner für „Neue Session“ heißen nicht „Projekt-Ordner“ (ohne eingetragene Projekt-Ordner zählt das Home-Verzeichnis).
    expect(byId(r, "bridge-rpc").result).toBe("2 Ordner für „Neue Session“");

    // Fehlendes Claude-Programm genau EINMAL, als „nur du“ mit dem Installationsbefehl aus dem Onboarding.
    const engine = byId(r, "haiku-engine");
    expect(engine).toMatchObject({ state: "user", command: "curl -fsSL https://claude.ai/install.sh | bash" });
    expect(engine.fix).toMatch(/„claude“/);
    expect(r.checks.filter((c) => /Claude-Programm/.test(c.cause ?? ""))).toHaveLength(1);

    // Keine Worte aus dem Server-Betrieb.
    const words = r.checks.map((c) => [c.label, c.expected, c.result, c.cause, c.fix].join(" ")).join("\n");
    expect(words).not.toMatch(/auf dem Server|diesem Server|Mac\b|Container|docker/i);
    for (const c of r.checks) if (c.state !== "ok") expect(c.cause, `${c.id} ohne Ursache`).toBeTruthy();
  });

  it("die Betriebsart kommt aus appInfo (wie local.ts sie setzt)", async () => {
    const appInfo = { version: "1.0.0", mode: "local" as const, demo: false, dataDir: null, updater: new Updater({ version: "1.0.0", cli: null }) };
    const t = await setup({ appInfo, connections: { overrides: localOverrides() } });
    const r = await report(t);
    expect(r.mode).toBe("local");
    expect(r.checks.map((c) => c.id)).not.toContain("socket-proxy");
  });

  it("was lief und stehen geblieben ist, bleibt rot: Brücke weg bzw. seit Langem verbunden, Verläufe da, aber nichts archiviert", async () => {
    const off = await setup({ connections: { mode: "local", overrides: localOverrides({ bridge: localBridge({ online: false }) }) } });
    const r = await report(off);
    expect(byId(r, "bridge-channel")).toMatchObject({ state: "fail", command: "nyxos restart" });
    expect(byId(r, "bridge-channel").cause).toMatch(/Brücke auf diesem Rechner/);
    expect(byId(r, "bridge-ingest").state).toBe("fail");
    expect(byId(r, "bridge-watcher").state).toBe("fail");

    const stuck = await setup({ connections: { mode: "local", overrides: localOverrides({ bridge: localBridge({ connectedMs: 3 * 60 * MIN, status: statusReport({ watchedFiles: 12, scans: { usage: Date.now(), git: null, vault: null, catalog: null } }) }) }) } });
    const r2 = await report(stuck);
    expect(byId(r2, "bridge-watcher")).toMatchObject({ state: "fail", cause: "Noch kein Verlauf im Archiv." });
    expect(byId(r2, "bridge-usage").state).toBe("fail");
    expect(byId(r2, "bridge-git")).toMatchObject({ state: "fail", command: "nyxos restart" });
  });

  it("gerade gestartete Brücke mit vorhandenen Verläufen: liest ein → wartet", async () => {
    const t = await setup({ connections: { mode: "local", overrides: localOverrides({ bridge: localBridge({ connectedMs: 2 * MIN, status: statusReport({ watchedFiles: 30 }) }) }) } });
    const r = await report(t);
    expect(byId(r, "bridge-watcher")).toMatchObject({ state: "idle", cause: expect.stringContaining("liest die vorhandenen Verläufe ein") });
  });

  it("Ingest: fehlende Hooks sind ein „nur du“-Punkt; liefen seit der Einrichtung Sessions ohne Ereignis, eine Warnung", async () => {
    const noHooks = await setup({ connections: { mode: "local", overrides: localOverrides({ bridge: localBridge({ setup: setupState({ hooks: { claude: false, codex: false } }) }) }) } });
    expect(byId(await report(noHooks), "bridge-ingest")).toMatchObject({ state: "user", fix: expect.stringContaining("Onboarding erneut starten") });

    const ran = await setup({ connections: { mode: "local", overrides: localOverrides() } });
    await ran.db.execute(sql`update machines set created_at = now() - interval '2 hours'`);
    await ran.db.execute(sql`insert into sessions (id, tool, session_id, last_activity_at) values ('claude:s1', 'claude', 's1', now() - interval '5 minutes')`);
    expect(byId(await report(ran), "bridge-ingest")).toMatchObject({ state: "warn", cause: expect.stringContaining("kein Ereignis") });
  });

  it("eingerichteter Vault und Codex werden geprüft; Push über ntfy.sh wird geprüft", async () => {
    const healthy = (async (url: string | URL) => (String(url) === "https://ntfy.sh/v1/health" ? new Response(JSON.stringify({ healthy: true }), { status: 200 }) : Promise.reject(new TypeError("fetch failed")))) as unknown as typeof fetch;
    const bridge = localBridge({ connectedMs: 3 * 60 * MIN, status: statusReport({ watchedFiles: 4, scans: { usage: Date.now(), git: Date.now(), vault: Date.now() - MIN, catalog: null } }), setup: setupState({ vaultDir: "/home/demo/vault", vaultExists: true, tools: { ...setupState().tools, codex: true } }) });
    const t = await setup({ connections: { mode: "local", overrides: localOverrides({ bridge, fetch: healthy }) } });
    await t.db.execute(sql`insert into push_settings (id, topic, ntfy_target) values (1, 'nyxos-test', 'ntfy_sh') on conflict (id) do update set ntfy_target = 'ntfy_sh'`);
    const r = await report(t);
    expect(r.checks.map((c) => c.id)).toContain("bridge-vault");
    expect(byId(r, "vault")).toMatchObject({ state: "fail", result: "0 Notizen" });
    expect(byId(r, "codex")).toMatchObject({ state: "idle", cause: "Kommt, sobald du Codex startest." });
    expect(byId(r, "ntfy")).toMatchObject({ state: "ok", result: "https://ntfy.sh" });
  });

  it("Server-Modus bleibt, wie er war: alle Prüfungen, Server-Worte, kein „wartet“", async () => {
    const t = await setup({ connections: { overrides: { ...localOverrides(), bridge: localBridge() } } });
    const r = await report(t);
    expect(r.mode).toBe("server");
    for (const id of SERVER_ONLY) expect(r.checks.map((c) => c.id)).toContain(id);
    expect(r.checks.filter((c) => c.state === "idle")).toEqual([]);
    expect(byId(r, "bridge-ingest")).toMatchObject({ state: "fail", cause: "Es ist noch nie ein Session-Ereignis angekommen." });
    expect(byId(r, "bridge-rpc").result).toBe("2 Projekt-Ordner gemeldet");
  });
});
