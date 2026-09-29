// Vorlage „Kurz & knapp“ versprach früher 1–2 Sätze, die Antwort hatte 6.
// Jetzt: die Länge steht als letzte, harte Regel im System-Prompt (zuletzt gelesen, vor Werkzeug-/Beleg-Abschnitten
// nicht mehr überstimmt), und die Token-Grenze aus behaviorHints wirkt auch im Claude-Programm (CLI).
import { BUILTIN_NYX_PRESETS, DEFAULT_NYX_PROFILE, type NyxProfile } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { ClaudeCliEngine } from "../src/haiku/claudeCli.js";
import { buildNyxSystemPrompt } from "../src/nyx/prompt.js";

const kurz = BUILTIN_NYX_PRESETS.find((p) => p.id === "kurz-knapp");
const KURZ: NyxProfile = { ...DEFAULT_NYX_PROFILE, sliders: { ...DEFAULT_NYX_PROFILE.sliders, ...(kurz?.sliders ?? {}) } };
const TOOLS = ["memory", "todo", "schedule", "show_link"];

describe("„Kurz & knapp“ wirkt wirklich", () => {
  it("harte Längen-Regel steht ganz am Ende des Prompts (Web und Telegram)", () => {
    for (const channel of ["web", "telegram"] as const) {
      const p = buildNyxSystemPrompt({ memoryBlock: "", tools: TOOLS, channel, profile: KURZ });
      const tail = p.slice(-400);
      expect(tail).toMatch(/Länge – zuletzt und verbindlich/);
      expect(tail).toMatch(/höchstens zwei Sätze/);
    }
  });

  it("mittlere/lange Einstellung bekommt keine harte Kurz-Regel", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: TOOLS, channel: "web", profile: { ...DEFAULT_NYX_PROFILE, sliders: { ...DEFAULT_NYX_PROFILE.sliders, length: 80 } } });
    expect(p).not.toMatch(/Länge – zuletzt und verbindlich/);
  });

  it("KEINE Token-Grenze ans Claude-Programm – sie brach lange Antworten ab bzw. zerlegte sie (Anfang fehlte)", () => {
    const e = new ClaudeCliEngine({ apiUrl: "http://x", env: { PATH: "/bin" } });
    expect(e.envFor({ maxTokens: 400 }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(e.envFor({}).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });
});
