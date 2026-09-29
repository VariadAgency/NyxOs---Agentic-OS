// Echte Claude-Limits statt Schätzung. Anlass: Push „in 25 Min voll, Reset erst 21:00 (gemessen an dem Fenster,
// in dem du zuletzt ans Limit kamst)“, obwohl Anthropic 5 % belegt meldete. Push nur noch auf echten Werten
// (OAuth-Nutzungs-Endpunkt, über den Agent-Container), ohne echte Werte KEINE Push-Warnung.
import { describe, expect, it, vi } from "vitest";
import { sessions } from "../src/db/schema.js";
import { RemoteEngine } from "../src/haiku/remoteEngine.js";
import { patchSettings } from "../src/push/settings.js";
import { getForecasts } from "../src/usage/forecast.js";
import { OAUTH_BETA_HEADER, OAUTH_USAGE_URL, UsageReadings, fetchOauthUsage, paceFromReadings, parseOauthUsage, startUsagePoller, type FetchLike } from "../src/usage/official.js";
import { getLimits } from "../src/usage/query.js";
import { getUsageWindows } from "../src/usage/window.js";
import { checkUsageWarnings } from "../src/usage/warnings.js";
import { FakeNtfySender } from "./automation/fakes.js";
import { setup } from "./helpers.js";

const NOW = new Date("2026-09-26T14:03:00Z"); // 16:03 Berliner Zeit
const TOKEN = "sk-ant-oat01-GEHEIM-nie-zeigen-1234567890";
const row = (over: Record<string, unknown>) => ({ ts: NOW.toISOString(), tool: "claude", model: "claude-opus-5-5", project: "andere", sessionKey: null, input: 0, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, reasoning: 0, ...over });

/** Antwort wie von Anthropic: Sitzung 5 % (Reset 20:30 Berlin), Woche 29 %. */
const body = (fivePct: number, weekPct = 29) => ({
  five_hour: { utilization: fivePct, resets_at: "2026-09-26T18:30:00.000Z" },
  seven_day: { utilization: weekPct, resets_at: "2026-10-02T17:00:00.000Z" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 3, resets_at: "2026-10-02T17:00:00.000Z" },
});

function fakeFetch(res: { status: number; json?: unknown } | Error): FetchLike & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    if (res instanceof Error) throw res;
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
  }) as unknown as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

/** Wie im Vorfall: Claude kam vor Tagen ans Limit; die alte Schätzung meldete „in ~25 Min voll“. */
async function oldEstimateScenario(t: Awaited<ReturnType<typeof setup>>) {
  const lastReset = Date.parse("2026-09-24T12:40:00Z");
  await t.db.insert(sessions).values({ id: "claude:lim", tool: "claude", sessionId: "lim", lastActivityAt: "2026-09-24T11:00:00Z", limits: { status: "rejected", resetsAt: lastReset / 1000, rateLimitType: "five_hour" } });
  await t.post("/ingest/usage", {
    items: [
      row({ ts: "2026-09-24T09:00:00Z", input: 600 }),
      row({ ts: "2026-09-24T11:30:00Z", input: 400 }),
      row({ ts: "2026-09-26T14:00:00Z", input: 500 }), // 16:00 Berlin: Fenster „ab 16:00, Reset 21:00“ geschätzt
      row({ ts: "2026-09-26T14:02:00Z", input: 280 + 120 }),
    ],
  });
}

async function pushReady(t: Awaited<ReturnType<typeof setup>>) {
  return patchSettings(t.db, { quietStart: "00:00", quietEnd: "00:00", bundleWindowSeconds: 0 });
}

describe("OAuth-Nutzung von Anthropic lesen", () => {
  it("fragt mit Bearer-Token und Beta-Kopf, liefert nur Zahlen (nie das Token)", async () => {
    const f = fakeFetch({ status: 200, json: body(5) });
    const r = await fetchOauthUsage({ token: TOKEN, fetchImpl: f, now: () => NOW });
    expect(f.calls[0]?.url).toBe(OAUTH_USAGE_URL);
    expect(f.calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]?.headers["anthropic-beta"]).toBe(OAUTH_BETA_HEADER);
    expect(r).toEqual({
      ok: true,
      usage: {
        fiveHour: { pct: 5, resetsAt: "2026-09-26T18:30:00.000Z" },
        sevenDay: { pct: 29, resetsAt: "2026-10-02T17:00:00.000Z" },
        sevenDayOpus: null,
        sevenDaySonnet: { pct: 3, resetsAt: "2026-10-02T17:00:00.000Z" },
        fetchedAt: NOW.toISOString(),
      },
    });
    expect(JSON.stringify(r)).not.toContain("GEHEIM");
  });

  it("Fehler still und ohne Geheimnis: 401, 403, 429, Netz, Zeitlimit, kaputte Antwort, kein Token", async () => {
    expect(await fetchOauthUsage({ token: TOKEN, fetchImpl: fakeFetch({ status: 401 }) })).toEqual({ ok: false, error: "unauthorized", status: 401 });
    expect(await fetchOauthUsage({ token: TOKEN, fetchImpl: fakeFetch({ status: 403 }) })).toEqual({ ok: false, error: "forbidden", status: 403 });
    expect(await fetchOauthUsage({ token: TOKEN, fetchImpl: fakeFetch({ status: 429 }) })).toEqual({ ok: false, error: "rate_limited", status: 429 });
    expect(await fetchOauthUsage({ token: TOKEN, fetchImpl: fakeFetch(new Error(`boom ${TOKEN}`)) })).toEqual({ ok: false, error: "network" });
    expect(await fetchOauthUsage({ token: TOKEN, fetchImpl: fakeFetch({ status: 200, json: { foo: 1 } }) })).toEqual({ ok: false, error: "parse" });
    expect(await fetchOauthUsage({ token: "", fetchImpl: fakeFetch({ status: 200, json: body(5) }) })).toEqual({ ok: false, error: "no_token" });
    const hang: FetchLike = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("abgebrochen"))));
    expect(await fetchOauthUsage({ token: TOKEN, fetchImpl: hang, timeoutMs: 20 })).toEqual({ ok: false, error: "timeout" });
  });

  it("Utilization wird auf 0–100 begrenzt, fehlende Fenster → null", () => {
    expect(parseOauthUsage({ five_hour: { utilization: 130, resets_at: null } }, NOW)?.fiveHour).toEqual({ pct: 100, resetsAt: null });
    expect(parseOauthUsage({}, NOW)).toBeNull();
  });

  it("Abruf-Takt im Arbeiter: sofort, dann alle 5 Min; sendet und loggt nie das Token", async () => {
    const sent: unknown[] = [];
    const logs: unknown[] = [];
    const timers: { ms: number }[] = [];
    const stop = startUsagePoller({
      token: () => TOKEN,
      fetchImpl: fakeFetch({ status: 403 }),
      send: (r) => sent.push(r),
      log: (m, e) => logs.push([m, e]),
      setTimer: (_fn, ms) => (timers.push({ ms }), 1),
      clearTimer: () => {},
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ type: "usage", usage: null, error: "forbidden", status: 403 });
    expect(timers[0]?.ms).toBe(60 * 60_000); // abgelehnt → stündlich statt alle 5 Min
    expect(JSON.stringify([sent, logs])).not.toContain("GEHEIM");
    stop();
  });

  it("die API nimmt den Bericht des Arbeiters über die bestehende Leitung an", () => {
    const store = new UsageReadings();
    const engine = new RemoteEngine({ tokenConfigured: true, usage: store });
    const usage = parseOauthUsage(body(5), NOW);
    engine.onMessage(JSON.stringify({ type: "usage", usage, error: null }));
    expect(store.official(NOW)?.fiveHour).toEqual({ pct: 5, resetsAt: "2026-09-26T18:30:00.000Z" });
    // nach 20 Min ohne neuen Stand gilt der Wert nicht mehr als aktuell
    expect(store.official(new Date(NOW.getTime() + 20 * 60_000))).toBeNull();
  });

  it("kaputte oder unplausible Berichte über die Leitung werden verworfen (Prozent, Zeitstempel, Fehlerart)", () => {
    const store = new UsageReadings();
    const engine = new RemoteEngine({ tokenConfigured: true, usage: store });
    const good = parseOauthUsage(body(5), new Date());
    const bad = [
      { ...good, fetchedAt: "kaputt" }, // Date.parse → NaN: galt sonst für immer als „aktuell“
      { ...good, fetchedAt: new Date(Date.now() + 3_600_000).toISOString() }, // aus der Zukunft
      { ...good, fiveHour: { pct: 500, resetsAt: null } },
      { ...good, fiveHour: { pct: "88", resetsAt: null } },
      { ...good, sevenDay: { pct: 5, resetsAt: "morgen" } },
    ];
    for (const usage of bad) engine.onMessage(JSON.stringify({ type: "usage", usage, error: null }));
    engine.onMessage(JSON.stringify({ type: "usage", usage: null, error: "<script>" }));
    expect(store.official()).toBeNull();
    expect(store.status().error).toBeNull();
    engine.onMessage(JSON.stringify({ type: "usage", usage: good, error: null }));
    expect(store.official()?.fiveHour?.pct).toBe(5);
  });

  it("Tempo nur aus zwei echten Messpunkten (≥ 5 Min auseinander, gleiches Fenster)", () => {
    const r = (pct: number, min: number, resetsAt = "2026-09-26T18:30:00.000Z") => ({ pct, resetsAt, at: new Date(NOW.getTime() + min * 60_000).toISOString() });
    expect(paceFromReadings([r(60, 0)])).toBeNull();
    expect(paceFromReadings([r(60, 0), r(61, 2)])).toBeNull();
    expect(paceFromReadings([r(60, 0), r(70, 10)])).toBe(1);
    expect(paceFromReadings([r(90, 0, "2026-09-26T13:30:00.000Z"), r(5, 10)])).toBeNull(); // neues Fenster
  });
});

describe("Push-Warnungen nur auf echten Werten", () => {
  it("alte Schätzung („in ~25 Min voll … zuletzt ans Limit“) löst KEINEN Push mehr aus", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    await oldEstimateScenario(t);
    const readings = new UsageReadings();
    expect(await checkUsageWarnings(t.db, sender, await pushReady(t), NOW, readings)).toEqual([]);
    expect(sender.sent).toHaveLength(0);
    // Die Nutzungs-Ansicht zeigt die Schätzung weiter, aber als solche gekennzeichnet
    const f = await getForecasts(t.db, await getLimits(t.db), NOW, readings);
    const c5 = f.find((x) => x.tool === "claude" && x.window === "5h");
    expect(c5?.basis).toBe("last_limit");
    expect(c5?.line).toMatch(/^Schätzung/);
  });

  it("mit echten Werten (Sitzung 5 %) keine Warnung – auch wenn die alte Schätzung „voll“ sagen würde", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    await oldEstimateScenario(t);
    const readings = new UsageReadings();
    readings.recordReport({ usage: parseOauthUsage(body(4), new Date(NOW.getTime() - 10 * 60_000)), error: null });
    readings.recordReport({ usage: parseOauthUsage(body(5), NOW), error: null });
    expect(await checkUsageWarnings(t.db, sender, await pushReady(t), NOW, readings)).toEqual([]);
    const f = await getForecasts(t.db, await getLimits(t.db), NOW, readings);
    expect(f.find((x) => x.tool === "claude" && x.window === "5h")).toMatchObject({ basis: "reported", pct: 5, resetsAt: "2026-09-26T18:30:00.000Z", hitsLimitAt: null });
    expect(f.find((x) => x.tool === "claude" && x.window === "week")).toMatchObject({ basis: "reported", pct: 29 });
  });

  it("Sitzung ≥ 85 % belegt → genau eine Mitteilung mit echten Zahlen, danach Ruhe für dieses Fenster", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const push = await pushReady(t);
    const readings = new UsageReadings();
    readings.recordReport({ usage: parseOauthUsage(body(88), NOW), error: null });
    expect(await checkUsageWarnings(t.db, sender, push, NOW, readings)).toEqual(["high:claude:5h"]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.title).toMatch(/Claude/);
    expect(sender.sent[0]?.message).toMatch(/Sitzung 88 % belegt, Reset um 20:30/);
    expect(sender.sent[0]?.message).toMatch(/Anthropic/);
    readings.recordReport({ usage: parseOauthUsage(body(92), new Date(NOW.getTime() + 5 * 60_000)), error: null });
    expect(await checkUsageWarnings(t.db, sender, push, new Date(NOW.getTime() + 5 * 60_000), readings)).toEqual([]);
    expect(sender.sent).toHaveLength(1);
  });

  it("Hochrechnung aus zwei echten Messpunkten: voll vor dem Reset → eine Mitteilung „voll um …“", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const readings = new UsageReadings();
    const tMinus10 = new Date(NOW.getTime() - 10 * 60_000);
    readings.recordReport({ usage: parseOauthUsage(body(50), tMinus10), error: null });
    readings.recordReport({ usage: parseOauthUsage(body(70), NOW), error: null }); // 2 %/Min → voll in 15 Min (16:18)
    expect(await checkUsageWarnings(t.db, sender, await pushReady(t), NOW, readings)).toEqual(["forecast:claude:5h"]);
    expect(sender.sent[0]?.message).toMatch(/Sitzung 70 % belegt/);
    expect(sender.sent[0]?.message).toMatch(/voll um 16:18.*Reset um 20:30/);
  });

  it("nur EIN echter Messpunkt unter der Schwelle → keine Hochrechnung, keine Mitteilung", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const readings = new UsageReadings();
    readings.recordReport({ usage: parseOauthUsage(body(70), NOW), error: null });
    expect(await checkUsageWarnings(t.db, sender, await pushReady(t), NOW, readings)).toEqual([]);
  });

  it("Wochenlimit ≥ 85 % → eigene Mitteilung „Woche … belegt“", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const readings = new UsageReadings();
    readings.recordReport({ usage: parseOauthUsage(body(10, 90), NOW), error: null });
    expect(await checkUsageWarnings(t.db, sender, await pushReady(t), NOW, readings)).toEqual(["high:claude:week"]);
    expect(sender.sent[0]?.message).toMatch(/Woche 90 % belegt, Reset/);
  });

  it("veralteter echter Stand (> 16 Min) → keine Warnung", async () => {
    const t = await setup();
    const sender = new FakeNtfySender();
    const readings = new UsageReadings();
    readings.recordReport({ usage: parseOauthUsage(body(95), new Date(NOW.getTime() - 30 * 60_000)), error: null });
    expect(await checkUsageWarnings(t.db, sender, await pushReady(t), NOW, readings)).toEqual([]);
  });

  it("Nutzungs-Ansicht: echte Werte von Anthropic mit Reset-Zeiten", async () => {
    const t = await setup();
    const readings = new UsageReadings();
    readings.recordReport({ usage: parseOauthUsage(body(5), NOW), error: null });
    const w = (await getUsageWindows(t.db, NOW, readings)).find((x) => x.tool === "claude");
    expect(w?.reported).toMatchObject({ fiveHourPct: 5, weekPct: 29, resetsAt: "2026-09-26T18:30:00.000Z", weekResetsAt: "2026-10-02T17:00:00.000Z", source: "anthropic", fetchedAt: NOW.toISOString() });
  });
});
