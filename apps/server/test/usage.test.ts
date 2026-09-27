import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const row = (over: Record<string, unknown> = {}) => ({
  ts: "2026-08-19T10:00:00.000Z",
  tool: "claude",
  model: "claude-opus-5",
  project: "shop",
  sessionKey: "claude:s1",
  input: 472,
  output: 178041,
  cacheRead: 81677137,
  cacheCreation5m: 0,
  cacheCreation1h: 842207,
  reasoning: 0,
  ...over,
});

type Daily = { days: { day: string; tool: string; model: string; totalTokens: number; cost: number | null }[] };
type Models = { models: { model: string; totalTokens: number }[] };
type Prices = { prices: { id: number; model: string }[] };
type Limits = { limits: { tool: string; source: string | null; data: unknown }[] };

describe("POST /ingest/usage + GET /api/usage/*", () => {
  // `registerUsageRoutes` muss `/ingest/usage`/`/ingest/otel/v1/metrics`
  // mit dem Maschinen-Token schützen (dieselbe Vertrauensstufe wie `/ingest/events`), NICHT mit der
  // Passkey-Sitzung — die Brücke hält kein Browser-Cookie. Wie `server.test.ts` (`/ingest/events`).
  it("Brücke mit Token → 2xx, ohne Token → 401 (/ingest/usage)", async () => {
    const { post } = await setup();
    expect((await post("/ingest/usage", { items: [row()] }, {})).status).toBe(401);
    expect((await post("/ingest/usage", { items: [row()] }, { authorization: "Bearer falsch" })).status).toBe(401);
    expect((await post("/ingest/usage", { items: [row()] })).status).toBe(200);
  });

  it("nimmt Nutzungszeilen an, rechnet Kosten und verdichtet sie je Tag", async () => {
    const { post, app } = await setup();
    const res = await post("/ingest/usage", { items: [row()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, duplicates: 0 });

    const daily = (await (await app.request("/api/usage/daily?range=all")).json()) as Daily;
    expect(daily.days).toHaveLength(1);
    expect(daily.days[0]).toMatchObject({ day: "2026-08-19", tool: "claude", model: "claude-opus-5", totalTokens: 472 + 178041 + 81677137 + 842207 });
    expect(daily.days[0]?.cost).toBeCloseTo(53.714023500000025, 4);
  });

  it("zählt beim erneuten Einlesen derselben Zeile nicht doppelt (idempotent, wie bei einem Nachimport)", async () => {
    const { post, app } = await setup();
    await post("/ingest/usage", { items: [row()] });
    const res2 = await post("/ingest/usage", { items: [row()] });
    expect(await res2.json()).toEqual({ accepted: 0, duplicates: 1 });
    const daily = (await (await app.request("/api/usage/daily?range=all")).json()) as Daily;
    expect(daily.days[0]?.totalTokens).toBe(472 + 178041 + 81677137 + 842207);
  });

  // NUTZUNG-BEFUND.md "Sub-Agent-Duplikate": ein Claude-Code-Subagent wiederholt die geerbte
  // Eltern-Antwort (gleiche `message.id` = `sourceId`) in seinem EIGENEN Verlauf, aber mit einer
  // ANDEREN Zeit (eigene Aufruf-Zeit statt der ursprünglichen Antwort-Zeit). Ein Schlüssel aus
  // (ts, Zahlen) würde das NICHT als Duplikat erkennen (verschiedene ts) — mit `sourceId` muss es
  // trotzdem als EIN Ereignis zählen.
  it("dedupliziert über sourceId, auch wenn ts/sessionKey abweichen (Subagent-Kopie derselben Nachricht)", async () => {
    const { post, app } = await setup();
    const parent = row({ sourceId: "msg_geteilt" });
    const subagentCopy = row({ sourceId: "msg_geteilt", ts: "2026-08-19T10:00:20.000Z", sessionKey: "claude:s1-subagent" });
    const res = await post("/ingest/usage", { items: [parent, subagentCopy] });
    expect(await res.json()).toEqual({ accepted: 1, duplicates: 1 });
    const daily = (await (await app.request("/api/usage/daily?range=all")).json()) as Daily;
    expect(daily.days).toHaveLength(1);
    expect(daily.days[0]?.totalTokens).toBe(472 + 178041 + 81677137 + 842207); // nicht verdoppelt
  });

  it("zwei ECHT verschiedene Nachrichten (unterschiedliche sourceId) zählen unabhängig, auch bei gleichen Zahlen", async () => {
    const { post, app } = await setup();
    await post("/ingest/usage", { items: [row({ sourceId: "msg_1" }), row({ sourceId: "msg_2", ts: "2026-08-19T10:05:00.000Z" })] });
    const daily = (await (await app.request("/api/usage/daily?range=all")).json()) as Daily;
    expect(daily.days[0]?.totalTokens).toBe(2 * (472 + 178041 + 81677137 + 842207));
  });

  it("verwirft sessionKey für Projekte außerhalb von projects (Datenschutz)", async () => {
    const { post, db } = await setup();
    await post("/ingest/usage", { items: [row({ project: "andere", sessionKey: "claude:sollte-nicht-gespeichert-werden" })] });
    const rows = await db.query.usageEvents.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionKey).toBeNull();
    expect(rows[0]?.project).toBe("andere");
  });

  it("lehnt fremde/ungültige Pakete ab", async () => {
    const { post } = await setup();
    const res = await post("/ingest/usage", { items: [{ tool: "claude" }] });
    expect(res.status).toBe(400);
  });

  it("summiert Modelle über alle Tage (GET /api/usage/models)", async () => {
    const { post, app } = await setup();
    await post("/ingest/usage", { items: [row(), row({ ts: "2026-08-20T10:00:00.000Z", sessionKey: "claude:s2" })] });
    const models = (await (await app.request("/api/usage/models?range=all")).json()) as Models;
    expect(models.models).toHaveLength(1);
    expect(models.models[0]?.totalTokens).toBe(2 * (472 + 178041 + 81677137 + 842207));
  });

  it("PATCH /api/usage/prices/:id ändert den Preis und rechnet usage_daily neu", async () => {
    const { post, app } = await setup();
    await post("/ingest/usage", { items: [row()] });
    const prices = (await (await app.request("/api/usage/prices")).json()) as Prices;
    const opus = prices.prices.find((p) => p.model === "claude-opus-5");
    if (!opus) throw new Error("Test-Vorbedingung: claude-opus-5 sollte gesät sein");
    const patched = await app.request(`/api/usage/prices/${opus.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outputPerToken: 0 }) });
    expect(patched.status).toBe(200);
    const daily = (await (await app.request("/api/usage/daily?range=all")).json()) as Daily;
    // outputPerToken=0 → die 178041 Output-Tokens tragen nichts mehr zu den Kosten bei.
    expect(daily.days[0]?.cost).toBeCloseTo(53.714023500000025 - 178041 * 2.5e-5, 4);
  });

  it("GET /api/usage/limits nennt die Quelle je Werkzeug oder 'keine Quelle' (null)", async () => {
    const { app } = await setup();
    const res = (await (await app.request("/api/usage/limits")).json()) as Limits;
    expect(res.limits).toHaveLength(2);
    for (const l of res.limits) expect(l.data === null ? l.source === null : typeof l.source === "string").toBe(true);
  });
});
