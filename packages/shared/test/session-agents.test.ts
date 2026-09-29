// Agents in the session chat: live tokens of a sub-agent. The parser attaches usage (`usage`), the message id
// (`msgId`) and the model to the FIRST event of every sub-agent answer — the server sums per agent (per `msgId`
// only the largest value, because one answer spans several lines with growing usage).
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../src/i18n/index.js";
import { ClaudeSessionParser } from "../src/parse/claude.js";
import { agentElapsedMs, formatAgentElapsed, mergeAgentTokens, splitCodexTitle } from "../src/session-agents.js";

afterEach(() => setLang("de"));

const line = (over: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    uuid: "u-1",
    sessionId: "s1",
    timestamp: "2026-09-28T10:00:00.000Z",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      role: "assistant",
      content: [
        { type: "text", text: "Ich lese die Datei." },
        { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x.ts" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    },
    ...over,
  });

describe("session agents: usage on sub-agent answers", () => {
  it("attaches usage/msgId/model only to the first event of a sub-agent answer", () => {
    const p = new ClaudeSessionParser("s1");
    const evs = p.push(line({}), { agentId: "a1" });
    expect(evs).toHaveLength(2);
    expect(evs[0]?.data).toMatchObject({ agentId: "a1", msgId: "msg_1", model: "claude-opus-5-5", usage: { input: 10, output: 5, cacheRead: 100, cacheCreation: 20 } });
    expect(evs[1]?.data.usage).toBeUndefined();
  });

  it("leaves main-session lines unchanged (their tokens already come via the summary)", () => {
    const p = new ClaudeSessionParser("s1");
    const evs = p.push(line({}));
    expect(evs[0]?.data.usage).toBeUndefined();
    expect(evs[0]?.data.msgId).toBeUndefined();
  });

  it("passes the final report (SubagentHandback.message) as text on the tool call", () => {
    const p = new ClaudeSessionParser("s1");
    const evs = p.push(
      JSON.stringify({
        type: "assistant",
        uuid: "u-9",
        sessionId: "s1",
        timestamp: "2026-09-28T10:00:00.000Z",
        message: { id: "msg_9", role: "assistant", content: [{ type: "tool_use", id: "tu9", name: "SubagentHandback", input: { message: "Fertig: alles grün." } }] },
      }),
      { agentId: "a1" },
    );
    expect(evs[0]?.data).toMatchObject({ name: "SubagentHandback", text: "Fertig: alles grün.", agentId: "a1" });
  });

  it("takes the larger of live sum and archive digest (both are lower bounds)", () => {
    const live = { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 };
    const archived = { input: 5, output: 5, cacheRead: 0, cacheCreation: 0, total: 10 };
    expect(mergeAgentTokens(live, archived)).toBe(archived);
    expect(mergeAgentTokens(archived, null)).toBe(archived);
    expect(mergeAgentTokens(null, null)).toBeNull();
  });
});

describe("session agents: elapsed time", () => {
  const now = Date.parse("2026-09-28T10:10:00.000Z");
  it("running: from start until now; done: start until last activity", () => {
    expect(agentElapsedMs({ status: "running", startedAt: "2026-09-28T10:00:00.000Z", endedAt: null, lastActivityAt: "2026-09-28T10:09:00.000Z" }, now)).toBe(600_000);
    expect(agentElapsedMs({ status: "done", startedAt: "2026-09-28T10:00:00.000Z", endedAt: "2026-09-28T10:03:30.000Z", lastActivityAt: null }, now)).toBe(210_000);
    expect(agentElapsedMs({ status: "done", startedAt: null, endedAt: null, lastActivityAt: null }, now)).toBeNull();
    // Clocks of computer and browser differ slightly: never negative.
    expect(agentElapsedMs({ status: "running", startedAt: "2026-09-28T10:10:05.000Z", endedAt: null, lastActivityAt: null }, now)).toBe(0);
  });

  it("shows seconds below one hour (the number visibly ticks)", () => {
    expect(formatAgentElapsed(null)).toBe("—");
    expect(formatAgentElapsed(7_000)).toBe("0:07");
    expect(formatAgentElapsed(247_000)).toBe("4:07");
    expect(formatAgentElapsed(3_600_000 + 4 * 60_000 + 9_000)).toBe("1:04:09");
    expect(formatAgentElapsed(26 * 3_600_000)).toBe("1 T 2 h");
    setLang("en");
    expect(formatAgentElapsed(26 * 3_600_000)).toBe("1 d 2 h");
    expect(formatAgentElapsed(48 * 3_600_000)).toBe("2 d");
  });
});

describe("session agents: Codex teammates", () => {
  it("separates the nickname (“Locke:”) from the task", () => {
    expect(splitCodexTitle("Locke: Prüfe die Tests")).toEqual({ name: "Locke", task: "Prüfe die Tests" });
    expect(splitCodexTitle("Ohne Spitzname")).toEqual({ name: null, task: "Ohne Spitzname" });
    expect(splitCodexTitle("zwei Wörter: davor")).toEqual({ name: null, task: "zwei Wörter: davor" });
    expect(splitCodexTitle(null)).toEqual({ name: null, task: null });
  });
});
