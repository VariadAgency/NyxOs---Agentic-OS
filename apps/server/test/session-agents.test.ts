// Agents in the session chat — live view of the sub-agents of ONE session (agent → session → run, status, elapsed
// time basics, live tokens from the events, last action), detail with steps, manage (hide, add to tasks), Nyx rules.
// Only sample data from this test, never real transcripts.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { IngestItem, SessionAgentLiveDetail, SessionAgentsLiveResponse, SessionSummary } from "@nyxos/shared";
import { ARCHIVE_HEADERS, emptyTokens, setLang } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { codexChildRunning, isUniqueViolation } from "../src/agents/session-live.js";
import { archiveDigests, entries } from "../src/db/schema.js";
import { buildCatalog } from "../src/nyx/appApi/catalog.js";
import { classifyApiRequest } from "../src/nyx/appApi/rules.js";
import { setup } from "./helpers.js";

type App = Awaited<ReturnType<typeof setup>>;

afterEach(() => setLang("de"));
const MIN = 60_000;
const PARENT = "aaaaaaaa-5a5a-4000-8000-000000000001";
const CODEX_PARENT = "bbbbbbbb-5a5a-4000-8000-000000000002";
const CODEX_CHILD = "cccccccc-5a5a-4000-8000-000000000003";
const KEY = `claude:${PARENT}`;

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: "/nyxos-test/projekt",
  title: null,
  titleSource: null,
  startedAt: new Date(Date.now() - 90 * MIN).toISOString(),
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

let n = 0;
const ev = (sessionId: string, kind: string, agoMs: number, data: Record<string, unknown>, tool: "claude" | "codex" = "claude", source: "file" | "hook" = "file"): IngestItem => ({
  type: "event",
  event: { id: `${tool}:${sessionId}:e${++n}`, tool, sessionId, ts: new Date(Date.now() - agoMs).toISOString(), kind: kind as never, source, data },
});
const usage = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({ input, output, cacheRead, cacheCreation });

async function seed(): Promise<App> {
  const t = await setup();
  const res = await t.post("/ingest/events", {
    items: [
      {
        type: "summary",
        summary: summary({
          sessionId: PARENT,
          title: "Probe-Leiter",
          subagents: [
            { id: "old", name: "Alter Prüfer", type: "general-purpose" },
            { id: "busy", name: "Baut Paket A", type: "general-purpose" },
            { id: "fin", name: "Recherche", type: "Explore" },
            { id: "hooked", name: "Per Hook fertig", type: "Explore" },
            { id: "gone", name: "Ohne Abschluss", type: "Plan" },
          ],
        }),
      },
      // Lauf 1 (vor 60 Min): „Prüfe Paket Z“ → Agent „old“ (fertig per Bericht)
      ev(PARENT, "prompt", 60 * MIN, { text: "Prüfe Paket Z\nmit allen Details" }),
      ev(PARENT, "prompt", 59 * MIN, { text: "Auftrag an den Prüfer", agentId: "old" }),
      ev(PARENT, "tool_call", 58 * MIN, { name: "Read", target: "/a.ts", toolUseId: "o1", agentId: "old" }),
      ev(PARENT, "assistant", 57 * MIN, { text: "Urteil: PASS", agentId: "old" }),
      ev(PARENT, "tool_call", 56 * MIN, { name: "SubagentHandback", toolUseId: "o2", agentId: "old", text: "Bericht: Paket Z ist in Ordnung." }),
      ev(PARENT, "prompt", 50 * MIN, { text: "Plane weiter", agentId: "gone" }),
      ev(PARENT, "tool_call", 49 * MIN, { name: "Grep", target: "foo", toolUseId: "g1", agentId: "gone" }),
      // Lauf 2 (vor 10 Min): „Baue Paket A“ → busy (läuft), fin (fertig mit Schlussantwort), hooked (SubagentStop)
      ev(PARENT, "prompt", 10 * MIN, { text: "Baue Paket A" }),
      ev(PARENT, "system", 9.5 * MIN, { tagged: true }),
      ev(PARENT, "prompt", 9 * MIN, { text: "Baue die Agenten-Leiste\nDetails …", agentId: "busy" }),
      ev(PARENT, "assistant", 8 * MIN, { text: "Ich lese erst.", agentId: "busy", msgId: "m1", model: "claude-opus-5-5", usage: usage(10, 1, 1000, 0) }),
      ev(PARENT, "tool_call", 8 * MIN, { name: "Read", target: "/x.ts", toolUseId: "b1", agentId: "busy" }),
      // gleiche Antwort in einer zweiten Zeile mit gewachsener Nutzung → zählt nur einmal (größter Stand)
      ev(PARENT, "tool_call", 7.9 * MIN, { name: "Grep", target: "Agent", toolUseId: "b2", agentId: "busy", msgId: "m1", model: "claude-opus-5-5", usage: usage(10, 50, 1000, 0) }),
      ev(PARENT, "tool_result", 7.8 * MIN, { toolUseId: "b1", isError: false, agentId: "busy" }),
      ev(PARENT, "tool_result", 7.7 * MIN, { toolUseId: "b2", isError: true, agentId: "busy" }),
      ev(PARENT, "tool_call", 0.5 * MIN, { name: "Bash", target: "pnpm test", toolUseId: "b3", agentId: "busy", msgId: "m2", model: "claude-opus-5-5", usage: usage(5, 20, 2000, 100) }),
      ev(PARENT, "prompt", 9 * MIN, { text: "Suche die Stellen", agentId: "fin" }),
      ev(PARENT, "tool_call", 8.5 * MIN, { name: "Glob", target: "**/*.ts", toolUseId: "f1", agentId: "fin" }),
      ev(PARENT, "assistant", 3 * MIN, { text: "Gefunden: drei Stellen.", agentId: "fin" }),
      ev(PARENT, "prompt", 5 * MIN, { text: "Kurz prüfen", agentId: "hooked" }),
      ev(PARENT, "tool_call", 0.2 * MIN, { name: "Read", target: "/y.ts", toolUseId: "h1", agentId: "hooked" }),
      ev(PARENT, "hook", 0.1 * MIN, { event: "SubagentStop", subagentId: "hooked" }, "claude", "hook"),
    ],
  });
  expect(res.status).toBe(200);
  // Wait for the background work of the ingest (context guard/delivery): PGlite has only one connection.
  await t.background.idle();
  return t;
}

async function live(t: App, key = KEY): Promise<SessionAgentsLiveResponse> {
  const res = await t.app.request(`/api/sessions/${encodeURIComponent(key)}/agents-live`);
  expect(res.status).toBe(200);
  return (await res.json()) as SessionAgentsLiveResponse;
}

describe("session agents: Agenten einer Session live", () => {
  it("ordnet jeden Agenten seinem Lauf zu (letzte Nachricht an die Session vor seinem Start)", async () => {
    const t = await seed();
    const body = await live(t);
    const ids = body.agents.map((a) => a.id).sort();
    expect(ids).toEqual(["busy", "fin", "gone", "hooked", "old"]);
    expect(body.runs).toHaveLength(2);
    const [current, earlier] = body.runs;
    expect(current).toMatchObject({ prompt: "Baue Paket A", current: true });
    expect(earlier).toMatchObject({ prompt: "Prüfe Paket Z", current: false });
    expect(body.currentRunId).toBe(current?.id);
    const run = new Map(body.agents.map((a) => [a.id, a.runId]));
    expect(run.get("busy")).toBe(current?.id);
    expect(run.get("fin")).toBe(current?.id);
    expect(run.get("hooked")).toBe(current?.id);
    expect(run.get("old")).toBe(earlier?.id);
    expect(run.get("gone")).toBe(earlier?.id);
  });

  it("Status aus echten Signalen: läuft · fertig (Bericht, Schlussantwort, SubagentStop) · ohne Abschluss", async () => {
    const t = await seed();
    const status = new Map((await live(t)).agents.map((a) => [a.id, a.status]));
    expect(status.get("busy")).toBe("running");
    expect(status.get("old")).toBe("done");
    expect(status.get("fin")).toBe("done");
    expect(status.get("hooked")).toBe("done");
    expect(status.get("gone")).toBe("stopped");
  });

  it("Tokens live aus den Ereignissen (je Antwort nur einmal), Modell, Kosten, Aufrufe, Auftrag, letzte Aktion", async () => {
    const t = await seed();
    const busy = (await live(t)).agents.find((a) => a.id === "busy");
    expect(busy).toBeDefined();
    expect(busy?.tokens).toEqual({ input: 15, output: 70, cacheRead: 3000, cacheCreation: 100, total: 3185 });
    expect(busy?.model).toBe("claude-opus-5-5");
    expect(busy?.costUsd).toBeGreaterThan(0);
    expect(busy?.toolCalls).toBe(3);
    expect(busy).toMatchObject({ name: "Baut Paket A", type: "general-purpose", task: "Baue die Agenten-Leiste", endedAt: null, tool: "claude", sessionKey: null, hidden: false });
    expect(busy?.lastAction).toMatchObject({ kind: "tool", tool: "Bash", label: "pnpm test" });
    const old = (await live(t)).agents.find((a) => a.id === "old");
    expect(old?.verdict).toBe("PASS");
    expect(old?.endedAt).not.toBeNull();
    expect(old?.tokens).toBeNull(); // ältere Brücke: keine Nutzung an den Ereignissen, kein Archiv → ehrlich „keine Angabe“
    expect(old?.costUsd).toBeNull();
  });

  it("Detail: letzte Schritte mit Status, der aktuelle Schritt ist markiert; Auftrag voll", async () => {
    const t = await seed();
    const res = await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents-live/busy`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as SessionAgentLiveDetail;
    expect(d.agent.id).toBe("busy");
    expect(d.prompt).toBe("Baue die Agenten-Leiste\nDetails …");
    const tools = d.steps.filter((s) => s.kind === "tool");
    expect(tools.map((s) => [s.tool, s.status])).toEqual([
      ["Read", "ok"],
      ["Grep", "error"],
      ["Bash", "open"],
    ]);
    expect(d.steps.filter((s) => s.current).map((s) => s.tool)).toEqual(["Bash"]);
    expect(d.result).toBeNull();
    expect(d.hasTranscript).toBe(false);

    const fin = (await (await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents-live/fin`)).json()) as SessionAgentLiveDetail;
    expect(fin.result).toBe("Gefunden: drei Stellen.");
    expect(fin.steps.some((s) => s.current)).toBe(false);
  });

  it("Detail kennt den archivierten Verlauf des Agenten (für den Chat)", async () => {
    const t = await seed();
    const raw = Buffer.from(`${JSON.stringify({ type: "user", uuid: "s1", sessionId: PARENT, timestamp: new Date().toISOString(), message: { role: "user", content: "Suche die Stellen" } })}\n`);
    const res = await t.app.request("/ingest/archive", {
      method: "POST",
      body: gzipSync(raw),
      headers: {
        authorization: t.auth.authorization,
        [ARCHIVE_HEADERS.tool]: "claude",
        [ARCHIVE_HEADERS.sessionId]: PARENT,
        [ARCHIVE_HEADERS.path]: encodeURIComponent(`-nyxos-test-projekt/${PARENT}/subagents/agent-fin.jsonl`),
        [ARCHIVE_HEADERS.sha256]: createHash("sha256").update(raw).digest("hex"),
        [ARCHIVE_HEADERS.size]: String(raw.length),
      },
    });
    expect(res.status).toBe(200);
    const d = (await (await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents-live/fin`)).json()) as SessionAgentLiveDetail;
    expect(d.hasTranscript).toBe(true);
    // Die Archiv-Auswertung läuft im Hintergrund — abwarten, sonst hält ihre Transaktion die geteilte Test-DB,
    // während der nächste Test sie leert (PGlite hat nur eine Verbindung → Stillstand).
    for (let i = 0; i < 100; i++) {
      const rows = await t.db.select({ id: archiveDigests.archiveId }).from(archiveDigests);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("unbekannte Session bzw. unbekannter Agent → 404 mit einfachem Satz", async () => {
    const t = await seed();
    const a = await t.app.request(`/api/sessions/${encodeURIComponent("claude:gibtsnicht")}/agents-live`);
    expect(a.status).toBe(404);
    const b = await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents-live/nix`);
    expect(b.status).toBe(404);
    expect(((await b.json()) as { error: string }).error).toMatch(/Agent/);
  });
});

describe("session agents: Verwalten", () => {
  it("blendet einen Agenten aus und wieder ein (bleibt nach dem Neuladen)", async () => {
    const t = await seed();
    const url = `/api/sessions/${encodeURIComponent(KEY)}/agents/old/hide`;
    const hide = await t.app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hidden: true }) });
    expect(hide.status).toBe(200);
    expect((await live(t)).agents.find((a) => a.id === "old")?.hidden).toBe(true);
    const show = await t.app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hidden: false }) });
    expect(show.status).toBe(200);
    expect((await live(t)).agents.find((a) => a.id === "old")?.hidden).toBe(false);
    const bad = await t.app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hidden: "ja" }) });
    expect(bad.status).toBe(400);
    const unknown = await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents/nix/hide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hidden: true }) });
    expect(unknown.status).toBe(404);
  });

  it("übernimmt einen Agenten in die Aufgaben — ein zweites Mal zeigt dieselbe Aufgabe", async () => {
    const t = await seed();
    const url = `/api/sessions/${encodeURIComponent(KEY)}/agents/fin/task`;
    const first = await t.app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { entry: { id: number; title: string; href: string }; existing?: boolean };
    expect(a.entry.title).toContain("Recherche");
    expect(a.entry.href).toBe(`/tasks?e=${a.entry.id}`);
    const again = await t.app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { entry: { id: number }; existing: boolean }).existing).toBe(true);
    const d = (await (await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents-live/fin`)).json()) as SessionAgentLiveDetail;
    expect(d.task?.id).toBe(a.entry.id);
    const entry = (await (await t.app.request(`/api/entries/${a.entry.id}`)).json()) as { entry: { kind: string; description: string | null } };
    expect(entry.entry.kind).toBe("aufgabe");
    expect(entry.entry.description).toContain("Gefunden: drei Stellen.");
  });
});

describe("session agents: Kritik-Nachträge", () => {
  it("Ergebnis = Abschlussbericht (SubagentHandback), nicht die letzte Zwischenantwort; Archiv-Kennzeichen", async () => {
    const t = await seed();
    const old = (await (await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents-live/old`)).json()) as SessionAgentLiveDetail;
    expect(old.result).toBe("Bericht: Paket Z ist in Ordnung.");
    expect(old.archived).toBe(true);
    expect(old.steps.at(-1)).toMatchObject({ kind: "text", label: "Bericht: Paket Z ist in Ordnung." });
    const fin = (await (await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents-live/fin`)).json()) as SessionAgentLiveDetail;
    expect(fin.archived).toBe(false);
  });

  it("Session ohne Agenten: leere Antwort (früher Ausstieg)", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [{ type: "summary", summary: summary({ sessionId: CODEX_CHILD, title: "Ohne Agenten" }) }, ev(CODEX_CHILD, "prompt", MIN, { text: "Hallo" })] });
    await t.background.idle();
    const body = await live(t, `claude:${CODEX_CHILD}`);
    expect(body).toMatchObject({ agents: [], runs: [], currentRunId: null, childKeys: [] });
  });

  // Zwei gleichzeitige Klicks lassen sich mit PGlite (eine Verbindung, Transaktionen sperren) nicht echt nachstellen —
  // geprüft wird der Baustein: der Fehler des eindeutigen Index wird als „schon da“ erkannt (echter Datenbank-Fehler).
  it("erkennt die Verletzung des eindeutigen Index (Doppelklick → dieselbe Aufgabe statt Fehler)", async () => {
    const t = await setup();
    const row = { kind: "aufgabe", title: "x", source: "api", sourceType: "session_agent", sourceId: "k|a" } as const;
    await t.db.insert(entries).values(row as never);
    let err: unknown = null;
    try {
      await t.db.insert(entries).values(row as never);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(new Error("anderer Fehler"))).toBe(false);
  });
});

describe("session agents: Codex läuft nicht ewig", () => {
  it("„idle“ ohne Aktivität seit über 15 Min gilt nicht mehr als laufend", () => {
    const now = Date.now();
    expect(codexChildRunning("running", new Date(now - 60 * MIN).toISOString(), now)).toBe(true);
    expect(codexChildRunning("idle", new Date(now - 2 * MIN).toISOString(), now)).toBe(true);
    expect(codexChildRunning("idle", new Date(now - 20 * MIN).toISOString(), now)).toBe(false);
    expect(codexChildRunning("waiting", new Date(now).toISOString(), now)).toBe(false);
  });
});

describe("session agents: Codex-Teamkollegen", () => {
  it("Kind-Sessions („Locke: …“) erscheinen mit Spitzname, Auftrag, eigener Session und Tokens", async () => {
    const t = await setup();
    const res = await t.post("/ingest/events", {
      items: [
        { type: "summary", summary: summary({ tool: "codex", sessionId: CODEX_PARENT, title: "Codex-Leiter" }) },
        ev(CODEX_PARENT, "prompt", 20 * MIN, { text: "Teile die Arbeit auf" }, "codex"),
        {
          type: "summary",
          summary: summary({
            tool: "codex",
            sessionId: CODEX_CHILD,
            parentSessionId: CODEX_PARENT,
            title: "Locke: Prüfe die Tests",
            startedAt: new Date(Date.now() - 15 * MIN).toISOString(),
            models: ["gpt-5.5-codex"],
            tokens: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0, reasoning: 5, total: 120 },
            toolCalls: { shell: 2 },
          }),
        },
        ev(CODEX_CHILD, "tool_call", 1 * MIN, { name: "shell", target: "pnpm test" }, "codex"),
      ],
    });
    expect(res.status).toBe(200);
    await t.background.idle();
    const body = await live(t, `codex:${CODEX_PARENT}`);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      id: `codex:${CODEX_CHILD}`,
      tool: "codex",
      name: "Locke",
      task: "Prüfe die Tests",
      sessionKey: `codex:${CODEX_CHILD}`,
      model: "gpt-5.5-codex",
      toolCalls: 2,
      lastAction: { kind: "tool", tool: "shell", label: "pnpm test" },
    });
    expect(body.agents[0]?.tokens?.total).toBe(120);
    expect(body.childKeys).toEqual([`codex:${CODEX_CHILD}`]);
    expect(body.runs[0]).toMatchObject({ prompt: "Teile die Arbeit auf", current: true });
  });
});

describe("session agents: English and Nyx", () => {
  it("writes the task in the chosen language", async () => {
    const t = await seed();
    setLang("en");
    const res = await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents/old/task`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(201);
    const a = (await res.json()) as { entry: { id: number; title: string } };
    expect(a.entry.title).toBe("Agent “Alter Prüfer”: Auftrag an den Prüfer");
    const entry = (await (await t.app.request(`/api/entries/${a.entry.id}`)).json()) as { entry: { description: string | null } };
    expect(entry.entry.description).toMatch(/^From the session “Probe-Leiter” on .+ – agent “Alter Prüfer” \(general-purpose\)\./);
    expect(entry.entry.description).toContain("## Result\n\nBericht: Paket Z ist in Ordnung.");
    const nix = await t.app.request(`/api/sessions/${encodeURIComponent(KEY)}/agents-live/nix`);
    expect(((await nix.json()) as { error: string }).error).toBe("This agent doesn't exist in the session.");
  });

  it("Nyx may read, hide and add to tasks directly (all reversible) and finds the routes in the catalog", async () => {
    const t = await setup();
    const key = "claude:x1";
    expect(classifyApiRequest("GET", `/api/sessions/${key}/agents-live`).access).toBe("direkt");
    expect(classifyApiRequest("GET", `/api/sessions/${key}/agents-live/a1`).access).toBe("direkt");
    expect(classifyApiRequest("POST", `/api/sessions/${key}/agents/a1/hide`).access).toBe("direkt");
    expect(classifyApiRequest("POST", `/api/sessions/${key}/agents/a1/task`).access).toBe("direkt");
    const catalog = buildCatalog(t.app.routes, "agents");
    const byKey = new Map(catalog.map((e) => [`${e.methode} ${e.pfad}`, e]));
    for (const k of ["GET /api/sessions/:id/agents-live", "GET /api/sessions/:id/agents-live/:agentId", "POST /api/sessions/:id/agents/:agentId/hide", "POST /api/sessions/:id/agents/:agentId/task"]) {
      expect(byKey.get(k)?.zweck, k).toBeTruthy();
    }
  });
});
