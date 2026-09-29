// Echte Claude-Limits über CodexBar (Brücke → Brücken-Kanal). Der OAuth-Weg scheitert live mit 403;
// CodexBar liefert die echten Anthropic-Werte. Der Server prüft die Berichte selbst (wie `parseUsageReport`)
// und nutzt sie für Anzeige und Warnungen wie die OAuth-Werte.
import type { UsageReadingsMsg } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { patchSettings } from "../src/push/settings.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { getForecasts } from "../src/usage/forecast.js";
import { CODEXBAR_FRESH_MS, UsageReadings, parseCodexBarReport, usageReadings } from "../src/usage/official.js";
import { getLimits } from "../src/usage/query.js";
import { getUsageWindows } from "../src/usage/window.js";
import { checkUsageWarnings } from "../src/usage/warnings.js";
import { FakeNtfySender } from "./automation/fakes.js";
import { setup } from "./helpers.js";

const NOW = new Date("2026-09-26T15:06:30Z"); // 17:06 Berliner Zeit
const iso = (d: Date | number) => new Date(d).toISOString();
const ago = (min: number) => iso(NOW.getTime() - min * 60_000);

/** Wie im echten Betrieb: Sitzung 9 % (Reset 20:29:59 Berlin), Woche 30 %. */
function msg(over: Partial<UsageReadingsMsg> = {}, fivePct = 9, at = ago(0.5)): UsageReadingsMsg {
  const five = { utilization: fivePct, resets_at: "2026-09-26T18:29:59.000Z", fetchedAt: at };
  return {
    op: "usage_readings",
    source: "codexbar",
    tool: "claude",
    fiveHour: five,
    sevenDay: { utilization: 30, resets_at: "2026-10-02T17:59:59.000Z", fetchedAt: at },
    sevenDayOpus: { utilization: 0, resets_at: null, fetchedAt: "2026-07-14T08:26:39.000Z" }, // uralt → verwerfen
    sevenDaySonnet: null,
    sessionHistory: [{ utilization: Math.max(0, fivePct - 3), resets_at: five.resets_at, fetchedAt: ago(60.5) }, five],
    ...over,
  };
}

describe("CodexBar-Bericht prüfen (wie parseUsageReport)", () => {
  it("gültiger Bericht → Werte im OAuth-Format mit Quelle „codexbar“; uraltes Modell-Fenster fällt weg", () => {
    const r = parseCodexBarReport(msg(), NOW);
    expect(r?.usage).toEqual({
      fiveHour: { pct: 9, resetsAt: "2026-09-26T18:29:59.000Z" },
      sevenDay: { pct: 30, resetsAt: "2026-10-02T17:59:59.000Z" },
      sevenDayOpus: null,
      sevenDaySonnet: null,
      fetchedAt: ago(0.5),
      source: "codexbar",
    });
    expect(r?.history.map((h) => h.pct)).toEqual([6, 9]);
  });

  it("unplausibel → verworfen: Prozent außerhalb 0–100, Zeit aus der Zukunft, Reset > 8 Tage, kein Fenster, falscher Aufbau", () => {
    const five = msg().fiveHour;
    if (!five) throw new Error("Testdaten");
    expect(parseCodexBarReport(msg({ fiveHour: { ...five, utilization: 120 } }), NOW)).toBeNull();
    expect(parseCodexBarReport(msg({ fiveHour: { ...five, utilization: -1 } }), NOW)).toBeNull();
    expect(parseCodexBarReport(msg({ fiveHour: { ...five, fetchedAt: iso(NOW.getTime() + 3 * 60_000) } }), NOW)).toBeNull();
    expect(parseCodexBarReport(msg({ fiveHour: { ...five, fetchedAt: "kaputt" } }), NOW)).toBeNull();
    expect(parseCodexBarReport(msg({ sevenDay: { utilization: 30, resets_at: iso(NOW.getTime() + 9 * 24 * 3_600_000), fetchedAt: five.fetchedAt } }), NOW)).toBeNull();
    expect(parseCodexBarReport(msg({ fiveHour: null, sevenDay: null }), NOW)).toBeNull();
    expect(parseCodexBarReport({ ...msg(), op: "usage" }, NOW)).toBeNull();
    expect(parseCodexBarReport({ ...msg(), fiveHour: { utilization: "9" } }, NOW)).toBeNull();
    // unplausible Verlaufspunkte fallen einzeln weg, der Bericht bleibt
    const r = parseCodexBarReport(msg({ sessionHistory: [{ ...five, utilization: 400 }, five] }), NOW);
    expect(r?.history).toHaveLength(1);
  });

  it("älter als 20 Min → angenommen, aber nicht „aktuell“ (keine Anzeige als echt, keine Warnung)", () => {
    const store = new UsageReadings();
    const r = parseCodexBarReport(msg({}, 95, ago(25)), NOW);
    expect(r).not.toBeNull();
    if (r) store.recordCodexBar(r);
    expect(store.official(NOW)).toBeNull();
    expect(CODEXBAR_FRESH_MS).toBe(20 * 60_000);
  });

  it("Brücken-Kanal: die Nachricht „usage_readings“ landet geprüft im Speicher", () => {
    const store = new UsageReadings();
    const hub = new BridgeHub(undefined, undefined, undefined, (m) => {
      const r = parseCodexBarReport(m, NOW);
      if (r) store.recordCodexBar(r);
    });
    hub.handle(JSON.stringify(msg()));
    hub.handle(JSON.stringify({ ...msg(), fiveHour: { utilization: 999, resets_at: null, fetchedAt: ago(1) } }));
    expect(store.official(NOW)?.fiveHour?.pct).toBe(9);
    expect(store.official(NOW)?.source).toBe("codexbar");
  });
});

describe("CodexBar-Werte in Warnungen und Anzeige", () => {
  it("Sitzung 88 % → genau eine Mitteilung mit echter Reset-Zeit, Quelle CodexBar", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    const store = new UsageReadings();
    const r = parseCodexBarReport(msg({ sessionHistory: [] }, 88), NOW);
    if (r) store.recordCodexBar(r);
    expect(await checkUsageWarnings(t.db, sender, push, NOW, store)).toEqual(["high:claude:5h"]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.message).toMatch(/Sitzung 88 % belegt, Reset um 20:29/);
    expect(sender.sent[0]?.message).toMatch(/CodexBar/);
    expect(await checkUsageWarnings(t.db, sender, push, new Date(NOW.getTime() + 60_000), store)).toEqual([]);
  });

  it("Hochrechnung aus dem Sitzungs-Verlauf von CodexBar (zwei echte Punkte)", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    const store = new UsageReadings();
    const reset = "2026-09-26T18:29:59.000Z";
    const r = parseCodexBarReport(
      msg({ sessionHistory: [{ utilization: 50, resets_at: reset, fetchedAt: ago(10.5) }, { utilization: 70, resets_at: reset, fetchedAt: ago(0.5) }] }, 70),
      NOW,
    );
    if (r) store.recordCodexBar(r);
    expect(await checkUsageWarnings(t.db, sender, push, NOW, store)).toEqual(["forecast:claude:5h"]);
    expect(sender.sent[0]?.message).toMatch(/voll um 17:21/);
  });

  it("Nutzungs-Ansicht: Quelle „codexbar“ mit Stand; Hochrechnungs-Zeile nennt CodexBar", async () => {
    const t = await setup();
    const store = new UsageReadings();
    const r = parseCodexBarReport(msg(), NOW);
    if (r) store.recordCodexBar(r);
    const w = (await getUsageWindows(t.db, NOW, store)).find((x) => x.tool === "claude");
    expect(w?.reported).toMatchObject({ fiveHourPct: 9, weekPct: 30, resetsAt: "2026-09-26T18:29:59.000Z", source: "codexbar", fetchedAt: ago(0.5) });
    const f = await getForecasts(t.db, await getLimits(t.db), NOW, store);
    expect(f.find((x) => x.tool === "claude" && x.window === "5h")?.line).toMatch(/CodexBar/);
  });

  it("status(): ohne aktuelle echte Quelle der Grund des OAuth-Wegs, mit CodexBar „aktuell“", () => {
    const store = new UsageReadings();
    store.recordReport({ usage: null, error: "forbidden" }, NOW);
    expect(store.status(NOW)).toMatchObject({ fresh: false, source: null, error: "forbidden", errorText: expect.stringMatching(/Berechtigung/) });
    const r = parseCodexBarReport(msg(), NOW);
    if (r) store.recordCodexBar(r);
    expect(store.status(NOW)).toMatchObject({ fresh: true, source: "codexbar", error: null, errorText: null, codexbarAt: ago(0.5) });
    // eine spätere OAuth-Absage verdrängt die frischen CodexBar-Werte nicht
    store.recordReport({ usage: null, error: "forbidden" }, NOW);
    expect(store.official(NOW)?.source).toBe("codexbar");
  });

  it("API /api/usage/window: liefert den Status der echten Quelle mit (Grund sichtbar statt still)", async () => {
    const t = await setup();
    usageReadings.recordReport({ usage: null, error: "forbidden" });
    const res = await t.app.request("/api/usage/window");
    const body = (await res.json()) as { official: { fresh: boolean; errorText: string | null } };
    expect(body.official).toMatchObject({ fresh: false, errorText: expect.stringMatching(/Berechtigung/) });
    const r = parseCodexBarReport(msg({}, 9, iso(Date.now() - 30_000)));
    if (r) usageReadings.recordCodexBar(r);
    const res2 = await t.app.request("/api/usage/window");
    const body2 = (await res2.json()) as { official: { fresh: boolean; source: string | null } };
    expect(body2.official).toMatchObject({ fresh: true, source: "codexbar" });
  });
});
