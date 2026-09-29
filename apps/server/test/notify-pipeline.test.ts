// Notifications – die gemeinsame Mitteilungs-Pipeline, rein (Zeitquelle, Nyx-Laufzeit, Anwesenheit und Versand von außen):
// Wann-Stufen, da/weg, Unter-Agenten, Mindestabstand/Doppelt, Stil/Vorlagen, Nyx prüft (senden/weglassen/bündeln/
// Zeitlimit), Nyx schreibt (falsche Zahl → Vorlage), Dringendes nicht wegfilterbar.
import type { NotifyRulesPatch, PushNotifyInput } from "@nyxos/shared";
import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AwayEvent } from "../src/away/notifier.js";
import { pushLog, sessions } from "../src/db/schema.js";
import type { RuntimeEvent } from "../src/haiku/runtime.js";
import type { NyxRunner } from "../src/notifications/nyx.js";
import { checkNyxText } from "../src/notifications/nyx.js";
import { NotifyHold, runPipeline, type NotifyEnv } from "../src/notifications/pipeline.js";
import { patchNotifyRules } from "../src/notifications/rules.js";
import { patchSettings } from "../src/push/settings.js";
import { setup } from "./helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

const NOON = new Date("2026-03-02T11:00:00Z"); // 12:00 Berliner Zeit, keine Ruhezeit
const NO_QUIET = { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 };

type Db = Awaited<ReturnType<typeof setup>>["db"];

/** Nyx-Laufzeit als Attrappe: antwortet mit festem JSON (oder nie). Zählt Aufrufe, merkt sich die Aufträge. */
function fakeNyx(reply: Record<string, unknown> | "never" | "error"): NyxRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (o) => {
      calls.push(o.prompt);
      if (reply === "never") return new Promise<never>(() => {});
      if (reply === "error") return { type: "error", code: "engine", message: "kaputt", callId: null } satisfies RuntimeEvent;
      return {
        type: "final",
        rawText: JSON.stringify(reply),
        text: "",
        sources: [],
        estimate: false,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 },
        callId: 1,
        claudeSessionId: null,
      } as unknown as Extract<RuntimeEvent, { type: "final" }>;
    },
  };
}

function envWith(o: { away?: boolean; runner?: NyxRunner | null; hold?: NotifyHold; timeoutMs?: number } = {}): NotifyEnv & { batch: AwayEvent[]; logs: string[] } {
  const batch: AwayEvent[] = [];
  const logs: string[] = [];
  return {
    batch,
    logs,
    isAway: () => o.away ?? false,
    enqueueAway: (e) => {
      batch.push(e);
      return true;
    },
    runtime: () => o.runner ?? null,
    hold: o.hold,
    nyxTimeoutMs: o.timeoutMs,
    log: (m) => logs.push(m),
  };
}

async function prep(t: { db: Db }, rules: NotifyRulesPatch = {}) {
  const settings = await patchSettings(t.db, NO_QUIET);
  if (Object.keys(rules).length > 0) await patchNotifyRules(t.db, rules, NOON);
  await t.db.insert(sessions).values({ id: "claude:s1", tool: "claude", sessionId: "s1", title: "Push umbauen", titleSource: "ai", categoryBaustelleLabel: "Webshop", state: "waiting" });
  return settings;
}

const WAITING: PushNotifyInput = { kind: "session_waiting", title: "Wartet auf dich", message: "wartet auf dich", what: "wartet auf dich", sessionKey: "claude:s1", path: "/sessions/x", at: NOON.toISOString() };

async function lastRow(db: Db) {
  const [row] = await db.select().from(pushLog).orderBy(desc(pushLog.id)).limit(1);
  return row;
}

describe("Pipeline · Wann?", () => {
  it("„Nie“ → nicht gesendet, im Verlauf „Anlass ist aus“", async () => {
    const t = await setup();
    const settings = await prep(t, { when: { session_waiting: "never" } });
    const sender = new FakeNtfySender();
    const res = await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env: envWith() });
    expect(res).toMatchObject({ sent: false, reason: "kind_disabled" });
    expect(sender.sent).toHaveLength(0);
    expect((await lastRow(t.db))?.decision).toBe("kind_off");
  });

  it("„Nur wenn ich weg bin“: da → still (kein Verlauf-Eintrag), weg → Rechner/Browser + Sammel-Mitteilung fürs Handy", async () => {
    const t = await setup();
    const settings = await prep(t, { when: { context_guard_hinweis: "away" } });
    const input: PushNotifyInput = { kind: "context_guard_hinweis", title: "Kontext fast voll", message: "Kontext 70 %", what: "Kontext 70 % – Komprimieren empfohlen", sessionKey: "claude:s1" };
    const sender = new FakeNtfySender();
    const present = await runPipeline(input, { db: t.db, sender, settings, now: NOON, env: envWith({ away: false }) });
    expect(present).toMatchObject({ sent: false, reason: "not_away" });
    expect(await t.db.select().from(pushLog)).toHaveLength(0);

    const env = envWith({ away: true });
    const away = await runPipeline(input, { db: t.db, sender, settings, now: NOON, env });
    expect(away.sent).toBe(true);
    expect(sender.sent[0]?.channels?.ntfy).toBe(false); // Handy nicht einzeln …
    expect(env.batch).toHaveLength(1); // … sondern gesammelt
    expect(env.batch[0]?.label).toContain("Push umbauen");
    expect((await lastRow(t.db))?.decisionNote).toBe("Handy: kommt gesammelt");
  });

  it("„Immer“ + da → alle Wege inkl. Handy", async () => {
    const t = await setup();
    const settings = await prep(t);
    const sender = new FakeNtfySender();
    const res = await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env: envWith() });
    expect(res.sent).toBe(true);
    expect(sender.sent[0]?.channels?.ntfy).toBe(true);
    expect((await lastRow(t.db))?.decision).toBe("sent");
  });

  it("Unter-Agent (parent_id) → „Unter-Agent“; Schalter aus → wird gemeldet", async () => {
    const t = await setup();
    const settings = await prep(t);
    await t.db.insert(sessions).values({ id: "codex:locke", tool: "codex", sessionId: "locke", parentId: "claude:s1", title: "Locke: prüfe alles", titleSource: "prompt", state: "waiting" });
    const sender = new FakeNtfySender();
    const input = { ...WAITING, sessionKey: "codex:locke" };
    expect(await runPipeline(input, { db: t.db, sender, settings, now: NOON, env: envWith() })).toMatchObject({ reason: "sub_agent" });
    const row = await lastRow(t.db);
    expect(row?.decision).toBe("sub_agent");
    expect(row?.decisionNote).toContain("Push umbauen");
    await patchNotifyRules(t.db, { skipSubAgents: false });
    expect((await runPipeline(input, { db: t.db, sender, settings, now: NOON, env: envWith() })).sent).toBe(true);
  });

  it("Mindestabstand je Session: zweite Meldung derselben Session (auch „fertig“ nach „wartet“) → still; Dringendes geht immer", async () => {
    const t = await setup();
    const settings = await prep(t, { minGapMinutes: 10 });
    const sender = new FakeNtfySender();
    const deps = { db: t.db, sender, settings, env: envWith() };
    expect((await runPipeline(WAITING, { ...deps, now: NOON })).sent).toBe(true);
    const done = await runPipeline({ ...WAITING, kind: "session_done", what: "ist fertig" }, { ...deps, now: new Date(NOON.getTime() + 3 * 60_000) });
    // session_done steht standardmäßig auf „nur wenn weg“ → erst auf „Immer“ stellen, dann greift der Abstand
    expect(done.reason).toBe("not_away");
    await patchNotifyRules(t.db, { when: { session_done: "always" } });
    const again = await runPipeline({ ...WAITING, kind: "session_done", what: "ist fertig" }, { ...deps, now: new Date(NOON.getTime() + 3 * 60_000) });
    expect(again).toMatchObject({ sent: false, reason: "min_gap" });
    const later = await runPipeline(WAITING, { ...deps, now: new Date(NOON.getTime() + 11 * 60_000) });
    expect(later.sent).toBe(true);
    const urgent = await runPipeline({ ...WAITING, kind: "session_crashed", what: "ist abgestürzt", priority: "urgent" }, { ...deps, now: new Date(NOON.getTime() + 12 * 60_000) });
    expect(urgent.sent).toBe(true);
  });

  it("Kritik: neue Warte-Runde kurz nach der letzten Meldung wird NICHT vom Mindestabstand verschluckt", async () => {
    const t = await setup();
    const settings = await prep(t, { minGapMinutes: 10 });
    const sender = new FakeNtfySender();
    const deps = { db: t.db, sender, settings, env: envWith() };
    expect((await runPipeline(WAITING, { ...deps, now: NOON })).sent).toBe(true);
    // der Nutzer antwortet, Session arbeitet 3 Min, wartet ab 12:04 wieder → Meldung um 12:06 kommt
    const next = { ...WAITING, at: new Date(NOON.getTime() + 4 * 60_000).toISOString() };
    expect((await runPipeline(next, { ...deps, now: new Date(NOON.getTime() + 6 * 60_000) })).sent).toBe(true);
  });

  it("Kritik: Freigaben gelten nie als „Unter-Agent“ und haben keinen Mindestabstand", async () => {
    const t = await setup();
    const settings = await prep(t, { minGapMinutes: 10 });
    await t.db.insert(sessions).values({ id: "codex:dirac", tool: "codex", sessionId: "dirac", parentId: "claude:s1", title: "Dirac: baue", titleSource: "prompt", state: "waiting" });
    const sender = new FakeNtfySender();
    const deps = { db: t.db, sender, settings, now: NOON, env: envWith() };
    const approval: PushNotifyInput = { kind: "approval_needed", title: "Freigabe nötig", message: "Befehl A", what: "Push – Befehl A", sessionKey: "codex:dirac", priority: "high" };
    expect((await runPipeline(approval, deps)).sent).toBe(true);
    expect((await runPipeline({ ...approval, what: "Löschen – Befehl B" }, { ...deps, now: new Date(NOON.getTime() + 60_000) })).sent).toBe(true);
  });

  it("Kritik: weg, „wartet“ ohne „fertig“ im Stapel → trotzdem in die Sammel-Mitteilung", async () => {
    const t = await setup();
    const settings = await prep(t);
    const env = envWith({ away: true });
    const res = await runPipeline(WAITING, { db: t.db, sender: new FakeNtfySender(), settings, now: NOON, env });
    expect(res.sent).toBe(true); // Rechner/Browser
    expect(env.batch).toHaveLength(1);
  });

  it("Kritik: weg + Ruhezeit → Rechner/Browser still, Verlauf sagt ehrlich „kommt gesammelt“", async () => {
    const t = await setup();
    await prep(t);
    const settings = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "23:59" });
    const sender = new FakeNtfySender();
    const env = envWith({ away: true });
    const res = await runPipeline({ ...WAITING, kind: "session_crashed", what: "ist abgestürzt", priority: "high" }, { db: t.db, sender, settings, now: NOON, env });
    expect(res.reason).toBe("away_batch");
    expect(sender.sent).toHaveLength(0);
    expect(env.batch[0]?.important).toBe(true);
    expect((await lastRow(t.db))?.decisionNote).toContain("Handy: kommt gesammelt");
  });

  it("derselbe Anlass gleichzeitig (Wettlauf) → einmal", async () => {
    const t = await setup();
    const settings = await prep(t);
    const sender = new FakeNtfySender();
    const deps = { db: t.db, sender, settings, now: NOON, env: envWith() };
    const input: PushNotifyInput = { kind: "build_red", title: "Build rot: Webshop", message: "Typfehler", what: "Build rot: Webshop – Typfehler" };
    const results = await Promise.all([runPipeline(input, deps), runPipeline(input, deps), runPipeline(input, deps)]);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
  });
});

describe("Pipeline · Wie geschrieben?", () => {
  it("Stil Knapp / Mit Zusammenhang / Ausführlich und eigene Vorlage mit Platzhaltern", async () => {
    const t = await setup();
    const settings = await prep(t);
    const texts: string[] = [];
    for (const style of ["knapp", "zusammenhang", "ausfuehrlich"] as const) {
      await patchNotifyRules(t.db, { style, minGapMinutes: 0 });
      const sender = new FakeNtfySender();
      await runPipeline({ ...WAITING, detail: "Zuletzt: Tests grün." }, { db: t.db, sender, settings, now: new Date(NOON.getTime() + texts.length * 3_600_000), env: envWith() });
      texts.push(sender.sent[0]?.message ?? "");
    }
    expect(texts[0]).toBe("Push umbauen");
    expect(texts[1]).toBe("„Push umbauen“ wartet seit 12:00 auf dich.");
    expect(texts[2]).toBe("„Push umbauen“ (Webshop) wartet seit 12:00 auf dich.\nZuletzt: Tests grün.");
    await patchNotifyRules(t.db, { templates: { session_waiting: { title: "{baustelle}", body: "{session} braucht dich ({wann})" } } });
    const sender = new FakeNtfySender();
    await runPipeline(WAITING, { db: t.db, sender, settings, now: new Date(NOON.getTime() + 9 * 3_600_000), env: envWith() });
    expect(sender.sent[0]).toMatchObject({ title: "Webshop", message: "Push umbauen braucht dich (12:00)" });
  });
});

describe("Pipeline · Nyx prüft", () => {
  it("weglassen → nicht gesendet, Grund im Verlauf; „Was mir wichtig ist“ + Beispiele gehen an Nyx", async () => {
    const t = await setup();
    const settings = await prep(t, { nyxReview: true, important: "Nur echte Blocker" });
    const nyx = fakeNyx({ entscheidung: "weglassen", grund: "Session wartet nur auf ein OK" });
    const sender = new FakeNtfySender();
    const res = await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env: envWith({ runner: nyx }) });
    expect(res).toMatchObject({ sent: false, reason: "nyx_skip" });
    expect(sender.sent).toHaveLength(0);
    expect(nyx.calls[0]).toContain("Nur echte Blocker");
    const row = await lastRow(t.db);
    expect(row).toMatchObject({ decision: "nyx_skip", decisionNote: "Session wartet nur auf ein OK" });
    expect(row?.nyx).toMatchObject({ review: "weglassen" });
  });

  it("senden → gesendet mit Nyx-Spur", async () => {
    const t = await setup();
    const settings = await prep(t, { nyxReview: true });
    const sender = new FakeNtfySender();
    const res = await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env: envWith({ runner: fakeNyx({ entscheidung: "senden", grund: "wichtig" }) }) });
    expect(res.sent).toBe(true);
    expect((await lastRow(t.db))?.nyx).toMatchObject({ review: "senden" });
  });

  it("Zeitlimit (8 s, hier 30 ms) → wie ohne Nyx gesendet, Spur „zeitlimit“, Log-Ereignis", async () => {
    const t = await setup();
    const settings = await prep(t, { nyxReview: true, nyxWrite: true });
    const sender = new FakeNtfySender();
    const env = envWith({ runner: fakeNyx("never"), timeoutMs: 30 });
    const res = await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env });
    expect(res.sent).toBe(true);
    expect(sender.sent[0]?.message).toBe("„Push umbauen“ wartet seit 12:00 auf dich.");
    expect((await lastRow(t.db))?.nyx).toMatchObject({ review: "zeitlimit", wrote: "vorlage" });
    expect(env.logs).toContain("mitteilung-nyx-zeitlimit");
  });

  it("bündeln, solange der Nutzer da ist → gesammelt, nach dem Bündel-Abstand EINE Mitteilung", async () => {
    const t = await setup();
    const settings = await prep(t, { nyxReview: true, minGapMinutes: 0 });
    const hold = new NotifyHold();
    const sender = new FakeNtfySender();
    const env = envWith({ runner: fakeNyx({ entscheidung: "buendeln", grund: "nicht eilig" }), hold });
    await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env });
    await runPipeline({ ...WAITING, kind: "build_red", what: "Build rot: Webshop", sessionKey: null }, { db: t.db, sender, settings, now: NOON, env });
    expect(sender.sent).toHaveLength(0);
    expect(hold.size).toBe(2);
    expect(await hold.flush({ db: t.db, sender, settings, env, now: new Date(NOON.getTime() + 60_000), afterMs: 15 * 60_000 })).toBe(0);
    expect(await hold.flush({ db: t.db, sender, settings, env, now: new Date(NOON.getTime() + 16 * 60_000), afterMs: 15 * 60_000 })).toBe(2);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.title).toBe("NyxOS: 2 Mitteilungen gesammelt");
    expect(sender.sent[0]?.message.split("\n")).toHaveLength(2);
  });

  it("Dringendes (Deploy fehlgeschlagen) kann Nyx nicht wegfiltern – außer der Schalter ist aus", async () => {
    const t = await setup();
    const settings = await prep(t, { nyxReview: true });
    const nyx = fakeNyx({ entscheidung: "weglassen", grund: "egal" });
    const deploy: PushNotifyInput = { kind: "deploy_failed", title: "Deploy fehlgeschlagen", message: "Server alt", what: "Deploy fehlgeschlagen", priority: "urgent" };
    const sender = new FakeNtfySender();
    const res = await runPipeline(deploy, { db: t.db, sender, settings, now: NOON, env: envWith({ runner: nyx, away: true }) });
    expect(res.sent).toBe(true);
    expect(nyx.calls).toHaveLength(0); // gar nicht erst gefragt
    expect(sender.sent[0]?.channels?.ntfy).toBe(true); // dringend: sofort auch aufs Handy, obwohl weg
    expect((await lastRow(t.db))?.nyx).toMatchObject({ review: "uebersprungen" });
    await patchNotifyRules(t.db, { protectUrgent: false });
    const res2 = await runPipeline({ ...deploy, what: "Deploy fehlgeschlagen (2)" }, { db: t.db, sender, settings, now: NOON, env: envWith({ runner: nyx }) });
    expect(res2).toMatchObject({ sent: false, reason: "nyx_skip" });
  });

  it("Freigaben und Abstürze kann Nyx ebenfalls nicht wegfiltern (eine Session hinge sonst still)", async () => {
    const t = await setup();
    const settings = await prep(t, { nyxReview: true });
    const nyx = fakeNyx({ entscheidung: "weglassen", grund: "egal" });
    const sender = new FakeNtfySender();
    const approval: PushNotifyInput = { kind: "approval_needed", title: "Freigabe nötig", message: "Deploy freigeben?", what: "Freigabe nötig" };
    const crash: PushNotifyInput = { kind: "session_crashed", title: "Session abgestürzt", message: "Push-Umbau", what: "Session abgestürzt" };
    expect(await runPipeline(approval, { db: t.db, sender, settings, now: NOON, env: envWith({ runner: nyx }) })).toMatchObject({ sent: true });
    expect(await runPipeline(crash, { db: t.db, sender, settings, now: NOON, env: envWith({ runner: nyx }) })).toMatchObject({ sent: true });
    expect(nyx.calls).toHaveLength(0);
    expect((await lastRow(t.db))?.nyx).toMatchObject({ review: "uebersprungen" });
  });
});

describe("Pipeline · Nyx schreibt", () => {
  it("guter Text → Nyx' Text", async () => {
    const t = await setup();
    const settings = await prep(t, { nyxWrite: true });
    const sender = new FakeNtfySender();
    await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env: envWith({ runner: fakeNyx({ titel: "Push umbauen wartet", text: "„Push umbauen“ ist fertig und braucht dein OK." }) }) });
    expect(sender.sent[0]).toMatchObject({ title: "Push umbauen wartet", message: "„Push umbauen“ ist fertig und braucht dein OK." });
    expect((await lastRow(t.db))?.nyx).toMatchObject({ wrote: "nyx" });
  });

  it("erfundene Zahl oder fremder Name → Vorlagen-Text, Grund in der Spur", async () => {
    const t = await setup();
    const settings = await prep(t, { nyxWrite: true });
    const sender = new FakeNtfySender();
    await runPipeline(WAITING, { db: t.db, sender, settings, now: NOON, env: envWith({ runner: fakeNyx({ titel: "Wartet", text: "„Push umbauen“ hat 17 Tests repariert." }) }) });
    expect(sender.sent[0]?.message).toBe("„Push umbauen“ wartet seit 12:00 auf dich.");
    const row = await lastRow(t.db);
    expect(row?.nyx).toMatchObject({ wrote: "vorlage" });
    expect(String(row?.nyx?.note)).toContain("17");
  });

  it("Prüfung der Zahlen/Namen (rein)", () => {
    const input = {
      kind: "context_guard_hinweis" as const,
      kindLabel: "Kontext-Wächter",
      priority: "default" as const,
      away: false,
      time: "22:47",
      style: "zusammenhang" as const,
      title: "Kontext fast voll",
      body: "„Shop-Website“: Kontext 65 % – Komprimieren empfohlen.",
      was: "Kontext 65 % – Komprimieren empfohlen",
      details: null,
      session: null,
      important: "",
      examples: [],
      review: false,
      write: true,
    };
    expect(checkNyxText("Kontext fast voll", "„Shop-Website“ ist bei 65 % – bitte komprimieren.", input)).toBeNull();
    expect(checkNyxText("Kontext fast voll", "„Shop-Website“ ist bei 80 %.", input)).toMatch(/80/);
    expect(checkNyxText("Kontext fast voll", "„Kassen-App“ ist bei 65 %.", input)).toMatch(/Kassen-App/);
  });
});

describe("Pipeline · Abwesenheits-Ereignisse", () => {
  it("Session fertig: weg → nur in die Sammel-Mitteilung (kein Rechner/Browser); da + „Immer“ → normale Mitteilung", async () => {
    const t = await setup();
    const settings = await prep(t);
    const sender = new FakeNtfySender();
    const input: PushNotifyInput = { kind: "session_done", title: "Session fertig", message: "Session fertig", what: "ist fertig", sessionKey: "claude:s1", path: "/sessions/x" };
    const env = envWith({ away: true });
    const res = await runPipeline(input, { db: t.db, sender, settings, now: NOON, env }, { awayEvent: { key: "s:1" } });
    expect(res.reason).toBe("away_batch");
    expect(sender.sent).toHaveLength(0);
    expect(env.batch.map((e) => e.key)).toEqual(["s:1"]);
    await patchNotifyRules(t.db, { when: { session_done: "always" }, minGapMinutes: 0 });
    const present = await runPipeline(input, { db: t.db, sender, settings, now: new Date(NOON.getTime() + 60_000), env: envWith({ away: false }) }, { awayEvent: { key: "s:2" } });
    expect(present.sent).toBe(true);
    expect(sender.sent).toHaveLength(1);
  });

  it("alte Schalter (enabledKinds aus) werden „Nie“", async () => {
    const t = await setup();
    const settings = await patchSettings(t.db, { ...NO_QUIET, enabledKinds: { context_guard_hinweis: false } });
    const res = await runPipeline({ kind: "context_guard_hinweis", title: "x", message: "y" }, { db: t.db, sender: new FakeNtfySender(), settings, now: NOON });
    expect(res.reason).toBe("kind_disabled");
    const [row] = await t.db.select().from(pushLog).where(eq(pushLog.kind, "context_guard_hinweis"));
    expect(row?.decision).toBe("kind_off");
  });
});
