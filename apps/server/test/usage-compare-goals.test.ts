// Nutzung — Vergleiche (Woche/Woche, Monat/Monat, Modelle, Claude/Codex, Baustellen), Ziele mit
// Hochrechnung, Einstellungen (Standard-Zeitraum, Ziele, Warnschwellen) und Warn-Push.
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { getUsageComparison, getBaustellenUsage, getModelTrend } from "../src/usage/compare.js";
import { projectGoal, getGoalStatus } from "../src/usage/goals.js";
import { localDay, localMidnight, comparisonWindows, deltaPct } from "../src/usage/periods.js";
import { loadUsageSettings, patchUsageSettings } from "../src/usage/settings.js";
import { checkUsageWarnings } from "../src/usage/warnings.js";
import { loadOrInitSettings, patchSettings } from "../src/push/settings.js";
import { FakeNtfySender } from "./automation/fakes.js";
import { setup } from "./helpers.js";

const row = (over: Record<string, unknown> = {}) => ({
  ts: new Date().toISOString(),
  tool: "claude",
  model: "claude-opus-5",
  project: "andere",
  sessionKey: null,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  reasoning: 0,
  ...over,
});

/** Berliner Ortszeit → Zeitpunkt (Sommerzeit/Winterzeit richtig). */
const berlin = (day: string, hh = 0, mm = 0) => new Date(localMidnight(day).getTime() + (hh * 60 + mm) * 60_000);

describe("Zeiträume (Berliner Zeit) und Woche/Woche, Monat/Monat", () => {
  it("localDay/localMidnight: 22:30 UTC im Sommer ist schon der nächste Berliner Tag", () => {
    expect(localDay(new Date("2026-09-20T22:30:00Z"))).toBe("2026-09-21");
    expect(localMidnight("2026-09-21").toISOString()).toBe("2026-09-20T22:00:00.000Z");
    expect(localMidnight("2026-12-01").toISOString()).toBe("2026-11-30T23:00:00.000Z");
  });

  it("Mittwoch 15:00: diese Woche ab Montag, Vorwoche Montag bis Mittwoch 15:00 (gleicher Stand)", () => {
    const w = comparisonWindows("week", berlin("2026-09-23", 15));
    expect(w.current.fromDay).toBe("2026-09-21");
    expect(w.current.toDay).toBe("2026-09-23");
    expect(w.current.start.toISOString()).toBe(localMidnight("2026-09-21").toISOString());
    expect(w.previous.fromDay).toBe("2026-09-14");
    expect(w.previous.toDay).toBe("2026-09-16");
    expect(w.previous.end.toISOString()).toBe(berlin("2026-09-16", 15).toISOString());
    expect(w.previousFull.fromDay).toBe("2026-09-14");
    expect(w.previousFull.toDay).toBe("2026-09-20");
    expect(w.totalDays).toBe(7);
  });

  it("Montag 00:30 Berliner Zeit (Sonntag in UTC) gehört schon zur neuen Woche", () => {
    const w = comparisonWindows("week", new Date("2026-09-20T22:30:00Z"));
    expect(w.current.fromDay).toBe("2026-09-21");
    expect(w.previous.fromDay).toBe("2026-09-14");
    expect(w.previous.toDay).toBe("2026-09-14");
  });

  it("Sonntag 23:30 in der Nacht der Zeitumstellung (25-Std-Tag): Vorwoche endet spätestens um Mitternacht", () => {
    const now = berlin("2026-10-25", 23, 30); // 24,5 Std nach Mitternacht
    const w = comparisonWindows("week", now);
    expect(w.current.fromDay).toBe("2026-10-19");
    expect(w.previous.toDay).toBe("2026-10-18");
    expect(w.previous.end.getTime()).toBeLessThanOrEqual(localMidnight("2026-10-19").getTime());
  });

  it("31. März gegen Februar: Vormonat ist kürzer → ganzer Februar", () => {
    const w = comparisonWindows("month", berlin("2026-03-31", 12));
    expect(w.current.fromDay).toBe("2026-03-01");
    expect(w.previous.fromDay).toBe("2026-02-01");
    expect(w.previous.toDay).toBe("2026-02-28");
    expect(w.previous.end.toISOString()).toBe(localMidnight("2026-03-01").toISOString());
    expect(w.totalDays).toBe(31);
  });

  it("Januar gegen Dezember über den Jahreswechsel", () => {
    const w = comparisonWindows("month", berlin("2026-01-15", 9));
    expect(w.previous.fromDay).toBe("2025-12-01");
    expect(w.previous.toDay).toBe("2025-12-15");
    expect(w.previousFull.toDay).toBe("2025-12-31");
  });

  it("Veränderung in Prozent: ohne Vorwert keine Zahl (nicht ∞, nicht 100 %)", () => {
    expect(deltaPct(150, 100)).toBe(50);
    expect(deltaPct(50, 100)).toBe(-50);
    expect(deltaPct(10, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
  });
});

describe("Vergleiche aus echten Nutzungszeilen", () => {
  it("Woche/Woche zählt die Vorwoche nur bis zum gleichen Stand, die ganze Vorwoche extra", async () => {
    const { post, db } = await setup();
    const now = berlin("2026-09-23", 15);
    await post("/ingest/usage", {
      items: [
        row({ ts: berlin("2026-09-21", 10).toISOString(), input: 100 }),
        row({ ts: berlin("2026-09-23", 14).toISOString(), tool: "codex", model: "gpt-6", input: 50 }),
        row({ ts: berlin("2026-09-14", 10).toISOString(), tool: "codex", model: "gpt-6", input: 40 }),
        row({ ts: berlin("2026-09-16", 16).toISOString(), input: 1000 }), // nach dem „gleichen Stand“
        row({ ts: berlin("2026-09-13", 23, 59).toISOString(), input: 7 }), // Woche davor
      ],
    });
    const c = await getUsageComparison(db, now);
    expect(c.week.current.tokens).toBe(150);
    expect(c.week.current.byTool).toEqual({ claude: 100, codex: 50 });
    expect(c.week.previous.tokens).toBe(40);
    expect(c.week.previousFull.tokens).toBe(1040);
    expect(c.week.deltaPct).toBe(275);
    // Tagesreihe: 7 Plätze Mo–So; Zukunft der laufenden Woche ist null (keine 0, die wie „nichts“ aussieht).
    expect(c.week.series.current).toEqual([100, 0, 50, null, null, null, null]);
    expect(c.week.series.previous).toEqual([40, 0, 1000, 0, 0, 0, 0]);
    const claude = c.week.tools.find((t) => t.tool === "claude");
    expect(claude?.tokens).toBe(100);
    expect(claude?.previousTokens).toBe(0);
    expect(claude?.activeDays).toBe(1);
    expect(claude?.topModel).toBe("claude-opus-5");
    const codex = c.week.tools.find((t) => t.tool === "codex");
    expect(codex?.previousTokens).toBe(40);
    expect(codex?.deltaPct).toBe(25);
  });

  it("GET /api/usage/compare liefert Woche und Monat", async () => {
    const { app } = await setup();
    const res = await app.request("/api/usage/compare");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { week: { series: { current: unknown[] } }; month: { series: { current: unknown[] } } };
    expect(body.week.series.current).toHaveLength(7);
    expect(body.month.series.current.length).toBeGreaterThanOrEqual(28);
  });

  it("Modelle im Verlauf: Tokens je Modell und Woche (Montag als Wochenbeginn)", async () => {
    const { post, db } = await setup();
    const now = berlin("2026-09-23", 15);
    await post("/ingest/usage", {
      items: [
        row({ ts: berlin("2026-09-21", 10).toISOString(), input: 100 }),
        row({ ts: berlin("2026-09-15", 10).toISOString(), model: "claude-sonnet-5", input: 30 }),
        row({ ts: berlin("2026-09-14", 1).toISOString(), tool: "codex", model: "gpt-6", input: 20 }),
      ],
    });
    const t = await getModelTrend(db, 3, now);
    expect(t.weeks).toEqual(["2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(t.models.find((m) => m.model === "claude-opus-5")?.tokens).toEqual([0, 0, 100]);
    expect(t.models.find((m) => m.model === "claude-sonnet-5")?.tokens).toEqual([0, 30, 0]);
    expect(t.models.find((m) => m.model === "gpt-6")?.tool).toBe("codex");
  });

  it("pro Baustelle: Tokens über die Session der Zeile, sortiert, fremde Projekte nur als Summe", async () => {
    const { post, db } = await setup();
    await db.insert(sessions).values([
      { id: "claude:a", tool: "claude", sessionId: "a", categoryArt: "coding", categoryBaustelleSlug: "heatmap", categoryBaustelleLabel: "Heatmap" },
      { id: "codex:b", tool: "codex", sessionId: "b", categoryArt: "coding", categoryBaustelleSlug: "heatmap", categoryBaustelleLabel: "Heatmap" },
      { id: "claude:c", tool: "claude", sessionId: "c", categoryArt: "audit", categoryBaustelleSlug: "nyxos", categoryBaustelleLabel: "NyxOS" },
      { id: "claude:d", tool: "claude", sessionId: "d" },
    ]);
    await post("/ingest/usage", {
      items: [
        row({ project: "shop", sessionKey: "claude:a", input: 100 }),
        row({ project: "shop", sessionKey: "codex:b", tool: "codex", model: "gpt-6", input: 60 }),
        row({ project: "shop", sessionKey: "claude:c", input: 500 }),
        row({ project: "shop", sessionKey: "claude:d", input: 9 }),
        row({ project: "andere", input: 1000 }),
        row({ project: "shop", sessionKey: "claude:a", input: 77, ts: new Date(Date.now() - 40 * 86_400_000).toISOString() }),
      ],
    });
    const b = await getBaustellenUsage(db, "30");
    expect(b.items.map((i) => [i.slug, i.tokens])).toEqual([
      ["nyxos", 500],
      ["heatmap", 160],
    ]);
    const heat = b.items.find((i) => i.slug === "heatmap");
    expect(heat).toMatchObject({ label: "Heatmap", art: "coding", claude: 100, codex: 60, sessions: 2 });
    expect(b.ohneBaustelle).toBe(9);
    expect(b.andere).toBe(1000);
  });
});

describe("Ziel-Hochrechnung", () => {
  const monthEnd = localMidnight("2026-10-01");

  it("hochgerechnet nach dem Tempo der letzten 7 Tage: schafft es nicht", () => {
    const now = berlin("2026-09-16", 0); // 15 Tage Rest
    const p = projectGoal({ target: 10e9, soFar: 4e9, pacePerDay: 0.3e9, now, periodEnd: monthEnd });
    expect(p.remainingDays).toBeCloseTo(15, 5);
    expect(p.projected).toBeCloseTo(8.5e9, -3);
    expect(p.onTrack).toBe(false);
    expect(p.neededPerDay).toBeCloseTo(0.4e9, -3);
    expect(p.pct).toBeCloseTo(40, 5);
    expect(p.reachDay).toBeNull();
  });

  it("schafft es: Tag, an dem das Ziel beim aktuellen Tempo erreicht ist", () => {
    const now = berlin("2026-09-11", 0); // 20 Tage Rest
    const p = projectGoal({ target: 10e9, soFar: 4e9, pacePerDay: 0.5e9, now, periodEnd: monthEnd });
    expect(p.onTrack).toBe(true);
    expect(p.reachDay).toBe("2026-09-23");
  });

  it("schon erreicht: ja, nichts mehr nötig", () => {
    const p = projectGoal({ target: 1000, soFar: 1200, pacePerDay: 0, now: berlin("2026-09-20", 8), periodEnd: monthEnd });
    expect(p.onTrack).toBe(true);
    expect(p.neededPerDay).toBe(0);
    expect(p.reachDay).toBe("2026-09-20");
    expect(p.pct).toBe(120);
  });

  it("ohne Tempo: Hochrechnung = bisher, kein Zieltag", () => {
    const p = projectGoal({ target: 1000, soFar: 100, pacePerDay: 0, now: berlin("2026-09-20", 8), periodEnd: monthEnd });
    expect(p.projected).toBe(100);
    expect(p.onTrack).toBe(false);
    expect(p.reachDay).toBeNull();
  });

  it("GET /api/usage/goals rechnet mit dem Werkzeug-Filter des Ziels", async () => {
    const { post, db, app } = await setup();
    await post("/ingest/usage", { items: [row({ input: 300 }), row({ tool: "codex", model: "gpt-6", input: 700 })] });
    expect((await app.request("/api/usage/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ goalMonthTokens: 10_000, goalScope: "codex" }) })).status).toBe(200);
    const status = await getGoalStatus(db, await loadUsageSettings(db), new Date());
    expect(status.month?.soFar).toBe(700);
    expect(status.week).toBeNull();
    const res = (await (await app.request("/api/usage/goals")).json()) as { month: { target: number; soFar: number } | null };
    expect(res.month).toMatchObject({ target: 10_000, soFar: 700 });
  });
});

describe("Einstellungen speichern und prüfen", () => {
  it("Standardwerte beim ersten Lesen, Änderungen bleiben gespeichert", async () => {
    const { app, db } = await setup();
    const first = (await (await app.request("/api/usage/settings")).json()) as Record<string, unknown>;
    expect(first).toEqual({ defaultRange: "30", goalScope: "all", goalMonthTokens: null, goalWeekTokens: null, warnWindowPct: null, warnDailyTokens: null });
    const res = await app.request("/api/usage/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultRange: "7", goalMonthTokens: 10_000_000_000, warnWindowPct: 80, warnDailyTokens: 500_000_000 }),
    });
    expect(res.status).toBe(200);
    const saved = await loadUsageSettings(db);
    expect(saved).toMatchObject({ defaultRange: "7", goalMonthTokens: 10_000_000_000, warnWindowPct: 80, warnDailyTokens: 500_000_000, goalWeekTokens: null });
    // Einzelnes Feld zurücksetzen (null = aus), der Rest bleibt.
    await app.request("/api/usage/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ warnWindowPct: null }) });
    expect(await loadUsageSettings(db)).toMatchObject({ warnWindowPct: null, defaultRange: "7" });
  });

  it.each([
    [{ warnWindowPct: 150 }],
    [{ warnWindowPct: 0 }],
    [{ goalMonthTokens: -5 }],
    [{ goalMonthTokens: 1.5 }],
    [{ defaultRange: "90" }],
    [{ goalScope: "gemini" }],
    [{ unbekannt: 1 }],
  ])("ungültig → 400 mit verständlicher Meldung: %j", async (body) => {
    const { app } = await setup();
    const res = await app.request("/api/usage/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Einstellung/);
  });

  it("ohne Anmeldung nicht änderbar", async () => {
    const { app, db } = await setup({ signedIn: false });
    const res = await app.request("/api/usage/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultRange: "7" }) });
    expect([401, 403]).toContain(res.status);
    expect((await loadUsageSettings(db)).defaultRange).toBe("30");
  });
});

describe("Warnschwellen → Push", () => {
  it("Tagesverbrauch über der Schwelle: genau eine Mitteilung pro Tag", async () => {
    const { post, db } = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    await patchUsageSettings(db, { warnDailyTokens: 100 });
    await post("/ingest/usage", { items: [row({ input: 150 })] });
    const now = new Date();
    expect(await checkUsageWarnings(db, sender, push, now)).toEqual(["daily"]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.title).toMatch(/Nutzung/);
    expect(sender.sent[0]?.clickUrl).toContain("/usage");
    expect(await checkUsageWarnings(db, sender, push, new Date(now.getTime() + 60_000))).toEqual([]);
    expect(sender.sent).toHaveLength(1);
  });

  it("unter der Schwelle oder ohne Schwelle: keine Mitteilung", async () => {
    const { post, db } = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00" });
    await post("/ingest/usage", { items: [row({ input: 50 })] });
    expect(await checkUsageWarnings(db, sender, push)).toEqual([]);
    await patchUsageSettings(db, { warnDailyTokens: 100 });
    expect(await checkUsageWarnings(db, sender, push)).toEqual([]);
    expect(sender.sent).toHaveLength(0);
  });

  it("5-Std-Fenster: Codex meldet Prozent selbst → Warnung ab der Schwelle, danach 5 Std Ruhe", async () => {
    const { post, db } = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    await patchUsageSettings(db, { warnWindowPct: 80 });
    await db.insert(sessions).values({ id: "codex:x", tool: "codex", sessionId: "x", lastActivityAt: new Date().toISOString(), limits: { primary: { used_percent: 85, window_minutes: 300 } } });
    await post("/ingest/usage", { items: [row({ tool: "codex", model: "gpt-6", input: 10 })] });
    const now = new Date();
    // Codex-Prozent ist ein echter Wert → Warnung „Sitzung 85 % belegt“ (ohne Reset-Zeit: 5 Std Ruhe).
    expect(await checkUsageWarnings(db, sender, push, now)).toEqual(["high:codex:5h"]);
    expect(sender.sent[0]?.message).toMatch(/Codex: Sitzung 85 % belegt/);
    expect(await checkUsageWarnings(db, sender, push, new Date(now.getTime() + 2 * 3_600_000))).toEqual([]);
    expect(await checkUsageWarnings(db, sender, push, new Date(now.getTime() + 6 * 3_600_000))).toEqual(["high:codex:5h"]);
  });

  it("Anlass in den Push-Einstellungen abgeschaltet → nichts gesendet", async () => {
    const { post, db } = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00", enabledKinds: { usage_warning: false } });
    await patchUsageSettings(db, { warnDailyTokens: 100 });
    await post("/ingest/usage", { items: [row({ input: 150 })] });
    await checkUsageWarnings(db, sender, push);
    expect(sender.sent).toHaveLength(0);
    expect((await loadOrInitSettings(db)).enabledKinds.usage_warning).toBe(false);
  });

  it("der 60-s-Ticker der App prüft die Warnschwellen mit", async () => {
    const sender = new FakeNtfySender();
    const { post, db, tickStates } = await setup({ pushSender: sender });
    await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00" });
    await patchUsageSettings(db, { warnDailyTokens: 100 });
    await post("/ingest/usage", { items: [row({ input: 150 })] });
    await tickStates();
    expect(sender.sent.some((m) => /Nutzung/.test(m.title))).toBe(true);
  });
});

describe("Berliner Tagesgrenzen im Nutzungs-Code", () => {
  it("„7 Tage“ bei den Modellen = heute + 6 Tage davor (wie der Verlauf), nicht 8 Tage", async () => {
    const { post, app } = await setup();
    const today = localDay(new Date());
    const eightDaysAgo = new Date(localMidnight(today).getTime() - 7 * 86_400_000 + 12 * 3_600_000);
    await post("/ingest/usage", { items: [row({ input: 5 }), row({ ts: eightDaysAgo.toISOString(), model: "claude-alt", input: 9 })] });
    const body = (await (await app.request("/api/usage/models?range=7")).json()) as { models: { model: string }[] };
    expect(body.models.map((m) => m.model)).toEqual(["claude-opus-5"]);
  });
});
