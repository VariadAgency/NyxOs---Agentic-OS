// Nichts wird stillschweigend gekürzt. Der Chat (Transkript-Route) bekommt den vollen Text;
// nur die Ereignisse für Index/Vorschau (Brücke → DB) bleiben gekürzt – und tragen dann eine Marke.
import { describe, expect, it } from "vitest";
import { ClaudeSessionParser } from "../src/parse/claude.js";
import { CodexSessionParser } from "../src/parse/codex.js";
import { EVENT_TEXT_MAX } from "../src/parse/common.js";

const SID = "dddddddd-0000-4000-8000-000000000011";
const CODEX = "01a0c424-0000-7000-8000-0000000d11d1";

/** 3.000 Zeichen mit erkennbarem Anfang und Ende. */
const LONG = `ANFANG-${"x".repeat(3000 - "ANFANG-".length - "-ENDE".length)}-ENDE`;

function claudeLines(): string[] {
  const base = { isSidechain: false, cwd: "/Users/alex/projects", sessionId: SID, version: "2.1.282" };
  return [
    JSON.stringify({ ...base, type: "user", uuid: "u-1", timestamp: "2026-09-25T10:00:00.000Z", message: { role: "user", content: LONG } }),
    JSON.stringify({
      ...base,
      type: "assistant",
      uuid: "u-2",
      timestamp: "2026-09-25T10:00:05.000Z",
      message: { model: "claude-opus-5-5", id: "msg_1", role: "assistant", content: [{ type: "text", text: LONG }] },
    }),
  ];
}

function codexLines(): string[] {
  const ev = (id: string, type: string, ts: string) =>
    JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", thread_id: CODEX, turn_id: "t-1", item: { type, id, content: [{ type: "text", text: LONG }] } } });
  return [ev("um-1", "UserMessage", "2026-09-25T10:00:00.000Z"), ev("am-1", "AgentMessage", "2026-09-25T10:00:05.000Z")];
}

describe("voller Text statt stiller Kürzung", () => {
  it("Claude: im Volltext-Modus (Chat) kommen alle 3.000 Zeichen an, Anfang und Ende", () => {
    const p = new ClaudeSessionParser(SID, { textMax: null });
    const events = claudeLines().flatMap((l) => p.push(l));
    const prompt = events.find((e) => e.kind === "prompt");
    const answer = events.find((e) => e.kind === "assistant");
    expect(prompt?.data.text).toBe(LONG);
    expect(answer?.data.text).toBe(LONG);
    expect(prompt?.data.textTruncated).toBeUndefined();
  });

  it("Claude: Standard (Index/Vorschau) kürzt weiter, aber sichtbar markiert mit echter Länge", () => {
    const p = new ClaudeSessionParser(SID);
    const events = claudeLines().flatMap((l) => p.push(l));
    const prompt = events.find((e) => e.kind === "prompt");
    expect(String(prompt?.data.text).length).toBe(EVENT_TEXT_MAX);
    expect(String(prompt?.data.text).startsWith("ANFANG-")).toBe(true);
    expect(prompt?.data.textTruncated).toBe(true);
    expect(prompt?.data.textLength).toBe(3000);
    const answer = events.find((e) => e.kind === "assistant");
    expect(answer?.data.textTruncated).toBe(true);
  });

  it("Codex: Volltext-Modus liefert alles, Standard markiert die Kürzung", () => {
    const full = new CodexSessionParser(CODEX, { textMax: null });
    const fullEvents = codexLines().flatMap((l) => full.push(l));
    expect(fullEvents.find((e) => e.kind === "prompt")?.data.text).toBe(LONG);
    expect(fullEvents.find((e) => e.kind === "assistant")?.data.text).toBe(LONG);

    const short = new CodexSessionParser(CODEX);
    const shortEvents = codexLines().flatMap((l) => short.push(l));
    const prompt = shortEvents.find((e) => e.kind === "prompt");
    expect(prompt?.data.textTruncated).toBe(true);
    expect(prompt?.data.textLength).toBe(3000);
  });

  it("eingefügter langer Text (Claude Code: <pasted_content>) ist eine normale Nachricht von Alex, kein versteckter Hinweis", () => {
    // Echte Zeile aus Claude Code 2.1.282: lange Einfügungen landen so im Verlauf.
    const content = `  <pasted_content id="22d3">\n${LONG}\n</pasted_content id="22d3">  `;
    const p = new ClaudeSessionParser(SID, { textMax: null });
    const [ev] = p.push(JSON.stringify({ type: "user", uuid: "u-7", timestamp: "2026-09-25T10:00:00.000Z", sessionId: SID, message: { role: "user", content } }));
    expect(ev?.kind).toBe("prompt");
    expect(ev?.data.text).toBe(LONG);
    const mixed = new ClaudeSessionParser(SID, { textMax: null });
    const [ev2] = mixed.push(JSON.stringify({ type: "user", uuid: "u-8", timestamp: "2026-09-25T10:00:00.000Z", sessionId: SID, message: { role: "user", content: `Schau mal:\n<pasted_content id="a1">\nZeile\n</pasted_content id="a1">` } }));
    expect(ev2?.data.text).toBe("Schau mal:\nZeile");
  });

  it("kurze Texte tragen nie eine Kürzungs-Marke", () => {
    const p = new ClaudeSessionParser(SID);
    const line = JSON.stringify({ type: "user", uuid: "u-9", timestamp: "2026-09-25T10:00:00.000Z", sessionId: SID, message: { role: "user", content: "kurz" } });
    const [ev] = p.push(line);
    expect(ev?.data).toEqual({ text: "kurz" });
  });
});
