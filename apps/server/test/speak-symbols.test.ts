import { describe, expect, it } from "vitest";
import { toSpeakText } from "../src/nyx/speak.js";

describe("Sprechfassung ohne Pfeile und Klammer-Zählungen", () => {
  it("liest Pfeile als Wort und lässt „(2)“ vor Doppelpunkt weg", () => {
    const s = toSpeakText("**Sortier-Vorschläge** (4): „Shop relevance“ → Audit?");
    expect(s).not.toMatch(/→|\(4\)/);
    expect(s).toContain("nach Audit");
  });
});
