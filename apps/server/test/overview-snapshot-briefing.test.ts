// Überblick, Briefing und Recap aus einem Schnappschuss:
// - Kopfzeile, Kacheln, „Kritische Sessions“, Briefing und „Braucht dich“ aus EINEM Schnappschuss;
//   Haikus Zahlen werden geprüft (Neuschreiben, sonst Daten-Satz + Marke); ohne Motor ehrlicher Grund.
// - „abgestürzt“ nur bis N Stunden ohne Prozess (Einstellung), danach beendet.
// - neue Kacheln/Listen aus echten Daten (Tokens, Builds, zuletzt fertig, Konflikt-Trend).
// - Build-Wächter: grüner Lauf im selben Ordner räumt „Braucht dich“ auf; nach Reparatur wieder Push.
import type { PushNotifyInput } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { notifyBuildDone } from "../src/builds/notify.js";
import { BuildQueue, type BuildJob, type BuildRunner } from "../src/builds/queue.js";
import { approvals, buildRuns, conflictEvents, entries, pushLog, sessions, usageDaily } from "../src/db/schema.js";
import { createEntry } from "../src/entries/store.js";
import { createInboxItem, YES_NO } from "../src/haiku/inbox.js";
import { generateReport, latestReport } from "../src/haiku/report.js";
import { HaikuScheduler } from "../src/haiku/scheduler.js";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { takeSnapshot } from "../src/overview/snapshot.js";
import { notify } from "../src/push/dispatcher.js";
import { loadOrInitSettings } from "../src/push/settings.js";
import { computeSessionState } from "../src/state.js";
import { loadStateSettings, saveStateSettings } from "../src/state-settings.js";
import { retickIdleStates } from "../src/store.js";
import { answer, FakeEngine, setupAssistant } from "./assistant/assistant-helpers.js";
import { FakeNtfySender } from "./automation/fakes.js";

type T = Awaited<ReturnType<typeof setupAssistant>>;
const now = new Date("2026-09-25T08:38:00Z"); // 10:38 Berlin
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

/** Typische Lage: 1 läuft, 2 warten (+1 Sub-Agent wartet), 1 frisch abgestürzt, 1 „vor 33 T“, 1 ruht, 1 sauber fertig. */
// echte Sessions haben Nachrichten (`parsedEventCount`) – ohne gälten sie nach > 1 Tag (die Route rechnet
// mit der echten Uhr, der Test mit einer festen) als „verwaist“ und zählten nicht mehr als „wartet“.
async function seed(t: T) {
  await t.db.insert(sessions).values([
    { id: "claude:r1", tool: "claude", sessionId: "r1", parsedEventCount: 5, title: "Karte bauen", status: "running", turnOpen: true, state: "running", categoryArt: "coding", categoryBaustelleSlug: "app", lastActivityAt: ago(2 * MIN), startedAt: ago(3 * H) },
    { id: "claude:w1", tool: "claude", sessionId: "w1", parsedEventCount: 5, title: "Neumorphic dashboard design", status: "running", turnOpen: false, state: "waiting", categoryArt: "coding", categoryBaustelleSlug: "nyxos", lastActivityAt: ago(5 * MIN) },
    { id: "claude:w2", tool: "claude", sessionId: "w2", parsedEventCount: 5, title: "Projekt-Orchestrierung", status: "running", turnOpen: false, state: "waiting", categoryArt: "planung", lastActivityAt: ago(14 * H) },
    { id: "claude:w1-sub", tool: "claude", sessionId: "w1-sub", parentId: "claude:w1", title: "Sub-Agent", status: "running", turnOpen: false, state: "waiting", lastActivityAt: ago(5 * MIN) },
    { id: "claude:c1", tool: "claude", sessionId: "c1", title: "Zähle langsam bis 50", status: "ended", turnOpen: true, state: "crashed", categoryArt: "coding", lastActivityAt: ago(2 * H) },
    { id: "claude:c2", tool: "claude", sessionId: "c2", title: "Community-Feed Planung und Änderungen", status: "ended", turnOpen: true, state: "crashed", categoryArt: "coding", categoryBaustelleSlug: "community", lastActivityAt: ago(33 * DAY) },
    { id: "claude:i1", tool: "claude", sessionId: "i1", title: "Ruhige Session", status: "running", turnOpen: true, state: "idle", lastActivityAt: ago(2 * H) },
    { id: "claude:e1", tool: "claude", sessionId: "e1", title: "Fertige Session Login", status: "ended", turnOpen: false, state: null, sessionEndReceivedAt: ago(40 * MIN), endedAt: ago(40 * MIN), categoryArt: "coding", categoryBaustelleSlug: "app", lastActivityAt: ago(40 * MIN) },
  ]);
  await t.db.insert(approvals).values({ rule: "git_push", reason: "Push ist Alex vorbehalten", tool: "Bash", command: "git push origin auftrag/t-01", commandHash: "h1", sessionKey: "claude:r1" });
  await createInboxItem(t.db, { kind: "frage", title: "Darf T-01 die Tabelle umbenennen?", options: YES_NO, createdBy: "session", sessionKey: "claude:w1" });
  await createInboxItem(t.db, { kind: "plan", title: "Heute Nacht A02 starten", body: "A02 ist startklar", options: [{ id: "freigeben", label: "Freigeben" }], createdBy: "haiku" });
  await t.db.insert(buildRuns).values({ kind: "nyxos", command: "pnpm -r typecheck", status: "red", logExcerpt: "src/x.ts(1,1): error TS2322: kaputt", trigger: "stop_hook", startedAt: ago(30 * MIN), endedAt: ago(29 * MIN), folder: "/wt/nyxos" });
}

/** Alle Zahlen eines Satzes. */
const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);

describe("Altersgrenze für „abgestürzt“", () => {
  it("reine Funktion: ohne Prozess und offene Runde → abgestürzt nur bis N Stunden, danach beendet (null)", () => {
    const base = { status: "ended", turnOpen: true, sessionEndReceivedAt: null, closedAt: null } as const;
    const t0 = now.getTime();
    expect(computeSessionState({ ...base, lastActivityAt: ago(2 * H) }, t0)).toBe("crashed");
    expect(computeSessionState({ ...base, lastActivityAt: ago(33 * DAY) }, t0)).toBeNull();
    // Standard 12 h: knapp darunter noch abgestürzt, knapp darüber beendet.
    expect(computeSessionState({ ...base, lastActivityAt: ago(11 * H) }, t0)).toBe("crashed");
    expect(computeSessionState({ ...base, lastActivityAt: ago(13 * H) }, t0)).toBeNull();
    // Schwelle einstellbar.
    expect(computeSessionState({ ...base, lastActivityAt: ago(13 * H) }, t0, { crashedMaxMs: 48 * H })).toBe("crashed");
    expect(computeSessionState({ ...base, lastActivityAt: ago(2 * H) }, t0, { crashedMaxMs: 1 * H })).toBeNull();
  });

  it("Takt räumt alte „abgestürzt“ ab; Einstellung wirkt sofort in beide Richtungen; Zähler/Kritische Sessions/Briefing/Rundgang folgen", async () => {
    const t = await setupAssistant();
    await seed(t);
    expect((await loadStateSettings(t.db)).crashedMaxHours).toBe(12);
    await retickIdleStates(t.db, now.getTime());
    const [c2] = await t.db.select({ state: sessions.state }).from(sessions).where(eq(sessions.id, "claude:c2"));
    expect(c2?.state).toBeNull();

    const ov = await getOverviewSnapshot(t.db, "Alex", now);
    expect(ov.counts.crashed).toBe(1);
    expect(ov.criticalSessions.filter((s) => s.reason === "abgestürzt").map((s) => s.sessionId)).toEqual(["c1"]);
    const r = await generateReport(t.runtime, "briefing", now);
    expect(r.needsYou.filter((i) => i.kind === "crashed").map((i) => i.title)).toEqual(["Abgestürzt: Zähle langsam bis 50"]);
    expect(JSON.stringify(r.sections)).not.toContain("Community-Feed");
    const findings = await new HaikuScheduler({ runtime: t.runtime, notify: () => {} }).rundgang(now);
    expect(findings.filter((f) => f.kind === "crashed").map((f) => f.sessionKey)).toEqual(["claude:c1"]);

    // Schwelle hoch (40 Tage) → die 33 Tage alte zählt wieder; zurück auf 1 h → auch c1 (2 h) ist beendet.
    await saveStateSettings(t.db, { crashedMaxHours: 40 * 24 });
    await retickIdleStates(t.db, now.getTime());
    expect((await getOverviewSnapshot(t.db, "Alex", now)).counts.crashed).toBe(2);
    await saveStateSettings(t.db, { crashedMaxHours: 1 });
    await retickIdleStates(t.db, now.getTime());
    expect((await getOverviewSnapshot(t.db, "Alex", now)).counts.crashed).toBe(0);
  });

  it("Route: GET/PATCH /api/settings/session-state (prüft Grenzen, wirkt sofort)", async () => {
    const t = await setupAssistant();
    await seed(t);
    const get = await t.app.request("/api/settings/session-state");
    expect(await get.json()).toEqual({ crashedMaxHours: 12 });
    expect((await t.json("/api/settings/session-state", { crashedMaxHours: 0 }, "PATCH")).status).toBe(400);
    const res = await t.json("/api/settings/session-state", { crashedMaxHours: 24 * 40 }, "PATCH");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ crashedMaxHours: 960 });
    // Wirkt sofort (ohne auf den nächsten Takt zu warten): die 33 Tage alte ist wieder „abgestürzt“.
    const [c2] = await t.db.select({ state: sessions.state }).from(sessions).where(eq(sessions.id, "claude:c2"));
    expect(c2?.state).toBe("crashed");
  });
});

describe("eine Quelle, ein Zeitpunkt", () => {
  it("Kopfzeile, Kacheln, Kritische Sessions, Briefing-Lage, Sätze und „Braucht dich“ stimmen überein", async () => {
    const engine = new FakeEngine(answer("x"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    await seed(t);
    await retickIdleStates(t.db, now.getTime());
    const ov = await getOverviewSnapshot(t.db, "Alex", now);
    const r = await generateReport(t.runtime, "briefing", now);

    // Zahlen: 1 läuft, 2 warten (Sub-Agent zählt nicht), 1 abgestürzt (die 33 Tage alte nicht), 1 ruht.
    expect(ov.counts).toMatchObject({ running: 1, waiting: 2, crashed: 1, idle: 1 });
    expect(r.snapshot?.counts).toEqual(ov.counts);
    expect(r.snapshot?.fingerprint).toBe(ov.fingerprint);
    expect(r.lage).toBe(ov.lage);
    expect(ov.lage).toBe("1 Session läuft, 2 warten auf dich, 1 ist abgestürzt.");
    expect(r.snapshot?.needsYouCount).toBe(r.needsYou.length);
    expect(ov.needsYouCount).toBe(r.needsYou.length);

    // Kacheln
    expect(ov.metrics.find((m) => m.key === "sessions_waiting")?.value).toBe(ov.counts.waiting);
    expect(ov.metrics.find((m) => m.key === "sessions_open")?.value).toBe(ov.counts.running + ov.counts.waiting + ov.counts.idle);
    // Kritische Sessions = Abgestürzt + Wartet aus demselben Stand
    expect(ov.criticalSessions.filter((s) => s.reason === "abgestürzt")).toHaveLength(ov.counts.crashed);
    expect(ov.criticalSessions.filter((s) => s.reason.startsWith("wartet"))).toHaveLength(ov.counts.waiting);
    // „Braucht dich“
    expect(r.needsYou.filter((i) => i.kind === "session")).toHaveLength(ov.counts.waiting);
    expect(r.needsYou.filter((i) => i.kind === "crashed")).toHaveLength(ov.counts.crashed);
    expect(r.needsYou.filter((i) => i.kind === "build")).toHaveLength(1);
    // Sätze im Briefing: jede Zahl zu wartend/laufend/abgestürzt ist die aus dem Stand.
    const all = r.sections.flatMap((s) => s.statements.map((st) => st.text));
    const waitingLine = all.find((s) => /warten auf dich|wartet auf dich/.test(s)) ?? "";
    expect(nums(waitingLine)[0]).toBe(ov.counts.waiting);
    const crashLine = all.find((s) => /abgestürzt/.test(s)) ?? "";
    expect(nums(crashLine)[0]).toBe(ov.counts.crashed);
    const runLine = all.find((s) => /läuft gerade|laufen gerade/.test(s)) ?? "";
    expect(nums(runLine)[0]).toBe(ov.counts.running);
    expect(all.some((s) => /Keine Abstürze/.test(s))).toBe(false);
    // Plural stimmt („1 Sessions“ war falsch).
    expect(all.join(" ")).not.toMatch(/\b1 Sessions\b/);

    // Ohne Motor: ehrlich gekennzeichnet, mit Grund.
    expect(r.mode).toBe("nur-daten");
    expect(r.modeReason).toBe("fake aus");
  });

  it("gespeicherter Bericht bleibt beim Stand seines Schnappschusses; „veraltet“, sobald sich etwas ändert; „Jetzt neu erstellen“ holt ihn auf den Stand", async () => {
    const engine = new FakeEngine(answer("x"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    await seed(t);
    await retickIdleStates(t.db, now.getTime());
    const first = await generateReport(t.runtime, "briefing", now);
    const fresh = await latestReport(t.db, "briefing", now);
    expect(fresh?.stale).toBe(false);
    // Sätze und Liste kommen aus DEMSELBEN gespeicherten Stand (nicht Liste live, Sätze alt).
    expect(fresh?.needsYou.map((i) => i.id)).toEqual(first.needsYou.map((i) => i.id));
    expect(fresh?.lage).toBe(first.lage);

    await t.db.update(sessions).set({ state: "waiting", turnOpen: false }).where(eq(sessions.id, "claude:r1"));
    const stale = await latestReport(t.db, "briefing", now);
    expect(stale?.stale).toBe(true);
    expect(stale?.lage).toBe(first.lage);
    expect(stale?.needsYou.map((i) => i.id)).toEqual(first.needsYou.map((i) => i.id));

    const res = await t.json("/api/haiku/report", { kind: "briefing" });
    expect(res.status).toBe(200);
    const { report } = (await res.json()) as { report: { id: number; lage: string } };
    expect(report.id).toBe(first.id + 1);
    expect(report.lage).toBe("Keine Session läuft, 3 warten auf dich, 1 ist abgestürzt.");
    const after = (await (await t.app.request("/api/haiku/report?kind=briefing")).json()) as { report: { stale: boolean; lage: string } };
    expect(after.report.stale).toBe(false);
    const ov = (await (await t.app.request("/api/overview")).json()) as { lage: string };
    expect(after.report.lage).toBe(ov.lage);
  });

  it("Haikus Zahlen werden geprüft: falsche Zahl → einmal neu schreiben lassen, dann gilt der neue Satz", async () => {
    const engine = new FakeEngine(async function* (req) {
      const facts = JSON.parse(req.prompt.split("Fakten:\n")[1]?.split("\nOffene Punkte")[0] ?? "[]") as { id: string; text: string }[];
      const w = facts.find((f) => /warten auf dich/.test(f.text));
      const retry = /stimmen nicht mit den Fakten/.test(req.prompt);
      const text = retry ? "2 Sessions warten auf dich." : "5 Sessions warten auf dich.";
      yield* answer(JSON.stringify({ saetze: [{ abschnitt: "Was wartet", text, fakten: [w?.id] }] }))(req);
    });
    const t = await setupAssistant({ engine });
    await seed(t);
    await retickIdleStates(t.db, now.getTime());
    const r = await generateReport(t.runtime, "briefing", now);
    expect(engine.requests).toHaveLength(2);
    const all = r.sections.flatMap((s) => s.statements);
    expect(all.some((s) => s.author === "haiku" && s.text === "2 Sessions warten auf dich.")).toBe(true);
    expect(all.some((s) => s.text.includes("5 Sessions"))).toBe(false);
    expect(r.mode).toBe("ok");
  });

  it("bleibt die Zahl falsch, steht der Satz aus den Daten da — markiert als korrigiert", async () => {
    const engine = new FakeEngine(async function* (req) {
      const facts = JSON.parse(req.prompt.split("Fakten:\n")[1]?.split("\nOffene Punkte")[0] ?? "[]") as { id: string; text: string }[];
      const w = facts.find((f) => /warten auf dich/.test(f.text));
      yield* answer(JSON.stringify({ saetze: [{ abschnitt: "Was wartet", text: "7 Sessions warten auf dich.", fakten: [w?.id] }] }))(req);
    });
    const t = await setupAssistant({ engine });
    await seed(t);
    await retickIdleStates(t.db, now.getTime());
    const r = await generateReport(t.runtime, "briefing", now);
    const all = r.sections.flatMap((s) => s.statements);
    expect(all.some((s) => s.text.includes("7 Sessions"))).toBe(false);
    const fixed = all.find((s) => /warten auf dich/.test(s.text));
    expect(fixed?.author).toBe("regeln");
    expect(fixed?.corrected).toBe(true);
    expect(nums(fixed?.text ?? "")[0]).toBe(2);
  });
});

describe("mehr echte Daten im Überblick", () => {
  it("Tokens heute/7 Tage mit Trend, Builds (gebündelt, offen rot), Konflikt-Trend, zuletzt fertig — alles echt und verlinkt", async () => {
    const t = await setupAssistant();
    await seed(t);
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
    const lastWeek = new Date(now.getTime() - 9 * DAY).toISOString().slice(0, 10);
    await t.db.insert(usageDaily).values([
      { day: today, tool: "claude", model: "claude-opus-5-5", project: "shop", totalTokens: 3_000_000 },
      { day: today, tool: "codex", model: "gpt-5", project: "andere", totalTokens: 1_000_000 },
      { day: yesterday, tool: "claude", model: "claude-opus-5-5", project: "shop", totalTokens: 2_000_000 },
      { day: lastWeek, tool: "claude", model: "claude-opus-5-5", project: "shop", totalTokens: 10_000_000 },
    ]);
    await t.db.insert(conflictEvents).values([
      { kind: "kollision", folder: "/wt", path: "/a", detectedAt: ago(1 * DAY) },
      { kind: "kollision", folder: "/wt", path: "/b", detectedAt: ago(2 * DAY) },
      { kind: "kollision", folder: "/wt", path: "/c", detectedAt: ago(9 * DAY) },
    ]);
    const done = await createEntry(t.db, { kind: "bug", title: "Login-Absturz behoben", source: "manual" });
    await t.db.update(entries).set({ stage: "erledigt", updatedAt: ago(10 * MIN) }).where(eq(entries.id, done.id));

    const ov = await getOverviewSnapshot(t.db, "Alex", now);
    const tokensToday = ov.metrics.find((m) => m.key === "tokens_today");
    expect(tokensToday).toMatchObject({ value: 4_000_000, format: "tokens", href: "/usage", placeholder: false });
    // der Tages-Trend vergleicht mit gestern bis zur gleichen Uhrzeit (usage_events, s. unsaved-count-day-trend.test.ts),
    // nie mehr mit dem ganzen Vortag aus usage_daily (vorher „▼ 99 %“ kurz nach Mitternacht).
    expect(tokensToday?.trend?.previous ?? 0).not.toBe(2_000_000);
    expect(tokensToday?.sparkline).toHaveLength(14);
    const week = ov.metrics.find((m) => m.key === "tokens_7d");
    expect(week).toMatchObject({ value: 6_000_000, href: "/usage" });
    expect(week?.trend).toMatchObject({ current: 6_000_000, previous: 10_000_000, upIsGood: null });
    const builds = ov.metrics.find((m) => m.key === "builds_red");
    expect(builds).toMatchObject({ value: 1, href: "/server", captionTone: "bad" });
    expect(builds?.caption).toContain("NyxOS"); // Anzeigename, `kind` bleibt „nyxos“
    const conflicts = ov.metrics.find((m) => m.key === "conflicts");
    // kein Abzeichen mehr — „neue Kollisionen 7 T“ ist nicht die Größe der großen Zahl (aktive Konflikte).
    expect(conflicts?.trend).toBeNull();
    expect(conflicts?.sparkline.slice(-7).reduce((a, b) => a + b, 0)).toBe(2);
    expect(ov.metrics.every((m) => !m.placeholder)).toBe(true);

    expect(ov.recentDone.map((d) => d.title)).toEqual(["Login-Absturz behoben", "Fertige Session Login"]);
    expect(ov.recentDone[0]).toMatchObject({ kind: "entry", href: `/tasks?e=${done.id}` });
    expect(ov.recentDone[1]).toMatchObject({ kind: "session", href: "/sessions/coding/app/e1" });
  });
});

describe("Build-Wächter: grüner Lauf räumt auf, nach Reparatur wieder Push", () => {
  const job = (cwd: string): BuildJob => ({ sessionKey: null, kind: "nyxos", command: ["pnpm", "-r", "typecheck"], cwd, trigger: "manual" });

  it("Ordner wird gespeichert; roter Build verschwindet aus „Braucht dich“, sobald derselbe Ordner grün ist; anderer Ordner bleibt", async () => {
    const t = await setupAssistant();
    const outcomes = [2, 2, 0];
    let i = 0;
    const runner: BuildRunner = { run: async () => ({ exitCode: outcomes[i++] ?? 0, log: "src/x.ts(1,1): error TS2322: kaputt" }) };
    const queue = new BuildQueue(t.db, runner);
    for (const cwd of ["/wt/a", "/wt/b", "/wt/a"]) {
      const id = await queue.submit(job(cwd));
      await queue.waitFor(id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const rows = await t.db.select({ folder: buildRuns.folder, status: buildRuns.status }).from(buildRuns).orderBy(buildRuns.id);
    expect(rows).toEqual([
      { folder: "/wt/a", status: "red" },
      { folder: "/wt/b", status: "red" },
      { folder: "/wt/a", status: "green" },
    ]);
    const snap = await takeSnapshot(t.db, new Date());
    const build = snap.needsYou.filter((n) => n.kind === "build");
    expect(build).toHaveLength(1);
    expect(build[0]?.count).toBe(1); // nur noch /wt/b
    const ov = await getOverviewSnapshot(t.db, "Alex", new Date());
    expect(ov.metrics.find((m) => m.key === "builds_red")?.value).toBe(1);
  });

  it("rot → Push; grün im selben Ordner; wieder rot → erneut Push", async () => {
    const t = await setupAssistant();
    const sender = new FakeNtfySender();
    const settings = { ...(await loadOrInitSettings(t.db)), quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 };
    const send = async (input: PushNotifyInput) => notify(input, { db: t.db, sender, settings });
    const outcomes = [2, 2, 0, 2];
    let i = 0;
    const runner: BuildRunner = { run: async () => ({ exitCode: outcomes[i++] ?? 0, log: "src/x.ts(1,1): error TS2322: kaputt" }) };
    const queue = new BuildQueue(t.db, runner, (e) => notifyBuildDone(t.db, e, send));
    for (let n = 0; n < outcomes.length; n++) {
      const id = await queue.submit(job("/wt/a"));
      await queue.waitFor(id);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(sender.sent).toHaveLength(2);
    const log = await t.db.select().from(pushLog).where(eq(pushLog.kind, "build_red")).orderBy(pushLog.id);
    expect(log.map((l) => l.bundledCount)).toEqual([2, 1]);
  });
});
