import { describe, expect, it } from "vitest";
import { extractClaudeUsageLine, extractCodexModelLine, extractCodexUsageLine } from "../src/parse/usage-extract.js";

const claudeLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-19T10:00:00.000Z",
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      content: [{ type: "text", text: "geheimer Inhalt, darf nie gelesen werden" }],
      usage: {
        input_tokens: 472,
        output_tokens: 178041,
        cache_read_input_tokens: 81677137,
        cache_creation_input_tokens: 842207,
        cache_creation: { ephemeral_1h_input_tokens: 842207, ephemeral_5m_input_tokens: 0 },
        output_tokens_details: { thinking_tokens: 10 },
      },
      ...over,
    },
  });

describe("extractClaudeUsageLine", () => {
  it("liest Modell/Zeit/Tokens, nie den Nachrichtentext", () => {
    const { row } = extractClaudeUsageLine(claudeLine(), null);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      ts: "2026-08-19T10:00:00.000Z",
      model: "claude-opus-5",
      input: 472,
      output: 178041,
      cacheRead: 81677137,
      cacheCreation1h: 842207,
      cacheCreation5m: 0,
      reasoning: 10,
      sourceId: "msg_1",
    });
    expect(JSON.stringify(row)).not.toContain("geheimer Inhalt");
  });

  // Sub-Agent-Duplikate: ein Subagent-Verlauf wiederholt die geerbte
  // Eltern-Antwort (gleiche message.id, gleiche usage) mit der EIGENEN Aufruf-Zeit statt der
  // ursprünglichen — ein Schlüssel aus (ts, Zahlen) würde das nicht erkennen. `sourceId` (=
  // message.id) bleibt aber unabhängig von `ts` stabil, damit `usageEventId` (apps/server) das
  // Duplikat trotz unterschiedlicher Zeit erkennt.
  it("liefert dieselbe sourceId auch bei anderer Zeit (Subagent-Kopie derselben Nachricht)", () => {
    const subagentTs = "2026-09-06T21:58:06.071Z";
    const parent = extractClaudeUsageLine(claudeLine(), null);
    const subagentCopy = extractClaudeUsageLine(JSON.stringify({ ...JSON.parse(claudeLine()), timestamp: subagentTs }), null);
    expect(parent.row?.sourceId).toBe("msg_1");
    expect(subagentCopy.row?.sourceId).toBe("msg_1");
    expect(parent.row?.ts).toBe("2026-08-19T10:00:00.000Z");
    expect(subagentCopy.row?.ts).toBe(subagentTs);
  });

  it("zählt eine mehrteilige Antwort (gleiche message.id) nur einmal", () => {
    const line = claudeLine();
    const first = extractClaudeUsageLine(line, null);
    expect(first.row).not.toBeNull();
    const second = extractClaudeUsageLine(line, first.lastMessageId);
    expect(second.row).toBeNull();
  });

  it("ignoriert Zeilen ohne usage (z. B. user-Nachrichten)", () => {
    const { row } = extractClaudeUsageLine(JSON.stringify({ type: "user", timestamp: "2026-08-19T10:00:00.000Z" }), null);
    expect(row).toBeNull();
  });

  it("ignoriert kaputte Zeilen", () => {
    expect(extractClaudeUsageLine("{kaputt", null).row).toBeNull();
  });

  it("behandelt <synthetic> nicht als Modell", () => {
    const { row } = extractClaudeUsageLine(claudeLine({ model: "<synthetic>" }), null);
    expect(row?.model).toBeNull();
  });
});

const codexLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-09-07T10:00:00.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 110 },
        last_token_usage: { input_tokens: 3195419, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 270243, reasoning_output_tokens: 45433, total_tokens: 3510095 },
        model_context_window: 258_400,
      },
      ...over,
    },
  });

describe("extractCodexUsageLine", () => {
  it("nutzt last_token_usage (nur die letzte Antwort), nicht die kumulative Summe", () => {
    const { row } = extractCodexUsageLine(codexLine(), "gpt-6-astra", null);
    expect(row).toMatchObject({ ts: "2026-09-07T10:00:00.000Z", model: "gpt-6-astra", input: 3195419, output: 270243, reasoning: 45433, liveContextWindow: 258_400, sourceId: null });
  });

  it("liefert null bei anderen event_msg-Arten", () => {
    expect(extractCodexUsageLine(JSON.stringify({ type: "event_msg", timestamp: "2026-09-07T10:00:00.000Z", payload: { type: "task_started" } }), null, null).row).toBeNull();
  });

  // Codex wich ~5–7 % nach oben ab (Ursache, mit echten ~/.codex/sessions-
  // Verläufen an allen 4 bekannten Tagen exakt gegen ccusage geprüft): Codex meldet manchmal ein
  // weiteres `token_count`-Ereignis, dessen `last_token_usage` eine vorherige Meldung 1:1 wiederholt,
  // OHNE dass das kumulative `total_token_usage` weitergerückt ist (z. B. ein Limit-Update ohne
  // neuen Turn). Naives Aufsummieren jedes Ereignisses zählt diese Wiederholung ein zweites Mal.
  it("zählt ein token_count-Ereignis mit UNVERÄNDERTEM total_token_usage nicht doppelt", () => {
    const total = { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 110 };
    const last = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 };
    const line = codexLine({ info: { total_token_usage: total, last_token_usage: last, model_context_window: 258_400 } });
    const first = extractCodexUsageLine(line, "gpt-6-astra", null);
    expect(first.row).toMatchObject({ input: 100, output: 10 });
    // Zweites Ereignis: gleiches total_token_usage (nicht weitergerückt), last_token_usage wird
    // trotzdem erneut gemeldet — muss verworfen werden (0 neue Tokens), nicht nochmal gezählt.
    const second = extractCodexUsageLine(line, "gpt-6-astra", first.previousTotals);
    expect(second.row).toBeNull();
  });

  // Gegenprobe zum verworfenen ersten Fix-Versuch (Bericht "Offene Punkte"): zwei ECHTE,
  // aufeinanderfolgende Antworten mit zufällig GLEICH GROSSEM last_token_usage (aber
  // fortschreitendem total_token_usage) dürfen NICHT als Duplikat verworfen werden.
  it("verwirft last_token_usage NICHT nur weil er wie die letzte Meldung aussieht, solange total_token_usage weiterrückt", () => {
    const last = { input_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55 };
    const line1 = codexLine({ info: { total_token_usage: { input_tokens: 50, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 55 }, last_token_usage: last, model_context_window: 258_400 } });
    const line2 = codexLine({ info: { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 110 }, last_token_usage: last, model_context_window: 258_400 } });
    const first = extractCodexUsageLine(line1, "gpt-6-astra", null);
    const second = extractCodexUsageLine(line2, "gpt-6-astra", first.previousTotals);
    expect(first.row).toMatchObject({ input: 50, output: 5 });
    expect(second.row).toMatchObject({ input: 50, output: 5 }); // echte zweite Antwort, gleich groß wie die erste — zählt trotzdem
  });

  it("nutzt bei fehlendem last_token_usage die Differenz aus total_token_usage", () => {
    const line1 = codexLine({ info: { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 110 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }, model_context_window: 258_400 } });
    const line2 = codexLine({ info: { total_token_usage: { input_tokens: 150, output_tokens: 20, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 170 }, model_context_window: 258_400 } }); // kein last_token_usage
    const first = extractCodexUsageLine(line1, "gpt-6-astra", null);
    const second = extractCodexUsageLine(line2, "gpt-6-astra", first.previousTotals);
    expect(second.row).toMatchObject({ input: 50, output: 10 });
  });
});

describe("extractCodexModelLine", () => {
  it("liest das Modell aus turn_context", () => {
    expect(extractCodexModelLine(JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }))).toBe("gpt-6-astra");
  });
  it("liefert null bei anderen Zeilen", () => {
    expect(extractCodexModelLine(JSON.stringify({ type: "session_meta", payload: {} }))).toBeNull();
  });
});
