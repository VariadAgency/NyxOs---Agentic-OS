// „Limit-Wecker“: Hochrechnung aus Tempo (letzte 30 Min) und Reset. Genau eine Mitteilung je Fenster über
// den vorhandenen Anlass `usage_warning` (Ruhezeiten, Anlass abschaltbar), ehrlich ohne Daten (keine Zahl, kein Fehler).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { patchSettings } from "../src/push/settings.js";
import { currentBlockStart, getForecasts } from "../src/usage/forecast.js";
import { getLimits } from "../src/usage/query.js";
import { UsageReadings } from "../src/usage/official.js";
import { checkUsageWarnings, forecastDue, forecastWindow, sameWindow } from "../src/usage/warnings.js";
import { FakeNtfySender } from "./automation/fakes.js";
import { setup } from "./helpers.js";

const NOW = new Date("2026-09-25T20:10:00Z"); // 22:10 Berliner Zeit
const at = (iso: string) => new Date(iso);

describe("forecastWindow (rein)", () => {
  it("Tempo 0: nie voll, alles Übrige bleibt frei", () => {
    expect(forecastWindow({ pct: 40, resetsAt: at("2026-09-25T21:00:00Z"), pacePctPerMin: 0, now: NOW })).toEqual({ hitsLimitAt: null, unusedAtReset: 60 });
  });

  it("knapp davor: voll 1 Min vor dem Reset", () => {
    // 50 Min bis Reset, 49 Min bis voll (49 × 1 % = 49 %)
    const r = forecastWindow({ pct: 51, resetsAt: at("2026-09-25T21:00:00Z"), pacePctPerMin: 1, now: NOW });
    expect(r.hitsLimitAt?.toISOString()).toBe("2026-09-25T20:59:00.000Z");
    expect(r.unusedAtReset).toBe(0);
  });

  it("knapp danach: reicht bis zum Reset, 1 % bleibt übrig", () => {
    const r = forecastWindow({ pct: 49, resetsAt: at("2026-09-25T21:00:00Z"), pacePctPerMin: 1, now: NOW });
    expect(r.hitsLimitAt).toBeNull();
    expect(r.unusedAtReset).toBeCloseTo(1, 5);
  });

  it("ohne Reset oder Füllstand: keine Aussage, kein Fehler", () => {
    expect(forecastWindow({ pct: 80, resetsAt: null, pacePctPerMin: 3, now: NOW })).toEqual({ hitsLimitAt: null, unusedAtReset: null });
    expect(forecastWindow({ pct: null, resetsAt: at("2026-09-25T21:00:00Z"), pacePctPerMin: 3, now: NOW })).toEqual({ hitsLimitAt: null, unusedAtReset: null });
  });

  it("Claude-Fenster beginnt mit der ersten Nachricht (volle Stunde) und endet 5 Std später", () => {
    const t = (iso: string) => ({ t: Date.parse(iso) });
    expect(currentBlockStart([t("2026-09-25T10:20:00Z"), t("2026-09-25T16:05:00Z"), t("2026-09-25T19:59:00Z")], NOW)?.toISOString()).toBe("2026-09-25T16:00:00.000Z");
    expect(currentBlockStart([t("2026-09-25T14:00:00Z")], NOW)).toBeNull(); // Fenster schon vorbei
  });
});

const row = (over: Record<string, unknown>) => ({ ts: NOW.toISOString(), tool: "claude", model: "claude-opus-5-5", project: "andere", sessionKey: null, input: 0, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, reasoning: 0, ...over });

/** Claude kam am 23.09. ans Limit (1.000 Tokens im Fenster davor). Heute läuft ein Fenster seit 18:00 Berlin (16:00 Z). */
async function claudeScenario(t: Awaited<ReturnType<typeof setup>>, recentTokens: number) {
  const lastReset = Date.parse("2026-09-23T18:40:00Z");
  await t.db.insert(sessions).values({ id: "claude:lim", tool: "claude", sessionId: "lim", lastActivityAt: "2026-09-23T17:00:00Z", limits: { status: "rejected", resetsAt: lastReset / 1000, rateLimitType: "five_hour" } });
  await t.post("/ingest/usage", {
    items: [
      row({ ts: "2026-09-23T15:00:00Z", input: 600 }),
      row({ ts: "2026-09-23T17:30:00Z", input: 400 }),
      // heute: 780 Tokens seit 16:05 Z, dazu `recentTokens` in den letzten 30 Min
      row({ ts: "2026-09-25T16:05:00Z", input: 500 }),
      row({ ts: "2026-09-25T18:00:00Z", input: 900 - 120 - 500 }),
      row({ ts: "2026-09-25T19:50:00Z", input: recentTokens }),
    ],
  });
}

describe("Hochrechnung aus echten Daten", () => {
  it("Claude: Füllstand gemessen am letzten Limit, Tempo der letzten 30 Min, Reset = Fensterbeginn + 5 Std", async () => {
    const t = await setup();
    await claudeScenario(t, 120);
    const f = await getForecasts(t.db, await getLimits(t.db), NOW);
    const c5 = f.find((x) => x.tool === "claude" && x.window === "5h");
    expect(c5).toMatchObject({ basis: "last_limit", resetsAt: "2026-09-25T21:00:00.000Z" });
    expect(c5?.pct).toBeCloseTo(90, 5);
    expect(c5?.pacePctPerMin).toBeCloseTo(0.4, 5); // 120 Tokens / 30 Min / 1.000
    expect(c5?.hitsLimitAt).toBe("2026-09-25T20:35:00.000Z");
    expect(c5?.line).toMatch(/voll um 22:35.*Reset erst 23:00/);
    // Woche und Codex: keine Daten → ehrlicher Satz, keine Zahl
    expect(f.find((x) => x.tool === "claude" && x.window === "week")).toMatchObject({ pct: null, hitsLimitAt: null });
    expect(f.find((x) => x.tool === "claude" && x.window === "week")?.line).toMatch(/keine Hochrechnung/);
    expect(f.find((x) => x.tool === "codex" && x.window === "5h")).toMatchObject({ pct: null, hitsLimitAt: null });
  });

  it("schon über dem gemessenen Limit, aber nicht gesperrt: keine Zahl statt falschem „voll“", async () => {
    const t = await setup();
    await claudeScenario(t, 400); // 1.180 Tokens > 1.000 gemessen
    const f = await getForecasts(t.db, await getLimits(t.db), NOW);
    const c5 = f.find((x) => x.tool === "claude" && x.window === "5h");
    expect(c5).toMatchObject({ pct: null, hitsLimitAt: null });
    expect(c5?.line).toMatch(/Keine sichere Hochrechnung/);
  });

  it("ohne je erreichtes Limit: keine Claude-Zahl, ehrlicher Satz", async () => {
    const t = await setup();
    await t.post("/ingest/usage", { items: [row({ ts: "2026-09-25T19:50:00Z", input: 500 })] });
    const f = await getForecasts(t.db, await getLimits(t.db), NOW);
    const c5 = f.find((x) => x.tool === "claude" && x.window === "5h");
    expect(c5).toMatchObject({ pct: null, hitsLimitAt: null });
    expect(c5?.line).toMatch(/Keine Hochrechnung/);
  });

  it("Codex getrennt: eigener Füllstand und Reset, Tempo aus dem gemeldeten Stand", async () => {
    const t = await setup();
    const reset = Date.parse("2026-09-25T21:10:00Z") / 1000;
    await t.db.insert(sessions).values({ id: "codex:x", tool: "codex", sessionId: "x", lastActivityAt: NOW.toISOString(), limits: { primary: { used_percent: 80, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: reset + 3 * 86400 } } });
    await t.post("/ingest/usage", { items: [row({ tool: "codex", model: "gpt-6", ts: "2026-09-25T17:00:00Z", input: 700 }), row({ tool: "codex", model: "gpt-6", ts: "2026-09-25T19:55:00Z", input: 300 })] });
    const f = await getForecasts(t.db, await getLimits(t.db), NOW);
    const x5 = f.find((x) => x.tool === "codex" && x.window === "5h");
    // 80 % bei 1.000 Tokens → 0,08 % je Token; 300 Tokens/30 Min = 10/Min → 0,8 %/Min → voll in 25 Min
    expect(x5).toMatchObject({ basis: "reported", pct: 80, hitsLimitAt: "2026-09-25T20:35:00.000Z" });
    // Woche: 20 % bei 1.000 Tokens → 0,2 %/Min → voll in 400 Min (vor dem Reset in 3 Tagen), aber noch kein Weckruf
    const xw = f.find((x) => x.tool === "codex" && x.window === "week");
    expect(xw).toMatchObject({ pct: 20, hitsLimitAt: "2026-09-26T02:50:00.000Z" });
    expect(forecastDue(xw as NonNullable<typeof xw>, NOW)).toBe(false);
    expect(forecastDue(x5 as NonNullable<typeof x5>, NOW)).toBe(true);
    // Claude bleibt davon unberührt
    expect(f.find((x) => x.tool === "claude" && x.window === "5h")?.pct).toBeNull();
  });
});

describe("Limit-Wecker → genau eine Mitteilung", () => {
  it("die Schätzung aus Token-Summen („in ~25 Min voll … zuletzt ans Limit“) schickt KEINE Mitteilung mehr", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    await claudeScenario(t, 120);
    expect(await checkUsageWarnings(t.db, sender, push, NOW, new UsageReadings())).toEqual([]);
    expect(sender.sent).toHaveLength(0);
  });

  it("gemächliches Tempo (reicht bis zum Reset) oder ohne Reset: keine Mitteilung, kein Fehler", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    await claudeScenario(t, 10);
    expect(await checkUsageWarnings(t.db, sender, push, NOW)).toEqual([]);
    const t2 = await setup();
    await t2.post("/ingest/usage", { items: [row({ ts: "2026-09-25T19:50:00Z", input: 5000 })] });
    expect(await checkUsageWarnings(t2.db, sender, await patchSettings(t2.db, { quietStart: "00:00", quietEnd: "00:00" }), NOW)).toEqual([]);
    expect(sender.sent).toHaveLength(0);
  });

  it("Codex meldet den Reset ein paar Sekunden anders → dasselbe Fenster, keine zweite Mitteilung", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    const readings = new UsageReadings();
    const reset = Date.parse("2026-09-25T21:10:00Z") / 1000;
    const limits = (pct: number, r: number) => ({ primary: { used_percent: pct, window_minutes: 300, resets_at: r }, secondary: null });
    await t.db.insert(sessions).values({ id: "codex:x", tool: "codex", sessionId: "x", lastActivityAt: NOW.toISOString(), limits: limits(60, reset) });
    // Tempo nur aus zwei echten Codex-Ständen (60 % → 80 % in 10 Min = 2 %/Min → voll in 10 Min, vor dem Reset)
    expect(await checkUsageWarnings(t.db, sender, push, NOW, readings)).toEqual([]);
    await t.db.update(sessions).set({ limits: limits(80, reset) }).where(eq(sessions.id, "codex:x"));
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect(await checkUsageWarnings(t.db, sender, push, later, readings)).toEqual(["forecast:codex:5h"]);
    expect(sender.sent[0]?.message).toMatch(/Codex: Sitzung 80 % belegt – bei diesem Tempo voll um 22:30, Reset um 23:10/);
    await t.db.update(sessions).set({ limits: limits(81, reset + 3) }).where(eq(sessions.id, "codex:x"));
    expect(await checkUsageWarnings(t.db, sender, push, new Date(later.getTime() + 60_000), readings)).toEqual([]);
    expect(sender.sent).toHaveLength(1);
    expect(sameWindow("2026-09-25T21:10:00.000Z", "2026-09-25T21:10:03.000Z")).toBe(true);
    expect(sameWindow("2026-09-25T21:10:00.000Z", "2026-09-26T02:10:00.000Z")).toBe(false);
    expect(sameWindow(undefined, "2026-09-25T21:10:00.000Z")).toBe(false);
  });

  it("Anlass abgeschaltet → nichts gesendet", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00", enabledKinds: { usage_warning: false } });
    await claudeScenario(t, 120);
    await checkUsageWarnings(t.db, sender, push, NOW);
    expect(sender.sent).toHaveLength(0);
  });
});
