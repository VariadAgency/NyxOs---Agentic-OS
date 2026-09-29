// Nutzung, Grenzfälle:
// 1. Überblick: „Tokens heute“, „Haiku heute“ und die Sparklines bauten ihre Tage aus UTC, `usage_daily.day`
//    und `haiku.day` sind aber Berliner Tage → zwischen 0 und 2 Uhr stand „heute“ auf dem Vortag.
// 2. Ziel schon erreicht: `reachDay` war immer „heute“, auch wenn das Ziel vor Tagen fiel.
// 3. Warnschwellen: das Blatt „Nutzung einstellen“ schickt beim Speichern IMMER alle Felder mit — jede
//    Änderung (z. B. nur der Standard-Zeitraum) setzte den Warn-Stand zurück → sofort erneuter Push.
// 4. Haiku-Zahlenprüfung: „1,5 Mrd.“ ging als Zahl „1,5“ durch, obwohl der Fakt „1,5 Mio.“ sagt.
import { describe, expect, it } from "vitest";
import { haikuCalls, usageSettings } from "../src/db/schema.js";
import { validateStatement, type Fact } from "../src/haiku/report.js";
import { getOverviewSnapshot } from "../src/overview/aggregate.js";
import { patchSettings } from "../src/push/settings.js";
import { getGoalStatus } from "../src/usage/goals.js";
import { localMidnight } from "../src/usage/periods.js";
import { loadUsageSettings, patchUsageSettings } from "../src/usage/settings.js";
import { checkUsageWarnings } from "../src/usage/warnings.js";
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
const berlin = (day: string, hh = 0, mm = 0) => new Date(localMidnight(day).getTime() + (hh * 60 + mm) * 60_000);

describe("Überblick zählt Berliner Tage", () => {
  it("00:30 Uhr Berliner Zeit (UTC noch Vortag): Tokens und Haiku von heute stehen unter „heute“", async () => {
    const { db, post } = await setup();
    const now = berlin("2026-09-25", 0, 45); // = 2026-09-24T22:45Z
    await post("/ingest/usage", {
      items: [row({ ts: berlin("2026-09-25", 0, 30).toISOString(), input: 700 }), row({ ts: berlin("2026-09-24", 23, 0).toISOString(), input: 40 })],
    });
    await db.insert(haikuCalls).values({ kind: "briefing", engine: "cli", status: "done", createdAt: berlin("2026-09-25", 0, 10).toISOString() });
    const snap = await getOverviewSnapshot(db, "Alex", now);
    const today = snap.metrics.find((m) => m.key === "tokens_today");
    expect(today?.value).toBe(700);
    // vor 06:00 kein Tages-Trend (00:45 gegen 00:45 sagt nichts, gegen den ganzen Vortag wäre es falsch).
    expect(today?.trend).toBeNull();
    expect(today?.sparkline.at(-1)).toBe(700);
    const haiku = snap.metrics.find((m) => m.key === "haiku_briefing");
    expect(haiku?.value).toBe(1);
    expect(snap.commits.at(-1)?.date).toBe("2026-09-25");
  });
});

describe("Ziel schon erreicht", () => {
  it("nennt den Tag, an dem das Ziel wirklich erreicht wurde, nicht „heute“", async () => {
    const { db, post } = await setup();
    const now = berlin("2026-09-23", 15);
    await post("/ingest/usage", {
      items: [
        row({ ts: berlin("2026-09-02", 10).toISOString(), input: 600 }),
        row({ ts: berlin("2026-09-05", 10).toISOString(), input: 500 }), // hier fällt die 1000
        row({ ts: berlin("2026-09-20", 10).toISOString(), input: 100 }),
      ],
    });
    await patchUsageSettings(db, { goalMonthTokens: 1000 });
    const status = await getGoalStatus(db, await loadUsageSettings(db), now);
    expect(status.month?.soFar).toBe(1200);
    expect(status.month?.reachDay).toBe("2026-09-05");
  });
});

describe("Warnschwellen bleiben ruhig, wenn sie sich nicht ändern", () => {
  it("Speichern mit denselben Schwellen (Blatt schickt alle Felder) löst keinen zweiten Push aus", async () => {
    const { db, post } = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    await patchUsageSettings(db, { warnDailyTokens: 100, warnWindowPct: null });
    await post("/ingest/usage", { items: [row({ input: 150 })] });
    const now = new Date();
    expect(await checkUsageWarnings(db, sender, push, now)).toEqual(["daily"]);
    // der Nutzer ändert nur den Standard-Zeitraum; das Blatt schickt die Schwellen unverändert mit.
    await patchUsageSettings(db, { defaultRange: "7", warnDailyTokens: 100, warnWindowPct: null, goalMonthTokens: null });
    expect(await checkUsageWarnings(db, sender, push, new Date(now.getTime() + 60_000))).toEqual([]);
    expect(sender.sent).toHaveLength(1);
    // Eine wirklich geänderte Schwelle darf sofort wieder warnen.
    await patchUsageSettings(db, { warnDailyTokens: 120 });
    const [r] = await db.select().from(usageSettings);
    expect(r?.warnState).toEqual({});
  });
});

describe("Warn-Push bei Claude sagt ehrlich, woran gemessen wird", () => {
  it("ohne echte Werte gar keine Fenster-Mitteilung (früher „nahe deiner Spitze“)", async () => {
    const { db, post } = await setup();
    const sender = new FakeNtfySender();
    const push = await patchSettings(db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
    await patchUsageSettings(db, { warnWindowPct: 80 });
    await post("/ingest/usage", { items: [row({ input: 500 })] });
    expect(await checkUsageWarnings(db, sender, push)).toEqual([]);
    expect(sender.sent).toHaveLength(0);
  });
});

describe("Haiku-Zahlenprüfung kennt Mio./Mrd.", () => {
  const facts: Fact[] = [{ id: "f1", section: "Nutzung", text: "Alle heute aktiven Sessions zusammen: 1,5 Mio. Tokens seit ihrem Start (nicht nur heute).", sources: [] }];
  it("falsche Größenordnung wird abgelehnt", () => {
    expect(validateStatement("Heute liefen 1,5 Mrd. Tokens.", ["f1"], facts).ok).toBe(false);
    expect(validateStatement("Heute liefen 1,5 Milliarden Tokens.", ["f1"], facts).ok).toBe(false);
  });
  it("gleiche Größenordnung, anders geschrieben, bleibt erlaubt", () => {
    expect(validateStatement("Heute liefen 1,5 Mio. Tokens.", ["f1"], facts).ok).toBe(true);
    expect(validateStatement("Heute liefen 1,5 Millionen Tokens.", ["f1"], facts).ok).toBe(true);
    expect(validateStatement("Heute liefen 1,5 Mio Tokens.", ["f1"], facts).ok).toBe(true);
  });
});
