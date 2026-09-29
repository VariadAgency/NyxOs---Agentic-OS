// Wettläufe und Verfall der Zustell-Warteschlange — Text in des Nutzers Sessions darf nie doppelt,
// nie nach dem Zurückziehen und nie veraltet landen. Erst rot, dann der Fix in delivery/queue.ts.
import { BRIDGE_CAP_CHAT, type ServerToBridge } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runContextGuardTicker } from "../src/context-guard/tick.js";
import { sessionDeliveries, sessions } from "../src/db/schema.js";
import { cancelDelivery, deliverOrQueue, flushDeliveries, type DeliveryRpc } from "../src/delivery/queue.js";
import type { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

type Db = Awaited<ReturnType<typeof setup>>["db"];
type Rpc = Extract<ServerToBridge, { op: "rpc" }>;
type Outcome = Awaited<ReturnType<DeliveryRpc["rpc"]>>;

async function insertSession(db: Db, o: Partial<typeof sessions.$inferInsert> & { id: string; sessionId: string }) {
  await db.insert(sessions).values({ tool: "claude", status: "running", state: "running", attachable: true, tmuxName: "zc-claude-bbbb2222", models: ["opus"], ...o });
}
const rowsOf = async (db: Db, key: string) => db.select().from(sessionDeliveries).where(eq(sessionDeliveries.sessionKey, key)).orderBy(sessionDeliveries.id);

/** Brücke, deren Antwort der Test selbst freigibt (Senden „läuft gerade“). */
function slowBridge() {
  const calls: { method: string; params: unknown }[] = [];
  let release: (o: Outcome) => void = () => {};
  let called: () => void = () => {};
  const firstCall = new Promise<void>((r) => (called = r));
  const bridge: DeliveryRpc = {
    rpc(method, params) {
      calls.push({ method, params });
      called();
      return new Promise<Outcome>((r) => (release = r));
    },
  };
  return { bridge, calls, firstCall, finish: (o: Outcome) => release(o) };
}

function fakeBridge(hub: BridgeHub) {
  const calls: Rpc[] = [];
  hub.attach(
    {
      send(data: string) {
        const msg = JSON.parse(data) as ServerToBridge;
        if (msg.op !== "rpc") return;
        calls.push(msg);
        const result = msg.method === "send_message" ? { sent: true, busy: false } : { sent: true };
        queueMicrotask(() => hub.handle(JSON.stringify({ op: "rpc_result", id: msg.id, ok: true, result })));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "r1", tmuxSocket: "nyxos", caps: [BRIDGE_CAP_CHAT] }));
  return { sends: () => calls.filter((c) => c.method === "send_text" || c.method === "send_message") };
}

describe("Zurückziehen vs. laufendes Senden", () => {
  it("während die Brücke gerade tippt, gilt der Eintrag als unterwegs – Zurückziehen sagt ehrlich nein, Status am Ende „sent“", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:k1", sessionId: "k1" });
    const slow = slowBridge();
    const q = await deliverOrQueue({ db: t.db, bridge: slow.bridge }, { sessionKey: "claude:k1", kind: "inbox", text: "Antwort" });
    expect(q.status).toBe("queued");
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:k1"));

    const flushing = flushDeliveries({ db: t.db, bridge: slow.bridge });
    await slow.firstCall;
    const cancelled = await cancelDelivery(t.db, q.status === "queued" ? q.id : 0);
    expect(cancelled).toBeNull(); // schon unterwegs – nicht mehr zurückziehbar
    slow.finish({ ok: true, result: { sent: true } });
    await flushing;
    expect((await rowsOf(t.db, "claude:k1"))[0]?.status).toBe("sent");
  });
});

describe("Zeitüberschreitung heißt nicht „nicht angekommen“", () => {
  it("Brücke antwortet nicht rechtzeitig → nie ein zweites Mal senden, ehrlich „unklar“", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:k2", sessionId: "k2" });
    let clock = Date.parse("2026-09-25T10:00:00Z");
    const calls: string[] = [];
    const bridge: DeliveryRpc = {
      rpc: async (method) => {
        calls.push(method);
        return { ok: false, code: "timeout", error: "Brücke antwortet nicht" };
      },
    };
    const deps = { db: t.db, bridge, now: () => clock };
    await deliverOrQueue(deps, { sessionKey: "claude:k2", kind: "approval", text: "Freigegeben" });
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:k2"));
    await flushDeliveries(deps);
    clock += 5 * 60_000;
    await flushDeliveries(deps);
    expect(calls).toHaveLength(1);
    const [row] = await rowsOf(t.db, "claude:k2");
    expect(row?.status).toBe("failed");
    expect(row?.reason).toMatch(/[Uu]nklar/);
  });

  it("auch beim Sofort-Versuch: Zeitüberschreitung → nicht erneut einreihen", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:k3", sessionId: "k3", state: "waiting" });
    const calls: string[] = [];
    const bridge: DeliveryRpc = {
      rpc: async (method) => {
        calls.push(method);
        return { ok: false, code: "timeout", error: "Brücke antwortet nicht" };
      },
    };
    const r = await deliverOrQueue({ db: t.db, bridge }, { sessionKey: "claude:k3", kind: "inbox", text: "Ja" });
    expect(r.status).toBe("rejected");
    expect(r.status === "rejected" && r.reason).toMatch(/[Uu]nklar/);
    await flushDeliveries({ db: t.db, bridge, now: () => Date.now() + 60_000 });
    expect(calls).toHaveLength(1);
  });
});

describe("20-s-Sperre", () => {
  it("zählt ab dem Ende des Sendens (langsame Brücke), nicht ab dem Start des Durchlaufs", async () => {
    const t = await setup();
    await insertSession(t.db, { id: "claude:k4", sessionId: "k4" });
    let clock = Date.parse("2026-09-25T11:00:00Z");
    const calls: string[] = [];
    const bridge: DeliveryRpc = {
      rpc: async (method) => {
        calls.push(method);
        clock += 15_000; // Bilder einfügen + Luft lassen dauert
        return { ok: true, result: { sent: true } };
      },
    };
    const deps = { db: t.db, bridge, now: () => clock };
    await deliverOrQueue(deps, { sessionKey: "claude:k4", kind: "approval", text: "eins" });
    await deliverOrQueue(deps, { sessionKey: "claude:k4", kind: "approval", text: "zwei" });
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:k4"));
    await flushDeliveries(deps); // eins raus, Uhr jetzt +15 s
    clock += 10_000; // 10 s nach dem Senden — Hook meldet evtl. noch „wartet“
    await flushDeliveries(deps);
    expect(calls).toHaveLength(1);
  });

  it("Chat direkt nach einer Zustellung aus der Schlange tippt nicht gleich hinterher, sondern reiht ein", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:k5", sessionId: "k5" });
    await deliverOrQueue({ db: t.db, bridge: t.bridgeHub }, { sessionKey: "claude:k5", kind: "approval", text: "Freigegeben" });
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:k5"));
    expect((await flushDeliveries({ db: t.db, bridge: t.bridgeHub })).sent).toBe(1);
    const res = await t.post("/api/sessions/claude%3Ak5/message", { text: "und noch was", attachments: [] }, {});
    expect(await res.json()).toMatchObject({ sent: true, queued: true });
    expect(b.sends()).toHaveLength(1);
  });
});

describe("veraltetes /compact", () => {
  it("Kontext wieder klein (z. B. selbst komprimiert) → wartendes /compact wird verworfen, nie gesendet", async () => {
    const t = await setup();
    const b = fakeBridge(t.bridgeHub);
    await insertSession(t.db, { id: "claude:k6", sessionId: "k6" });
    const r = await deliverOrQueue({ db: t.db, bridge: t.bridgeHub }, { sessionKey: "claude:k6", kind: "compact", text: "/compact", dedupeKey: "compact", ttlHours: 2 });
    expect(r.status).toBe("queued");
    await runContextGuardTicker({ db: t.db, hub: t.hub, bridgeHub: t.bridgeHub, pushSender: t.pushSender, getContextPct: () => 20, log: () => {} });
    await t.db.update(sessions).set({ state: "waiting" }).where(eq(sessions.id, "claude:k6"));
    await flushDeliveries({ db: t.db, bridge: t.bridgeHub });
    expect(b.sends()).toHaveLength(0);
    expect((await rowsOf(t.db, "claude:k6"))[0]?.status).toBe("cancelled");
  });
});
