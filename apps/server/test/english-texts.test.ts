// English mode: server texts must not fall back to German – quotes, Telegram commands, spoken briefing,
// persona texts and briefings that were written before the language switch.
import { DEFAULT_NYX_PROFILE, NYX_SLIDER_STAGES, quote, setLang } from "@nyxos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { generateReport, latestReport } from "../src/haiku/report.js";
import { speakEnglish } from "../src/haiku/speech.js";
import { telegramCommands } from "../src/telegram/service.js";
import { setupAssistant } from "./assistant/assistant-helpers.js";

afterEach(() => setLang("de"));

describe("English texts", () => {
  it("quotes with the marks of the language", () => {
    expect(quote("Build", "de")).toBe("„Build“");
    expect(quote("Build", "en")).toBe("“Build”");
  });

  it("Telegram menu uses English command names in English, German ones in German", () => {
    setLang("en");
    const en = telegramCommands().map((c) => c.command);
    expect(en).toEqual(expect.arrayContaining(["new", "temporary", "help"]));
    expect(en).not.toContain("neu");
    expect(telegramCommands().find((c) => c.command === "new")?.description).toBe("Start a new session");
    setLang("de");
    expect(telegramCommands().map((c) => c.command)).toEqual(expect.arrayContaining(["neu", "temporaer", "hilfe"]));
  });

  it("speaks short units and US dates as words", () => {
    expect(speakEnglish("7-day peak: 28.1M in 5 h")).toBe("7-day peak: 28.1 million in 5 hours");
    expect(speakEnglish("1 h ago, 950K tokens · 14 d")).toBe("1 hour ago, 950 thousand tokens, 14 days");
    expect(speakEnglish("3 sessions failed on 09/26")).toBe("3 sessions failed on September 26");
  });

  it("persona stages and default personality follow the app language", () => {
    setLang("en");
    expect(NYX_SLIDER_STAGES.length[1]).toBe("Answer briefly: a few sentences, most important first.");
    expect(DEFAULT_NYX_PROFILE.personality.tone).toBe("Friendly and clear, no filler.");
    expect(JSON.parse(JSON.stringify(DEFAULT_NYX_PROFILE)).personality.character).toMatch(/^Right hand/);
    setLang("de");
    expect(NYX_SLIDER_STAGES.length[1]).toBe("Antworte kurz: wenige Sätze, das Wichtigste zuerst.");
  });

  it("a briefing written in German counts as stale once the app is English (it gets rewritten)", async () => {
    const t = await setupAssistant();
    const now = new Date("2026-09-25T12:30:00Z");
    setLang("de");
    await generateReport(t.runtime, "briefing", now);
    expect((await latestReport(t.db, "briefing", now))?.stale).toBe(false);
    setLang("en");
    expect((await latestReport(t.db, "briefing", now))?.stale).toBe(true);
    await generateReport(t.runtime, "briefing", now);
    const fresh = await latestReport(t.db, "briefing", now);
    expect(fresh?.stale).toBe(false);
    expect(fresh?.lang).toBe("en");
  });
});
