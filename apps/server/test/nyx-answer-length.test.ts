// Wunsch aus dem Alltag: „Nyx soll intelligent verstehen, ob er lang oder kürzer antworten soll. Mit Buttons soll ich das
// einstellen können.“ – Längen-Wähler an der Eingabe (Auto · Kurz · Normal · Ausführlich), Feld `length` im Chat-Request.
// Die Wahl überschreibt für die Runde die Längen-Anweisung im Prompt; ausdrückliche Wünsche in der Frage gehen immer vor,
// auch beim Sprechen. Keine Token-Kappung: die Länge steuert nur der Prompt.
import { DEFAULT_NYX_PROFILE, HaikuChatRequestSchema, type NyxProfile } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { behaviorHints } from "../src/nyx/personaDefault.js";
import { buildNyxSystemPrompt, withChannelNote } from "../src/nyx/prompt.js";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant/assistant-helpers.js";

const SHORT: NyxProfile = {
  ...DEFAULT_NYX_PROFILE,
  sliders: { ...DEFAULT_NYX_PROFILE.sliders, length: 0 },
};
const prompt = (o: { channel: "web" | "voice" | "telegram"; length?: "auto" | "kurz" | "normal" | "ausfuehrlich"; profile?: NyxProfile }) =>
  buildNyxSystemPrompt({
    memoryBlock: "",
    tools: [],
    channel: o.channel,
    profile: o.profile ?? DEFAULT_NYX_PROFILE,
    ...(o.length ? { length: o.length } : {}),
  });

describe("Antwort-Länge (Wähler an der Eingabe)", () => {
  it("Schema: length ist optional und nur auto/kurz/normal/ausfuehrlich", () => {
    expect(
      HaikuChatRequestSchema.safeParse({
        message: "Hi",
        context: CTX,
        length: "ausfuehrlich",
      }).success,
    ).toBe(true);
    expect(HaikuChatRequestSchema.safeParse({ message: "Hi", context: CTX }).success).toBe(true);
    expect(
      HaikuChatRequestSchema.safeParse({
        message: "Hi",
        context: CTX,
        length: "riesig",
      }).success,
    ).toBe(false);
  });

  it("„auto“: Länge nach der Frage, ausdrückliche Längenwünsche haben Vorrang – auch beim Sprechen", () => {
    for (const channel of ["web", "voice", "telegram"] as const) {
      const p = prompt({ channel, length: "auto" });
      expect(p).toMatch(/Länge nach der Frage/);
      expect(p).toMatch(/ausdrückliche[rn]? Längenw(ü|u)nsch\w* .*Vorrang/i);
      expect(p).toMatch(/auch beim Sprechen/);
    }
  });

  it("die Wahl steht zuletzt im Prompt und ersetzt die harte Regler-Regel „höchstens zwei Sätze“", () => {
    const p = prompt({
      channel: "web",
      length: "ausfuehrlich",
      profile: SHORT,
    });
    expect(p).not.toMatch(/Antworte in höchstens zwei Sätzen/);
    expect(p.trim().split("\n\n").at(-1)).toMatch(/ausführlich/i);
    expect(prompt({ channel: "web", length: "kurz" }).trim().split("\n\n").at(-1)).toMatch(/kurz/i);
    // Ohne Wahl (Telegram, ältere Clients) bleibt der Regler wie bisher.
    expect(prompt({ channel: "web", profile: SHORT })).toMatch(/Antworte in höchstens zwei Sätzen/);
  });

  it("Sprach-Kanal verbietet lange Antworten nicht mehr pauschal", () => {
    const long = prompt({ channel: "voice", length: "ausfuehrlich" });
    expect(long).not.toMatch(/Insgesamt (ein Satz|höchstens drei kurze Sätze)/);
    expect(long).not.toMatch(/meist ein bis zwei Sätze/);
    expect(long).not.toMatch(/Lange Inhalte liest du nicht vor/);
    // Auch ohne Wahl: ein ausdrücklicher Wunsch nach einer langen Antwort gilt beim Sprechen.
    expect(prompt({ channel: "voice" })).toMatch(/ausdrücklich.*(lange|ausführlich).*gilt/i);
    // Der Hinweis an der gesprochenen Nachricht erzwingt mit Wahl keine ein bis zwei Sätze mehr.
    expect(withChannelNote("voice", "Erklär mir ausführlich den Build", undefined, "ausfuehrlich")).not.toMatch(/meist ein bis zwei/);
    expect(withChannelNote("voice", "Wie steht der Build?")).toMatch(/ausdrücklich/);
  });

  it("die Wahl senkt keine Token-Grenze – „kurz“ wirkt nur über den Prompt", () => {
    const top = behaviorHints(DEFAULT_NYX_PROFILE, "web", "ausfuehrlich").maxTokens ?? 0;
    expect(top).toBeGreaterThanOrEqual(8000);
    expect(behaviorHints(SHORT, "web", "kurz").maxTokens).toBe(top);
    expect(behaviorHints(SHORT, "voice", "auto").maxTokens ?? 0).toBeGreaterThanOrEqual(behaviorHints(DEFAULT_NYX_PROFILE, "voice").maxTokens ?? 0);
  });

  it("POST /api/haiku/chat: length landet im System-Prompt der Runde; ungültig → 400", async () => {
    const engine = new FakeEngine(answer("Gern."));
    const t = await setupAssistant({ engine });
    await readNdjson(
      await t.json("/api/haiku/chat", {
        message: "Erklär mir NyxOS",
        context: CTX,
        channel: "voice",
        length: "ausfuehrlich",
      }),
    );
    const sys = engine.requests.at(-1)?.systemPrompt ?? "";
    expect(sys).toMatch(/Länge – für diese Antwort: ausführlich/);
    expect(engine.requests.at(-1)?.prompt ?? "").not.toMatch(/meist ein bis zwei/);
    await readNdjson(
      await t.json("/api/haiku/chat", {
        message: "Wie spät?",
        context: CTX,
        length: "auto",
      }),
    );
    expect(engine.requests.at(-1)?.systemPrompt ?? "").toMatch(/Länge nach der Frage/);
    const bad = await t.json("/api/haiku/chat", {
      message: "Hi",
      context: CTX,
      length: "riesig",
    });
    expect(bad.status).toBe(400);
  });
});
