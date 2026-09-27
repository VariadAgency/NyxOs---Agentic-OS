// Nyx bedient ganz NyxOS: Werkzeug `app_api` ruft jeden /api-Weg der App im selben Prozess auf – angemeldet als
// der Nutzer über einen nur im Speicher existierenden Weg. Gesperrte Wege (Anmeldung, Geheimnisse, Nyx-Runde) gehen nie,
// riskante Wege (Löschen, Session beenden, Freigaben entscheiden …) erst nach des Nutzers Klick auf „Ausführen“,
// automatische Läufe (geplante Aufgaben …) dürfen nur lesen.
import { BRIDGE_CAP_CHAT, type ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { haikuMessages, haikuThreads, inboxItems, nyxApiCalls, sessions } from "../src/db/schema.js";
import type { EngineEvent, EngineRequest } from "../src/haiku/engine.js";
import { HaikuRuntime } from "../src/haiku/runtime.js";
import { buildDefaultRegistry, type ToolContext } from "../src/haiku/tools.js";
import { markInternalRequest } from "../src/nyx/appApi/internal.js";
import { APP_API_BODY_LIMIT, BLOCKED_RULES, CONFIRM_RULES, classifyApiRequest, matchRoutePattern, validateApiPath } from "../src/nyx/appApi/rules.js";
import { APP_API_PROMPT } from "../src/nyx/appApiPrompt.js";
import { buildNyxSystemPrompt } from "../src/nyx/prompt.js";
import { cb } from "../src/telegram/callbacks.js";
import { staticTokenSource } from "../src/telegram/tokens.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup, sharedDb } from "./helpers.js";
import { FakeEngine, answer } from "./assistant/assistant-helpers.js";

const TG_TOKEN = "123456789:AAHfakefakefakefakefakefakefakefake12";
const BOT_INFO = { id: 123456789, is_bot: true, first_name: "Nyx", username: "nyx_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as UserFromGetMe;
const ME = 4242;

function fakeTelegram() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let nextId = 100;
  const factory = (token: string) => {
    const bot = new Bot(token, { botInfo: BOT_INFO });
    bot.api.config.use((async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
      calls.push({ method, payload });
      if (method === "getMe") return { ok: true, result: BOT_INFO };
      if (method === "sendMessage") return { ok: true, result: { message_id: nextId++, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } };
      return { ok: true, result: true };
    }) as never);
    return bot;
  };
  return { calls, factory, sent: () => calls.filter((c) => c.method === "sendMessage") };
}

/** Brücke im selben Prozess: beantwortet jeden RPC, merkt sich alle. */
function fakeBridge(hub: BridgeHub) {
  const rpcs: { method: string; params: Record<string, unknown> }[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc") return;
        const params = msg.params as Record<string, unknown>;
        rpcs.push({ method: msg.method, params });
        let result: unknown = { ok: true };
        if (msg.method === "start") result = { tmuxName: "zc-claude-n1x2y3z4", tool: "claude", sessionId: "0b5e2b1c-1111-4222-8333-944455556666", startedMs: 90 };
        if (msg.method === "kill") result = { killed: true };
        if (msg.method === "send_message") result = { sent: true, busy: false };
        if (msg.method === "send_text") result = { sent: true };
        queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result })));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "r4", tmuxSocket: "nyxos", caps: [BRIDGE_CAP_CHAT] }));
  return { rpcs };
}

/** App mit eigener Laufzeit (Fake-Motor) – wie assistant-helpers.ts, aber mit Brücke und optional Telegram. */
async function app(opts: { engine?: FakeEngine; telegram?: boolean; signedIn?: boolean } = {}) {
  const hub = new BridgeHub();
  const bridge = fakeBridge(hub);
  const tg = fakeTelegram();
  const engine = opts.engine ?? new FakeEngine(answer("Ok."));
  const db = await sharedDb();
  const runtime = new HaikuRuntime({ db, tools: buildDefaultRegistry(), cliEngine: engine, apiEngine: null, ideas: null, concurrency: 1 });
  const t = await setup({
    bridgeHub: hub,
    signedIn: opts.signedIn,
    haiku: { runtime },
    ...(opts.telegram ? { telegram: { tokens: staticTokenSource(TG_TOKEN), botFactory: tg.factory, polling: false, bufferMs: 0 } } : {}),
  });
  if (opts.telegram) {
    await t.telegram.start();
    const { code } = await t.telegram.createPairing();
    await t.telegram.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: ME, type: "private", first_name: "C" }, from: { id: ME, is_bot: false, first_name: "C" }, text: `/start ${code}`, entities: [{ type: "bot_command", offset: 0, length: 6 }] } });
    await t.telegram.idle();
  }
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ db: t.db, scope: "full", ideaLink: null, ideas: null, kind: "chat", channel: "web", threadId: null, ...over });
  const call = (args: unknown, over: Partial<ToolContext> = {}) => t.haiku.tools.call("full", "app_api", args, ctx(over)) as Promise<Record<string, unknown>>;
  const katalog = (args: unknown = {}) => t.haiku.tools.call("full", "app_api_katalog", args, ctx()) as Promise<Record<string, unknown>>;
  return { t, bridge, tg, engine, runtime, call, katalog, ctx };
}

async function newThread(db: Awaited<ReturnType<typeof app>>["t"]["db"]): Promise<number> {
  const [th] = await db.insert(haikuThreads).values({ scope: "full", topic: "test", day: "2026-09-26", title: "Test" }).returning({ id: haikuThreads.id });
  return th?.id ?? 0;
}

async function insertSession(db: Awaited<ReturnType<typeof app>>["t"]["db"], id = "claude:s1", sid = "s1") {
  await db.insert(sessions).values({ id, sessionId: sid, tool: "claude", status: "running", state: "waiting", attachable: true, tmuxName: "zc-claude-abcd1234", models: ["claude-opus-5-5"] });
}

describe("app_api · Regeln (Sperren, Bestätigung, Pfade)", () => {
  it("gesperrt: Anmeldung, Geheimnisse, Zugänge, Nyx-Runde, Cursor-Wege – egal welche Methode", () => {
    const blocked: [string, string][] = [
      ["GET", "/api/auth/status"],
      ["POST", "/api/auth/logout-all"],
      ["POST", "/api/auth/setup-code"],
      ["DELETE", "/api/auth/credentials/abc"],
      ["GET", "/api/secrets"],
      ["PUT", "/api/secrets/OPENAI_KEY"],
      ["GET", "/api/access"],
      ["PUT", "/api/access/anthropic"],
      ["PUT", "/api/telegram/token"],
      ["POST", "/api/telegram/pairing"],
      ["PUT", "/api/nyx/voice/elevenlabs/key"],
      ["POST", "/api/models/providers"],
      ["PUT", "/api/models/providers/7"],
      ["POST", "/api/mcp/connectors"],
      ["GET", "/api/idealinks"],
      ["POST", "/api/idealinks"],
      ["GET", "/api/push/subscribe"],
      ["POST", "/api/haiku/chat"],
      ["POST", "/api/haiku/selftest"],
      ["POST", "/api/nyx/ui/command"],
      ["GET", "/api/nyx/ui/screen"],
      ["POST", "/api/away/heartbeat"],
      ["POST", "/api/server/ssh/start"],
    ];
    for (const [m, p] of blocked) expect(classifyApiRequest(m, p).access, `${m} ${p}`).toBe("gesperrt");
  });

  it("Bestätigung: jedes DELETE, Session beenden/schließen/übernehmen, Freigaben und Entscheidungen, Git-Schreiben", () => {
    const confirm: [string, string][] = [
      ["DELETE", "/api/entries/5"],
      ["DELETE", "/api/nyx/schedules/3"],
      ["POST", "/api/sessions/claude:x/kill"],
      ["POST", "/api/sessions/claude:x/close"],
      ["POST", "/api/sessions/claude:x/takeover"],
      ["POST", "/api/approvals/3/decide"],
      ["POST", "/api/inbox/3/answer"],
      ["POST", "/api/inbox/3/dismiss"],
      ["POST", "/api/haiku/release-all"],
      ["POST", "/api/conflicts/decisions/dismiss"],
      ["POST", "/api/conflicts/pause"],
      ["POST", "/api/git/merge"],
      // Nyx soll sein eigenes Tages-Budget / die Ideen-Link-Grenzen nicht selbst lockern.
      ["PATCH", "/api/haiku/settings"],
    ];
    for (const [m, p] of confirm) expect(classifyApiRequest(m, p).access, `${m} ${p}`).toBe("bestaetigung");
  });

  it("direkt: lesen, Einstellungen, Session starten, in eine Session schreiben, Aufgaben anlegen", () => {
    const direct: [string, string][] = [
      ["GET", "/api/sessions"],
      ["POST", "/api/terminal/start"],
      ["POST", "/api/sessions/claude:x/message"],
      ["PUT", "/api/nyx/profile"],
      ["PATCH", "/api/entries/1"],
      ["POST", "/api/entries"],
    ];
    for (const [m, p] of direct) expect(classifyApiRequest(m, p).access, `${m} ${p}`).toBe("direkt");
  });

  it("Pfade: nur saubere /api/-Wege, keine Umgehung über Punkte, Kodierung oder Abfrage im Pfad", () => {
    expect(validateApiPath("/api/sessions")).toBeNull();
    expect(validateApiPath("/api/sessions/claude:abc-1/transcript")).toBeNull();
    for (const bad of ["/health", "/ingest/events", "/api/../api/auth/status", "/api/./auth/status", "/api/%2e%2e/auth/status", "/api/auth%2Fstatus", "//api/sessions", "/api/sessions?x=1", "/api/sessions#a", "/api\\auth", "api/sessions", "/api//auth/status", "/live"]) {
      expect(validateApiPath(bad), bad).not.toBeNull();
    }
  });

  it("jeder Tabellen-Eintrag trifft einen echten Weg der App, und jeder /api-Weg ist eingeordnet", async () => {
    const { t } = await app();
    const routes = t.app.routes.filter((r) => r.path.startsWith("/api/") && r.method !== "ALL");
    const sample = (p: string) => p.replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x1").replace(/\*$/, "x1");
    for (const rule of [...BLOCKED_RULES, ...CONFIRM_RULES]) {
      if (rule.pattern === "/api/**" || rule.future) continue; // „jedes DELETE“ bzw. Vorsorge
      const hit = routes.some((r) => (rule.methods === "*" || rule.methods.includes(r.method)) && matchRoutePattern(rule.pattern, sample(r.path)));
      expect(hit, `${String(rule.methods)} ${rule.pattern}`).toBe(true);
    }
    for (const r of routes) expect(["direkt", "bestaetigung", "gesperrt"]).toContain(classifyApiRequest(r.method, sample(r.path)).access);
  });
});

describe("app_api · interner Anmelde-Weg", () => {
  it("nur im Prozess markierte Anfragen gelten als Alex – von außen hilft kein Kopf", async () => {
    const { t } = await app({ signedIn: false });
    const profile = (await (await t.app.request("/api/nyx/profile")).json()) as { profile: Record<string, unknown> };
    const put = () => new Request("http://localhost/api/nyx/profile", { method: "PUT", headers: { "content-type": "application/json", "x-nyx-internal": "1", authorization: "Bearer x" }, body: JSON.stringify(profile.profile) });
    expect((await t.app.fetch(put())).status).toBe(401);
    const internal = put();
    markInternalRequest(internal);
    expect((await t.app.fetch(internal)).status).toBe(200);
  });

  it("auch markiert kommt keine Anfrage an gesperrte Wege (zweite Sperre im Anmelde-Tor)", async () => {
    const { t } = await app({ signedIn: false });
    const req = new Request("http://localhost/api/auth/logout-all", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    markInternalRequest(req);
    expect((await t.app.fetch(req)).status).toBe(403);
    const secrets = new Request("http://localhost/api/secrets");
    markInternalRequest(secrets);
    expect((await t.app.fetch(secrets)).status).toBe(403);
  });
});

describe("app_api · Werkzeug", () => {
  it("Sessions auflisten (GET) liefert Status und JSON", async () => {
    const { t, call } = await app();
    await insertSession(t.db);
    const r = await call({ method: "GET", path: "/api/sessions" });
    expect(r.status).toBe(200);
    expect((r.antwort as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toContain("claude:s1");
  });

  it("neue Session starten (Werkzeug, Modell, Ordner, Auftrag) – die Brücke bekommt genau das", async () => {
    const { call, bridge } = await app();
    const r = await call({ method: "POST", path: "/api/terminal/start", body: { tool: "claude", model: "claude-opus-5-5", cwd: "/Users/alex/projects", prompt: "Bau die Suche um" } });
    expect(r.status).toBe(200);
    const start = bridge.rpcs.find((x) => x.method === "start");
    expect(start?.params).toMatchObject({ tool: "claude", model: "claude-opus-5-5", cwd: "/Users/alex/projects", prompt: "Bau die Suche um" });
  });

  it("Text in eine laufende Session schreiben (derselbe Weg wie der Session-Chat)", async () => {
    const { t, call, bridge } = await app();
    await insertSession(t.db);
    const r = await call({ method: "POST", path: "/api/sessions/claude:s1/message", body: { text: "Mach bitte mit Schritt 2 weiter" } });
    expect(r.status).toBe(200);
    const sent = bridge.rpcs.find((x) => x.method === "send_message");
    expect(JSON.stringify(sent?.params)).toContain("Mach bitte mit Schritt 2 weiter");
  });

  it("eine Nyx-Einstellung ändern (Profil, Regler „Länge“)", async () => {
    const { t, call } = await app();
    const got = await call({ method: "GET", path: "/api/nyx/profile" });
    const profile = (got.antwort as { profile: { sliders: { length: number } } & Record<string, unknown> }).profile;
    const next = profile.sliders.length === 80 ? 20 : 80;
    const r = await call({ method: "PUT", path: "/api/nyx/profile", body: { ...profile, activePreset: null, sliders: { ...profile.sliders, length: next } } });
    expect(r.status).toBe(200);
    const after = (await (await t.app.request("/api/nyx/profile")).json()) as { profile: { sliders: { length: number } } };
    expect(after.profile.sliders.length).toBe(next);
  });

  it("Abfrage-Parameter gehen mit", async () => {
    const { t, call } = await app();
    await insertSession(t.db, "claude:s1", "s1");
    await insertSession(t.db, "claude:s2", "s2");
    const r = await call({ method: "GET", path: "/api/sessions", query: { limit: "1" } });
    expect((r.antwort as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("gesperrte Wege: nichts passiert, Nyx bekommt den Grund, im Protokoll „abgelehnt“", async () => {
    const { t, call } = await app();
    const r = await call({ method: "POST", path: "/api/auth/logout-all", body: {} });
    expect(r).toMatchObject({ ausgefuehrt: false, abgelehnt: true });
    expect(String(r.grund)).toMatch(/Anmeldung/);
    const [log] = await t.db.select().from(nyxApiCalls);
    expect(log).toMatchObject({ method: "POST", path: "/api/auth/logout-all", outcome: "abgelehnt", channel: "web" });
  });

  it("automatische Läufe (geplante Aufgabe, ohne Kanal) dürfen nur lesen", async () => {
    const { t, call, bridge } = await app();
    await insertSession(t.db);
    const write = { method: "POST", path: "/api/sessions/claude:s1/message", body: { text: "hallo" } };
    const sched = await call(write, { kind: "schedule", channel: null });
    expect(sched).toMatchObject({ ausgefuehrt: false, abgelehnt: true });
    const noChannel = await call(write, { kind: "chat", channel: null });
    expect(noChannel).toMatchObject({ ausgefuehrt: false, abgelehnt: true });
    const compact = await call(write, { kind: "compact", channel: "web" });
    expect(compact).toMatchObject({ ausgefuehrt: false, abgelehnt: true });
    expect(bridge.rpcs.filter((x) => x.method === "send_message")).toHaveLength(0);
    // Lesen geht
    const read = await call({ method: "GET", path: "/api/sessions" }, { kind: "schedule", channel: null });
    expect(read.status).toBe(200);
    // Auch eine Bestätigung darf ein automatischer Lauf nicht anlegen
    const kill = await call({ method: "POST", path: "/api/sessions/claude:s1/kill", body: { confirm: true } }, { kind: "schedule", channel: null });
    expect(kill).toMatchObject({ abgelehnt: true });
    expect(await t.db.select().from(inboxItems)).toHaveLength(0);
  });

  it("große Antworten werden gekürzt – und Nyx erfährt das", async () => {
    const { t, call } = await app();
    for (let i = 0; i < 120; i++) await t.db.insert(sessions).values({ id: `claude:big${i}`, sessionId: `big${i}`, tool: "claude", status: "running", state: "idle", title: `Session ${i} ${"x".repeat(300)}` });
    const r = await call({ method: "GET", path: "/api/sessions" });
    expect(r.gekuerzt).toBe(true);
    expect(String(r.antwort).length).toBeLessThanOrEqual(APP_API_BODY_LIMIT + 200);
    expect(String(r.hinweis)).toMatch(/gekürzt/);
  });

  it("Protokoll: jeder Aufruf mit Methode, Weg, Status, Kanal – Körper ohne Geheimnisse", async () => {
    const { t, call } = await app();
    await insertSession(t.db);
    await call({ method: "POST", path: "/api/sessions/claude:s1/message", body: { text: "mein api_key=sk-live-1234567890 bitte", token: "geheim-abc-123456" } }, { channel: "telegram" });
    const [log] = await t.db.select().from(nyxApiCalls);
    expect(log).toMatchObject({ method: "POST", path: "/api/sessions/claude:s1/message", status: 200, outcome: "ausgefuehrt", channel: "telegram" });
    expect(log?.bodyRedacted ?? "").not.toContain("sk-live-1234567890");
    expect(log?.bodyRedacted ?? "").not.toContain("geheim-abc-123456");
    expect(log?.pendingBody).toBeNull();
  });

  it("Katalog: Wege mit deutschem Zweck und Zugriff, filterbar; gesperrte sind markiert", async () => {
    const { katalog } = await app();
    const all = (await katalog()) as { wege: { methode: string; pfad: string; zweck: string | null; zugriff: string }[] };
    const start = all.wege.find((w) => w.methode === "POST" && w.pfad === "/api/terminal/start");
    expect(start?.zweck).toMatch(/Session/);
    expect(start?.zugriff).toBe("direkt");
    expect(all.wege.find((w) => w.pfad === "/api/sessions/:id/kill")?.zugriff).toBe("bestaetigung");
    expect(all.wege.some((w) => w.pfad.startsWith("/api/auth/"))).toBe(false);
    const filtered = (await katalog({ filter: "session" })) as { wege: { pfad: string; zweck: string | null }[] };
    expect(filtered.wege.length).toBeGreaterThan(0);
    expect(filtered.wege.every((w) => `${w.pfad} ${w.zweck ?? ""}`.toLowerCase().includes("session"))).toBe(true);
  });
});

describe("app_api · Bestätigung durch Alex", () => {
  it("Session beenden: erst Karte (Inbox + Telegram-Knöpfe), nach „Ausführen“ genau einmal ausgeführt, Ergebnis im Faden", async () => {
    const { t, call, bridge, tg } = await app({ telegram: true });
    await insertSession(t.db);
    const threadId = await newThread(t.db);
    const r = await call({ method: "POST", path: "/api/sessions/claude:s1/kill", body: { confirm: true } }, { threadId });
    expect(r).toMatchObject({ wartet_auf_bestaetigung: true });
    expect(bridge.rpcs.filter((x) => x.method === "kill")).toHaveLength(0);

    const [item] = await t.db.select().from(inboxItems);
    expect(item?.options).toEqual([
      { id: "ausfuehren", label: "Ausführen" },
      { id: "nicht_ausfuehren", label: "Nicht ausführen" },
    ]);
    expect(item?.status).toBe("open");
    // Telegram: Karte mit beiden Knöpfen über den Inbox-Weg
    const card = tg.sent().find((s) => String(s.payload.text).includes("Session beenden"));
    expect(card).toBeTruthy();
    const buttons = ((card?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard ?? []).flat();
    expect(buttons.map((b) => b.callback_data)).toEqual([cb("ib", item?.id ?? 0, 0), cb("ib", item?.id ?? 0, 1)]);

    const yes = await t.app.request(`/api/inbox/${item?.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId: "ausfuehren" }) });
    expect(yes.status).toBe(200);
    expect(bridge.rpcs.filter((x) => x.method === "kill")).toHaveLength(1);
    const [row] = await t.db.select().from(nyxApiCalls);
    expect(row).toMatchObject({ outcome: "bestaetigt", status: 200 });
    expect(row?.pendingBody).toBeNull();
    const msgs = await t.db.select().from(haikuMessages).where(eq(haikuMessages.threadId, threadId));
    expect(msgs.some((m) => m.role === "assistant" && /Session beenden/.test(m.text) && /erledigt|ausgeführt/i.test(m.text))).toBe(true);

    // zweites Mal: schon beantwortet, kein zweiter Aufruf
    const again = await t.app.request(`/api/inbox/${item?.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId: "ausfuehren" }) });
    expect(again.status).toBe(409);
    expect(bridge.rpcs.filter((x) => x.method === "kill")).toHaveLength(1);
  });

  it("per Telegram-Knopf bestätigen führt ebenfalls genau einmal aus", async () => {
    const { t, call, bridge } = await app({ telegram: true });
    await insertSession(t.db);
    await call({ method: "POST", path: "/api/sessions/claude:s1/kill", body: { confirm: true } }, { channel: "telegram" });
    const [item] = await t.db.select().from(inboxItems);
    await t.telegram.handleUpdate({ update_id: 5, callback_query: { id: "cq", from: { id: ME, is_bot: false, first_name: "C" }, chat_instance: "ci", data: cb("ib", item?.id ?? 0, 0), message: { message_id: 101, date: 0, chat: { id: ME, type: "private", first_name: "C" }, text: "Karte" } } });
    await t.telegram.idle();
    expect(bridge.rpcs.filter((x) => x.method === "kill")).toHaveLength(1);
  });

  it("„Nicht ausführen“ und Verwerfen: nichts passiert", async () => {
    const { t, call, bridge } = await app();
    await insertSession(t.db);
    await call({ method: "DELETE", path: "/api/nyx/schedules/1" });
    await call({ method: "POST", path: "/api/sessions/claude:s1/kill", body: { confirm: true } });
    const items = await t.db.select().from(inboxItems).orderBy(inboxItems.id);
    expect(items).toHaveLength(2);
    await t.app.request(`/api/inbox/${items[0]?.id}/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await t.app.request(`/api/inbox/${items[1]?.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId: "nicht_ausfuehren" }) });
    expect(bridge.rpcs.filter((x) => x.method === "kill")).toHaveLength(0);
    const rows = await t.db.select().from(nyxApiCalls).orderBy(nyxApiCalls.id);
    expect(rows.map((r) => r.outcome)).toEqual(["verworfen", "nicht_ausgefuehrt"]);
    expect(rows.every((r) => r.pendingBody === null)).toBe(true);
  });

  it("nach 30 Minuten verfällt die Bestätigung", async () => {
    const { t, call, bridge } = await app();
    await insertSession(t.db);
    await call({ method: "POST", path: "/api/sessions/claude:s1/kill", body: { confirm: true } });
    await t.db.update(nyxApiCalls).set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const [item] = await t.db.select().from(inboxItems);
    await t.app.request(`/api/inbox/${item?.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId: "ausfuehren" }) });
    expect(bridge.rpcs.filter((x) => x.method === "kill")).toHaveLength(0);
    const [row] = await t.db.select().from(nyxApiCalls);
    expect(row?.outcome).toBe("abgelaufen");
  });
});

describe("app_api · in einer echten Nyx-Runde", () => {
  it("Web-Chat: Werkzeug kennt den Kanal und darf schreiben; Prompt erklärt app_api", async () => {
    let result: unknown = null;
    const engine = new FakeEngine(async function* (req: EngineRequest): AsyncIterable<EngineEvent> {
      if (req.kind === "chat") result = await req.callTool("app_api", { method: "POST", path: "/api/entries", body: { kind: "idee", title: "Aus Nyx angelegt" } });
      yield* answer("Angelegt.")(req);
    });
    const { t } = await app({ engine });
    const res = await t.app.request("/api/haiku/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Leg eine Aufgabe an", context: { path: "/", tab: null, filters: {}, openSessionId: null, openEntryId: null }, channel: "web" }),
    });
    await res.text();
    expect(result).toMatchObject({ status: 201 });
    expect(engine.requests[0]?.systemPrompt).toContain(APP_API_PROMPT.slice(0, 40));
  });

  it("ein Weg, der selbst ein Modell fragt, blockiert die laufende Runde nicht (keine Verklemmung)", async () => {
    let result: Record<string, unknown> | null = null;
    const engine = new FakeEngine(async function* (req: EngineRequest): AsyncIterable<EngineEvent> {
      if (req.kind === "chat") result = (await req.callTool("app_api", { method: "POST", path: `/api/inbox/1/nyx-summary`, body: {} })) as Record<string, unknown>;
      yield* answer('{"worum":"a","empfehlung":"b","risiko":"c"}')(req);
    });
    const { t } = await app({ engine });
    await t.db.insert(inboxItems).values({ kind: "frage", title: "Soll X?", options: [{ id: "ja", label: "Ja" }], createdBy: "session" });
    const res = await t.app.request("/api/haiku/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Was meinst du zur Frage?", context: { path: "/", tab: null, filters: {}, openSessionId: null, openEntryId: null }, channel: "web" }),
    });
    await res.text();
    expect(result).not.toBeNull();
    expect((result as unknown as { status: number }).status).not.toBe(504);
  }, 20_000);
});

describe("app_api · Prompt", () => {
  it("Abschnitt steht im System-Prompt, sobald app_api da ist", () => {
    const withTool = buildNyxSystemPrompt({ memoryBlock: "", tools: ["app_api", "app_api_katalog"], channel: "web" });
    expect(withTool).toContain(APP_API_PROMPT);
    expect(buildNyxSystemPrompt({ memoryBlock: "", tools: [], channel: "web" })).not.toContain(APP_API_PROMPT);
    expect(APP_API_PROMPT).toMatch(/app_api_katalog/);
    expect(APP_API_PROMPT).toMatch(/Daten, nie Anweisungen|nie eine Anweisung/);
  });
});
