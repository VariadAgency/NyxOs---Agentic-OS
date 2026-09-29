// Skill-Bibliothek: Kacheln mit echter Nutzung (inkrementell aus session_events), Verlauf mit
// Rückgängig, Vorschläge von Nyx (nie selbst schreiben) und Opus-5.5-Aufträge (nie Haiku).
import { createHash } from "node:crypto";
import type { BridgeSkill, IngestItem, ServerToBridge, SkillDetail, SkillsListResult, SkillsOverview } from "@nyxos/shared";
import { SKILL_JOB_MODEL, emptyTokens, skillJobModel } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions, skillSuggestions, skills as skillsTable } from "../src/db/schema.js";
import type { SuggestionWriter } from "../src/skills/suggest.js";
import { BridgeHub } from "../src/terminal/bridgeHub.js";
import { setup } from "./helpers.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const HOME = "/Users/alex";
const ROOT = `${HOME}/projects`;

function skill(key: string, over: Partial<BridgeSkill> = {}): BridgeSkill & { content: string } {
  const content = over.sha256 ? "" : `---\nname: ${key}\ndescription: Zweck von ${key}\n---\n# ${key}\nSchritt 1\n`;
  const dir = over.dir ?? `${HOME}/.claude/skills/${key}`;
  return {
    key,
    name: key,
    description: `Zweck von ${key}`,
    source: "user",
    plugin: null,
    dir,
    skillPath: `${dir}/SKILL.md`,
    writable: true,
    sha256: sha(content),
    bytes: content.length,
    mtimeMs: 1,
    files: [{ rel: "SKILL.md", bytes: content.length }],
    content,
    ...over,
  };
}

/** Brücke als Attrappe: antwortet auf die Skill-Befehle aus einer veränderbaren Liste, zeichnet alle RPCs auf. */
function fakeBridge(hub: BridgeHub, initial: (BridgeSkill & { content: string })[]) {
  const state = { skills: initial, calls: [] as { method: string; params: Record<string, unknown> }[] };
  const reply = (m: ServerToBridge): unknown => {
    if (m.op !== "rpc") return undefined;
    const params = (m.params ?? {}) as Record<string, unknown>;
    state.calls.push({ method: m.method, params });
    const ok = (result: unknown) => ({ op: "rpc_result", id: m.id, ok: true, result });
    switch (m.method) {
      case "skills_list": {
        const result: SkillsListResult = {
          skills: state.skills.map(({ content: _c, ...s }) => s),
          projectRoot: ROOT,
          targets: { user: `${HOME}/.claude/skills`, project: `${ROOT}/.claude/skills`, nyxos: `${ROOT}/nyxos/.claude/skills` },
        };
        return ok(result);
      }
      case "skill_read":
        return ok({ files: (params.paths as string[]).map((p) => ({ path: p, content: state.skills.find((s) => s.skillPath === p)?.content ?? null, sha256: null, truncated: false })) });
      case "skill_backup": {
        const s = state.skills.find((x) => x.dir === params.dir);
        return ok({ backupDir: `/sicherung/${s?.key}/1`, sha256: s?.sha256 ?? null, content: s?.content ?? null });
      }
      case "skill_restore": {
        const s = state.skills.find((x) => x.skillPath === params.skillPath);
        if (!s || s.sha256 !== params.expectSha256) return { op: "rpc_result", id: m.id, ok: false, error: "Der Skill wurde inzwischen geändert.", code: "skill_conflict" };
        s.content = params.content as string;
        s.sha256 = sha(s.content);
        return ok({ sha256: s.sha256, backupDir: "/sicherung/x/2" });
      }
      case "start":
        return ok({ tmuxName: "zc-claude-sk1ll000", tool: "claude", sessionId: "5b1e2b1c-1111-4222-8333-944455550000", startedMs: 3 });
      default:
        return undefined;
    }
  };
  hub.attach(
    {
      send(data: string) {
        const answer = reply(JSON.parse(data) as ServerToBridge);
        if (answer !== undefined) queueMicrotask(() => hub.handle(JSON.stringify(answer)));
      },
      close() {},
    },
    "m1",
  );
  hub.handle(JSON.stringify({ op: "hello", version: "p3", tmuxSocket: "nyxos", caps: ["skills"] }));
  return state;
}

const summaryItem = (sessionId: string, title: string): IngestItem => ({
  type: "summary",
  summary: {
    tool: "claude",
    sessionId,
    parentSessionId: null,
    cwd: ROOT,
    title,
    titleSource: "ai",
    startedAt: "2026-09-24T10:00:00.000Z",
    lastActivityAt: "2026-09-24T10:30:00.000Z",
    models: ["claude-opus-5-5"],
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
  },
});
const ev = (sessionId: string, id: string, kind: string, ts: string, data: Record<string, unknown>): IngestItem => ({
  type: "event",
  event: { id, tool: "claude", sessionId, ts, kind: kind as never, source: "file", data },
});

const POST_EMPTY = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
/** Minutes ago, but never before today's local midnight: the "today" bucket must not depend on the time of day. */
/** Exactly `minAgo` minutes ago – for checks that need a real age (signals are read only after 15 minutes). */
const minutesAgo = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const recent = (minAgo: number) => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const sinceMidnight = Date.now() - midnight.getTime();
  const offset = Math.min(minAgo * 60_000, Math.max(0, sinceMidnight - 1000) * (minAgo / 61));
  return new Date(Date.now() - offset).toISOString();
};

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("Modell der Skill-Aufträge (nie Haiku)", () => {
  it("ist fest Opus 5.5 – egal, was verlangt wird", () => {
    expect(SKILL_JOB_MODEL).toBe("claude-opus-5-5");
    for (const asked of ["claude-haiku-4-5", "haiku", "sonnet", null, undefined, "claude-haiku-4-5-20251001"]) {
      expect(skillJobModel(asked)).toBe("claude-opus-5-5");
      expect(skillJobModel(asked)).not.toMatch(/haiku/i);
    }
  });
});

describe("GET /api/skills – Kacheln mit echter Nutzung", () => {
  it("zeigt alle Quellen, zählt Skill-Aufrufe und /befehle (inkrementell), eingebaute Skills aus der Nutzung, nie /compact", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    fakeBridge(hub, [skill("dataviz"), skill("ideen", { source: "project", dir: `${ROOT}/.claude/skills/ideen` }), skill("superpowers:brainstorming", { source: "plugin", plugin: "superpowers", writable: false, dir: `${HOME}/.claude/plugins/cache/x/skills/brainstorming` })]);
    await t.post("/ingest/events", {
      items: [
        summaryItem("s1", "Diagramm bauen"),
        ev("s1", "e1", "tool_call", recent(60), { name: "Skill", toolUseId: "tu1", target: "dataviz" }),
        ev("s1", "e2", "tool_call", recent(50), { name: "Skill", toolUseId: "tu2", target: "dataviz" }),
        ev("s1", "e3", "prompt", recent(40), { command: "/ideen", args: "" }),
        ev("s1", "e4", "system", recent(39), { command: "compact", localCommand: true }),
        ev("s1", "e5", "tool_call", recent(30), { name: "Skill", toolUseId: "tu3", target: "artifact-design" }),
      ],
    });
    const res = await t.app.request("/api/skills");
    expect(res.status).toBe(200);
    const body = await json<SkillsOverview>(res);
    const by = new Map(body.skills.map((s) => [s.key, s]));
    expect(by.get("dataviz")).toMatchObject({ uses: 2, source: "user", writable: true });
    expect(by.get("dataviz")?.daily).toHaveLength(30);
    expect(by.get("dataviz")?.daily.at(-1)).toBe(2);
    expect(by.get("ideen")).toMatchObject({ uses: 1, source: "project" });
    expect(by.get("superpowers:brainstorming")).toMatchObject({ uses: 0, source: "plugin", writable: false });
    expect(by.get("artifact-design")).toMatchObject({ uses: 1, source: "builtin", writable: false });
    expect(by.has("compact")).toBe(false);
    expect(body.bridge).toBe("online");

    // Inkrementell: neue Ereignisse kommen dazu, alte werden nicht doppelt gezählt.
    await t.post("/ingest/events", { items: [ev("s1", "e6", "tool_call", recent(5), { name: "Skill", toolUseId: "tu4", target: "dataviz" })] });
    const again = await json<SkillsOverview>(await t.app.request("/api/skills"));
    expect(again.skills.find((s) => s.key === "dataviz")?.uses).toBe(3);
  });

  it("ohne Brücke: zuletzt gesehener Stand bleibt sichtbar, ehrlich als offline markiert", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    await t.db.insert(skillsTable).values({ key: "dataviz", name: "dataviz", source: "user", writable: true });
    const body = await json<SkillsOverview>(await t.app.request("/api/skills"));
    expect(body.bridge).toBe("offline");
    expect(body.skills.map((s) => s.key)).toEqual(["dataviz"]);
  });
});

describe("Verlauf der Verbesserungen + Rückgängig", () => {
  it("erster Stand, Änderung als neue Version, Zurücksetzen über die Brücke mit Hash-Prüfung", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub, [skill("dataviz")]);
    await t.app.request("/api/skills");
    let detail = await json<SkillDetail>(await t.app.request("/api/skills/dataviz"));
    expect(detail.versions.map((v) => v.reason)).toEqual(["erfasst"]);
    expect(detail.content).toContain("# dataviz");

    const s = bridge.skills[0];
    if (!s) throw new Error("Attrappe leer");
    s.content = `${s.content}Schritt 2\n`;
    s.sha256 = sha(s.content);
    await t.app.request("/api/skills/sync", POST_EMPTY);
    detail = await json<SkillDetail>(await t.app.request("/api/skills/dataviz"));
    expect(detail.versions.map((v) => v.reason)).toEqual(["geaendert", "erfasst"]);

    const first = detail.versions[1];
    const res = await t.app.request(`/api/skills/dataviz/versions/${first?.id}/restore`, POST_EMPTY);
    expect(res.status).toBe(200);
    const restore = bridge.calls.find((c) => c.method === "skill_restore");
    expect(restore?.params).toMatchObject({ skillPath: `${HOME}/.claude/skills/dataviz/SKILL.md`, expectSha256: sha(`---\nname: dataviz\ndescription: Zweck von dataviz\n---\n# dataviz\nSchritt 1\nSchritt 2\n`) });
    expect(s.content).not.toContain("Schritt 2");
    detail = await json<SkillDetail>(await t.app.request("/api/skills/dataviz"));
    expect(detail.versions[0]?.reason).toBe("zurueckgesetzt");
  });
});

describe("POST /api/skills/jobs – immer Opus 5.5, sichtbare temporäre Session, vorher Sicherung", () => {
  it("Verbessern: Sicherung vor dem Start, Modell Opus auch wenn Haiku verlangt wird, --add-dir, Session temporär", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub, [skill("dataviz")]);
    const prevEnv = process.env.NYXOS_WORKER_MODEL;
    process.env.NYXOS_WORKER_MODEL = "claude-haiku-4-5";
    try {
      const res = await t.app.request("/api/skills/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "improve", skillKey: "dataviz", brief: "Kürzer und klarer", model: "claude-haiku-4-5" }),
      });
      expect(res.status).toBe(200);
      const body = await json<{ job: { id: number; model: string; sessionHref: string | null } }>(res);
      expect(body.job.model).toBe("claude-opus-5-5");
      expect(body.job.sessionHref).toContain("5b1e2b1c-1111-4222-8333-944455550000");
    } finally {
      if (prevEnv === undefined) delete process.env.NYXOS_WORKER_MODEL;
      else process.env.NYXOS_WORKER_MODEL = prevEnv;
    }
    const methods = bridge.calls.map((c) => c.method);
    expect(methods.indexOf("skill_backup")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("skill_backup")).toBeLessThan(methods.indexOf("start"));
    const start = bridge.calls.find((c) => c.method === "start")?.params;
    expect(start).toMatchObject({ tool: "claude", model: "claude-opus-5-5", addDirs: [`${HOME}/.claude/skills`] });
    expect(String(start?.model)).not.toMatch(/haiku/i);
    expect(String(start?.prompt)).toContain(`${HOME}/.claude/skills/dataviz/SKILL.md`);
    expect(String(start?.prompt)).toContain("Kürzer und klarer");
    const [row] = await t.db.select().from(sessions).where(eq(sessions.id, "claude:5b1e2b1c-1111-4222-8333-944455550000"));
    expect(row?.temporarySince).toBeTruthy();
    const detail = await json<SkillDetail>(await t.app.request("/api/skills/dataviz"));
    expect(detail.versions[0]?.reason).toBe("vor_aenderung");
    expect(detail.jobs[0]).toMatchObject({ kind: "improve", model: "claude-opus-5-5", status: "running" });
  });

  it("Neuer Skill: Ziel-Ordner im Auftrag, Opus, kein Überschreiben eines vorhandenen Namens", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub, [skill("dataviz")]);
    const post = (body: unknown) => t.app.request("/api/skills/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const dup = await post({ kind: "create", name: "dataviz", target: "user", brief: "Diagramme nach unseren Regeln bauen" });
    expect(dup.status).toBe(409);
    const res = await post({ kind: "create", name: "release-notes", target: "project", brief: "Release-Notizen für die App schreiben" });
    expect(res.status).toBe(200);
    const start = bridge.calls.find((c) => c.method === "start")?.params;
    expect(start?.model).toBe("claude-opus-5-5");
    expect(start?.cwd).toBe(ROOT);
    expect(String(start?.prompt)).toContain(`${ROOT}/.claude/skills/release-notes/SKILL.md`);
  });

  it("Plugin-Skills lassen sich nicht verbessern – keine Session, verständlicher Satz", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub });
    const bridge = fakeBridge(hub, [skill("superpowers:brainstorming", { source: "plugin", plugin: "superpowers", writable: false })]);
    await t.app.request("/api/skills");
    const res = await t.app.request("/api/skills/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "improve", skillKey: "superpowers:brainstorming" }) });
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toMatch(/Plugin/);
    expect(bridge.calls.some((c) => c.method === "start" || c.method === "skill_backup")).toBe(false);
  });

  it("nach der Session: neuer Stand hängt am Auftrag („mit Opus verbessert“), Vorschlag gilt als umgesetzt", async () => {
    const hub = new BridgeHub();
    const writer: SuggestionWriter = async () => ({ problem: "P", evidence: "B", idea: "I" });
    const t = await setup({ bridgeHub: hub, skills: { writer } });
    const bridge = fakeBridge(hub, [skill("dataviz")]);
    await t.app.request("/api/skills");
    const [sug] = await t.db.insert(skillSuggestions).values({ skillKey: "dataviz", signal: "korrektur", problem: "Zu lang", evidence: "„zu lang“", idea: "Kürzen", author: "nyx" }).returning();
    const res = await t.app.request("/api/skills/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "apply", suggestionId: sug?.id }) });
    expect(res.status).toBe(200);
    expect(String(bridge.calls.find((c) => c.method === "start")?.params.prompt)).toContain("Kürzen");
    const s = bridge.skills[0];
    if (!s) throw new Error("Attrappe leer");
    s.content = "# kürzer\n";
    s.sha256 = sha(s.content);
    await t.app.request("/api/skills/sync", POST_EMPTY);
    const detail = await json<SkillDetail>(await t.app.request("/api/skills/dataviz"));
    expect(detail.versions[0]).toMatchObject({ reason: "verbessert", jobId: expect.any(Number) });
    expect(detail.suggestions.find((x) => x.id === sug?.id)?.status).toBe("umgesetzt");
  });
});

describe("Vorschläge von Nyx (Heuristik aus den Protokollen) – Nyx schreibt nie selbst", () => {
  const problemSession = (skillName: string): IngestItem[] => [
    summaryItem("p1", "Diagramm mit Ärger"),
    ev("p1", "q1", "tool_call", minutesAgo(90), { name: "Skill", toolUseId: "tuX", target: skillName }),
    ev("p1", "q2", "tool_result", minutesAgo(89), { toolUseId: "tuX", isError: true }),
    ev("p1", "q3", "prompt", minutesAgo(88), { text: "Nein, das ist falsch – die Achsen fehlen schon wieder." }),
  ];

  it("Fehler/Korrektur nach einem Skill → Vorschlag mit Beleg und Link zur Session; keine Schreib-Befehle an die Brücke", async () => {
    const hub = new BridgeHub();
    const seen: string[] = [];
    const writer: SuggestionWriter = async (input) => {
      seen.push(input.skillKey);
      return { problem: "Der Skill vergisst die Achsen.", evidence: "„die Achsen fehlen schon wieder“", idea: "Schritt „Achsen prüfen“ ergänzen." };
    };
    const t = await setup({ bridgeHub: hub, skills: { writer } });
    const bridge = fakeBridge(hub, [skill("dataviz")]);
    await t.app.request("/api/skills");
    await t.post("/ingest/events", { items: problemSession("dataviz") });
    await t.tickStates();
    const detail = await json<SkillDetail>(await t.app.request("/api/skills/dataviz"));
    expect(seen).toEqual(["dataviz"]);
    expect(detail.suggestions).toHaveLength(1);
    expect(detail.suggestions[0]).toMatchObject({ author: "nyx", status: "open", signal: "fehler_aufruf", problem: "Der Skill vergisst die Achsen.", sessionTitle: "Diagramm mit Ärger" });
    expect(detail.suggestions[0]?.sessionHref).toContain("/p1");
    const tile = (await json<SkillsOverview>(await t.app.request("/api/skills"))).skills.find((s) => s.key === "dataviz");
    expect(tile?.openSuggestions).toBe(1);
    // Nyx (Haiku) schreibt NIE: keine Sicherung, kein Zurückschreiben, keine Session.
    expect(bridge.calls.filter((c) => ["skill_restore", "skill_backup", "start"].includes(c.method))).toEqual([]);
    // Zweiter Takt: kein doppelter Vorschlag.
    await t.tickStates();
    expect((await json<SkillDetail>(await t.app.request("/api/skills/dataviz"))).suggestions).toHaveLength(1);
  });

  it("Nyx nicht erreichbar → Vorschlag aus der Regel (ehrlich markiert); angepinnte Skills bekommen keine Vorschläge", async () => {
    const hub = new BridgeHub();
    const writer: SuggestionWriter = async () => null;
    const t = await setup({ bridgeHub: hub, skills: { writer } });
    fakeBridge(hub, [skill("dataviz"), skill("ruhig")]);
    await t.app.request("/api/skills");
    const pin = await t.app.request("/api/skills/ruhig/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) });
    expect(pin.status).toBe(200);
    await t.post("/ingest/events", { items: [...problemSession("dataviz"), ev("p1", "q4", "tool_call", minutesAgo(80), { name: "Skill", toolUseId: "tuY", target: "ruhig" }), ev("p1", "q5", "prompt", minutesAgo(79), { text: "[Request interrupted by user]" })] });
    await t.tickStates();
    const d = await json<SkillDetail>(await t.app.request("/api/skills/dataviz"));
    expect(d.suggestions[0]).toMatchObject({ author: "regel", status: "open" });
    expect(d.suggestions[0]?.evidence).toContain("Achsen");
    expect((await json<SkillDetail>(await t.app.request("/api/skills/ruhig"))).suggestions).toEqual([]);
  });

  it("Verwerfen setzt den Status, der Vorschlag bleibt im Verlauf", async () => {
    const hub = new BridgeHub();
    const t = await setup({ bridgeHub: hub, skills: { writer: async () => null } });
    fakeBridge(hub, [skill("dataviz")]);
    await t.app.request("/api/skills");
    const [sug] = await t.db.insert(skillSuggestions).values({ skillKey: "dataviz", signal: "korrektur", problem: "x", evidence: "y", idea: "z", author: "nyx" }).returning();
    const res = await t.app.request(`/api/skills/suggestions/${sug?.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "verworfen" }) });
    expect(res.status).toBe(200);
    expect((await json<SkillDetail>(await t.app.request("/api/skills/dataviz"))).suggestions[0]?.status).toBe("verworfen");
  });
});
