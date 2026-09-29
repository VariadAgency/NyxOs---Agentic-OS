import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageScanner } from "../src/usage-scan.js";
import { noLog, sandbox, SID_A } from "./helpers.js";

/** Eine Claude-JSONL-Zeile mit `assistant`-Nachricht + `usage` (wie eine echte Antwort). */
function claudeAssistantLine(ts: string, messageId: string, inputTokens: number) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { id: messageId, model: "claude-sonnet-5", content: [{ type: "text", text: "x" }], usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

describe("UsageScanner ('Alle Projekte, aber ohne Inhalte')", () => {
  it("liest Sessions der Projektordner mit echtem sessionKey und project='projekte'", async () => {
    const s = sandbox();
    s.claudeMain();
    const scanner = new UsageScanner(s.cfg, join(s.home, "usage-state.json"), noLog);
    const rows = await scanner.scanOnce();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.tool).toBe("claude");
      expect(r.project).toBe("projekte");
      expect(r.sessionKey).toBe(`claude:${SID_A}`);
      // Strukturell nie Inhalt: nur die erwarteten Zahlen-/Modell-/Zeit-/ID-Felder
      // (`liveContextWindow` ist ein harmloses Extra-Feld von `extractClaudeUsageLine` — der
      // Server ignoriert unbekannte Felder beim Einlesen, s. `UsageIngestRowSchema`; `sourceId` =
      // Claude `message.id`, s. `usageEventId`).
      expect(Object.keys(r).sort()).toEqual(["cacheCreation1h", "cacheCreation5m", "cacheRead", "input", "liveContextWindow", "model", "output", "project", "reasoning", "sessionKey", "sourceId", "tool", "ts"]);
    }
  });

  it("meldet Sessions außerhalb der Projektordner nur als Zahlen, project='andere', kein sessionKey", async () => {
    const s = sandbox();
    s.claudeMain();
    const foreignDir = join(s.cfg.claudeDir, "projects", "-home-alex-anderes-projekt");
    mkdirSync(foreignDir, { recursive: true });
    copyFileSync(join(s.proj, `${SID_A}.jsonl`), join(foreignDir, "bbbbbbbb-0000-4000-8000-000000000002.jsonl"));

    const scanner = new UsageScanner(s.cfg, join(s.home, "usage-state.json"), noLog);
    const rows = await scanner.scanOnce();
    const foreign = rows.filter((r) => r.project === "andere");
    expect(foreign.length).toBeGreaterThan(0);
    for (const r of foreign) expect(r.sessionKey).toBeNull();
  });

  it("überspringt unveränderte Dateien beim zweiten Lauf (kein erneutes Einlesen)", async () => {
    const s = sandbox();
    s.claudeMain();
    const statePath = join(s.home, "usage-state.json");
    const scanner1 = new UsageScanner(s.cfg, statePath, noLog);
    const first = await scanner1.scanOnce();
    expect(first.length).toBeGreaterThan(0);
    const scanner2 = new UsageScanner(s.cfg, statePath, noLog);
    const second = await scanner2.scanOnce();
    expect(second).toHaveLength(0);
  });

  it("liest Codex: nur die letzte Antwort (last_token_usage), Kontextfenster live, Projekt aus cwd", async () => {
    const s = sandbox();
    const rolloutPath = join(s.cfg.codexDir, "sessions", "2026", "09", "24", "rollout-2026-09-24T10-00-00-cccccccc-0000-7000-8000-000000000003.jsonl");
    mkdirSync(join(s.cfg.codexDir, "sessions", "2026", "09", "24"), { recursive: true });
    const lines = [
      { type: "session_meta", timestamp: "2026-09-24T10:00:00.000Z", payload: { id: "cccccccc-0000-7000-8000-000000000003", timestamp: "2026-09-24T10:00:00.000Z", cwd: s.cfg.projectRoots[0], cli_version: "1.0.0" } },
      { type: "turn_context", timestamp: "2026-09-24T10:00:01.000Z", payload: { model: "gpt-6-astra", cwd: s.cfg.projectRoots[0] } },
      {
        type: "event_msg",
        timestamp: "2026-09-24T10:00:05.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 },
            last_token_usage: { input_tokens: 3195419, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 270243, reasoning_output_tokens: 45433, total_tokens: 3510095 },
            model_context_window: 258_400,
          },
        },
      },
    ];
    writeFileSync(rolloutPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const scanner = new UsageScanner(s.cfg, join(s.home, "usage-state.json"), noLog);
    const rows = await scanner.scanOnce();
    const codexRows = rows.filter((r) => r.tool === "codex");
    expect(codexRows).toHaveLength(1);
    expect(codexRows[0]).toMatchObject({ project: "projekte", model: "gpt-6-astra", input: 3195419, output: 270243, sessionKey: "codex:cccccccc-0000-7000-8000-000000000003" });
  });

  it("verwirft ein token_count-Ereignis mit UNVERÄNDERTEM total_token_usage (sonst weicht Codex ~5–7 % nach oben ab), zählt aber jeden echten Fortschritt", async () => {
    const s = sandbox();
    const rolloutPath = join(s.cfg.codexDir, "sessions", "2026", "09", "24", "rollout-2026-09-24T11-00-00-dddddddd-0000-7000-8000-000000000004.jsonl");
    mkdirSync(join(s.cfg.codexDir, "sessions", "2026", "09", "24"), { recursive: true });
    const tokenCount = (n: number, ts: string) => ({
      type: "event_msg",
      timestamp: ts,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: n, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: n + 1 },
          last_token_usage: { input_tokens: n, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: n + 1 },
          model_context_window: 258_400,
        },
      },
    });
    const lines = [
      { type: "session_meta", timestamp: "2026-09-24T11:00:00.000Z", payload: { id: "dddddddd-0000-7000-8000-000000000004", timestamp: "2026-09-24T11:00:00.000Z", cwd: s.cfg.projectRoots[0] } },
      { type: "turn_context", timestamp: "2026-09-24T11:00:01.000Z", payload: { model: "gpt-6-astra", cwd: s.cfg.projectRoots[0] } },
      tokenCount(1000, "2026-09-24T11:00:05.000Z"),
      tokenCount(1000, "2026-09-24T11:00:06.000Z"),
      tokenCount(2000, "2026-09-24T11:00:10.000Z"),
    ];
    writeFileSync(rolloutPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const rows = (await new UsageScanner(s.cfg, join(s.home, "usage-state.json"), noLog).scanOnce()).filter((r) => r.tool === "codex");
    // Die zweite Meldung (n=1000, identisches total_token_usage wie die erste) ist eine
    // Wiederholung ohne echten Fortschritt — verworfen, nicht nochmal gezählt. Die dritte (n=2000,
    // total_token_usage rückt weiter) ist ein echter neuer Turn und zählt.
    expect(rows.map((r) => r.input)).toEqual([1000, 2000]);
  });

  // Sub-Agent-Duplikate: ein Subagent-Verlauf wiederholt die geerbte
  // Eltern-Antwort (gleiche message.id) mit der EIGENEN Aufruf-Zeit — der Scan selbst dedupliziert
  // das (bewusst) nicht über Dateigrenzen hinweg (jede Datei wird für sich gelesen), aber liefert für
  // beide Vorkommen dieselbe `sourceId` mit, damit `usageEventId` (Server) sie zu EINEM Ereignis
  // zusammenführt (s. apps/server/test/usage.test.ts für den eigentlichen Dedup-Nachweis).
  it("liefert für eine Subagent-Kopie derselben Nachricht dieselbe sourceId wie die Eltern-Zeile (verschiedene ts)", async () => {
    const s = sandbox();
    const messageId = "msg_geteilt_mit_subagent";
    writeFileSync(join(s.proj, `${SID_A}.jsonl`), [claudeAssistantLine("2026-09-24T10:00:00.000Z", messageId, 5000)].join("\n") + "\n");
    const subDir = join(s.proj, SID_A, "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-a0000000000000009.jsonl"), [claudeAssistantLine("2026-09-24T10:00:20.000Z", messageId, 5000)].join("\n") + "\n");

    const rows = (await new UsageScanner(s.cfg, join(s.home, "usage-state.json"), noLog).scanOnce()).filter((r) => r.tool === "claude");
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first?.sourceId).toBe(messageId);
    expect(second?.sourceId).toBe(messageId);
    expect(first?.ts).not.toBe(second?.ts);
  });
});
