// Kontext-Wächter — API (Einstellungen, Auflösung, Anmeldung/CSRF), Ticker/Ingest-Wirkung
// (Hinweis + Push, Erzwingen über `send_text`, kein Doppel-Senden), Start-Umgebung.
import type { ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runContextGuardForSessions, runContextGuardTicker } from "../src/context-guard/tick.js";
import { contextGuardEvents, contextGuardState, sessions } from "../src/db/schema.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { CSRF_HEADER, SESSION_COOKIE } from "../src/terminal/auth.js";
import { setup } from "./helpers.js";

/** `Response.json()` ist `Promise<any>` — eigener Helfer statt `any` an jeder Aufrufstelle (wie in entries-routes.test.ts). */
async function j<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface SettingsSnapshot {
  default: { hinweisPct: number; erzwingenEnabled: boolean; erzwingenPct: number | null };
  haiku: { hinweisPct: number; erzwingenEnabled: boolean; erzwingenPct: number | null };
  models: unknown[];
  sessions: unknown[];
}
interface SessionView {
  thresholds: { hinweisPct: number; erzwingenPct: number | null; source: string };
}

/** Brücke im selben Prozess wie in terminal.test.ts: beantwortet RPCs synchron (oder verzögert, um
 * zu prüfen, dass `/ingest` NICHT auf den Wächter wartet). */
function fakeBridge(hub: BridgeHub, opts: { sendTextResult?: { sent: boolean; reason?: string }; startResult?: unknown; sendTextDelayMs?: number } = {}) {
  const sent: ServerToBridge[] = [];
  const socket = {
    send(data: string) {
      const msg = JSON.parse(data) as ServerToBridge;
      sent.push(msg);
      if (msg.op === "rpc" && msg.method === "send_text") {
        const respond = () => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result: opts.sendTextResult ?? { sent: true } }));
        if (opts.sendTextDelayMs) setTimeout(respond, opts.sendTextDelayMs);
        else queueMicrotask(respond);
      }
      if (msg.op === "rpc" && (msg.method === "start" || msg.method === "resume")) {
        queueMicrotask(() =>
          hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result: opts.startResult ?? { tmuxName: "zc-claude-xxxx0000", tool: "claude", sessionId: "sid-1", startedMs: 5 } })),
        );
      }
    },
    close() {},
  };
  hub.attach(socket, "m1");
  return { sent };
}

async function insertSession(db: Awaited<ReturnType<typeof setup>>["db"], overrides: Partial<typeof sessions.$inferInsert> & { id: string; sessionId: string }) {
  await db.insert(sessions).values({ tool: "claude", status: "running", state: "waiting", attachable: true, tmuxName: "zc-claude-aaaa1111", models: ["opus"], ...overrides });
}

describe("W-1 Einstellungen — Auflösung Session > Modell > Standard, Haiku separat", () => {
  it("Standard wird beim ersten Lesen lazy angelegt (60 % Hinweis, 80 % Erzwingen)", async () => {
    const t = await setup();
    const res = await t.app.request("/api/context-guard/settings");
    expect(res.status).toBe(200);
    const body = await j<SettingsSnapshot>(res);
    expect(body.default).toMatchObject({ hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 });
    expect(body.haiku).toMatchObject({ hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 });
    expect(body.models).toEqual([]);
    expect(body.sessions).toEqual([]);
  });

  it("Modell-Override wirkt für dieses Modell, Session-Override sticht über allem", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:s1", sessionId: "s1", models: ["opus"] });

    const modelPut = await t.app.request("/api/context-guard/settings/model/opus", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hinweisPct: 55, erzwingenEnabled: true, erzwingenPct: 85 }),
    });
    expect(modelPut.status).toBe(200);

    const stateForSession = await j<SessionView>(await t.app.request("/api/context-guard/sessions/s1"));
    expect(stateForSession.thresholds).toMatchObject({ hinweisPct: 55, erzwingenPct: 85, source: "model" });

    const sessionPut = await t.app.request("/api/context-guard/settings/session/s1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hinweisPct: 50, erzwingenEnabled: true, erzwingenPct: 70 }),
    });
    expect(sessionPut.status).toBe(200);

    const stateAfter = await j<SessionView>(await t.app.request("/api/context-guard/sessions/s1"));
    expect(stateAfter.thresholds).toMatchObject({ hinweisPct: 50, erzwingenPct: 70, source: "session" });
  });

  it("ungültige %-Kodierung im Modellnamen → 400, nicht 500 (`decodeURIComponent` wirft sonst)", async () => {
    const t = await setup();
    const putRes = await t.app.request("/api/context-guard/settings/model/%", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hinweisPct: 55, erzwingenEnabled: true, erzwingenPct: 85 }),
    });
    expect(putRes.status).toBe(400);
    const delRes = await t.app.request("/api/context-guard/settings/model/%", { method: "DELETE", headers: { "content-type": "application/json" } });
    expect(delRes.status).toBe(400);
  });

  it("Validierung: 50–100, hinweis ≤ erzwingen — 400 bei Verstoß", async () => {
    const t = await setup();
    const tooLow = await t.app.request("/api/context-guard/settings/default", { headers: { "content-type": "application/json" }, method: "PUT", body: JSON.stringify({ hinweisPct: 40, erzwingenEnabled: true, erzwingenPct: 80 }) });
    expect(tooLow.status).toBe(400);
    const inverted = await t.app.request("/api/context-guard/settings/default", { headers: { "content-type": "application/json" }, method: "PUT", body: JSON.stringify({ hinweisPct: 90, erzwingenEnabled: true, erzwingenPct: 70 }) });
    expect(inverted.status).toBe(400);
    const ok = await t.app.request("/api/context-guard/settings/default", { headers: { "content-type": "application/json" }, method: "PUT", body: JSON.stringify({ hinweisPct: 60, erzwingenEnabled: false, erzwingenPct: null }) });
    expect(ok.status).toBe(200);
  });

  it("Haiku-Session bekommt den Haiku-Eintrag statt des Standards", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:haiku1", sessionId: "haiku1", models: ["claude-haiku-4"] });
    await t.app.request("/api/context-guard/settings/haiku", { headers: { "content-type": "application/json" }, method: "PUT", body: JSON.stringify({ hinweisPct: 70, erzwingenEnabled: true, erzwingenPct: 90 }) });
    const view = await j<SessionView>(await t.app.request("/api/context-guard/sessions/haiku1"));
    expect(view.thresholds).toMatchObject({ hinweisPct: 70, erzwingenPct: 90, source: "haiku" });
  });
});

describe("Anmeldung — wie alle schreibenden Wege", () => {
  it("ohne Anmeldung: 401, mit falschem CSRF: 403", async () => {
    const t = await setup({ signedIn: false });
    const noAuth = await t.app.request("/api/context-guard/settings/default", { headers: { "content-type": "application/json" }, method: "PUT", body: JSON.stringify({ hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }) });
    expect(noAuth.status).toBe(401);

    const badCsrf = await t.app.request("/api/context-guard/settings/default", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${t.login.token}`, [CSRF_HEADER]: "falsch" },
      body: JSON.stringify({ hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }),
    });
    expect(badCsrf.status).toBe(403);

    // GET bleibt ohne Anmeldung erreichbar (lokal, wie die übrigen /api/*-Leseendpunkte vor Tailscale).
    const read = await t.app.request("/api/context-guard/settings");
    expect(read.status).toBe(200);
  });
});

describe("W-1 Ticker/Ingest — Hinweis genau einmal, Erzwingen nur wartend+tmux, kein Doppel-Senden", () => {
  it("Hinweis über der Schwelle wird genau einmal geloggt/gemerkt, auch über mehrere Ticks", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:hint1", sessionId: "hint1", state: "running", models: ["opus"] });
    const hub = t.bridgeHub;
    fakeBridge(hub);
    const deps = { db: t.db, hub: t.hub, bridgeHub: hub, pushSender: t.pushSender, getContextPct: () => 65, log: () => {} };

    await runContextGuardTicker(deps);
    await runContextGuardTicker(deps); // zweiter Tick, gleicher Wert — darf keinen zweiten Hinweis auslösen

    const events = await t.db.select().from(contextGuardEvents).where(eq(contextGuardEvents.sessionKey, "claude:hint1"));
    expect(events.filter((e) => e.action === "notified")).toHaveLength(1);
    const [state] = await t.db.select().from(contextGuardState).where(eq(contextGuardState.sessionKey, "claude:hint1"));
    expect(state?.hinweisNotifiedAt).not.toBeNull();
  });

  it("Erzwingen: nur wenn 'wartet' UND tmux (attachable) — sonst kein send_text, kein Merker gesetzt", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:force1", sessionId: "force1", state: "running", attachable: true, models: ["opus"] });
    const hub = t.bridgeHub;
    const bridge = fakeBridge(hub);
    const deps = { db: t.db, hub: t.hub, bridgeHub: hub, pushSender: t.pushSender, getContextPct: () => 90, log: () => {} };

    await runContextGuardTicker(deps); // Session läuft noch (nicht "waiting") → kein Erzwingen
    expect(bridge.sent.filter((m) => m.op === "rpc" && m.method === "send_text")).toHaveLength(0);
    const [afterRunning] = await t.db.select().from(contextGuardState).where(eq(contextGuardState.sessionKey, "claude:force1"));
    expect(afterRunning?.erzwingenAttemptedAt ?? null).toBeNull();

    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:force1"));
    await runContextGuardTicker(deps);
    const sendTextCalls = bridge.sent.filter((m) => m.op === "rpc" && m.method === "send_text");
    expect(sendTextCalls).toHaveLength(1);
    expect(sendTextCalls[0]).toMatchObject({ params: { tmuxName: "zc-claude-aaaa1111", text: "/compact" } });

    // Noch ein Tick über der Schwelle: kein zweiter Versuch (kein Doppel-Senden/keine Schleife).
    await runContextGuardTicker(deps);
    expect(bridge.sent.filter((m) => m.op === "rpc" && m.method === "send_text")).toHaveLength(1);
  });

  it("Wettlauf: zwei GLEICHZEITIGE Prüfungen (Ticker + Ingest) senden /compact nur einmal je Überschreitung", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:race1", sessionId: "race1", state: "waiting", attachable: true, models: ["opus"] });
    const bridge = fakeBridge(t.bridgeHub);
    const deps = { db: t.db, hub: t.hub, bridgeHub: t.bridgeHub, pushSender: t.pushSender, getContextPct: () => 90, log: () => {} };

    // Simuliert den 60-s-Ticker und einen Ingest-Aufruf, die zufällig gleichzeitig auf dieselbe
    // Session treffen — beide lesen `erzwingenAttemptedAt: null`, bevor irgendeiner geschrieben hat.
    await Promise.all([runContextGuardTicker(deps), runContextGuardForSessions(deps, ["claude:race1"])]);

    const sendTextCalls = bridge.sent.filter((m) => m.op === "rpc" && m.method === "send_text");
    expect(sendTextCalls).toHaveLength(1);
    const events = await t.db.select().from(contextGuardEvents).where(eq(contextGuardEvents.sessionKey, "claude:race1"));
    expect(events.filter((e) => e.action === "compact_sent")).toHaveLength(1);
  });

  it("nicht attachable (kein tmux) → nie send_text, obwohl 'wartet'", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:noterm1", sessionId: "noterm1", state: "waiting", attachable: false, tmuxName: null, models: ["opus"] });
    const bridge = fakeBridge(t.bridgeHub);
    await runContextGuardTicker({ db: t.db, hub: t.hub, bridgeHub: t.bridgeHub, pushSender: t.pushSender, getContextPct: () => 90, log: () => {} });
    expect(bridge.sent.filter((m) => m.op === "rpc" && m.method === "send_text")).toHaveLength(0);
  });

  it("Ingest-Pfad (`runContextGuardForSessions`) prüft nur die übergebenen Sessions", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:ingest1", sessionId: "ingest1", state: "waiting", models: ["opus"] });
    await insertSession(t.db, { id: "claude:ingest2", sessionId: "ingest2", state: "waiting", tmuxName: "zc-claude-bbbb2222", models: ["opus"] });
    const bridge = fakeBridge(t.bridgeHub);
    await runContextGuardForSessions({ db: t.db, hub: t.hub, bridgeHub: t.bridgeHub, pushSender: t.pushSender, getContextPct: () => 90, log: () => {} }, ["claude:ingest1"]);
    const [s1] = await t.db.select().from(contextGuardState).where(eq(contextGuardState.sessionKey, "claude:ingest1"));
    const [s2] = await t.db.select().from(contextGuardState).where(eq(contextGuardState.sessionKey, "claude:ingest2"));
    expect(s1?.erzwingenAttemptedAt ?? null).not.toBeNull();
    expect(s2).toBeUndefined(); // nicht angefasst
    expect(bridge.sent.filter((m) => m.op === "rpc" && m.method === "send_text")).toHaveLength(1);
  });

  it("`/ingest/events` wartet NICHT auf den Wächter (der läuft erst nach der Antwort, asynchron)", async () => {
    const t = await setup({ getContextPct: () => 90 });
    await insertSession(t.db, { id: "claude:ingestasync", sessionId: "ingestasync", state: "waiting", attachable: true, tmuxName: "zc-claude-aaaa1111", models: ["opus"] });
    // send_text (der langsame Schritt im Wächter) antwortet erst nach 300 ms — die Ingest-Antwort
    // muss trotzdem sofort kommen, wenn der Wächter wirklich erst NACH dem Commit, ohne await, läuft.
    const bridge = fakeBridge(t.bridgeHub, { sendTextDelayMs: 300 });
    const item = { type: "event" as const, event: { id: "e-ingestasync-1", tool: "claude" as const, sessionId: "ingestasync", ts: new Date().toISOString(), kind: "assistant" as const, source: "file" as const, data: {} } };

    const t0 = Date.now();
    const res = await t.post("/ingest/events", { items: [item] });
    const elapsedMs = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(250); // deutlich unter den 300 ms, die send_text braucht

    // Der Wächter lief tatsächlich (nur eben nicht VOR der Antwort) — send_text kommt kurz danach an.
    expect(await new Promise((resolve) => setTimeout(() => resolve(bridge.sent.filter((m) => m.op === "rpc" && m.method === "send_text").length), 400))).toBe(1);
  });
});

describe("W-1 Jetzt komprimieren (manueller Knopf)", () => {
  it("sendet /compact, wenn die Session wartet (sonst Warteschlange) — nur bei einer tmux-Session", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:manual1", sessionId: "manual1", state: "waiting", models: ["opus"] });
    fakeBridge(t.bridgeHub);
    const res = await t.app.request("/api/context-guard/sessions/manual1/compact-now", { headers: { "content-type": "application/json" }, method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true });

    await insertSession(t.db, { id: "claude:manual2", sessionId: "manual2", state: "running", attachable: false, tmuxName: null, models: ["opus"] });
    const notAttachable = await t.app.request("/api/context-guard/sessions/manual2/compact-now", { headers: { "content-type": "application/json" }, method: "POST", body: "{}" });
    expect(notAttachable.status).toBe(409);
    // einfacher Satz statt „läuft nicht in tmux“.
    expect(((await notAttachable.json()) as { error: string }).error).not.toMatch(/tmux/i);
  });
});

describe("W-1 Start-Umgebung — Auto-Compact-Grenze beim Start setzen", () => {
  it("`/api/terminal/start` reicht CLAUDE_AUTOCOMPACT_PCT_OVERRIDE an die Brücke weiter (Claude, Standard-Schwelle 80 %)", async () => {
    const t = await setup();
    const bridge = fakeBridge(t.bridgeHub);
    const res = await t.app.request("/api/terminal/start", { headers: { "content-type": "application/json" }, method: "POST", body: JSON.stringify({ tool: "claude", model: null, cwd: "/tmp", prompt: null, cols: 100, rows: 30 }) });
    expect(res.status).toBe(200);
    const startCall = bridge.sent.find((m) => m.op === "rpc" && m.method === "start");
    expect(startCall).toMatchObject({ params: { autoCompactEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" } } });
  });

  it("Codex bekommt `-c model_auto_compact_token_limit=<n>` VOR Modell/Prompt, wenn das Fenster bekannt ist", async () => {
    const t = await setup();
    const bridge = fakeBridge(t.bridgeHub);
    const res = await t.app.request("/api/terminal/start", { headers: { "content-type": "application/json" }, method: "POST", body: JSON.stringify({ tool: "codex", model: "gpt-6-astra", cwd: "/tmp", prompt: null, cols: 100, rows: 30 }) });
    expect(res.status).toBe(200);
    const startCall = bridge.sent.find((m) => m.op === "rpc" && m.method === "start");
    expect(startCall).toMatchObject({ params: { autoCompactArgs: ["-c", `model_auto_compact_token_limit=${Math.round(0.8 * 258_400)}`] } });
  });

  it("Erzwingen abgeschaltet → keine Auto-Compact-Umgebung beim Start", async () => {
    const t = await setup();
    await t.app.request("/api/context-guard/settings/default", { headers: { "content-type": "application/json" }, method: "PUT", body: JSON.stringify({ hinweisPct: 60, erzwingenEnabled: false, erzwingenPct: null }) });
    const bridge = fakeBridge(t.bridgeHub);
    await t.app.request("/api/terminal/start", { headers: { "content-type": "application/json" }, method: "POST", body: JSON.stringify({ tool: "claude", model: null, cwd: "/tmp", prompt: null, cols: 100, rows: 30 }) });
    const startCall = bridge.sent.find((m) => m.op === "rpc" && m.method === "start");
    expect(startCall).toMatchObject({ params: { autoCompactEnv: null } });
  });
});
