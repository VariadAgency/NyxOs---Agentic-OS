// Sub-Agenten „laufen gerade“: früher stand „Laufen gerade 0“, obwohl 4 Agenten liefen — `running` war für
// Claude-Sub-Agenten fest `false`. Jetzt aus echten Signalen: letzte Aktivität des Agenten, kein
// Abschlussbericht (SubagentHandback bzw. Schlussantwort) und die Eltern-Session lebt noch.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { IngestItem, SessionSummary } from "@nyxos/shared";
import { ClaudeSessionParser, emptyTokens } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isClaudeAgentRunning } from "../src/agents/runs.js";
import { sessions } from "../src/db/schema.js";
import { setup } from "./helpers.js";

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: "/Users/alex/projects",
  title: null,
  titleSource: null,
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastActivityAt: new Date().toISOString(),
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
const ev = (sessionId: string, id: string, kind: string, agoMs: number, data: Record<string, unknown>): IngestItem => ({
  type: "event",
  event: { id, tool: "claude", sessionId, ts: new Date(Date.now() - agoMs).toISOString(), kind: kind as never, source: "file", data },
});

type Runs = { runs: { id: string; running: boolean; agentName: string | null }[] };
const MIN = 60_000;

async function seed() {
  const t = await setup();
  const res = await t.post("/ingest/events", {
    items: [
      { type: "summary", summary: summary({ sessionId: "p1", title: "Hauptsession", subagents: [
        { id: "busy", name: "Fix-Agent", type: null },
        { id: "tool", name: "Langer Testlauf", type: null },
        { id: "done", name: "Fertig mit Bericht", type: null },
        { id: "quiet", name: "Seit 20 Min still", type: null },
        { id: "answered", name: "Schlussantwort", type: null },
      ] }) },
      // arbeitet: letzte Aktivität vor 30 s
      ev("p1", "b1", "tool_call", 90_000, { name: "Read", agentId: "busy" }),
      ev("p1", "b2", "tool_result", 30_000, { toolUseId: "x", agentId: "busy" }),
      // wartet seit 6 Min auf einen langen Befehl (tool_call ohne Ergebnis)
      ev("p1", "t1", "tool_call", 6 * MIN, { name: "Bash", agentId: "tool" }),
      // hat per SubagentHandback abgegeben (auch wenn das erst vor 10 s war)
      ev("p1", "d1", "tool_call", 60_000, { name: "Edit", agentId: "done" }),
      ev("p1", "d2", "tool_call", 10_000, { name: "SubagentHandback", agentId: "done" }),
      // seit 20 Min nichts mehr
      ev("p1", "q1", "tool_result", 20 * MIN, { toolUseId: "y", agentId: "quiet" }),
      // letzte Zeile ist die Schlussantwort (Text, kein Werkzeug)
      ev("p1", "a1", "tool_result", 40_000, { toolUseId: "z", agentId: "answered" }),
      ev("p1", "a2", "assistant", 20_000, { text: "Fertig: PASS", agentId: "answered" }),
    ],
  });
  expect(res.status).toBe(200);
  return t;
}

async function runs(t: Awaited<ReturnType<typeof setup>>) {
  const body = (await (await t.app.request("/api/agents/runs")).json()) as Runs;
  return new Map(body.runs.map((r) => [r.agentName, r.running]));
}

describe("Claude-Sub-Agenten „laufen gerade“ aus echten Signalen", () => {
  it("läuft = frische Aktivität ohne Abschluss; Abgabe, Schlussantwort und lange Stille = fertig", async () => {
    const t = await seed();
    const byName = await runs(t);
    expect(byName.get("Fix-Agent")).toBe(true);
    expect(byName.get("Langer Testlauf")).toBe(true);
    expect(byName.get("Fertig mit Bericht")).toBe(false);
    expect(byName.get("Seit 20 Min still")).toBe(false);
    expect(byName.get("Schlussantwort")).toBe(false);

    const running = (await (await t.app.request("/api/agents/runs?filter=running")).json()) as Runs;
    expect(running.runs.map((r) => r.agentName).sort()).toEqual(["Fix-Agent", "Langer Testlauf"]);
  });

  it("Eltern-Session beendet oder geschlossen → kein Agent läuft mehr", async () => {
    const t = await seed();
    await t.db.update(sessions).set({ status: "ended" }).where(eq(sessions.id, "claude:p1"));
    expect([...(await runs(t)).values()].some(Boolean)).toBe(false);
  });

  it("reine Regel: Grenzen der Stille (2 Min, beim Warten auf ein Werkzeug 15 Min)", () => {
    const now = Date.parse("2026-09-25T12:00:00.000Z");
    const at = (agoMs: number) => new Date(now - agoMs).toISOString();
    const base = { parentAlive: true, handedBack: false, lastKind: "tool_result", lastToolName: null };
    expect(isClaudeAgentRunning({ ...base, lastTs: at(MIN) }, now)).toBe(true);
    expect(isClaudeAgentRunning({ ...base, lastTs: at(3 * MIN) }, now)).toBe(false);
    expect(isClaudeAgentRunning({ ...base, lastKind: "tool_call", lastToolName: "Bash", lastTs: at(10 * MIN) }, now)).toBe(true);
    expect(isClaudeAgentRunning({ ...base, lastKind: "tool_call", lastToolName: "Bash", lastTs: at(16 * MIN) }, now)).toBe(false);
    expect(isClaudeAgentRunning({ ...base, parentAlive: false, lastTs: at(1000) }, now)).toBe(false);
    expect(isClaudeAgentRunning({ ...base, handedBack: true, lastTs: at(1000) }, now)).toBe(false);
  });
});

// Session-Seite „Bezüge“: „N von M Agenten fertig“ — ein laufender Agent ist nicht fertig, auch wenn
// sein Archiv schon Zwischentext (= digest.result) enthält.
describe("Session-Seite zählt laufende Agenten nicht als fertig", () => {
  it("frische Aktivität des Agenten → 0 von 1 fertig; Eltern-Session beendet → 1 von 1", async () => {
    process.env.NYXOS_DIGEST_MIN_INTERVAL_MS = "0";
    const FIX = join(import.meta.dirname, "fixtures", "transcript-panels");
    const SID = "bbbbbbbb-0000-4000-8000-000000000db1";
    const KEY = `claude:${SID}`;
    const AGENT = "b0000000000000001";
    const dir = "-Users-alex-projects-08-Systeme-NyxOS";
    const mainRaw = readFileSync(join(FIX, `${SID}.jsonl`));
    const subRaw = readFileSync(join(FIX, SID, "subagents", `agent-${AGENT}.jsonl`));
    const t = await setup();
    const parser = new ClaudeSessionParser(SID);
    for (const line of mainRaw.toString("utf8").split("\n")) parser.push(line);
    for (const line of subRaw.toString("utf8").split("\n")) parser.push(line, { agentId: AGENT });
    await t.post("/ingest/events", { items: [{ type: "summary", summary: parser.summary() }, ev(SID, "fresh", "tool_call", 20_000, { name: "Bash", agentId: AGENT })] });
    const files: [string, Buffer][] = [
      [`${dir}/${SID}.jsonl`, mainRaw],
      [`${dir}/${SID}/subagents/agent-${AGENT}.jsonl`, subRaw],
    ];
    for (const [path, raw] of files) {
      const res = await t.app.request("/ingest/archive", {
        method: "POST",
        body: gzipSync(raw),
        headers: {
          authorization: t.auth.authorization,
          "x-nyxos-tool": "claude",
          "x-nyxos-session": SID,
          "x-nyxos-path": encodeURIComponent(path),
          "x-nyxos-sha256": createHash("sha256").update(raw).digest("hex"),
          "x-nyxos-size": String(raw.length),
        },
      });
      expect(res.status).toBe(200);
    }
    type Out = { stats: { agentsFinished: number; agentsTotal: number }; done: { kind: string }[] };
    const get = async () => (await (await t.app.request(`/api/sessions/${KEY}/outcomes`)).json()) as Out;
    const live = await get();
    expect(live.stats).toMatchObject({ agentsFinished: 0, agentsTotal: 1 });
    expect(live.done.some((d) => d.kind === "agent")).toBe(false);

    await t.db.update(sessions).set({ status: "ended" }).where(eq(sessions.id, KEY));
    const after = await get();
    expect(after.stats).toMatchObject({ agentsFinished: 1, agentsTotal: 1 });
  });
});
