import type { IngestItem, SessionSummary } from "@nyxos/shared";
import { emptyTokens } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

/**
 * Sessions-Seitenkopf:
 * - `GET /api/categories?tool=` zählt Arten UND Baustellen nur für das gewählte Werkzeug.
 * - „Zuletzt geöffnet“ – `POST /api/sessions/:id/opened` merkt sich das Öffnen (nur angemeldet),
 *   `GET /api/recent-sessions` liefert die Reihenfolge, gefiltert nach Werkzeug.
 */

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: null,
  title: null,
  titleSource: null,
  startedAt: "2026-09-24T10:00:00.000Z",
  lastActivityAt: "2026-09-24T10:00:00.000Z",
  models: [],
  tokens: emptyTokens(),
  toolCalls: {},
  filesWritten: [],
  filesRead: [],
  subagents: [],
  gitBranch: null,
  cliVersion: null,
  eventCount: 0,
  parseErrors: 0,
  limits: null,
  lastUsage: null,
  lastUsageModel: null,
  modelContextWindow: null,
  ...over,
});

const item = (s: SessionSummary): IngestItem => ({ type: "summary", summary: s });

type Categories = { categories: { art: string; count: number; baustellen: { slug: string | null; count: number }[] }[] };

async function seed() {
  const t = await setup();
  await t.post("/ingest/events", {
    items: [
      item(summary({ sessionId: "c-1", tool: "claude", title: "Postgres upgrade" })),
      item(summary({ sessionId: "c-2", tool: "claude", title: "Postgres migr" })),
      item(summary({ sessionId: "x-1", tool: "codex", title: "Postgres backup" })),
    ],
  });
  return t;
}

describe("GET /api/categories mit Werkzeug-Filter", () => {
  it("ohne Filter zählt alle, mit ?tool= nur das Werkzeug – Art und Baustellen gleich", async () => {
    const t = await seed();
    const all = (await (await t.app.request("/api/categories")).json()) as Categories;
    const serverAll = all.categories.find((c) => c.art === "server");
    expect(serverAll?.count).toBe(3);

    const claude = (await (await t.app.request("/api/categories?tool=claude")).json()) as Categories;
    const serverClaude = claude.categories.find((c) => c.art === "server");
    expect(serverClaude?.count).toBe(2);
    expect(serverClaude?.baustellen.reduce((s, b) => s + b.count, 0)).toBe(2);

    const codex = (await (await t.app.request("/api/categories?tool=codex")).json()) as Categories;
    const serverCodex = codex.categories.find((c) => c.art === "server");
    expect(serverCodex?.count).toBe(1);
    expect(serverCodex?.baustellen.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it("ein unbekannter Wert wirkt wie „Alle“", async () => {
    const t = await seed();
    const body = (await (await t.app.request("/api/categories?tool=quatsch")).json()) as Categories;
    expect(body.categories.find((c) => c.art === "server")?.count).toBe(3);
  });
});

type Recent = { items: { sessionKey: string; sessionId: string; tool: string; title: string | null; state: string | null; art: string; openedAt: string; openCount: number }[] };

describe("Zuletzt geöffnet", () => {
  it("merkt sich die Öffnen-Reihenfolge; erneutes Öffnen rückt nach vorn und zählt mit", async () => {
    const t = await seed();
    const open = (id: string, openedAt: string) => t.app.request(`/api/sessions/${encodeURIComponent(id)}/opened`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openedAt }) });

    expect((await open("claude:c-1", "2026-09-20T09:00:00.000Z")).status).toBe(200);
    expect((await open("codex:x-1", "2026-09-20T09:05:00.000Z")).status).toBe(200);
    // Nackte Session-ID (wie aus Suche/Gehirn-Links) wird auch erkannt.
    expect((await open("c-2", "2026-09-20T09:10:00.000Z")).status).toBe(200);
    expect((await open("claude:c-1", "2026-09-20T09:20:00.000Z")).status).toBe(200);

    const all = (await (await t.app.request("/api/recent-sessions")).json()) as Recent;
    expect(all.items.map((i) => i.sessionKey)).toEqual(["claude:c-1", "claude:c-2", "codex:x-1"]);
    expect(all.items[0]?.openCount).toBe(2);
    expect(all.items[0]?.openedAt).toBe("2026-09-20T09:20:00.000Z");
    expect(all.items[0]?.title).toBe("Postgres upgrade");
    expect(all.items[0]?.art).toBe("server");

    const codex = (await (await t.app.request("/api/recent-sessions?tool=codex")).json()) as Recent;
    expect(codex.items.map((i) => i.sessionKey)).toEqual(["codex:x-1"]);

    const limited = (await (await t.app.request("/api/recent-sessions?limit=1")).json()) as Recent;
    expect(limited.items).toHaveLength(1);
  });

  it("ein älterer Zeitstempel (nachgereicht aus dem lokalen Speicher) überschreibt keinen neueren", async () => {
    const t = await seed();
    const open = (id: string, openedAt: string) => t.app.request(`/api/sessions/${id}/opened`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openedAt }) });
    await open("claude:c-1", "2026-09-20T10:00:00.000Z");
    await open("claude:c-1", "2026-09-20T08:00:00.000Z");
    const all = (await (await t.app.request("/api/recent-sessions")).json()) as Recent;
    expect(all.items[0]?.openedAt).toBe("2026-09-20T10:00:00.000Z");
  });

  it("Zeit in der Zukunft wird auf „jetzt“ gekappt, unbekannte Session → 404", async () => {
    const t = await seed();
    const before = Date.now();
    const res = await t.app.request("/api/sessions/claude:c-1/opened", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openedAt: "2099-01-01T00:00:00.000Z" }) });
    expect(res.status).toBe(200);
    const all = (await (await t.app.request("/api/recent-sessions")).json()) as Recent;
    expect(Date.parse(all.items[0]?.openedAt ?? "")).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(all.items[0]?.openedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);

    const missing = await t.app.request("/api/sessions/claude:gibt-es-nicht/opened", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(404);
  });

  it("Schreiben braucht Anmeldung", async () => {
    const t = await setup({ signedIn: false });
    const res = await t.app.request("/api/sessions/claude:c-1/opened", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
