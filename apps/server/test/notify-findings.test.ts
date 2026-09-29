// Notifications – rote Tests zuerst für die drei Fehler aus dem Befund (Live-DB `push_log`, 27./28.09.):
//   1. Kontext-Wächter schickt dieselbe Meldung 2–3× in derselben Minute (Ticker + Ingest gleichzeitig).
//   2. Unter-Agenten (Codex-Worker „Locke: …“, `sessions.parent_id` gesetzt) lösen „wartet“, „fertig“ und Kontext-Hinweise aus.
//   3. Beschriftung ist der rohe Prompt („/goal Erstelle für unser Tool …“) oder „Session vom 28.09., 22:33“.
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runContextGuardForSessions, runContextGuardTicker } from "../src/context-guard/tick.js";
import { pushLog, sessionEvents, sessions } from "../src/db/schema.js";
import { patchSettings } from "../src/push/settings.js";
import { checkWaitingSessions } from "../src/push/waiting.js";
import type { NtfyMessage, NtfySender } from "../src/push/ntfy.js";
import { setup } from "./helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

const NOON = new Date(2026, 0, 1, 12, 0);
const iso = (d: Date | number) => new Date(d).toISOString();
/** Tests laufen zu jeder Uhrzeit – ohne Ruhezeit ist das Ergebnis nicht von der Wanduhr abhängig. */
const NO_QUIET = { quietStart: "00:00", quietEnd: "00:00" };

/** Sender wie der Rechner-Weg: braucht spürbar Zeit (Brücken-RPC), damit sich zwei Prüfungen überholen können. */
class SlowSender implements NtfySender {
  sent: NtfyMessage[] = [];
  async send(msg: NtfyMessage) {
    this.sent.push(msg);
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, status: 200 };
  }
}

type Db = Awaited<ReturnType<typeof setup>>["db"];

async function insertRunning(db: Db, over: Partial<typeof sessions.$inferInsert> & { id: string; sessionId: string }) {
  await db.insert(sessions).values({ tool: "codex", status: "running", state: "running", models: ["gpt-5"], ...over });
}

describe("Befund 1 · Kontext-Wächter doppelt", () => {
  it("Ticker und drei Ingest-Prüfungen GLEICHZEITIG → genau EINE Mitteilung je Überschreitung", async () => {
    const t = await setup();
    await insertRunning(t.db, { id: "claude:ctx1", sessionId: "ctx1", tool: "claude", title: "NyxOS Open-Source-Veröffentlichung", titleSource: "ai", models: ["opus"] });
    await patchSettings(t.db, NO_QUIET);
    const sender = new SlowSender();
    const deps = { db: t.db, hub: t.hub, bridgeHub: t.bridgeHub, pushSender: sender, getContextPct: () => 65, log: () => {} };
    await Promise.all([runContextGuardTicker(deps), runContextGuardForSessions(deps, ["claude:ctx1"]), runContextGuardForSessions(deps, ["claude:ctx1"]), runContextGuardForSessions(deps, ["claude:ctx1"])]);
    const rows = await t.db.select().from(pushLog).where(eq(pushLog.kind, "context_guard_hinweis"));
    expect(rows).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
  });
});

describe("Befund 2 · Unter-Agenten melden sich nicht", () => {
  it("wartender Codex-Worker mit Eltern-Session → keine „Wartet auf dich“-Mitteilung (Standard „Unter-Agenten nie melden“)", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, { waitingAfterSeconds: 120 });
    const sender = new FakeNtfySender();
    const old = iso(NOON.getTime() - 300_000);
    await t.db.insert(sessions).values({ id: "codex:haupt", tool: "codex", sessionId: "haupt", title: "Bevor wir mit der Shop-App arbeiten,", titleSource: "index", state: "running", stateObservedAt: old });
    await t.db.insert(sessions).values({
      id: "codex:locke",
      tool: "codex",
      sessionId: "locke",
      parentId: "codex:haupt",
      title: "Locke: Welche dinge sind 10000% fertig geschrieben und welche pfade",
      titleSource: "prompt",
      state: "waiting",
      stateObservedAt: old,
    });
    const notified = await checkWaitingSessions(t.db, sender, settings, NOON);
    expect(notified).toEqual([]);
    expect(sender.sent).toHaveLength(0);
  });

  it("Kontext-Wächter über der Schwelle bei einem Unter-Agenten → keine Mitteilung", async () => {
    const t = await setup();
    await insertRunning(t.db, { id: "codex:haupt2", sessionId: "haupt2", title: "Haupt", titleSource: "index" });
    await insertRunning(t.db, { id: "codex:popper", sessionId: "popper", parentId: "codex:haupt2", title: "Popper: Welche dinge sind fertig", titleSource: "prompt" });
    await patchSettings(t.db, NO_QUIET);
    const sender = new FakeNtfySender();
    await runContextGuardForSessions({ db: t.db, hub: t.hub, bridgeHub: t.bridgeHub, pushSender: sender, getContextPct: () => 70, log: () => {} }, ["codex:popper"]);
    expect(sender.sent).toHaveLength(0);
  });
});

describe("Befund 3 · Namen statt rohem Prompt", () => {
  it("Titel = erste Nachricht mit „/goal …“ → Mitteilung nennt die Baustelle, nicht den Prompt", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, { waitingAfterSeconds: 120 });
    const sender = new FakeNtfySender();
    await t.db.insert(sessions).values({
      id: "claude:web",
      tool: "claude",
      sessionId: "web",
      title: "/goal Erstelle für unser Tool NYX OS eine website. Keine unterseiten nur OnePage",
      titleSource: "prompt",
      categoryBaustelleLabel: "Shop-Website",
      state: "waiting",
      stateObservedAt: iso(NOON.getTime() - 300_000),
    });
    await checkWaitingSessions(t.db, sender, settings, NOON);
    expect(sender.sent).toHaveLength(1);
    const text = `${sender.sent[0]?.title} ${sender.sent[0]?.message}`;
    expect(text).toContain("Shop-Website");
    expect(text).not.toContain("/goal");
    expect(text).not.toContain("Erstelle für unser Tool");
  });

  it("noch ohne Titel und Baustelle → kurze Zusammenfassung der ersten Nachricht statt „Session vom …“", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, { waitingAfterSeconds: 120 });
    const sender = new FakeNtfySender();
    await t.db.insert(sessions).values({ id: "claude:neu", tool: "claude", sessionId: "neu", state: "waiting", startedAt: iso(NOON.getTime() - 400_000), stateObservedAt: iso(NOON.getTime() - 300_000) });
    await t.db.insert(sessionEvents).values({ id: "e-neu-1", sessionKey: "claude:neu", source: "hook", ts: iso(NOON.getTime() - 390_000), kind: "prompt", data: { text: "Bitte die Mitteilungen überarbeiten. der Nutzer hat gemerkt, dass …" } });
    await checkWaitingSessions(t.db, sender, settings, NOON);
    expect(sender.sent).toHaveLength(1);
    const text = `${sender.sent[0]?.title} ${sender.sent[0]?.message}`;
    expect(text).not.toMatch(/Session vom/);
    expect(text).toContain("Mitteilungen überarbeiten");
  });

  it("der Kontext-Wächter benutzt denselben Namen (kein roher Prompt im Text)", async () => {
    const t = await setup();
    await insertRunning(t.db, { id: "claude:ctx2", sessionId: "ctx2", tool: "claude", title: "/goal Erstelle für unser Tool NYX OS eine website", titleSource: "prompt", categoryBaustelleLabel: "Shop-Website", models: ["opus"] });
    const sender = new FakeNtfySender();
    await patchSettings(t.db, NO_QUIET);
    await runContextGuardForSessions({ db: t.db, hub: t.hub, bridgeHub: t.bridgeHub, pushSender: sender, getContextPct: () => 66, log: () => {}, now: () => NOON.getTime() }, ["claude:ctx2"]);
    const [row] = await t.db.select().from(pushLog).where(and(eq(pushLog.kind, "context_guard_hinweis"), eq(pushLog.sessionKey, "claude:ctx2")));
    expect(row?.message).toContain("Shop-Website");
    expect(row?.message).not.toContain("/goal");
  });
});
