// Abwesenheit: Nyx merkt, wenn der Nutzer nicht mehr in NyxOS arbeitet, und meldet sich dann – Ereignisse
// gebündelt NUR über ntfy, Fragen über Telegram (mit Knöpfen, Antwort landet in der Inbox).
import { DEFAULT_AWAY_SETTINGS, type AwaySettings, type ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { AwayNotifier, type AwayEvent, type AwayNtfyMessage, type AwayQuestion } from "../src/away/notifier.js";
import { Presence } from "../src/away/presence.js";
import { clickUrlFor } from "../src/away/service.js";
import { AwayWatcher } from "../src/away/watch.js";
import { entries, inboxItems, sessions } from "../src/db/schema.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { cb } from "../src/telegram/callbacks.js";
import { staticTokenSource } from "../src/telegram/tokens.js";
import { setup } from "./helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

const MIN = 60_000;
const YES_NO_OPTIONS_FOR_TEST = [
  { id: "ja", label: "Ja" },
  { id: "nein", label: "Nein" },
];
/** Mittags (keine Ruhezeit, egal in welcher Zeitzone die Tests laufen). */
const T0 = Date.parse("2026-09-26T10:00:00Z");

function clock(start = T0) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v), add: (ms: number) => void (t += ms) };
}

function ev(key: string, kind: AwayEvent["kind"] = "session_done", important = false): AwayEvent {
  return { key, kind, label: `Ereignis ${key}`, path: `/sessions/x/${key}`, important };
}

function notifierWith(opts: { settings?: Partial<AwaySettings>; telegramReady?: boolean } = {}) {
  const c = clock();
  const presence = new Presence(c.now);
  const sent: AwayNtfyMessage[] = [];
  const asked: AwayQuestion[][] = [];
  const logs: string[] = [];
  const settings = { ...DEFAULT_AWAY_SETTINGS, ...opts.settings };
  const n = new AwayNotifier({
    presence,
    settings: async () => settings,
    sendNtfy: async (m) => {
      sent.push(m);
      return true;
    },
    telegram: { ready: async () => opts.telegramReady ?? true, sendQuestions: async (qs) => (asked.push(qs), true) },
    log: (m) => logs.push(m),
    now: c.now,
  });
  return { c, presence, n, sent, asked, logs };
}

describe("Abwesenheit · Anwesenheit", () => {
  it("da, solange Herzschläge kommen; weg nach > N Minuten ohne Herzschlag (falsche Uhr)", () => {
    const c = clock();
    const p = new Presence(c.now);
    expect(p.isAway(5 * MIN)).toBe(false); // Serverstart zählt als „gerade gesehen“
    expect(p.lastSeenAt()).toBeNull();
    c.add(4 * MIN);
    p.beat();
    expect(p.lastSeenAt()).toBe(T0 + 4 * MIN);
    c.add(5 * MIN);
    expect(p.isAway(5 * MIN)).toBe(false);
    c.add(1);
    expect(p.isAway(5 * MIN)).toBe(true);
    p.beat();
    expect(p.isAway(5 * MIN)).toBe(false);
  });
});

describe("Abwesenheit · Bündelung", () => {
  it("5 Ereignisse in 3 Min → EINE Mitteilung; die zweite erst nach dem Bündel-Abstand", async () => {
    const t = notifierWith();
    t.c.add(6 * MIN); // weg
    for (let i = 0; i < 5; i++) {
      await t.n.tick({ events: [ev(`e${i}`)], openQuestions: [] });
      expect(t.sent).toHaveLength(0);
      t.c.add(45_000);
    }
    t.c.set(T0 + 6 * MIN + 3 * MIN);
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.sent).toHaveLength(0); // Sammelzeit (5 Min) läuft noch
    t.c.set(T0 + 6 * MIN + 5 * MIN);
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.title).toBe("NyxOS: 5 Sessions fertig");
    expect(t.sent[0]?.message.split("\n")).toHaveLength(5);
    // neues Ereignis → erst 15 Min nach der letzten Mitteilung
    t.c.add(MIN);
    await t.n.tick({ events: [ev("spät", "auftrag_done")], openQuestions: [] });
    t.c.add(10 * MIN);
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.sent).toHaveLength(1);
    t.c.add(4 * MIN); // jetzt 15 Min nach der ersten
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]?.title).toBe("NyxOS: 1 Auftrag erledigt");
    // derselbe Schlüssel kommt nicht zweimal in den Stapel
    t.c.add(20 * MIN);
    await t.n.tick({ events: [ev("x1"), ev("x1")], openQuestions: [] });
    t.c.add(5 * MIN);
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.sent[2]?.title).toBe("NyxOS: 1 Session fertig");
  });

  it("Wichtiges (Build rot) geht sofort, aber mit Mindestabstand; nimmt den Rest mit", async () => {
    const t = notifierWith();
    t.c.add(6 * MIN);
    await t.n.tick({ events: [ev("s1"), ev("b1", "build_red", true)], openQuestions: [] });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ title: "NyxOS: 1 Build rot, 1 Session fertig", priority: "high" });
    t.c.add(2 * MIN);
    await t.n.tick({ events: [ev("b2", "bug_new", true)], openQuestions: [] });
    expect(t.sent).toHaveLength(1); // Mindestabstand 5 Min
    t.c.add(3 * MIN);
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.sent).toHaveLength(2);
  });

  it("nichts, solange Alex da ist; kommt er zurück, verfällt der Stapel", async () => {
    const t = notifierWith();
    for (let i = 0; i < 4; i++) {
      t.presence.beat();
      await t.n.tick({ events: [ev(`p${i}`)], openQuestions: [{ key: "i:1", kind: "inbox", ref: 1, title: "Frage", options: [], path: null }] });
      t.c.add(MIN);
    }
    expect(t.sent).toHaveLength(0);
    expect(t.asked).toHaveLength(0);
    t.c.add(6 * MIN); // weg
    await t.n.tick({ events: [ev("w1")], openQuestions: [] });
    expect(t.n.pendingEvents).toBe(1);
    t.presence.beat(); // zurück, bevor die Sammelzeit um ist
    t.c.add(10 * MIN - 1);
    // (zwischendurch noch da: Herzschlag vor < 5 Min)
    t.presence.beat();
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.n.pendingEvents).toBe(0);
    expect(t.sent).toHaveLength(0);
    expect(t.logs).toContain("abwesend-stapel-verworfen");
  });

  it("Ruhezeit: nur Wichtiges, der Rest wartet", async () => {
    const t = notifierWith({ settings: { quietStart: "00:00", quietEnd: "23:59" } });
    t.c.add(6 * MIN);
    await t.n.tick({ events: [ev("s1")], openQuestions: [] });
    t.c.add(10 * MIN);
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.sent).toHaveLength(0);
    await t.n.tick({ events: [ev("b1", "build_red", true)], openQuestions: [] });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.title).toBe("NyxOS: 1 Build rot");
    expect(t.n.pendingEvents).toBe(1); // die Session wartet bis morgens
  });

  it("abgeschaltete Art oder Abwesenheit aus → kein Versand", async () => {
    const t = notifierWith({ settings: { events: { ...DEFAULT_AWAY_SETTINGS.events, session_done: false } } });
    t.c.add(30 * MIN);
    await t.n.tick({ events: [ev("s1")], openQuestions: [] });
    t.c.add(30 * MIN);
    await t.n.tick({ events: [], openQuestions: [] });
    expect(t.sent).toHaveLength(0);
    const off = notifierWith({ settings: { enabled: false } });
    off.c.add(30 * MIN);
    await off.n.tick({ events: [ev("b", "build_red", true)], openQuestions: [] });
    expect(off.sent).toHaveLength(0);
  });
});

describe("Abwesenheit · Fragen", () => {
  const q = (id: number): AwayQuestion => ({ key: `i:${id}`, kind: "inbox", ref: id, title: `Frage ${id}`, options: YES_NO_OPTIONS_FOR_TEST, path: `/inbox#inbox-${id}` });

  it("Frage → Telegram, je Frage genau einmal, höchstens eine Nachricht je Abstand", async () => {
    const t = notifierWith();
    t.c.add(6 * MIN);
    await t.n.tick({ events: [], openQuestions: [q(1), q(2)] });
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]?.map((x) => x.key)).toEqual(["i:1", "i:2"]);
    t.c.add(MIN);
    await t.n.tick({ events: [], openQuestions: [q(1), q(2), q(3)] });
    expect(t.asked).toHaveLength(1); // Abstand 3 Min
    t.c.add(2 * MIN);
    await t.n.tick({ events: [], openQuestions: [q(1), q(2), q(3)] });
    expect(t.asked).toHaveLength(2);
    expect(t.asked[1]?.map((x) => x.key)).toEqual(["i:3"]);
    expect(t.sent).toHaveLength(0); // Fragen nie über ntfy, wenn Telegram geht
  });

  it("Telegram nicht gekoppelt → EIN ntfy-Hinweis, nicht je Frage", async () => {
    const t = notifierWith({ telegramReady: false });
    t.c.add(6 * MIN);
    await t.n.tick({ events: [], openQuestions: [q(1)] });
    t.c.add(10 * MIN);
    await t.n.tick({ events: [], openQuestions: [q(1), q(2)] });
    t.c.add(10 * MIN);
    await t.n.tick({ events: [], openQuestions: [q(1), q(2), q(3)] });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.title).toBe("Nyx hat eine Frage – Telegram ist nicht gekoppelt");
    expect(t.asked).toHaveLength(0);
  });

  it("Klick-Adresse nur mit echter Basis-URL", () => {
    expect(clickUrlFor("http://127.0.0.1:47801", "/inbox")).toBeNull();
    expect(clickUrlFor("https://nyx.tailnet.ts.net/", "/inbox")).toBe("https://nyx.tailnet.ts.net/inbox");
    expect(clickUrlFor("https://nyx.tailnet.ts.net", null)).toBeNull();
  });
});


describe("Abwesenheit · Wächter: Session fertig je Zug", () => {
  it("auch für Sessions von vor dem Start; jeder neue Zug einmal; Notification nach Stop kein zweites Mal", async () => {
    const c = clock();
    const t = await setup();
    // Session läuft schon vor dem Serverstart (stateObservedAt = SessionStart von gestern Abend)
    const started = iso(T0 - 3 * 3_600_000);
    await t.db.insert(sessions).values({ id: "claude:alt", tool: "claude", sessionId: "alt", status: "running", state: "running", turnOpen: true, stateObservedAt: started, lastActivityAt: iso(T0 - MIN), title: "Alt", titleSource: "ai" });
    const w = new AwayWatcher(t.db, c.now);
    const done = async () => (await w.scan({ waitingAfterSeconds: 120 })).events.filter((e) => e.kind === "session_done");
    expect(await done()).toHaveLength(0); // Stand vormerken
    // Zug 1 fertig (Stop-Hook): Runde zu, turnObservedAt = jetzt – stateObservedAt bleibt beim SessionStart
    c.add(MIN);
    await t.db.update(sessions).set({ state: "waiting", turnOpen: false, turnObservedAt: iso(c.now()) }).where(eq(sessions.id, "claude:alt"));
    expect(await done()).toHaveLength(1);
    // Notification-Hook eine Minute später: Runde bleibt zu, nur turnObservedAt rückt vor → kein zweites „fertig“
    c.add(MIN);
    await t.db.update(sessions).set({ turnObservedAt: iso(c.now()) }).where(eq(sessions.id, "claude:alt"));
    expect(await done()).toHaveLength(0);
    // Zug 2: Nyx schickt eine Nachricht, Runde offen …
    c.add(MIN);
    await t.db.update(sessions).set({ state: "running", turnOpen: true, turnObservedAt: iso(c.now()) }).where(eq(sessions.id, "claude:alt"));
    expect(await done()).toHaveLength(0);
    // … und wieder zu → neues Ereignis
    c.add(3 * MIN);
    await t.db.update(sessions).set({ state: "waiting", turnOpen: false, turnObservedAt: iso(c.now()) }).where(eq(sessions.id, "claude:alt"));
    expect(await done()).toHaveLength(1);
    expect(await done()).toHaveLength(0);
  });

  it("„wartet auf Eingabe“ erst nach der echten Wartezeit, je Zug nur einmal (kein Flackern)", async () => {
    const c = clock();
    const t = await setup();
    await t.db.insert(sessions).values({ id: "claude:w", tool: "claude", sessionId: "w", status: "running", state: "waiting", turnOpen: true, screenWaiting: true, stateObservedAt: iso(T0 - 3_600_000), turnObservedAt: iso(T0), lastActivityAt: iso(T0), title: "Wartet", titleSource: "ai" });
    const w = new AwayWatcher(t.db, c.now);
    const asked = async () => (await w.scan({ waitingAfterSeconds: 120 })).openQuestions.filter((q) => q.kind === "session").map((q) => q.key);
    expect(await asked()).toEqual([]); // wartet erst seit eben (Session läuft aber schon 1 Std)
    c.add(MIN);
    expect(await asked()).toEqual([]);
    c.add(MIN + 1000);
    const first = await asked();
    expect(first).toHaveLength(1);
    c.add(MIN);
    expect(await asked()).toEqual(first); // gleicher Schlüssel – der Notifier fragt nicht doppelt
  });

  it("nach einem Neustart keine Nachholflut: schon wartende Sessions gelten nicht als neu fertig", async () => {
    const c = clock();
    const t = await setup();
    await t.db.insert(sessions).values({ id: "claude:w", tool: "claude", sessionId: "w", status: "running", state: "waiting", turnOpen: false, stateObservedAt: iso(T0 - 3_600_000), turnObservedAt: iso(T0 - 10 * MIN), title: "W", titleSource: "ai" });
    const w = new AwayWatcher(t.db, c.now);
    expect((await w.scan({ waitingAfterSeconds: 120 })).events).toHaveLength(0);
    c.add(MIN);
    expect((await w.scan({ waitingAfterSeconds: 120 })).events).toHaveLength(0);
  });
});

// ───────────── Über den ganzen App-Weg: Wächter → Melder → ntfy / Telegram ─────────────

const TOKEN = "123456789:AAHfakefakefakefakefakefakefakefake12";
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

function macBridge(): { hub: BridgeHub; notified: { title: string }[] } {
  const hub = new BridgeHub();
  const notified: { title: string }[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op === "rpc" && msg.method === "notify") {
          notified.push(msg.params as { title: string });
          queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result: { shown: true } })));
        }
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "p3", tmuxSocket: "nyxos", caps: ["notify"] }));
  return { hub, notified };
}

const iso = (ms: number) => new Date(ms).toISOString();
const HEARTBEAT = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

describe("Abwesenheit · App-Weg", () => {
  it("Session fertig, Auftrag erledigt, neuer Bug → je genau einmal, gebündelt, NUR ntfy; Frage → Telegram-Knopf → Inbox beantwortet", async () => {
    const c = clock();
    const ntfy = new FakeNtfySender();
    const mac = macBridge();
    const tg = fakeTelegram();
    const t = await setup({ pushSender: ntfy, bridgeHub: mac.hub, away: { now: c.now }, telegram: { tokens: staticTokenSource(TOKEN), botFactory: tg.factory, polling: false, bufferMs: 0 } });
    const live: unknown[] = [];
    const broadcast = t.hub.broadcast.bind(t.hub);
    t.hub.broadcast = (m: unknown) => {
      live.push(m);
      broadcast(m);
    };
    await t.telegram.start();
    const { code } = await t.telegram.createPairing();
    await t.telegram.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: ME, type: "private", first_name: "C" }, from: { id: ME, is_bot: false, first_name: "C" }, text: `/start ${code}`, entities: [{ type: "bot_command", offset: 0, length: 6 }] } });
    await t.telegram.idle();

    // Herzschlag (angemeldet, CSRF über den Test-Helfer) → da
    expect((await t.app.request("/api/away/heartbeat", HEARTBEAT)).status).toBe(200);
    const [auftrag] = await t.db.insert(entries).values({ kind: "aufgabe", title: "Push umbauen", stage: "pruefen" }).returning({ id: entries.id });
    await t.tickStates(c.now()); // Stand vormerken
    expect((await (await t.app.request("/api/away/status")).json()) as { away: boolean }).toMatchObject({ away: false });

    // 6 Min ohne Herzschlag → weg; jetzt passiert etwas
    c.add(6 * MIN);
    expect((await (await t.app.request("/api/away/status")).json()) as { away: boolean }).toMatchObject({ away: true });
    await t.db.insert(sessions).values({ id: "claude:a1", tool: "claude", sessionId: "a1", status: "running", state: "waiting", turnOpen: false, stateObservedAt: iso(c.now()), title: "Push-Umbau", titleSource: "ai" });
    await t.db.update(entries).set({ stage: "erledigt" }).where(eq(entries.id, auftrag?.id ?? 0));
    await t.db.insert(entries).values({ kind: "bug", title: "Absturz beim Speichern", stage: "geplant", priority: "p2" });
    const [frage] = await t.db
      .insert(inboxItems)
      .values({ kind: "frage", title: "Soll der Build-Wächter nachts laufen?", options: YES_NO_OPTIONS_FOR_TEST, createdBy: "session", createdAt: iso(c.now()) })
      .returning({ id: inboxItems.id });
    const bundles = () => ntfy.sent.filter((m) => m.title.startsWith("NyxOS:"));

    await t.tickStates(c.now());
    expect(bundles()).toHaveLength(0); // Sammelzeit läuft
    // Frage → Telegram mit Knöpfen
    const q = tg.sent().find((s) => String(s.payload.text).includes("Build-Wächter nachts"));
    expect(q).toBeTruthy();
    const buttons = ((q?.payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard ?? []).flat();
    expect(buttons.map((b) => b.callback_data)).toEqual([cb("ib", frage?.id ?? 0, 0), cb("ib", frage?.id ?? 0, 1)]);

    c.add(2 * MIN);
    await t.tickStates(c.now()); // nichts doppelt
    c.add(3 * MIN);
    await t.tickStates(c.now());
    expect(bundles()).toHaveLength(1);
    const b = bundles()[0];
    expect(b?.title).toBe("NyxOS: 1 neuer Bug, 1 Auftrag erledigt, 1 Session fertig");
    expect(b?.channels).toEqual({ mac: false, browser: false, ntfy: true });
    // NUR ntfy: weder Mac noch Browser haben die Sammel-Mitteilung gesehen
    expect(mac.notified.some((n) => n.title.startsWith("NyxOS:"))).toBe(false);
    expect(live.some((m) => (m as { type?: string; title?: string }).type === "push" && String((m as { title?: string }).title).startsWith("NyxOS:"))).toBe(false);
    // ein weiterer Takt viel später: dieselben Ereignisse kommen nicht noch einmal
    c.add(30 * MIN);
    await t.tickStates(c.now());
    expect(bundles()).toHaveLength(1);
    expect(tg.sent().filter((s) => String(s.payload.text).includes("Build-Wächter nachts"))).toHaveLength(1);

    // Antwort per Knopf → landet in der Inbox (bestehender Weg)
    await t.telegram.handleUpdate({ update_id: 2, callback_query: { id: "cq2", from: { id: ME, is_bot: false, first_name: "C" }, chat_instance: "ci", data: cb("ib", frage?.id ?? 0, 0), message: { message_id: 101, date: 0, chat: { id: ME, type: "private", first_name: "C" }, text: String(q?.payload.text) } } });
    await t.telegram.idle();
    const [row] = await t.db.select().from(inboxItems).where(eq(inboxItems.id, frage?.id ?? 0));
    expect(row?.status).toBe("answered");
    expect(row?.answer).toMatchObject({ optionId: "ja" });

    // der Nutzer wieder da → neues Ereignis bleibt stumm
    await t.app.request("/api/away/heartbeat", HEARTBEAT);
    await t.db.insert(entries).values({ kind: "bug", title: "Noch ein Bug", stage: "geplant", priority: "p0" });
    await t.tickStates(c.now());
    c.add(MIN);
    await t.tickStates(c.now());
    expect(bundles()).toHaveLength(1);
    await t.telegram.stop();
  });

  it("weg: Einzel-Mitteilungen nicht aufs iPhone – Dringendes und der Test-Knopf aber schon", async () => {
    const c = clock();
    const ntfy = new FakeNtfySender();
    const t = await setup({ pushSender: ntfy, away: { now: c.now } });
    await t.away.settings();
    const base = { topic: "t", title: "x", message: "m", clickUrl: null, path: null, channels: { mac: false, browser: false, ntfy: true } } as const;
    await t.pushSender.send({ ...base, kind: "session_waiting", priority: "default" });
    expect(ntfy.sent).toHaveLength(1); // da → wie früher
    c.add(6 * MIN); // weg
    await t.pushSender.send({ ...base, kind: "session_waiting", priority: "default" });
    expect(ntfy.sent).toHaveLength(1); // „wartet“ kommt gebündelt bzw. per Telegram, nicht einzeln
    // Telegram ist hier nicht gekoppelt → die Freigabe muss trotzdem aufs iPhone (sonst ginge sie verloren)
    await t.pushSender.send({ ...base, kind: "approval_needed", priority: "high" });
    expect(ntfy.sent).toHaveLength(2);
    await t.pushSender.send({ ...base, kind: "deploy_failed", priority: "urgent" });
    await t.pushSender.send({ ...base, kind: "test", priority: "default" });
    expect(ntfy.sent).toHaveLength(4);
  });

  it("Einstellungen: Standardwerte, Ändern nur angemeldet", async () => {
    const t = await setup();
    const res = await t.app.request("/api/away/settings");
    expect(await res.json()).toEqual(DEFAULT_AWAY_SETTINGS);
    const patched = await t.app.request("/api/away/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundleMinutes: 30, events: { session_done: false } }) });
    expect(await patched.json()).toMatchObject({ bundleMinutes: 30, awayAfterMinutes: 5, events: { session_done: false, bug_new: true } });
    const bad = await t.app.request("/api/away/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundleMinutes: 0 }) });
    expect(bad.status).toBe(400);
    const anon = await setup({ signedIn: false });
    expect((await anon.app.request("/api/away/heartbeat", HEARTBEAT)).status).toBe(401);
  });
});
