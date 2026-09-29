// „Kontext komprimieren“ – echte Zeilenfolge aus einer Claude-Session (gekürzt).
// Die Zusammenfassung für den neuen Kontext und das getippte „/compact“ sind KEINE Nachrichten vom Nutzer:
// kein „prompt“, kein Session-Titel. Die Komprimierung selbst trägt, ob der Nutzer sie ausgelöst hat (manual).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSessionParser } from "../src/parse/claude.js";

const SID = "cccccccc-0000-4000-8000-00000000c0c0";

function feed() {
  const p = new ClaudeSessionParser(SID);
  const raw = readFileSync(join(import.meta.dirname, "fixtures", "claude", "sess-compact.jsonl"), "utf8");
  const events = raw.split("\n").flatMap((l) => p.push(l));
  return { events, summary: p.summary() };
}

describe("Komprimierung im Claude-Verlauf", () => {
  it("nur die echte Frage ist ein prompt – weder „/compact“ noch die Zusammenfassung", () => {
    const { events } = feed();
    const prompts = events.filter((e) => e.kind === "prompt").map((e) => (e.data as { text?: string }).text);
    expect(prompts).toEqual(["Schreib mir bitte eine kurze Liste"]);
  });

  it("compact_boundary wird zu „compaction“ mit dem Auslöser (manual/auto)", () => {
    const { events } = feed();
    const c = events.filter((e) => e.kind === "compaction");
    expect(c).toHaveLength(1);
    expect(c[0]?.data).toMatchObject({ trigger: "manual" });
  });

  it("die Zusammenfassung wird nie Session-Titel", () => {
    const { summary } = feed();
    expect(summary.title ?? "").not.toMatch(/continued|compact/i);
  });
});
