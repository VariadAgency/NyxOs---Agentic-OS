// Skill-Nutzung zählt auch ältere Ereignisse ohne `target` (früher „1 Aufruf“, obwohl
// 15 Skill-Aufrufe im Verlauf standen) – Name aus dem Ereignis ableiten, einmalig und ohne Doppelzählung
// aus dem Session-Archiv nachzählen. Dazu: Embedding-Modelle lassen sich keiner Chat-Rolle zuweisen.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { IngestItem, SkillsOverview } from "@nyxos/shared";
import { emptyTokens } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { archive, skillScanState, skillUses } from "../src/db/schema.js";
import { SKILL_BACKFILL_VERSION, scanSkillUses, skillFromTranscriptLine, skillNameFromEvent } from "../src/skills/usage.js";
import { setup } from "./helpers.js";

// ─── Echte Formen (lesend aus der Live-DB `session_events` bzw. `~/.claude/projects`) ───

/** So stehen die 15 älteren Aufrufe in `session_events.data` – ohne Skill-Namen. */
const LIVE_NULL_MAIN = { name: "Skill", target: null, toolUseId: "toolu_01Xp87zmYQdDuWuG7TCkaMuj" };
const LIVE_NULL_SUB = { name: "Skill", target: null, agentId: "a7477641ef2c69032", toolUseId: "toolu_018K5YEgDruKVTmhG3MZg4gs" };
/** Neuere Form. */
const LIVE_OK = { name: "Skill", target: "artifact-design", toolUseId: "toolu_016WiVmmiBEfhry7RXcvRpwj" };

/** Rohzeilen aus einem echten Claude-Protokoll (gekürzt auf die tragenden Felder). */
const toolUseLine = (id: string, input: Record<string, unknown>) =>
  JSON.stringify({
    parentUuid: "146153c8-f447-44b4-a813-cd2aa6073fe8",
    isSidechain: false,
    message: { model: "claude-sonnet-5", id: "msg_011CerEoc3nVJFwKC6AJHkcJ", type: "message", role: "assistant", content: [{ type: "tool_use", id, name: "Skill", input, caller: { type: "direct" } }], stop_reason: "tool_use" },
    type: "assistant",
    uuid: "85821cab-3904-4fbe-bcef-c2dba7f3283d",
    timestamp: "2026-09-08T15:51:10.632Z",
    sessionId: "190080fe-0cf7-4ad4-9590-f460c569f612",
    version: "2.1.263",
  });
const toolResultLine = (id: string, commandName: string) =>
  JSON.stringify({
    parentUuid: "85821cab-3904-4fbe-bcef-c2dba7f3283d",
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Launching skill: ${commandName}` }] },
    uuid: "86bca419-70d1-47ec-9e1a-1447a9febccd",
    timestamp: "2026-09-08T15:51:10.651Z",
    toolUseResult: { success: true, commandName },
  });

describe("Skill-Name aus dem Ereignis", () => {
  it("nimmt `target`, sonst die Eingabe (`skill`/`command`), sonst den Befehl oder die getippte Zeile", () => {
    expect(skillNameFromEvent("tool_call", LIVE_OK)).toBe("artifact-design");
    expect(skillNameFromEvent("tool_call", { ...LIVE_NULL_MAIN, input: { skill: "dataviz" } })).toBe("dataviz");
    expect(skillNameFromEvent("tool_call", { ...LIVE_NULL_MAIN, input: { command: "/blender-toolkit" } })).toBe("blender-toolkit");
    expect(skillNameFromEvent("tool_call", { ...LIVE_NULL_MAIN, input: { skill: "anthropic-skills:dj-multicam-sync", args: "Projekt …" } })).toBe("anthropic-skills:dj-multicam-sync");
    expect(skillNameFromEvent("prompt", { command: "/ideen", args: "" })).toBe("ideen");
    expect(skillNameFromEvent("prompt", { text: "/cc-design-language bitte" })).toBe("cc-design-language");
    // Ohne jeden Hinweis: kein Name (das Archiv muss helfen).
    expect(skillNameFromEvent("tool_call", LIVE_NULL_MAIN)).toBeNull();
    expect(skillNameFromEvent("tool_call", LIVE_NULL_SUB)).toBeNull();
    // Normale Texte und fremde Werkzeuge sind nie ein Skill.
    expect(skillNameFromEvent("prompt", { text: "Bitte baue /api/skills um" })).toBeNull();
    expect(skillNameFromEvent("prompt", { text: "/Users/alex/x.ts ansehen" })).toBeNull();
    expect(skillNameFromEvent("tool_call", { name: "Bash", target: "ls" })).toBeNull();
    expect(skillNameFromEvent("tool_call", { name: "Skill", target: "../../etc" })).toBeNull();
  });

  it("findet den Namen in den echten Protokoll-Zeilen (Aufruf und Ergebnis), nur für die passende toolUseId", () => {
    expect(skillFromTranscriptLine(toolUseLine("toolu_A", { skill: "blender-toolkit" }), "toolu_A")).toBe("blender-toolkit");
    expect(skillFromTranscriptLine(toolResultLine("toolu_B", "dataviz"), "toolu_B")).toBe("dataviz");
    expect(skillFromTranscriptLine(toolUseLine("toolu_A", { skill: "blender-toolkit" }), "toolu_X")).toBeNull();
    expect(skillFromTranscriptLine("kein json", "toolu_A")).toBeNull();
  });
});

// ─── Nachzählen aus dem Archiv ───

const SID = "89d2ca7f-b592-4343-9ab5-83f5a9a4926d";
const SID2 = "00903b73-2f1a-4fdd-8d68-5f247359b598";
const summaryItem = (sessionId: string): IngestItem => ({
  type: "summary",
  summary: {
    tool: "claude",
    sessionId,
    parentSessionId: null,
    cwd: "/Users/alex/projects",
    title: "Alte Session",
    titleSource: "ai",
    startedAt: "2026-08-19T18:00:00.000Z",
    lastActivityAt: "2026-08-19T19:00:00.000Z",
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

async function storeArchive(t: Awaited<ReturnType<typeof setup>>, sessionId: string, path: string, lines: string[]) {
  const storedPath = join(t.archiveDir, "claude", `${path}.gz`);
  mkdirSync(dirname(storedPath), { recursive: true });
  const raw = `${lines.join("\n")}\n`;
  const gz = gzipSync(raw);
  writeFileSync(storedPath, gz);
  await t.db.insert(archive).values({ sessionKey: `claude:${sessionId}`, tool: "claude", path, sha256: "0".repeat(64), size: raw.length, gzSize: gz.length, storedPath });
}

describe("Nachzählen alter Skill-Aufrufe", () => {
  it("liest Aufrufe ohne Namen einmalig aus dem Archiv nach (Haupt- und Subagent-Datei), ohne Doppelzählung", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(SID),
        summaryItem(SID2),
        // Echte Formen: zwei alte Aufrufe ohne Namen, ein neuerer mit Namen, ein alter mit Eingabe im Ereignis.
        ev(SID, "e-old-main", "tool_call", "2026-08-19T18:45:39.398Z", LIVE_NULL_MAIN),
        ev(SID2, "e-old-sub", "tool_call", "2026-09-24T23:25:28.633Z", LIVE_NULL_SUB),
        ev(SID2, "e-ok", "tool_call", "2026-09-25T15:56:18.288Z", LIVE_OK),
        ev(SID2, "e-input", "tool_call", "2026-09-25T16:00:00.000Z", { name: "Skill", target: null, toolUseId: "toolu_in", input: { skill: "cc-design-language" } }),
        ev(SID2, "e-lost", "tool_call", "2026-09-25T16:10:00.000Z", { name: "Skill", target: null, toolUseId: "toolu_nirgends" }),
      ],
    });
    await storeArchive(t, SID, `-Users-alex-projects/${SID}.jsonl`, [toolUseLine(LIVE_NULL_MAIN.toolUseId, { skill: "dataviz" }), toolResultLine(LIVE_NULL_MAIN.toolUseId, "dataviz")]);
    await storeArchive(t, SID2, `-Users-alex-projects-08-Systeme-NyxOS/${SID2}.jsonl`, [toolUseLine("toolu_anderes", { skill: "falsch" })]);
    await storeArchive(t, SID2, `-Users-alex-projects-08-Systeme-NyxOS/${SID2}/subagents/agent-${LIVE_NULL_SUB.agentId}.jsonl`, [toolUseLine(LIVE_NULL_SUB.toolUseId, { skill: "blender-toolkit" })]);
    // So steht es live: der Lese-Stand ist längst an den alten Ereignissen vorbei (nie nachgeholt).
    await t.db.insert(skillScanState).values({ id: 1, lastReceivedAt: new Date(Date.now() + 60_000).toISOString() });

    const body = (await (await t.app.request("/api/skills")).json()) as SkillsOverview;
    const uses = (k: string) => body.skills.find((s) => s.key === k)?.uses ?? 0;
    expect(uses("dataviz")).toBe(1);
    expect(uses("blender-toolkit")).toBe(1);
    expect(uses("cc-design-language")).toBe(1);
    expect(uses("artifact-design")).toBe(1);
    expect(body.skills.some((s) => s.key === "falsch")).toBe(false);

    const [state] = await t.db.select().from(skillScanState).where(eq(skillScanState.id, 1));
    expect(state?.backfillVersion).toBe(SKILL_BACKFILL_VERSION);
    const all = await t.db.select().from(skillUses);
    expect(all.map((u) => u.skill).sort()).toEqual(["artifact-design", "blender-toolkit", "cc-design-language", "dataviz"]);

    // Idempotent: weitere Läufe (Takt, erneuter Abruf) zählen nichts doppelt und lesen das Archiv nicht erneut.
    expect(await scanSkillUses(t.db)).toBe(0);
    const again = (await (await t.app.request("/api/skills")).json()) as SkillsOverview;
    expect(again.skills.find((s) => s.key === "dataviz")?.uses).toBe(1);
    expect(await t.db.select().from(skillUses)).toHaveLength(4);
  });

  it("fehlende oder kaputte Archiv-Datei reißt den Server nicht mit, der Rest wird trotzdem nachgezählt", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(SID),
        summaryItem(SID2),
        ev(SID, "e-old-main", "tool_call", "2026-08-19T18:45:39.398Z", LIVE_NULL_MAIN),
        ev(SID2, "e-old-sub", "tool_call", "2026-09-24T23:25:28.633Z", LIVE_NULL_SUB),
      ],
    });
    // SID: DB-Zeile zeigt auf eine Datei, die es nicht (mehr) gibt (ENOENT), plus eine kaputte gzip-Datei.
    await t.db.insert(archive).values({ sessionKey: `claude:${SID}`, tool: "claude", path: `-x/${SID}.jsonl`, sha256: "1".repeat(64), size: 1, gzSize: 1, storedPath: join(t.archiveDir, "claude", "fehlt.jsonl.gz") });
    const broken = join(t.archiveDir, "claude", "kaputt.jsonl.gz");
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, "kein gzip");
    await t.db.insert(archive).values({ sessionKey: `claude:${SID}`, tool: "claude", path: `-x/${SID}/subagents/agent-kaputt.jsonl`, sha256: "2".repeat(64), size: 1, gzSize: 1, storedPath: broken });
    await storeArchive(t, SID2, `-y/${SID2}/subagents/agent-${LIVE_NULL_SUB.agentId}.jsonl`, [toolUseLine(LIVE_NULL_SUB.toolUseId, { skill: "blender-toolkit" })]);

    expect(await scanSkillUses(t.db)).toBe(1);
    expect((await t.db.select().from(skillUses)).map((u) => u.skill)).toEqual(["blender-toolkit"]);
    const [state] = await t.db.select().from(skillScanState).where(eq(skillScanState.id, 1));
    expect(state?.backfillVersion).toBe(SKILL_BACKFILL_VERSION);
  });

  it("gleichzeitige Läufe (Takt + Abruf) zählen nicht doppelt", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [summaryItem(SID), ev(SID, "e-old-main", "tool_call", "2026-08-19T18:45:39.398Z", LIVE_NULL_MAIN)] });
    await storeArchive(t, SID, `-Users-alex-projects/${SID}.jsonl`, [toolUseLine(LIVE_NULL_MAIN.toolUseId, { skill: "dataviz" })]);
    const counts = await Promise.all([scanSkillUses(t.db), scanSkillUses(t.db), scanSkillUses(t.db)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await t.db.select().from(skillUses)).toHaveLength(1);
  });
});

// ─── Embedding-Modell nie als Chat-Rolle ───

const ENV = { NYXOS_SECRETS_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;
const JSONH = { "content-type": "application/json" };

describe("Rollen: Embedding-Modelle werden gesperrt", () => {
  it("lehnt ein Embedding-Modell für eine Chat-Rolle verständlich ab, ein Chat-Modell geht", async () => {
    const { app } = await setup({ models: { env: ENV } });
    const saved = await app.request("/api/models/providers/lmstudio", { method: "PUT", headers: JSONH, body: JSON.stringify({ kind: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" }) });
    expect(saved.status).toBe(200);
    for (const model of ["text-embedding-nomic-embed-text-v1.5", "nomic-embed-text", "mxbai-embed-large", "bge-m3"]) {
      const res = await app.request("/api/models/roles/nyx.briefing", { method: "PUT", headers: JSONH, body: JSON.stringify({ providerId: "lmstudio", model }) });
      expect(res.status, model).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/Embedding|Suche/);
    }
    const roles = (await (await app.request("/api/models/roles")).json()) as { roles: { role: string; active: { source: string } }[] };
    expect(roles.roles.find((r) => r.role === "nyx.briefing")?.active.source).toBe("claude-cli");
    const ok = await app.request("/api/models/roles/nyx.briefing", { method: "PUT", headers: JSONH, body: JSON.stringify({ providerId: "lmstudio", model: "qwen3-8b" }) });
    expect(ok.status).toBe(200);
  });
});
