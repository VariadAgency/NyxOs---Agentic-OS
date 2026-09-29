// Focus button: "away" / "do not disturb" / auto – pipeline per mode, expiry through the clock, route GET/PUT
// /api/focus, away service ("away" despite an open window), live message, Nyx' app_api, time zone of the user,
// and the "bundle with the next one" stack re-checking the focus.
import { effectiveFocus, focusUntilFor, focusUntilLabel, setTimeZone, type FocusMode, type FocusResponse, type PushNotifyInput } from "@nyxos/shared";
import { desc } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AwayEvent } from "../src/away/notifier.js";
import { pushLog, sessions } from "../src/db/schema.js";
import { NotifyHold, runPipeline, type NotifyEnv } from "../src/notifications/pipeline.js";
import { classifyApiRequest } from "../src/nyx/appApi/rules.js";
import { patchSettings } from "../src/push/settings.js";
import { setup } from "./helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

const NOON = new Date("2026-03-02T11:00:00Z"); // 12:00 in Europe/Berlin (test zone)
const MIN = 60_000;
type Db = Awaited<ReturnType<typeof setup>>["db"];

function envFor(focus: FocusMode, away: boolean): NotifyEnv & { batch: AwayEvent[] } {
  const batch: AwayEvent[] = [];
  return {
    batch,
    isAway: () => away,
    focus: () => focus,
    enqueueAway: (e) => {
      batch.push(e);
      return true;
    },
  };
}

async function prep(db: Db) {
  const settings = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
  await db.insert(sessions).values({ id: "claude:s1", tool: "claude", sessionId: "s1", title: "Push umbauen", titleSource: "ai", state: "waiting" });
  return settings;
}

async function lastRow(db: Db) {
  const [row] = await db.select().from(pushLog).orderBy(desc(pushLog.id)).limit(1);
  return row;
}

const WAITING: PushNotifyInput = { kind: "session_waiting", title: "Wartet", message: "wartet auf dich", what: "wartet auf dich", sessionKey: "claude:s1", at: NOON.toISOString() };
const APPROVAL: PushNotifyInput = { kind: "approval_needed", title: "Freigabe", message: "Merge in main?", what: "Merge in main?" };
const DEPLOY: PushNotifyInput = { kind: "deploy_failed", title: "Deploy", message: "Deploy fehlgeschlagen", what: "Deploy fehlgeschlagen", priority: "urgent" };
const USAGE: PushNotifyInput = { kind: "usage_warning", title: "Nutzung", message: "80 % verbraucht", what: "80 % verbraucht" };

describe("Fokus · Pipeline je Modus", () => {
  it("Ich bin weg: Handy bekommt es (Sammel-Mitteilung), Rechner und Browser still; Grund im Verlauf", async () => {
    const t = await setup();
    const settings = await prep(t.db);
    const sender = new FakeNtfySender();
    const env = envFor("away", true);
    const res = await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env });
    expect(res.sent).toBe(false);
    expect(sender.sent).toHaveLength(0); // no computer/browser
    expect(env.batch).toHaveLength(1); // iPhone gesammelt
    const row = await lastRow(t.db);
    expect(row?.decision).toBe("away_batch");
    expect(row?.decisionNote).toContain("Ich bin weg");
  });

  it("Ich bin weg: Nutzungswarnung/Dringendes sofort – nur aufs Handy", async () => {
    const t = await setup();
    const settings = await prep(t.db);
    for (const input of [USAGE, DEPLOY]) {
      const sender = new FakeNtfySender();
      const res = await runPipeline(input, { db: t.db, sender, settings, now: NOON, env: envFor("away", true) });
      expect(res.sent).toBe(true);
      expect(sender.sent[0]?.channels).toMatchObject({ mac: false, browser: false, ntfy: true });
    }
  });

  it("Nicht stören: normale Mitteilung → nirgends, Verlauf „Fokus“ mit Grund „Nicht stören“", async () => {
    const t = await setup();
    const settings = await prep(t.db);
    const sender = new FakeNtfySender();
    const res = await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env: envFor("dnd", false) });
    expect(res).toMatchObject({ sent: false, reason: "focus" });
    expect(sender.sent).toHaveLength(0);
    const row = await lastRow(t.db);
    expect(row?.decision).toBe("focus");
    expect(row?.decisionNote).toContain("Nicht stören");
  });

  it("Nicht stören: Freigabe und fehlgeschlagener Deploy → nur aufs Handy, nie Rechner/Browser", async () => {
    const t = await setup();
    const settings = await prep(t.db);
    for (const input of [APPROVAL, DEPLOY]) {
      const sender = new FakeNtfySender();
      const res = await runPipeline(input, { db: t.db, sender, settings, now: NOON, env: envFor("dnd", false) });
      expect(res.sent).toBe(true);
      expect(sender.sent[0]?.channels).toMatchObject({ mac: false, browser: false, ntfy: true });
      expect((await lastRow(t.db))?.decisionNote).toContain("Nicht stören");
    }
  });

  it("Automatisch: unverändert (da → alle Wege)", async () => {
    const t = await setup();
    const settings = await prep(t.db);
    const sender = new FakeNtfySender();
    const res = await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env: envFor("auto", false) });
    expect(res.sent).toBe(true);
    expect(sender.sent[0]?.channels?.ntfy).toBe(true);
    expect(sender.sent[0]?.channels?.mac).not.toBe(false);
  });
});

beforeAll(() => setTimeZone("Europe/Berlin"));
afterAll(() => setTimeZone(null));

describe("Fokus · Dauer in der Zeitzone des Nutzers", () => {
  it("1 Stunde · bis heute Abend (19 Uhr) · nach 18 Uhr bis morgen früh (8 Uhr) · bis ich es ausschalte", () => {
    expect(focusUntilFor("1h", NOON)).toBe("2026-03-02T12:00:00.000Z");
    expect(focusUntilFor("evening", NOON)).toBe("2026-03-02T18:00:00.000Z"); // 19:00 MEZ
    const late = new Date("2026-03-02T19:30:00Z"); // 20:30 Berlin
    expect(focusUntilFor("evening", late)).toBe("2026-03-03T07:00:00.000Z"); // morgen 08:00 MEZ
    expect(focusUntilFor("morning", new Date("2026-07-01T01:00:00Z"))).toBe("2026-07-01T06:00:00.000Z"); // 03:00 → heute 08:00 MESZ
    expect(focusUntilFor("manual", NOON)).toBeNull();
  });

  it("andere Zeitzone: „bis heute Abend“ ist 19 Uhr dort, nicht in Berlin", () => {
    const ny = new Date("2026-03-02T15:00:00Z"); // 10:00 in New York
    expect(focusUntilFor("evening", ny, "America/New_York")).toBe("2026-03-03T00:00:00.000Z"); // 19:00 EST
    expect(focusUntilFor("morning", ny, "Asia/Tokyo")).toBe("2026-03-02T23:00:00.000Z"); // 00:00 in Tokyo → 08:00 the same day
    setTimeZone("America/New_York");
    try {
      expect(focusUntilFor("evening", ny)).toBe("2026-03-03T00:00:00.000Z");
      expect(focusUntilLabel({ mode: "away", until: "2026-03-03T00:00:00.000Z", since: null, setBy: "user" }, ny)).toBe("bis 19:00");
    } finally {
      setTimeZone("Europe/Berlin");
    }
  });

  it("abgelaufen → Automatisch; Beschriftung", () => {
    const s = { mode: "dnd" as const, until: "2026-03-02T12:00:00.000Z", since: NOON.toISOString(), setBy: "user" as const };
    expect(effectiveFocus(s, NOON).mode).toBe("dnd");
    expect(effectiveFocus(s, new Date(NOON.getTime() + 61 * MIN)).mode).toBe("auto");
    expect(focusUntilLabel(s, NOON)).toBe("bis 13:00");
    expect(focusUntilLabel({ ...s, until: null }, NOON)).toBe("bis du es ausschaltest");
  });
});

describe("Fokus · Route /api/focus", () => {
  const put = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("GET Standard Automatisch; PUT „Ich bin weg“ 1 Stunde → gespeichert, live an alle Fenster, weg trotz Herzschlag; läuft ab", async () => {
    let now = NOON.getTime();
    const t = await setup({ away: { now: () => now } });
    const live: unknown[] = [];
    const broadcast = t.hub.broadcast.bind(t.hub);
    t.hub.broadcast = (m: unknown) => {
      live.push(m);
      broadcast(m);
    };
    const first = (await (await t.app.request("/api/focus")).json()) as FocusResponse;
    expect(first.state.mode).toBe("auto");

    await t.app.request("/api/away/heartbeat", { method: "POST" }); // Fenster ist offen und aktiv
    const res = await t.app.request("/api/focus", put({ mode: "away", duration: "1h" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FocusResponse;
    expect(body.state).toMatchObject({ mode: "away", until: "2026-03-02T12:00:00.000Z", setBy: "user" });
    expect(live).toContainEqual({ type: "focus", state: body.state });

    const status = (await (await t.app.request("/api/away/status")).json()) as { away: boolean };
    expect(status.away).toBe(true);
    expect(t.away.isAwayNow()).toBe(true);

    now += 61 * MIN;
    await t.focus.tick();
    const after = (await (await t.app.request("/api/focus")).json()) as FocusResponse;
    expect(after.state.mode).toBe("auto");
    expect(live.at(-1)).toMatchObject({ type: "focus", state: { mode: "auto", setBy: "expiry" } });
  });

  it("Nicht stören zählt nie als weg (Handy nur Wichtiges)", async () => {
    let now = NOON.getTime();
    const t = await setup({ away: { now: () => now } });
    now += 60 * MIN; // lange kein Herzschlag → eigentlich weg
    await t.app.request("/api/focus", put({ mode: "dnd" }));
    expect(t.away.isAwayNow()).toBe(false);
    expect(t.focus.mode()).toBe("dnd");
  });

  it("ungültig → 400 (falscher Modus, Ende in der Vergangenheit)", async () => {
    const t = await setup({ away: { now: () => NOON.getTime() } });
    expect((await t.app.request("/api/focus", put({ mode: "konzentriert" }))).status).toBe(400);
    expect((await t.app.request("/api/focus", put({ mode: "dnd", until: "2026-03-02T10:00:00Z" }))).status).toBe(400);
    expect((await t.app.request("/api/focus", put({ mode: "dnd", until: "2026-03-02T17:00:00+02:00" }))).status).toBe(200);
  });

  it("Nyx darf den Fokus direkt setzen („Nyx, ich bin weg bis 18 Uhr“)", () => {
    expect(classifyApiRequest("PUT", "/api/focus").access).toBe("direkt");
    expect(classifyApiRequest("GET", "/api/focus").access).toBe("direkt");
  });
});

describe("Fokus · von Nyx gebündelte Mitteilungen", () => {
  it("„Nicht stören“ nach dem Bündeln: nur Wichtiges geht raus (nur Handy), der Rest steht still gestellt im Verlauf", async () => {
    const t = await setup();
    const settings = await prep(t.db);
    const hold = new NotifyHold();
    hold.add({ kind: "session_waiting", line: "„Push umbauen“ wartet", path: null, at: NOON.getTime() });
    hold.add({ kind: "approval_needed", line: "Merge in main?", path: null, at: NOON.getTime() });
    const sender = new FakeNtfySender();
    const env = envFor("dnd", false);
    const n = await hold.flush({ db: t.db, sender, settings, env, now: new Date(NOON.getTime() + 16 * MIN), afterMs: 15 * MIN });
    expect(n).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.message).toContain("Merge in main?");
    expect(sender.sent[0]?.message).not.toContain("wartet");
    expect(sender.sent[0]?.channels).toMatchObject({ mac: false, browser: false });
    const rows = await t.db.select().from(pushLog).orderBy(desc(pushLog.id));
    expect(rows.some((r) => r.decision === "focus" && r.message.includes("wartet"))).toBe(true);
  });

  it("„Nicht stören“ und nichts Wichtiges im Stapel: nichts geht raus", async () => {
    const t = await setup();
    const settings = await prep(t.db);
    const hold = new NotifyHold();
    hold.add({ kind: "session_done", line: "fertig", path: null, at: NOON.getTime() });
    const sender = new FakeNtfySender();
    await hold.flush({ db: t.db, sender, settings, env: envFor("dnd", false), now: new Date(NOON.getTime() + 16 * MIN), afterMs: 15 * MIN });
    expect(sender.sent).toHaveLength(0);
    expect(hold.size).toBe(0);
    expect((await lastRow(t.db))?.decision).toBe("focus");
  });
});
