import type { IngestItem, SessionSummary } from "@nyxos/shared";
import { emptyTokens } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: "/Users/alex/projects",
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
const summaryItem = (s: SessionSummary): IngestItem => ({ type: "summary", summary: s });
const eventItem = (sessionId: string, id: string, kind: string, ts: string, data: Record<string, unknown>): IngestItem => ({
  type: "event",
  event: { id, tool: "claude", sessionId, ts, kind: kind as never, source: "file", data },
});

interface RunDTO {
  tool: string;
  parentSessionKey: string | null;
  parentTitle: string | null;
  agentName: string | null;
  toolCalls: number;
  verdict: string | null;
  durationMs: number | null;
}
type Runs = { runs: RunDTO[] };
type Catalog = { catalog: { kind: string; name: string }[] };
type Skills = { skills: { skill: string; runs7d: number; lastUsedAt: string | null }[] };
type Anomalies = { anomalies: { kind: string; skill?: string }[] };

describe("GET /api/agents/runs (Claude-Subagenten aus session_events)", () => {
  it("verdichtet Ereignisse mit derselben agentId zu einem Lauf mit Dauer/Werkzeug-Aufrufen/Urteil", async () => {
    const { post, app } = await setup();
    const ingest = await post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s1", title: "Eltern-Session", subagents: [{ id: "a1", name: "test-coverage-critic", type: "test-coverage-critic" }] })),
        eventItem("s1", "e1", "tool_call", "2026-09-24T10:00:00.000Z", { name: "Read", agentId: "a1" }),
        eventItem("s1", "e2", "tool_call", "2026-09-24T10:00:05.000Z", { name: "Grep", agentId: "a1" }),
        eventItem("s1", "e3", "assistant", "2026-09-24T10:00:10.000Z", { text: "Ergebnis: PASS_WITH_NOTES - 2 Luecken", agentId: "a1" }),
      ],
    });
    expect(ingest.status).toBe(200);

    const res = (await (await app.request("/api/agents/runs")).json()) as Runs;
    expect(res.runs).toHaveLength(1);
    const run = res.runs[0];
    expect(run).toMatchObject({
      tool: "claude",
      parentTitle: "Eltern-Session",
      agentName: "test-coverage-critic",
      toolCalls: 2,
      verdict: "PASS_WITH_NOTES",
    });
    expect(run?.durationMs).toBe(10_000);
  });

  it("erkennt BLOCK nur bei einem eigenständigen Wort (nicht als Teil von PASS_WITH_NOTES)", async () => {
    const { post, app } = await setup();
    await post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s2", subagents: [{ id: "a2", name: "ui-critic", type: "ui-critic" }] })),
        eventItem("s2", "e1", "assistant", "2026-09-24T10:00:00.000Z", { text: "BLOCK: Kontrast zu niedrig", agentId: "a2" }),
      ],
    });
    const res = (await (await app.request("/api/agents/runs")).json()) as Runs;
    expect(res.runs[0]?.verdict).toBe("BLOCK");
  });

  it("Codex-Subagenten sind eigene Sessions mit parentId", async () => {
    const { post, app } = await setup();
    await post("/ingest/events", {
      items: [
        summaryItem({ ...summary({ sessionId: "parent" }), tool: "codex" as const }),
        { type: "summary", summary: { ...summary({ sessionId: "child" }), tool: "codex" as const, parentSessionId: "parent", title: "Sub-Agent-Lauf" } },
      ],
    });
    const res = (await (await app.request("/api/agents/runs")).json()) as Runs;
    const codexRun = res.runs.find((r) => r.tool === "codex");
    expect(codexRun).toBeTruthy();
    expect(codexRun?.parentSessionKey).toBe("codex:parent");
  });
});

describe("Bestand + Skill-Nutzung + Auffälligkeiten", () => {
  // dasselbe Maschinen-Token wie `/ingest/usage`, nicht die Passkey-Sitzung.
  it("Brücke mit Token → 2xx, ohne Token → 401 (/ingest/catalog)", async () => {
    const { post } = await setup();
    const items = [{ kind: "agent", name: "test-coverage-critic", description: null, path: "/x/a.md", source: "project" }];
    expect((await post("/ingest/catalog", { items }, {})).status).toBe(401);
    expect((await post("/ingest/catalog", { items }, { authorization: "Bearer falsch" })).status).toBe(401);
    expect((await post("/ingest/catalog", { items })).status).toBe(200);
  });

  it("POST /ingest/catalog ersetzt den Bestand EINER Quelle, andere Quellen bleiben", async () => {
    const { post, app } = await setup();
    await post("/ingest/catalog", { items: [{ kind: "agent", name: "test-coverage-critic", description: "prüft Tests", path: "/x/a.md", source: "project" }] });
    await post("/ingest/catalog", { items: [{ kind: "skill", name: "dataviz", description: "Diagramme", path: "/x/dataviz/SKILL.md", source: "user" }] });
    let res = (await (await app.request("/api/agents/catalog")).json()) as Catalog;
    expect(res.catalog).toHaveLength(2);

    // Erneute Meldung derselben Quelle "project" mit EINEM anderen Eintrag ersetzt nur diese Quelle.
    await post("/ingest/catalog", { items: [{ kind: "agent", name: "ui-critic", description: null, path: "/x/b.md", source: "project" }] });
    res = (await (await app.request("/api/agents/catalog")).json()) as Catalog;
    expect(res.catalog.map((c) => c.name).sort()).toEqual(["dataviz", "ui-critic"]);
  });

  // Agenten-Kacheln brauchen Modell, Werkzeuge, Farbe und Prompt — die Brücke schickt sie mit,
  // die API gibt sie unverändert zurück. Ältere Brücken ohne `details` bleiben gültig (dann `null`).
  it("speichert und liefert Agenten-Details (Modell, Werkzeuge, Prompt); ohne Details → null", async () => {
    const { post, app } = await setup();
    const details = { model: "sonnet", tools: ["Read", "Grep"], color: "purple", prompt: "Du bewachst die Grenze." };
    expect((await post("/ingest/catalog", { items: [{ kind: "agent", name: "scope-warden", description: "Scope", path: "/x/s.md", source: "project", details }] })).status).toBe(200);
    expect((await post("/ingest/catalog", { items: [{ kind: "agent", name: "alt", description: null, path: "/x/alt.md", source: "user" }] })).status).toBe(200);
    const res = (await (await app.request("/api/agents/catalog")).json()) as { catalog: { name: string; details: unknown }[] };
    expect(res.catalog.find((c) => c.name === "scope-warden")?.details).toEqual(details);
    expect(res.catalog.find((c) => c.name === "alt")?.details).toBeNull();
  });

  it("zählt Skill-Nutzung der letzten 7 Tage aus tool_call-Ereignissen", async () => {
    const { post, app } = await setup();
    const now = new Date().toISOString();
    await post("/ingest/events", {
      items: [summaryItem(summary({ sessionId: "s3" })), eventItem("s3", "e1", "tool_call", now, { name: "Skill", target: "dataviz" })],
    });
    const res = (await (await app.request("/api/agents/skills/usage")).json()) as Skills;
    expect(res.skills).toEqual([{ skill: "dataviz", runs7d: 1, lastUsedAt: expect.any(String) }]);
  });

  it("meldet einen seit ≥ 30 Tagen ungenutzten Skill als Auffälligkeit", async () => {
    const { post, app } = await setup();
    await post("/ingest/catalog", { items: [{ kind: "skill", name: "nie-genutzt", description: null, path: "/x/nie-genutzt/SKILL.md", source: "user" }] });
    const res = (await (await app.request("/api/agents/anomalies")).json()) as Anomalies;
    expect(res.anomalies).toContainEqual(expect.objectContaining({ kind: "skill_unused", skill: "nie-genutzt" }));
  });
});
