import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionEventSchema, SessionSummarySchema } from "../src/events.js";
import { CodexSessionParser, codexSessionIdFromPath, parseCodexIndex } from "../src/parse/codex.js";

const FIX = join(import.meta.dirname, "fixtures", "codex");
const MAIN = "01a0c424-0000-7000-8000-00000000c0de";
const SUB = "01a0c40a-0000-7000-8000-00000000abcd";
const MAIN_FILE = `rollout-2026-09-21T15-25-10-${MAIN}.jsonl`;
const SUB_FILE = `rollout-2026-09-21T14-56-55-${SUB}.jsonl`;

function feed(sessionId: string, file: string) {
  const p = new CodexSessionParser(sessionId);
  const events = readFileSync(join(FIX, file), "utf8")
    .split("\n")
    .flatMap((l) => p.push(l));
  return { p, events, summary: p.summary() };
}

describe("Codex: Hilfsfunktionen", () => {
  it("liest die Session-ID aus dem Dateinamen", () => {
    expect(codexSessionIdFromPath(`/x/2026/09/21/${MAIN_FILE}`)).toBe(MAIN);
    expect(codexSessionIdFromPath("/x/rollout-ohne-id.jsonl")).toBeNull();
    expect(codexSessionIdFromPath("/x/notes.txt")).toBeNull();
  });

  it("nimmt im Titel-Index den jüngsten Namen je Session und überspringt kaputte Zeilen", () => {
    const text = readFileSync(join(FIX, "session_index.jsonl"), "utf8") + "kaputt\n{\"id\":5}\n";
    const idx = parseCodexIndex(text);
    expect(idx.get(MAIN)).toBe("Codex-Sitzungen prüfen");
    expect(idx.size).toBe(2);
  });

  it("lässt einen älteren Index-Eintrag einen neueren nicht überschreiben", () => {
    const text = [
      JSON.stringify({ id: "x", thread_name: "Neu", updated_at: "2026-09-21T13:00:00Z" }),
      JSON.stringify({ id: "x", thread_name: "Alt", updated_at: "2026-09-20T13:00:00Z" }),
    ].join("\n");
    expect(parseCodexIndex(text).get("x")).toBe("Neu");
  });
});

describe("Codex-Parser: Haupt-Session", () => {
  it("liest Kopf-Daten, Start aus session_meta und Ende aus der letzten Zeile", () => {
    const { summary } = feed(MAIN, MAIN_FILE);
    expect(summary).toMatchObject({
      tool: "codex",
      sessionId: MAIN,
      parentSessionId: null,
      cwd: "/Users/alex/projects",
      startedAt: "2026-09-21T13:25:10.672Z",
      lastActivityAt: "2026-09-21T13:40:05.000Z",
      gitBranch: "main",
      cliVersion: "0.153.4",
      parseErrors: 0,
    });
  });

  it("nimmt ohne Index den ersten echten Nutzer-Prompt als Titel, mit Index den Index-Namen", () => {
    const { p, summary } = feed(MAIN, MAIN_FILE);
    expect(summary.title).toBe("Prüfe bitte die Sitzungsdateien auf dem Mac");
    expect(summary.titleSource).toBe("prompt");
    p.setIndexTitle("Codex-Sitzungen prüfen");
    expect(p.summary()).toMatchObject({ title: "Codex-Sitzungen prüfen", titleSource: "index" });
  });

  it("übernimmt Tokens aus dem letzten Gesamtstand und trennt Cache-Anteil ab", () => {
    const { summary } = feed(MAIN, MAIN_FILE);
    expect(summary.tokens).toEqual({
      input: 18960,
      cacheRead: 58624,
      cacheCreation: 0,
      output: 681,
      reasoning: 123,
      total: 78265,
    });
  });

  it("sammelt Modelle, Werkzeuge, Dateien, Sub-Agenten und Limit-Stand", () => {
    const { summary } = feed(MAIN, MAIN_FILE);
    expect(summary.models).toEqual(["gpt-6-astra", "gpt-5.6-terra"]);
    expect(summary.toolCalls).toEqual({
      exec_command: 1,
      apply_patch: 1,
      "mcp:obsidian/search_notes": 1,
      spawn_agent: 1,
      "web.search": 1,
    });
    expect(summary.filesWritten).toEqual([
      "/Users/alex/projects/App/docs/notiz.md",
      "/Users/alex/projects/memory.md",
    ]);
    expect(summary.filesRead).toEqual(["/Users/alex/projects/memory.md"]);
    expect(summary.subagents).toEqual([{ id: SUB, name: "audit_recovery", type: null }]);
    expect(summary.limits).toMatchObject({ primary: { used_percent: 14 }, secondary: { used_percent: 40 } });
  });

  it("erzeugt Events mit stabilen IDs, ohne doppelte response_item-Kopien", () => {
    const { events, summary } = feed(MAIN, MAIN_FILE);
    expect(events.map((e) => e.kind)).toEqual([
      "session_meta",
      "turn_start",
      "prompt",
      "assistant",
      "tool_call",
      "thinking",
      "tool_call",
      "tool_call",
      "tool_call",
      "subagent",
      "tool_call",
      "turn_end",
      "compaction",
      "turn_aborted",
    ]);
    expect(summary.eventCount).toBe(14);
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`codex:${MAIN}:exec-1`);
    expect(ids).toContain(`codex:${MAIN}:turn:t-1:start`);
    for (const e of events) expect(SessionEventSchema.parse(e)).toEqual(e);
    expect(feed(MAIN, MAIN_FILE).events.map((e) => e.id)).toEqual(ids);
  });

  it("ergibt eine gültige Zusammenfassung laut Schema", () => {
    expect(() => SessionSummarySchema.parse(feed(MAIN, MAIN_FILE).summary)).not.toThrow();
  });
});

describe("Codex-Parser: Sub-Agent-Datei", () => {
  it("überspringt die kopierte Kopfzeile der Eltern-Session und kennt die Eltern-ID", () => {
    const { summary, events } = feed(SUB, SUB_FILE);
    expect(summary.parentSessionId).toBe(MAIN);
    expect(summary.cwd).toBe("/Users/alex/projects/App");
    expect(summary.startedAt).toBe("2026-09-21T13:27:14.550Z");
    expect(summary.lastActivityAt).toBe("2026-09-21T13:27:40.000Z");
    expect(summary.title).toBe("Noether: Untersuche die Wiederherstellung nach Absturz");
    expect(events.map((e) => e.kind)).toEqual(["session_meta", "prompt", "tool_call"]);
    expect(events.every((e) => e.sessionId === SUB)).toBe(true);
  });

  it("löst relative Lese-Pfade gegen das Arbeitsverzeichnis des Befehls auf", () => {
    const { summary } = feed(SUB, SUB_FILE);
    expect(summary.filesRead).toEqual(["/Users/alex/projects/App/Package.swift"]);
  });

  it("hat ohne Limit-Angabe keinen Limit-Stand und rechnet Tokens korrekt", () => {
    const { summary } = feed(SUB, SUB_FILE);
    expect(summary.limits).toBeNull();
    expect(summary.tokens).toEqual({ input: 4000, cacheRead: 1000, cacheCreation: 0, output: 300, reasoning: 100, total: 5300 });
  });
});

describe("Codex-Parser: kaputte Eingaben", () => {
  it("zählt ungültiges JSON als Fehler und liest weiter", () => {
    const p = new CodexSessionParser(MAIN);
    expect(p.push("{nicht json")).toEqual([]);
    expect(p.push("17")).toEqual([]);
    const first = readFileSync(join(FIX, MAIN_FILE), "utf8").split("\n")[0] ?? "";
    expect(p.push(first)).toHaveLength(1);
    expect(p.summary().parseErrors).toBe(2);
  });

  it("ignoriert Items einer fremden Thread-ID", () => {
    const p = new CodexSessionParser(MAIN);
    const line = JSON.stringify({
      timestamp: "2026-09-21T13:27:00.000Z",
      type: "event_msg",
      payload: { type: "item_completed", thread_id: "fremd", item: { type: "UserMessage", id: "x", content: [{ type: "text", text: "hallo" }] } },
    });
    expect(p.push(line)).toEqual([]);
    expect(p.summary().title).toBeNull();
  });

  it("übersteht Token-Stände mit falschen Typen, ohne alte Werte zu zerstören", () => {
    const p = new CodexSessionParser(MAIN);
    const tc = (usage: unknown) =>
      JSON.stringify({ timestamp: "2026-09-21T13:27:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } });
    p.push(tc({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }));
    p.push(tc({ input_tokens: "x", output_tokens: null }));
    p.push(tc(null));
    p.push(JSON.stringify({ timestamp: "2026-09-21T13:27:00.000Z", type: "event_msg", payload: { type: "token_count", info: null } }));
    expect(p.summary().tokens).toEqual({ input: 60, cacheRead: 40, cacheCreation: 0, output: 10, reasoning: 0, total: 110 });
  });

  it("zieht gelesenen und geschriebenen Cache vom Input ab (Codex zählt beides im Input mit)", () => {
    const p = new CodexSessionParser(MAIN);
    p.push(
      JSON.stringify({
        timestamp: "2026-09-21T13:27:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 105 } },
        },
      }),
    );
    expect(p.summary().tokens).toEqual({ input: 50, cacheRead: 30, cacheCreation: 20, output: 5, reasoning: 1, total: 105 });
  });

  it("wertet einen ungültigen Zeitstempel als Fehler und erzeugt kein Event", () => {
    const p = new CodexSessionParser(MAIN);
    const line = JSON.stringify({
      timestamp: "kaputt",
      type: "event_msg",
      payload: { type: "item_completed", thread_id: MAIN, item: { type: "AgentMessage", id: "a", content: [] } },
    });
    expect(p.push(line)).toEqual([]);
    expect(p.summary().parseErrors).toBe(1);
    expect(p.summary().lastActivityAt).toBeNull();
  });

  it("übersteht Items mit fehlenden Feldern", () => {
    const p = new CodexSessionParser(MAIN);
    const item = (it: unknown) =>
      JSON.stringify({ timestamp: "2026-09-21T13:27:00.000Z", type: "event_msg", payload: { type: "item_completed", thread_id: MAIN, item: it } });
    for (const it of [null, 5, { type: "FileChange", id: "f", changes: null }, { type: "CommandExecution", id: "c", parsed_cmd: "x" }, { type: "McpToolCall", id: "m" }]) {
      expect(() => p.push(item(it))).not.toThrow();
    }
    const s = p.summary();
    expect(SessionSummarySchema.safeParse(s).success).toBe(true);
    expect(s.filesWritten).toEqual([]);
    expect(s.toolCalls).toEqual({ apply_patch: 1, exec_command: 1, "mcp:?/?": 1 });
  });
});

describe("Codex-Parser: Lücken aus der Kritiker-Prüfung", () => {
  it("baut das session_meta-Event einer Sub-Agent-Datei aus der eigenen, nicht der kopierten Eltern-Kopfzeile", () => {
    const { events } = feed(SUB, SUB_FILE);
    const meta = events.find((e) => e.kind === "session_meta");
    expect(meta?.data).toEqual({ cwd: "/Users/alex/projects/App", parentSessionId: MAIN });
    expect(meta?.ts).toBe("2026-09-21T13:27:14.600Z");
  });

  it("verarbeitet die Eltern-Kopfzeile allein gar nicht", () => {
    const p = new CodexSessionParser(SUB);
    const first = readFileSync(join(FIX, SUB_FILE), "utf8").split("\n")[0] ?? "";
    expect(p.push(first)).toEqual([]);
    expect(p.summary()).toMatchObject({ cwd: null, startedAt: null, lastActivityAt: null, cliVersion: null });
  });

  it("erkennt die Session-ID auch in Großbuchstaben und gibt sie klein zurück", () => {
    expect(codexSessionIdFromPath(`/x/rollout-2026-09-21T15-25-10-${MAIN.toUpperCase()}.jsonl`)).toBe(MAIN);
  });

  it("lässt einen Index-Eintrag ohne Zeitstempel gegen einen datierten verlieren", () => {
    const text = [
      JSON.stringify({ id: "x", thread_name: "Datiert", updated_at: "2026-09-21T13:00:00Z" }),
      JSON.stringify({ id: "x", thread_name: "Ohne Datum" }),
    ].join("\n");
    expect(parseCodexIndex(text).get("x")).toBe("Datiert");
  });

  it("lehnt nicht-ISO-Zeitstempel ab", () => {
    const p = new CodexSessionParser(MAIN);
    expect(p.push(JSON.stringify({ timestamp: "09/21/2026 13:00", type: "turn_context", payload: { model: "m" } }))).toEqual([]);
    expect(p.summary()).toMatchObject({ models: [], parseErrors: 1 });
  });
});
