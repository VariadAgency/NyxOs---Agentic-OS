import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionEventSchema, SessionSummarySchema } from "../src/events.js";
import { isEmbeddingModel } from "../src/models.js";
import { ClaudeSessionParser, parseClaudeSubagentMeta } from "../src/parse/claude.js";
import { skillKeyFrom } from "../src/skills.js";

const FIX = join(import.meta.dirname, "fixtures", "claude");
const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";

function lines(file: string): string[] {
  return readFileSync(join(FIX, file), "utf8").split("\n");
}

function feed(sessionId: string, file: string) {
  const p = new ClaudeSessionParser(sessionId);
  const events = lines(file).flatMap((l) => p.push(l));
  return { p, events, summary: p.summary() };
}

function feedWithSubagent() {
  const p = new ClaudeSessionParser(SID_A);
  const events = lines("sess-a.jsonl").flatMap((l) => p.push(l));
  const agentId = "a0000000000000001";
  p.addSubagentMeta(agentId, parseClaudeSubagentMeta(readFileSync(join(FIX, "sess-a/subagents", `agent-${agentId}.meta.json`), "utf8")));
  events.push(...lines(`sess-a/subagents/agent-${agentId}.jsonl`).flatMap((l) => p.push(l, { agentId })));
  return { p, events, summary: p.summary() };
}

describe("Claude-Parser: Hauptdatei", () => {
  it("liest Kopf-Daten, Zeiten und den letzten KI-Titel", () => {
    const { summary } = feed(SID_A, "sess-a.jsonl");
    expect(summary.tool).toBe("claude");
    expect(summary.sessionId).toBe(SID_A);
    expect(summary.parentSessionId).toBeNull();
    expect(summary.cwd).toBe("/Users/alex/projects");
    expect(summary.title).toBe("Session-Liste bauen");
    expect(summary.titleSource).toBe("ai");
    expect(summary.startedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(summary.lastActivityAt).toBe("2026-09-24T10:05:04.000Z");
    expect(summary.gitBranch).toBe("main");
    expect(summary.cliVersion).toBe("2.1.281");
    expect(summary.parseErrors).toBe(0);
  });

  it("zählt Tokens pro Nachricht nur einmal, auch wenn eine Nachricht über mehrere Zeilen verteilt ist", () => {
    const { summary } = feed(SID_A, "sess-a.jsonl");
    expect(summary.tokens).toEqual({
      input: 24,
      output: 410,
      cacheRead: 30700,
      cacheCreation: 1400,
      reasoning: 150,
      total: 32534,
    });
  });

  it("sammelt Modelle in Reihenfolge des ersten Auftretens", () => {
    const { summary } = feed(SID_A, "sess-a.jsonl");
    expect(summary.models).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
  });

  it("zählt Werkzeug-Aufrufe und trennt geschriebene von gelesenen Dateien", () => {
    const { summary } = feed(SID_A, "sess-a.jsonl");
    expect(summary.toolCalls).toEqual({ Read: 1, Write: 1, Edit: 1, Agent: 1 });
    expect(summary.filesWritten).toEqual([
      "/Users/alex/projects/tools/NyxOS/a.ts",
      "/Users/alex/projects/memory.md",
    ]);
    expect(summary.filesRead).toEqual(["/Users/alex/projects/CLAUDE.md"]);
  });

  it("erkennt Sub-Agenten und verknüpft sie über das Ergebnis mit ihrer Agent-ID", () => {
    const { summary } = feed(SID_A, "sess-a.jsonl");
    expect(summary.subagents).toEqual([
      { id: "a0000000000000001", name: "Parser prüfen", type: "test-coverage-critic" },
    ]);
  });

  it("erzeugt pro Zeile mit UUID genau ein Event mit stabiler ID und richtiger Art", () => {
    const { events, summary } = feed(SID_A, "sess-a.jsonl");
    expect(events.map((e) => [e.id.split(":").at(-1), e.kind])).toEqual([
      ["u-0001", "prompt"],
      ["u-0002", "attachment"],
      ["u-0003", "thinking"],
      ["u-0004", "tool_call"],
      ["u-0005", "tool_result"],
      ["u-0006", "tool_call"],
      ["u-0007", "tool_result"],
      ["u-0008", "tool_call"],
      ["u-0009", "tool_call"],
      ["u-0010", "tool_result"],
      ["u-0011", "tool_result"],
      ["u-0012", "assistant"],
      ["u-0013", "system"],
      ["u-0014", "prompt"],
      ["u-0015", "assistant"],
    ]);
    expect(summary.eventCount).toBe(15);
    for (const e of events) {
      expect(SessionEventSchema.parse(e)).toEqual(e);
      expect(e.id).toBe(`claude:${SID_A}:${e.id.split(":").at(-1)}`);
      expect(e.source).toBe("file");
      expect(e.sessionId).toBe(SID_A);
    }
    expect(events[3]?.data).toMatchObject({ name: "Read", toolUseId: "toolu_R1", target: "/Users/alex/projects/CLAUDE.md" });
    expect(events[0]?.data).toMatchObject({ text: "Baue bitte die Liste der Sessions und prüfe die Tests" });
  });

  it("liefert dieselben Event-IDs bei erneutem Einlesen (idempotent)", () => {
    const a = feed(SID_A, "sess-a.jsonl").events.map((e) => e.id);
    const b = feed(SID_A, "sess-a.jsonl").events.map((e) => e.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it("ergibt eine gültige Zusammenfassung laut Schema", () => {
    const { summary } = feed(SID_A, "sess-a.jsonl");
    expect(() => SessionSummarySchema.parse(summary)).not.toThrow();
  });
});

describe("Claude-Parser: Sub-Agent-Dateien", () => {
  it("rechnet Tokens, Modelle, Dateien und Events der Sub-Agenten zur Session", () => {
    const { summary, events } = feedWithSubagent();
    expect(summary.tokens.input).toBe(124);
    expect(summary.tokens.output).toBe(460);
    expect(summary.tokens.total).toBe(32684);
    expect(summary.models).toEqual(["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    expect(summary.toolCalls.Write).toBe(2);
    expect(summary.filesWritten).toContain("/Users/alex/projects/tools/NyxOS/befund.md");
    expect(summary.eventCount).toBe(18);
    const sub = events.filter((e) => e.data.agentId === "a0000000000000001");
    expect(sub.map((e) => e.kind)).toEqual(["prompt", "tool_call", "tool_result"]);
    // Die Sub-Agent-Aktivität verschiebt das Ende nicht nach vorn:
    expect(summary.lastActivityAt).toBe("2026-09-24T10:05:04.000Z");
    // Sub-Agent-Prompt wird nie zum Session-Titel:
    expect(summary.title).toBe("Session-Liste bauen");
  });

  it("übernimmt Typ und Beschreibung aus der meta.json, wenn der Agent-Aufruf fehlt", () => {
    const p = new ClaudeSessionParser(SID_A);
    p.addSubagentMeta("a9", { agentType: "Explore", description: "Suche", toolUseId: "toolu_X" });
    expect(p.summary().subagents).toEqual([{ id: "a9", name: "Suche", type: "Explore" }]);
  });

  // UX-A Punkt 6 ("Kontext-Ring springt"): `lastUsage`/`lastUsageModel` sind die Grundlage für den
  // Kontext-Anteil (`apps/server/src/usage/query.ts` `sessionContext`) und dürfen NUR aus der
  // Haupt-Session kommen — ein Sub-Agent führt eine eigene, unabhängige Unterhaltung mit eigenem
  // (meist viel kleinerem) Kontextfenster-Füllstand. Die Fixtur füttert zuerst alle Haupt-Zeilen
  // (letzte Assistant-Zeile: Modell `claude-sonnet-5`, `cache_read_input_tokens: 7000`) und DANACH
  // die Sub-Agent-Zeile (Modell `claude-haiku-4-5-20251001`, `cache_read_input_tokens: 0`) — genau
  // die Reihenfolge, die den Fehler vorher auslöste (die zuletzt gepushte Zeile gewann, unabhängig
  // davon, ob sie zur Haupt-Session gehörte).
  it("lastUsage/lastUsageModel bleiben nach Sub-Agent-Zeilen bei der Haupt-Session (kein Springen)", () => {
    const { summary } = feedWithSubagent();
    expect(summary.lastUsageModel).toBe("claude-sonnet-5");
    expect(summary.lastUsage).toEqual({ input: 4, output: 30, cacheRead: 7000, cacheCreation: 0 });
  });
});

describe("Claude-Parser: Titel-Regeln", () => {
  it("nimmt einen selbst vergebenen Namen vor dem KI-Titel", () => {
    const { summary } = feed("cccccccc-0000-4000-8000-000000000003", "sess-custom.jsonl");
    expect(summary.title).toBe("Mein eigener Name");
    expect(summary.titleSource).toBe("custom");
  });

  it("nutzt bei Slash-Kommandos Kommando plus Argumente und überspringt Meta-Zeilen", () => {
    const { summary, events } = feed("bbbbbbbb-0000-4000-8000-000000000002", "sess-cmd.jsonl");
    expect(summary.titleSource).toBe("command");
    expect(summary.title).toBe("/goal Setze auftraege/P1-fundament/GOAL.md vollständig um, bis jeder Punkt unte…");
    expect(summary.title?.length).toBe(80);
    expect(summary.gitBranch).toBe("HEAD");
    expect(events.map((e) => e.kind)).toEqual(["system", "prompt", "assistant", "compaction"]);
  });

  it("kürzt den ersten Prompt auf 80 Zeichen, wenn es keinen anderen Titel gibt", () => {
    const { summary } = feed("dddddddd-0000-4000-8000-000000000004", "sess-prompt.jsonl");
    expect(summary.titleSource).toBe("prompt");
    expect(summary.title).toBe("Ein sehr langer erster Prompt, der deutlich mehr als achtzig Zeichen hat und de…");
  });

  it("nimmt eine Zusammenfassungszeile vor dem ersten Prompt", () => {
    const p = new ClaudeSessionParser("s1");
    p.push(lines("sess-prompt.jsonl")[0] ?? "");
    p.push(JSON.stringify({ type: "summary", summary: "Kurzfassung", leafUuid: "e-0001" }));
    expect(p.summary()).toMatchObject({ title: "Kurzfassung", titleSource: "summary" });
  });

  it("hat ohne jeden Hinweis keinen Titel", () => {
    const p = new ClaudeSessionParser("s1");
    expect(p.summary()).toMatchObject({ title: null, titleSource: null, startedAt: null, lastActivityAt: null });
  });
});

describe("Claude-Parser: Skill-Aufrufe", () => {
  it("schreibt bei einem Skill-Aufruf den Skill-Namen als 'target' (nicht mehr null)", () => {
    const p = new ClaudeSessionParser("s1");
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u-skill",
      timestamp: "2026-09-24T10:00:00.000Z",
      message: {
        id: "m-skill",
        model: "claude-opus-5-5",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_skill1", name: "Skill", input: { skill: "review", args: "" } }],
      },
    });
    const [event] = p.push(line);
    expect(event?.kind).toBe("tool_call");
    expect(event?.data).toMatchObject({ name: "Skill", toolUseId: "toolu_skill1", target: "review" });
  });

  it("ein anderer Werkzeug-Aufruf bleibt unverändert (Ziel weiter aus file_path/command/…)", () => {
    const p = new ClaudeSessionParser("s1");
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u-read",
      timestamp: "2026-09-24T10:00:00.000Z",
      message: {
        id: "m-read",
        model: "claude-opus-5-5",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/a/b.ts", skill: "sollte-ignoriert-werden" } }],
      },
    });
    const [event] = p.push(line);
    expect(event?.data).toMatchObject({ name: "Read", target: "/a/b.ts" });
  });

  it("ältere Eingabe-Form `command` und führender Schrägstrich ergeben ebenfalls den Namen", () => {
    const p = new ClaudeSessionParser("s1");
    const line = (id: string, input: Record<string, unknown>) =>
      JSON.stringify({ type: "assistant", uuid: `u-${id}`, timestamp: "2026-09-24T10:00:00.000Z", message: { id: `m-${id}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id, name: "Skill", input }] } });
    expect(p.push(line("t1", { command: "dataviz" }))[0]?.data).toMatchObject({ target: "dataviz" });
    expect(p.push(line("t2", { skill: "/ideen" }))[0]?.data).toMatchObject({ target: "ideen" });
    expect(p.push(line("t3", { skill: "anthropic-skills:dj-multicam-sync", args: "x" }))[0]?.data).toMatchObject({ target: "anthropic-skills:dj-multicam-sync" });
  });
});

describe("skillKeyFrom / isEmbeddingModel", () => {
  it("normalisiert Skill-Namen und lehnt Unsinn ab", () => {
    expect(skillKeyFrom("/dataviz")).toBe("dataviz");
    expect(skillKeyFrom("  ideen offene Einträge")).toBe("ideen");
    expect(skillKeyFrom("superpowers:brainstorming")).toBe("superpowers:brainstorming");
    for (const bad of [null, undefined, 3, "", "/", "../etc", "/Users/alex/x.ts"]) expect(skillKeyFrom(bad)).toBeNull();
  });

  it("erkennt Embedding-Modelle am Namen, Chat-Modelle nicht", () => {
    for (const m of ["text-embedding-nomic-embed-text-v1.5", "nomic-embed-text:latest", "text-embedding-3-small", "mxbai-embed-large", "bge-m3", "BAAI/bge-large-en-v1.5", "all-minilm", "snowflake-arctic-embed2", "jina-reranker-v2"]) {
      expect(isEmbeddingModel(m), m).toBe(true);
    }
    for (const m of ["qwen3-8b", "claude-haiku-4-5", "gpt-5-mini", "llama3.1:8b", "mistral-large-latest", "gemma-3-27b"]) expect(isEmbeddingModel(m), m).toBe(false);
  });
});

describe("Claude-Parser: lokale Befehle", () => {
  // Strukturgleich zur echten CLI-Ausgabe (s. Fixture `sess-cmd.jsonl`, dort `/goal` — ein
  // projekt-eigener Befehl, der zu einem echten Prompt expandiert und eine Antwort auslöst).
  // Lokale, eingebaute Befehle wie `/model`/`/clear`/`/login` kommen strukturell IDENTISCH an
  // (gleiche <command-name>/<command-args>-Form, kein `isMeta`), lösen aber NIE eine
  // Modell-Antwort aus — sie dürfen deshalb nicht als "prompt" (Runden-Inhalt) zählen.
  const commandLine = (name: string, args = "", uuid = "u-cmd") =>
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: "2026-09-24T10:00:00.000Z",
      sessionId: "s1",
      message: { role: "user", content: `<command-name>${name}</command-name>\n<command-message>x</command-message>\n<command-args>${args}</command-args>` },
    });

  it.each(["/login", "/clear", "/model", "/compact", "/mcp", "/help"])(
    "eingebauter lokaler Befehl %s wird 'system' (kein 'prompt', keine Runden-Rückfallregel, kein Titel)",
    (name) => {
      const p = new ClaudeSessionParser("s1");
      const [event] = p.push(commandLine(name, "opus"));
      expect(event?.kind).toBe("system");
      expect(event?.data).toMatchObject({ command: name, args: "opus", localCommand: true });
      expect(p.summary().title).toBeNull();
      expect(p.summary().titleSource).toBeNull();
    },
  );

  it("erkennt eingebaute Befehle unabhängig von führendem '/' und Groß-/Kleinschreibung", () => {
    const p = new ClaudeSessionParser("s1");
    const [a] = p.push(commandLine("MODEL", "", "u-1"));
    const [b] = p.push(commandLine("/Clear", "", "u-2"));
    expect(a?.kind).toBe("system");
    expect(b?.kind).toBe("system");
  });

  it("ein projekt-eigener Slash-Befehl (nicht in der eingebauten Liste) bleibt ein echter 'prompt' mit Titel (Regression zu sess-cmd.jsonl)", () => {
    const p = new ClaudeSessionParser("s1");
    const [event] = p.push(commandLine("/precommit", "bitte prüfen"));
    expect(event?.kind).toBe("prompt");
    expect(p.summary().title).toBe("/precommit bitte prüfen");
    expect(p.summary().titleSource).toBe("command");
  });

  it("ein isMeta-markierter lokaler Befehl (z. B. lokale Befehlsausgabe) war schon vorher 'system' (Regression)", () => {
    const p = new ClaudeSessionParser("s1");
    const [event] = p.push(
      JSON.stringify({
        type: "user",
        uuid: "u-out",
        timestamp: "2026-09-24T10:00:00.000Z",
        sessionId: "s1",
        isMeta: true,
        message: { role: "user", content: "<local-command-stdout>Model gesetzt auf opus</local-command-stdout>" },
      }),
    );
    expect(event?.kind).toBe("system");
  });
});

describe("Claude-Parser: kaputte Eingaben", () => {
  const good = () => lines("sess-a.jsonl")[1] ?? "";

  it("zählt ungültiges JSON als Fehler, stürzt nicht ab und liest danach weiter", () => {
    const p = new ClaudeSessionParser(SID_A);
    expect(p.push('{"type":"user","message":')).toEqual([]);
    expect(p.push("das ist kein json")).toEqual([]);
    expect(p.push(good())).toHaveLength(1);
    expect(p.summary().parseErrors).toBe(2);
    expect(p.summary().eventCount).toBe(1);
  });

  it("wertet JSON ohne Objekt (Zahl, null, Liste) als Fehler", () => {
    const p = new ClaudeSessionParser(SID_A);
    for (const l of ["42", "null", "[]", '"text"']) expect(p.push(l)).toEqual([]);
    expect(p.summary().parseErrors).toBe(4);
  });

  it("ignoriert Leerzeilen ohne Fehler", () => {
    const p = new ClaudeSessionParser(SID_A);
    expect(p.push("")).toEqual([]);
    expect(p.push("   ")).toEqual([]);
    expect(p.summary().parseErrors).toBe(0);
  });

  it("verwirft Zeilen mit ungültigem Zeitstempel, statt die Startzeit zu verfälschen", () => {
    const p = new ClaudeSessionParser(SID_A);
    const bad = JSON.parse(good()) as Record<string, unknown>;
    bad.timestamp = "gestern abend";
    bad.uuid = "u-bad";
    expect(p.push(JSON.stringify(bad))).toEqual([]);
    expect(p.summary().startedAt).toBeNull();
    expect(p.summary().parseErrors).toBe(1);
    p.push(good());
    expect(p.summary().startedAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("lässt kaputte Token-Zahlen (Text, negativ, Kommazahl) außen vor", () => {
    const p = new ClaudeSessionParser(SID_A);
    const line = (id: string, usage: unknown) =>
      JSON.stringify({
        type: "assistant",
        uuid: `u-${id}`,
        timestamp: "2026-09-24T10:00:00.000Z",
        message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "x" }], usage },
      });
    p.push(line("m1", { input_tokens: "viele", output_tokens: -5, cache_read_input_tokens: 1.5 }));
    p.push(line("m2", { input_tokens: 7, output_tokens: 3 }));
    p.push(line("m3", "kein objekt"));
    const t = p.summary().tokens;
    expect(t).toEqual({ input: 7, output: 3, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 10 });
    expect(Number.isInteger(t.total)).toBe(true);
  });

  it("verkraftet fehlende oder falsch typisierte Inhalte ohne Absturz", () => {
    const p = new ClaudeSessionParser(SID_A);
    const base = { uuid: "u-x", timestamp: "2026-09-24T10:00:00.000Z" };
    const variants = [
      { ...base, type: "assistant", message: null },
      { ...base, uuid: "u-y", type: "assistant", message: { content: "nur text" } },
      { ...base, uuid: "u-z", type: "user", message: { content: [null, 5, { type: "tool_result" }] } },
      { ...base, uuid: "u-w", type: "assistant", message: { content: [{ type: "tool_use", name: 7, input: null }] } },
    ];
    for (const v of variants) expect(() => p.push(JSON.stringify(v))).not.toThrow();
    const s = p.summary();
    expect(SessionSummarySchema.safeParse(s).success).toBe(true);
    expect(s.toolCalls).toEqual({ unbekannt: 1 });
    expect(s.filesWritten).toEqual([]);
  });

  it("ignoriert Zeilen einer fremden Session", () => {
    const p = new ClaudeSessionParser(SID_A);
    const other = JSON.parse(good()) as Record<string, unknown>;
    other.sessionId = "ffffffff-0000-4000-8000-00000000ffff";
    expect(p.push(JSON.stringify(other))).toEqual([]);
    expect(p.summary().startedAt).toBeNull();
    // Gezählt, damit die Brücke eine Datei ohne eigene Zeilen melden kann statt sie still zu schlucken.
    expect(p.onlyForeignLines()).toEqual({ sessionId: "ffffffff-0000-4000-8000-00000000ffff", lines: 1 });
    p.push(good());
    expect(p.onlyForeignLines()).toBeNull();
  });
});

describe("Claude-Parser: Lücken aus der Kritiker-Prüfung", () => {
  const base = (over: Record<string, unknown>) =>
    JSON.stringify({ type: "user", uuid: "u-1", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/Users/alex/projects", message: { role: "user", content: "Haupt-Prompt" }, ...over });

  it("lehnt Zeitstempel ab, die JavaScript zwar versteht, die aber kein ISO-Format sind", () => {
    const p = new ClaudeSessionParser("s1");
    expect(p.push(base({ timestamp: "09/24/2026 10:00:00" }))).toEqual([]);
    expect(p.push(base({ uuid: "u-2", timestamp: "Thu Sep 24 2026 10:00:00 GMT+0200" }))).toEqual([]);
    expect(p.summary()).toMatchObject({ startedAt: null, parseErrors: 2 });
  });

  it("nimmt den KI-Titel vor der Zusammenfassungszeile, egal in welcher Reihenfolge sie kommen", () => {
    for (const order of [["ai", "summary"], ["summary", "ai"]]) {
      const p = new ClaudeSessionParser("s1");
      for (const k of order) {
        p.push(k === "ai" ? JSON.stringify({ type: "ai-title", aiTitle: "KI" }) : JSON.stringify({ type: "summary", summary: "Zusammenfassung" }));
      }
      expect(p.summary()).toMatchObject({ title: "KI", titleSource: "ai" });
    }
  });

  it("macht einen Sub-Agent-Prompt nie zum Titel, auch wenn die Sub-Agent-Datei zuerst gelesen wird", () => {
    const p = new ClaudeSessionParser("s1");
    p.push(base({ uuid: "s-1", message: { role: "user", content: "Sub-Agent-Auftrag" } }), { agentId: "a1" });
    expect(p.summary().title).toBeNull();
    p.push(base({}));
    expect(p.summary()).toMatchObject({ title: "Haupt-Prompt", titleSource: "prompt" });
  });

  it("übernimmt Arbeitsordner, Zweig und Version nie aus Sub-Agent-Zeilen", () => {
    const p = new ClaudeSessionParser("s1");
    p.push(base({ uuid: "s-1", cwd: "/tmp/anders", gitBranch: "fremd", version: "9.9.9" }), { agentId: "a1" });
    expect(p.summary()).toMatchObject({ cwd: null, gitBranch: null, cliVersion: null });
    p.push(base({ gitBranch: "main", version: "2.1.281" }));
    p.push(base({ uuid: "s-2", cwd: "/tmp/anders", gitBranch: "fremd", version: "9.9.9" }), { agentId: "a1" });
    expect(p.summary()).toMatchObject({ cwd: "/Users/alex/projects", gitBranch: "main", cliVersion: "2.1.281" });
  });
});
