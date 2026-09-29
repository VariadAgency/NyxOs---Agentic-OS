// „In der NyxOS übernehmen“: Server-Routen. Vorschau für den Dialog (was hängt an der Session,
// was empfehlen wir) und das Übernehmen selbst (nur freigegebene PIDs gehen an die Brücke). Anmeldung nötig,
// nur für bekannte Sessions, Fehler in einfachen Worten (nie „tmux“).
import type { ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { CSRF_HEADER } from "../src/terminal/auth.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup, TOKEN } from "./helpers.js";

type Rpc = Extract<ServerToBridge, { op: "rpc" }>;

/** Brücke im selben Prozess: beantwortet RPCs über `reply`, merkt sich alles Gesendete. */
function fakeBridge(hub: BridgeHub, reply: (m: Rpc) => { ok: boolean; result?: unknown; error?: string; code?: string } | undefined) {
  const sent: Rpc[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc") return;
        sent.push(msg);
        const a = reply(msg);
        if (a) queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ...a })));
      },
      close() {},
    },
    "m1",
  );
  return sent;
}

const json = { "content-type": "application/json" };
const now = () => new Date().toISOString();

async function withSession(t: Awaited<ReturnType<typeof setup>>, sessionId: string, extra: Record<string, unknown> = {}) {
  await t.post("/ingest/events", { items: [{ type: "state", state: { tool: "claude", sessionId, running: true, observedAt: now() } }] });
  await t.db.update(sessions).set({ cwd: "/Users/alex/projects/App", ...extra }).where(eq(sessions.id, `claude:${sessionId}`));
}

describe("Übernehmen: Anmeldung und nur bekannte Sessions", () => {
  it("ohne Anmeldung → 401 (Vorschau und Übernehmen)", async () => {
    const { app } = await setup({ signedIn: false });
    for (const path of ["/api/sessions/claude:x/takeover", "/api/sessions/claude:x/takeover/preview"]) {
      const res = await app.request(path, { method: "POST", headers: json, body: "{}" });
      expect(res.status, path).toBe(401);
    }
  });

  it("angemeldet, aber ohne passendes CSRF-Token → 403, die Brücke wird nicht gefragt", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-csrf");
    const sent = fakeBridge(hub, () => ({ ok: true, result: { processes: [], inNyxOS: null } }));
    for (const path of ["/api/sessions/claude:tk-csrf/takeover", "/api/sessions/claude:tk-csrf/takeover/preview"]) {
      const res = await t.app.request(path, { method: "POST", headers: { ...json, [CSRF_HEADER]: "falsch" }, body: JSON.stringify({ endPids: [4242] }) });
      expect(res.status, path).toBe(403);
    }
    expect(sent).toHaveLength(0);
  });

  it("das Maschinen-Token der Brücke reicht NICHT (nur Anmeldung + CSRF)", async () => {
    const hub = new BridgeHub();
    const t = await setup({ signedIn: false, bridgeHub: hub });
    const sent = fakeBridge(hub, () => ({ ok: true, result: { processes: [], inNyxOS: null } }));
    for (const path of ["/api/sessions/claude:x/takeover", "/api/sessions/claude:x/takeover/preview"]) {
      const res = await t.app.request(path, { method: "POST", headers: { ...json, authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ endPids: [4242] }) });
      expect(res.status, path).toBe(401);
    }
    expect(sent).toHaveLength(0);
  });

  it("unbekannte Session → 404, die Brücke wird nicht gefragt", async () => {
    const hub = new BridgeHub();
    const { app } = await setup({ bridgeHub: hub });
    const sent = fakeBridge(hub, () => ({ ok: true, result: {} }));
    for (const path of ["/api/sessions/claude:gibtsnicht/takeover", "/api/sessions/claude:gibtsnicht/takeover/preview"]) {
      expect((await app.request(path, { method: "POST", headers: json, body: "{}" })).status, path).toBe(404);
    }
    expect(sent).toHaveLength(0);
  });
});

describe("Übernehmen: Vorschau für den Dialog", () => {
  it("altes Fenster läuft noch und die Session wartet → Programme + Empfehlung „altes Fenster beenden“", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-wait", { state: "waiting" });
    const sent = fakeBridge(hub, (m) => (m.method === "takeover_info" ? { ok: true, result: { processes: [{ pid: 4242, app: "Terminal" }], inNyxOS: null } } : undefined));
    const res = await t.app.request("/api/sessions/claude:tk-wait/takeover/preview", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attachable: false, tool: "claude", processes: [{ pid: 4242, app: "Terminal" }], inNyxOS: null, working: false, recommended: "end_old" });
    expect(sent[0]).toMatchObject({ method: "takeover_info", params: { tool: "claude", sessionId: "tk-wait" } });
  });

  it("arbeitet die Session gerade → Empfehlung „nur mitlesen“ (nichts unterbrechen)", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-busy", { state: "running" });
    fakeBridge(hub, () => ({ ok: true, result: { processes: [{ pid: 77, app: null }], inNyxOS: null } }));
    const body = (await (await t.app.request("/api/sessions/claude:tk-busy/takeover/preview", { method: "POST", headers: json, body: "{}" })).json()) as { recommended: string; working: boolean };
    expect(body).toMatchObject({ working: true, recommended: "watch" });
  });

  it("kein Programm mehr dran → einfach fortsetzen", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-idle");
    fakeBridge(hub, () => ({ ok: true, result: { processes: [], inNyxOS: null } }));
    const body = (await (await t.app.request("/api/sessions/claude:tk-idle/takeover/preview", { method: "POST", headers: json, body: "{}" })).json()) as { recommended: string };
    expect(body.recommended).toBe("resume");
  });

  it("schon in der NyxOS → nichts zu tun, Brücke nicht gefragt", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-in", { tmuxName: "zc-claude-already1", attachable: true });
    const sent = fakeBridge(hub, () => ({ ok: true, result: {} }));
    const body = await (await t.app.request("/api/sessions/claude:tk-in/takeover/preview", { method: "POST", headers: json, body: "{}" })).json();
    expect(body).toMatchObject({ attachable: true });
    expect(sent).toHaveLength(0);
  });

  it("Mac nicht verbunden → 503 mit verständlichem Satz", async () => {
    const t = await setup({ bridgeHub: new BridgeHub() });
    await withSession(t, "tk-off");
    const res = await t.app.request("/api/sessions/claude:tk-off/takeover/preview", { method: "POST", headers: json, body: "{}" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Rechner/);
  });
});

describe("Übernehmen", () => {
  it("reicht NUR die bestätigten PIDs + Arbeitsordner an die Brücke; danach ist die Session anhängbar", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-go");
    const sent = fakeBridge(hub, (m) => (m.method === "takeover" ? { ok: true, result: { tmuxName: "zc-claude-takeov01", tool: "claude", sessionId: "tk-go", startedMs: 30 } } : undefined));
    const res = await t.app.request("/api/sessions/claude:tk-go/takeover", { method: "POST", headers: json, body: JSON.stringify({ endPids: [4242], cols: 132, rows: 40 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tmuxName: "zc-claude-takeov01" });
    expect(sent[0]).toMatchObject({ method: "takeover", params: { tool: "claude", sessionId: "tk-go", cwd: "/Users/alex/projects/App", endPids: [4242], cols: 132, rows: 40 } });
    const [row] = await t.db.select().from(sessions).where(eq(sessions.id, "claude:tk-go"));
    expect(row).toMatchObject({ tmuxName: "zc-claude-takeov01", attachable: true, startedVia: "nyxos" });
  });

  it("ungültige PIDs → 400, die Brücke wird nicht gefragt", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-bad");
    const sent = fakeBridge(hub, () => ({ ok: true, result: {} }));
    for (const endPids of [["1; rm"], [-1], [0], "4242"]) {
      const res = await t.app.request("/api/sessions/claude:tk-bad/takeover", { method: "POST", headers: json, body: JSON.stringify({ endPids }) });
      expect(res.status, JSON.stringify(endPids)).toBe(400);
    }
    expect(sent).toHaveLength(0);
  });

  it("Fehler der Brücke kommen als einfacher Satz an, nie als Technik-Meldung", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-err");
    let code = "process_changed";
    fakeBridge(hub, () => ({ ok: false, error: "tmux: can't find session", code }));
    for (const [c, status] of [
      ["process_changed", 409],
      ["process_running", 409],
      ["tmux_missing", 503],
      ["bad_folder", 400],
    ] as const) {
      code = c;
      const res = await t.app.request("/api/sessions/claude:tk-err/takeover", { method: "POST", headers: json, body: JSON.stringify({ endPids: [1] }) });
      expect(res.status, c).toBe(status);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe(c);
      expect(body.error, c).not.toMatch(/tmux|ENOENT|pid/i);
      expect(body.error.length, c).toBeGreaterThan(20);
    }
    const [row] = await t.db.select().from(sessions).where(eq(sessions.id, "claude:tk-err"));
    expect(row?.attachable).toBe(false);
  });

  it("altes Fenster ließ sich nicht beenden → ehrlicher Satz (selbst schließen), kein Rat, denselben Knopf zu drücken", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await withSession(t, "tk-stuck");
    fakeBridge(hub, () => ({ ok: false, error: "Das alte Fenster hat sich nicht beendet", code: "process_stuck" }));
    const res = await t.app.request("/api/sessions/claude:tk-stuck/takeover", { method: "POST", headers: json, body: JSON.stringify({ endPids: [4242] }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("process_stuck");
    expect(body.error).toMatch(/nicht beenden|selbst/);
    expect(body.error).not.toMatch(/Wähle „Altes Fenster beenden“/);
  });
});
