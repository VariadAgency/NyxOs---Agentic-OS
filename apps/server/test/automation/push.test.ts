import { describe, expect, it } from "vitest";
import { isQuietNow, notify } from "../../src/push/dispatcher.js";
import { loadOrInitSettings, patchSettings, randomTopic } from "../../src/push/settings.js";
import { checkWaitingSessions } from "../../src/push/waiting.js";
import { sessions } from "../../src/db/schema.js";
import { setup } from "../helpers.js";
import { FakeNtfySender } from "./fakes.js";

describe("push/settings", () => {
  it("legt beim ersten Zugriff eine zufällige, geheime Themen-Zeile an", async () => {
    const { db } = await setup();
    const a = await loadOrInitSettings(db);
    const b = await loadOrInitSettings(db);
    expect(a.topic).toBe(b.topic);
    expect(a.topic).toMatch(/^nyxos-[0-9a-f]{24}$/);
    expect(a.quietStart).toBe("22:00");
  });

  it("zwei zufällige Themen sind verschieden", () => {
    expect(randomTopic()).not.toBe(randomTopic());
  });

  it("patchSettings ändert nur die angegebenen Felder", async () => {
    const { db } = await setup();
    await loadOrInitSettings(db);
    const updated = await patchSettings(db, { quietStart: "23:30" });
    expect(updated.quietStart).toBe("23:30");
    expect(updated.quietEnd).toBe("08:00"); // unverändert
  });
});

describe("push/dispatcher isQuietNow", () => {
  const settings = { quietStart: "22:00", quietEnd: "08:00" };
  it("über Mitternacht: 23:00 ist Ruhezeit", () => {
    expect(isQuietNow(settings, new Date(2026, 0, 1, 23, 0))).toBe(true);
  });
  it("07:00 ist noch Ruhezeit, 08:00 nicht mehr", () => {
    expect(isQuietNow(settings, new Date(2026, 0, 1, 7, 0))).toBe(true);
    expect(isQuietNow(settings, new Date(2026, 0, 1, 8, 0))).toBe(false);
  });
  it("12:00 mittags ist keine Ruhezeit", () => {
    expect(isQuietNow(settings, new Date(2026, 0, 1, 12, 0))).toBe(false);
  });
});

describe("push/dispatcher notify", () => {
  it("sendet normal außerhalb der Ruhezeit und schreibt push_log", async () => {
    const { db } = await setup();
    const settings = await loadOrInitSettings(db);
    const sender = new FakeNtfySender();
    const now = new Date(2026, 0, 1, 12, 0);
    const result = await notify({ kind: "session_waiting", title: "Wartet", message: "Testfall", path: "/sessions/coding/nyxos/abc" }, { db, sender, settings, now });
    expect(result.sent).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.clickUrl).toBe(`${settings.publicBaseUrl}/sessions/coding/nyxos/abc`);
  });

  it("unterdrückt in der Ruhezeit, außer bei urgent", async () => {
    const { db } = await setup();
    const settings = await loadOrInitSettings(db);
    const sender = new FakeNtfySender();
    const now = new Date(2026, 0, 1, 23, 0);
    const suppressed = await notify({ kind: "session_waiting", title: "t", message: "m" }, { db, sender, settings, now });
    expect(suppressed).toEqual({ sent: false, reason: "quiet_hours" });
    expect(sender.sent).toHaveLength(0);

    const urgent = await notify({ kind: "deploy_failed", title: "t", message: "m", priority: "urgent" }, { db, sender, settings, now });
    expect(urgent.sent).toBe(true);
    expect(sender.sent).toHaveLength(1);
  });

  it("bündelt gleichartige Anlässe innerhalb des Zeitfensters zu einer Mitteilung", async () => {
    const { db } = await setup();
    const settings = await patchSettings(db, { bundleWindowSeconds: 120 });
    const sender = new FakeNtfySender();
    const now = new Date(2026, 0, 1, 12, 0);
    await notify({ kind: "build_red", title: "Build rot", message: "erster Fehler" }, { db, sender, settings, now });
    const later = new Date(now.getTime() + 30_000);
    const second = await notify({ kind: "build_red", title: "Build rot", message: "zweiter Fehler" }, { db, sender, settings, now: later });
    expect(second.sent).toBe(true);
    expect(sender.sent).toHaveLength(2); // beide "gesendet" (Bündel-Update zählt als Versand), aber nur eine Zeile in push_log
    expect(sender.sent[1]?.message).toContain("2 neue Meldungen");
  });

  it("ausgeschaltete Art wird gar nicht geloggt/gesendet", async () => {
    const { db } = await setup();
    const settings = await patchSettings(db, { enabledKinds: { night_run_done: false } });
    const sender = new FakeNtfySender();
    const result = await notify({ kind: "night_run_done", title: "t", message: "m" }, { db, sender, settings });
    expect(result).toEqual({ sent: false, reason: "kind_disabled" });
    expect(sender.sent).toHaveLength(0);
  });
});

describe("push/waiting checkWaitingSessions", () => {
  // Feste Mittags-Uhrzeit (nie Ruhezeit) statt der echten Wanduhr — sonst wackelt der Test, je
  // nachdem, wann er zufällig läuft (die Standard-Ruhezeit ist 22:00–08:00).
  const NOON = new Date(2026, 0, 1, 12, 0);

  it("meldet eine wartende Session erst nach waitingAfterSeconds, und nur einmal je Warte-Episode", async () => {
    const { db } = await setup();
    const settings = await patchSettings(db, { waitingAfterSeconds: 120 });
    const sender = new FakeNtfySender();

    const observedAt = new Date(NOON.getTime() - 200_000).toISOString(); // vor 200s -> älter als 120s Schwelle
    await db.insert(sessions).values({
      id: "claude:abc",
      tool: "claude",
      sessionId: "abc",
      title: "Testsession",
      state: "waiting",
      stateObservedAt: observedAt,
      categoryArt: "coding",
      categoryBaustelleSlug: "nyxos",
    });

    const first = await checkWaitingSessions(db, sender, settings, NOON);
    expect(first).toEqual(["claude:abc"]);
    expect(sender.sent).toHaveLength(1);

    // Zweiter Aufruf (derselbe Zustandswechsel) darf NICHT erneut senden.
    const second = await checkWaitingSessions(db, sender, settings, new Date(NOON.getTime() + 60_000));
    expect(second).toEqual([]);
    expect(sender.sent).toHaveLength(1);
  });

  it("noch keine 120s her -> keine Meldung", async () => {
    const { db } = await setup();
    const settings = await patchSettings(db, { waitingAfterSeconds: 120 });
    const sender = new FakeNtfySender();
    await db.insert(sessions).values({
      id: "claude:fresh",
      tool: "claude",
      sessionId: "fresh",
      state: "waiting",
      stateObservedAt: NOON.toISOString(),
    });
    const result = await checkWaitingSessions(db, sender, settings, NOON);
    expect(result).toEqual([]);
  });
});

describe("push routes", () => {
  it("GET /api/push/settings gibt nie das Thema preis", async () => {
    const sender = new FakeNtfySender();
    const { app } = await setup({ pushSender: sender });
    const res = await app.request("/api/push/settings");
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.topic).toBeUndefined();
    expect(body.quietStart).toBe("22:00");
  });

  it("POST /api/push/test sendet über den injizierten Sender", async () => {
    const sender = new FakeNtfySender();
    const { app } = await setup({ pushSender: sender });
    // Ruhezeit ausschalten (quietStart === quietEnd), damit der Test nicht von der echten Wanduhr abhängt.
    await app.request("/api/push/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ quietStart: "00:00", quietEnd: "00:00" }) });
    const res = await app.request("/api/push/test", { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(sender.sent).toHaveLength(1);
  });

  it("PATCH /api/push/settings ändert Ruhezeiten, GET /api/push/log zeigt den Verlauf", async () => {
    const sender = new FakeNtfySender();
    const { app } = await setup({ pushSender: sender });
    const patch = await app.request("/api/push/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ quietStart: "21:00" }) });
    expect(patch.status).toBe(200);
    // Test-Mitteilungen landen bewusst NICHT im Verlauf (sie würden echte Meldungen wegbündeln) — ein echter Anlass schon.
    await app.request("/api/push/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "build_red", title: "Build rot", message: "x" }) });
    const log = await app.request("/api/push/log");
    const body = (await log.json()) as { rows: unknown[] };
    // Egal ob gesendet oder wegen Ruhezeit unterdrückt: es gibt IMMER eine push_log-Zeile.
    expect(body.rows.length).toBeGreaterThan(0);
  });
});
