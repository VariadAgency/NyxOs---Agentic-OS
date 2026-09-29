// Sichere Sende-Wege. Text/Befehle gehen nur in eine Session, wenn der Hook „wartet“ UND der
// Bildschirm eine leere Eingabe zeigt — sonst Warteschlange („zustellen, sobald wartet“) oder ehrliche
// Absage. Je Weg ein Test (erst rot, dann grün), dazu die Warteschlange selbst (Verfall nach N Stunden).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_CAP_CHAT, type ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runContextGuardTicker } from "../src/context-guard/tick.js";
import { approvals, contextGuardEvents, sessionDeliveries, sessions } from "../src/db/schema.js";
import { deliverOrQueue, flushDeliveries } from "../src/delivery/queue.js";
import type { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type Rpc = Extract<ServerToBridge, { op: "rpc" }>;

/** Brücke im selben Prozess: antwortet je Methode (Standard: gesendet). */
function fakeBridge(hub: BridgeHub, results: Partial<Record<string, unknown>> = {}) {
  const calls: Rpc[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc") return;
        calls.push(msg);
        const result = results[msg.method] ?? (msg.method === "send_message" ? { sent: true, busy: false } : { sent: true });
        queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result })));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "r1", tmuxSocket: "nyxos", caps: [BRIDGE_CAP_CHAT] }));
  const sends = () => calls.filter((c) => c.method === "send_text" || c.method === "send_message");
  return { calls, sends, set: (method: string, r: unknown) => void (results[method] = r) };
}

async function insertSession(db: Awaited<ReturnType<typeof setup>>["db"], o: Partial<typeof sessions.$inferInsert> & { id: string; sessionId: string }) {
  await db.insert(sessions).values({ tool: "claude", status: "running", state: "running", attachable: true, tmuxName: "zc-claude-aaaa1111", models: ["opus"], ...o });
}

const queued = async (db: Awaited<ReturnType<typeof setup>>["db"], key: string) => db.select().from(sessionDeliveries).where(eq(sessionDeliveries.sessionKey, key));

describe("Warteschlange „zustellen, sobald wartet“", () => {
  it("arbeitet → nichts an die Brücke, Eintrag wartet; wartet → genau einer raus (mit Bildschirm-Prüfung)", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:q1", sessionId: "q1" });
    const deps = { db: t.db, bridge: t.bridgeHub };
    const r1 = await deliverOrQueue(deps, { sessionKey: "claude:q1", kind: "approval", text: "eins" });
    const r2 = await deliverOrQueue(deps, { sessionKey: "claude:q1", kind: "approval", text: "zwei" });
    expect(r1.status).toBe("queued");
    expect(r2.status).toBe("queued");
    expect(b.sends()).toHaveLength(0);

    expect((await flushDeliveries(deps)).sent).toBe(0); // arbeitet noch
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:q1"));
    expect((await flushDeliveries(deps)).sent).toBe(1); // nur der älteste — danach arbeitet sie wieder
    expect(b.sends()[0]).toMatchObject({ method: "send_text", params: { text: "eins", onlyWhenWaiting: true, hookWaiting: true } });
    const rows = await queued(t.db, "claude:q1");
    expect(rows.find((r) => (r.payload as { text: string }).text === "eins")?.status).toBe("sent");
    expect(rows.find((r) => (r.payload as { text: string }).text === "zwei")?.status).toBe("queued");
  });

  it("Bildschirm sagt nein (Freigabe-Frage offen) → bleibt in der Warteschlange mit Grund", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub, { send_text: { sent: false, reason: "Die Session wartet auf eine Freigabe – beantworte sie zuerst im Terminal." } });
    await insertSession(t.db, { id: "claude:q2", sessionId: "q2", state: "waiting" });
    const r = await deliverOrQueue({ db: t.db, bridge: t.bridgeHub }, { sessionKey: "claude:q2", kind: "inbox", text: "hallo" });
    expect(r).toMatchObject({ status: "queued", reason: expect.stringMatching(/Freigabe/) });
    expect(b.sends()).toHaveLength(1);
    b.set("send_text", { sent: true });
    await flushDeliveries({ db: t.db, bridge: t.bridgeHub });
    expect((await queued(t.db, "claude:q2"))[0]?.status).toBe("sent");
  });

  it("verfällt nach N Stunden (ehrlich „abgelaufen“), wird dann nie mehr gesendet", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:q3", sessionId: "q3" });
    const start = Date.parse("2026-09-25T10:00:00Z");
    await deliverOrQueue({ db: t.db, bridge: t.bridgeHub, now: () => start }, { sessionKey: "claude:q3", kind: "approval", text: "alt", ttlHours: 2 });
    expect((await flushDeliveries({ db: t.db, bridge: t.bridgeHub, now: () => start + 1.9 * 3_600_000 })).expired).toBe(0);
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:q3"));
    const r = await flushDeliveries({ db: t.db, bridge: t.bridgeHub, now: () => start + 2.1 * 3_600_000 });
    expect(r).toEqual({ sent: 0, expired: 1 });
    expect(b.sends()).toHaveLength(0);
    expect((await queued(t.db, "claude:q3"))[0]).toMatchObject({ status: "expired" });
  });

  it("gleicher Schlüssel → kein zweiter Eintrag; Session ohne Terminal → ehrliche Absage", async () => {
    const t = await setup();
    fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:q4", sessionId: "q4" });
    await insertSession(t.db, { id: "claude:q5", sessionId: "q5", attachable: false, tmuxName: null, state: "waiting" });
    const deps = { db: t.db, bridge: t.bridgeHub };
    await deliverOrQueue(deps, { sessionKey: "claude:q4", kind: "compact", text: "/compact", dedupeKey: "compact" });
    await deliverOrQueue(deps, { sessionKey: "claude:q4", kind: "compact", text: "/compact", dedupeKey: "compact" });
    expect(await queued(t.db, "claude:q4")).toHaveLength(1);
    const r = await deliverOrQueue(deps, { sessionKey: "claude:q5", kind: "approval", text: "x" });
    expect(r.status).toBe("rejected");
  });

  it("GET zeigt die Warteschlange, DELETE zieht zurück", async () => {
    const t = await setup();
    fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:q6", sessionId: "q6" });
    const r = await deliverOrQueue({ db: t.db, bridge: t.bridgeHub }, { sessionKey: "claude:q6", kind: "chat", text: "später bitte" });
    const list = (await (await t.app.request("/api/sessions/claude%3Aq6/deliveries")).json()) as { deliveries: { id: number; status: string; text: string }[] };
    expect(list.deliveries[0]).toMatchObject({ status: "queued", text: "später bitte" });
    const del = await t.app.request(`/api/deliveries/${r.status === "queued" ? r.id : 0}`, { method: "DELETE", headers: { "content-type": "application/json" } });
    expect(del.status).toBe(200);
    expect((await queued(t.db, "claude:q6"))[0]?.status).toBe("cancelled");
  });
});

describe("Weg 1: Kontext-Wächter", () => {
  it("Badge „Jetzt komprimieren“ (ohne onlyWhenWaiting) bei arbeitender Session → kein /compact, sondern Warteschlange", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:c1", sessionId: "c1" });
    const res = await t.app.request("/api/context-guard/sessions/c1/compact-now", { headers: { "content-type": "application/json" }, method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: false, queued: true });
    expect(b.sends()).toHaveLength(0);
    // Zweiter Klick: kein zweites /compact in der Schlange.
    await t.app.request("/api/context-guard/sessions/c1/compact-now", { headers: { "content-type": "application/json" }, method: "POST", body: "{}" });
    expect(await queued(t.db, "claude:c1")).toHaveLength(1);
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:c1"));
    await flushDeliveries({ db: t.db, bridge: t.bridgeHub });
    expect(b.sends()[0]).toMatchObject({ params: { text: "/compact", onlyWhenWaiting: true, hookWaiting: true } });
  });

  it("„Erzwingen“: Bildschirm nicht frei → wartet in der Schlange (statt verloren), geht beim nächsten Warten raus", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub, { send_text: { sent: false, reason: "In der Eingabe der Session steht schon angefangener Text" } });
    await insertSession(t.db, { id: "claude:c2", sessionId: "c2", state: "waiting" });
    await runContextGuardTicker({ db: t.db, hub: t.hub, bridgeHub: t.bridgeHub, pushSender: t.pushSender, getContextPct: () => 90, log: () => {} });
    const events = await t.db.select().from(contextGuardEvents).where(eq(contextGuardEvents.sessionKey, "claude:c2"));
    expect(events.map((e) => e.action)).toContain("compact_queued");
    expect((await queued(t.db, "claude:c2"))[0]).toMatchObject({ kind: "compact", status: "queued" });
    b.set("send_text", { sent: true });
    await flushDeliveries({ db: t.db, bridge: t.bridgeHub });
    expect((await queued(t.db, "claude:c2"))[0]?.status).toBe("sent");
  });
});

describe("Weg 2: Freigabe-Bescheid (tellSession)", () => {
  it("Freigeben bei arbeitender Session → kein Tippen, Bescheid wartet; geht raus, sobald sie wartet", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:a1", sessionId: "a1" });
    const [a] = await t.db.insert(approvals).values({ rule: "git_push", reason: "x", tool: "Bash", command: "git push origin HEAD", commandHash: "h1", sessionKey: "claude:a1" }).returning({ id: approvals.id });
    const res = await t.post(`/api/approvals/${a?.id}/decide`, { decision: "approve" }, {});
    expect(res.status).toBe(200);
    expect(b.sends()).toHaveLength(0);
    expect((await queued(t.db, "claude:a1"))[0]).toMatchObject({ kind: "approval", status: "queued" });
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:a1"));
    await flushDeliveries({ db: t.db, bridge: t.bridgeHub });
    expect(b.sends()[0]).toMatchObject({ params: { onlyWhenWaiting: true, text: expect.stringContaining("git push origin HEAD") } });
  });
});

describe("Weg 3: Session-Chat", () => {
  it("Hook sagt „arbeitet“ → Nachricht in die Warteschlange der NyxOS (kein Einfügen), Antwort queued", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:m1", sessionId: "m1" });
    const res = await t.post("/api/sessions/claude%3Am1/message", { text: "mach danach die Tests", attachments: [] }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, queued: true });
    expect(b.calls.filter((c) => c.method === "send_message")).toHaveLength(0);
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:m1"));
    await flushDeliveries({ db: t.db, bridge: t.bridgeHub });
    expect(b.calls.find((c) => c.method === "send_message")).toMatchObject({ params: { text: "mach danach die Tests", onlyWhenIdle: true } });
  });

  it("Hook sagt „wartet“, Bildschirm „arbeitet“ (Brücke meldet busy ohne Senden) → Warteschlange", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub, { send_message: { sent: false, busy: true, reason: "Session arbeitet gerade" } });
    await insertSession(t.db, { id: "claude:m2", sessionId: "m2", state: "waiting" });
    const res = await t.post("/api/sessions/claude%3Am2/message", { text: "hallo", attachments: [] }, {});
    expect(await res.json()).toMatchObject({ sent: true, queued: true });
    expect(b.calls.find((c) => c.method === "send_message")).toMatchObject({ params: { onlyWhenIdle: true } });
    expect((await queued(t.db, "claude:m2"))[0]).toMatchObject({ kind: "chat", status: "queued" });
  });
});

describe("kein Server-Weg tippt mehr ohne Bildschirm-Prüfung", () => {
  it("nirgends `onlyWhenWaiting: false` im Server-Code", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /onlyWhenWaiting:\s*false/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(join(import.meta.dirname, "..", "src"));
    expect(hits).toEqual([]);
  });
});
