// Nyx: Sprache, Zahlen und unklare Bitten.
// 1. Englisch 0/4: Persona „Deutsch, kurz …“ und Profil „Deutsch.“ überstimmten die Sprach-Regel.
// 2. Zahlen in der Stimme („neunzigundachtzig Cent“): Das Modell schreibt Ziffern, die Stimme spricht sie aus.
// 3. „Mach das mal fertig“: erst EINE Rückfrage mit höchstens zwei Möglichkeiten, dann erst Werkzeuge.
import { DEFAULT_NYX_PROFILE } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { buildNyxSystemPrompt, ENGLISH_TURN_NOTE, languageRule, messageLanguage, withChannelNote } from "../src/nyx/prompt.js";
import { wrapUntrusted } from "../src/telegram/format.js";
import { toSpeakText } from "../src/nyx/speak.js";
import { answer, CTX, FakeEngine, readNdjson, setupAssistant } from "./assistant/assistant-helpers.js";

async function askWith(message: string, channel: "web" | "voice" = "web") {
  const engine = new FakeEngine(answer("Ok."));
  const t = await setupAssistant({ engine });
  await readNdjson(await t.json("/api/haiku/chat", { message, context: CTX, channel }));
  const req = engine.requests[0];
  if (!req) throw new Error("Motor wurde nicht gefragt");
  return req;
}

describe("Englisch: die Sprach-Regel gewinnt", () => {
  it("Persona und Standard-Profil sagen nicht mehr pauschal „Deutsch“", () => {
    const web = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "web", profile: DEFAULT_NYX_PROFILE });
    expect(web).not.toMatch(/^- Deutsch, kurz/m);
    expect(DEFAULT_NYX_PROFILE.user.likes).not.toMatch(/(^|\.\s)Deutsch\./);
  });
  it("die Sprach-Regel steht NACH Persona und Profil-Freitext und sagt, dass sie Vorrang hat", () => {
    for (const channel of ["web", "voice", "telegram"] as const) {
      const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel, profile: DEFAULT_NYX_PROFILE });
      expect(p).toContain(languageRule());
      expect(p.indexOf(languageRule())).toBeGreaterThan(p.lastIndexOf("</nutzerangaben>"));
      expect(p.indexOf(languageRule())).toBeGreaterThan(p.indexOf("So antwortest du"));
    }
    expect(languageRule()).toMatch(/Vorrang/);
    expect(languageRule()).toMatch(/nutzerangaben/);
  });
  it("Profil-Vorgaben heben die Sprach-Regel nicht auf", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "web", profile: DEFAULT_NYX_PROFILE });
    expect(p).toMatch(/Regeln zu Sprache, Fakten/);
  });
  it("Kanal-Hinweis: englische Nachricht bekommt den Englisch-Hinweis, deutsche nicht", () => {
    expect(withChannelNote("web", "How many sessions are running?")).toContain(ENGLISH_TURN_NOTE);
    expect(withChannelNote("voice", "What's the state of the server right now?")).toContain(ENGLISH_TURN_NOTE);
    expect(withChannelNote("telegram", "Which sessions are waiting for me, and why?")).toContain(ENGLISH_TURN_NOTE);
    expect(withChannelNote("web", "Wie viele Sessions laufen gerade?")).not.toContain(ENGLISH_TURN_NOTE);
    expect(withChannelNote("web", "Check mal den Build und den Deploy")).not.toContain(ENGLISH_TURN_NOTE);
    expect(withChannelNote("web", "Mach das mal fertig.")).not.toContain(ENGLISH_TURN_NOTE);
    // Angehängte (deutsche) Anhang-Beschreibung entscheidet nicht über die Sprache – nur des Nutzers Nachricht.
    expect(withChannelNote("telegram", "What's in this picture?\n\nAnhang: Bild von Alex", "What's in this picture?")).toContain(ENGLISH_TURN_NOTE);
  });
  it("Telegram-Sprachnachricht: der deutsche Fremdtext-Rahmen kippt ein englisches Transkript nicht auf Deutsch", () => {
    const en = wrapUntrusted("Sprachnachricht von Alex, transkribiert", "How many sessions are running?");
    expect(messageLanguage(en)).toBe("en");
    expect(withChannelNote("voice", en)).toContain(ENGLISH_TURN_NOTE);
    expect(messageLanguage(wrapUntrusted("Sprachnachricht von Alex, transkribiert", "Wie viele Sessions laufen?"))).toBe("de");
  });
  it("Chat-Runde mit gemocktem Motor: englische Frage → Englisch-Anweisung im Turn, deutsche nicht", async () => {
    const en = await askWith("How many sessions are running?");
    expect(en.prompt).toContain(ENGLISH_TURN_NOTE);
    expect(en.systemPrompt).toContain(languageRule());
    const enVoice = await askWith("Give me a short summary of what happened since yesterday.", "voice");
    expect(enVoice.prompt).toContain(ENGLISH_TURN_NOTE);
    const de = await askWith("Wie viele Sessions laufen gerade?");
    expect(de.prompt).not.toContain(ENGLISH_TURN_NOTE);
    expect(de.systemPrompt).toContain(languageRule());
  });
});

describe("Zahlen: Ziffern bleiben Ziffern, die Stimme spricht sie aus", () => {
  it("keine Regel mehr, Zahlen selbst in Worte zu fassen (Stimme und Web)", () => {
    for (const channel of ["voice", "web", "telegram"] as const) {
      const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel, profile: DEFAULT_NYX_PROFILE });
      expect(p).not.toMatch(/so schreiben, wie man sie spricht/);
      expect(p).not.toMatch(/als Wort mit genau demselben Wert/);
      expect(p).not.toContain("dreiundsechzig");
      expect(p).not.toContain("vierzehn Uhr dreißig");
    }
    const voice = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "voice", profile: DEFAULT_NYX_PROFILE });
    expect(voice).toMatch(/als Ziffern/);
    expect(voice).toMatch(/nie als Wort/);
  });
  it("Sprechfassung lässt Ziffern, Beträge, Prozent und Uhrzeiten unverändert (die Stimme macht Wörter daraus)", () => {
    expect(toSpeakText("Claude kostet dich diese Woche $1.809, Codex $333.")).toBe("Claude kostet dich diese Woche $1.809, Codex $333.");
    expect(toSpeakText("Kosten 0,98 €, 12,5 % mehr, fertig um 14:30 Uhr.")).toBe("Kosten 0,98 €, 12,5 % mehr, fertig um 14:30 Uhr.");
    expect(toSpeakText("Claude: **1.882,90 $** diese Woche, 98 Cent heute.")).toBe("Claude: 1.882,90 $ diese Woche, 98 Cent heute.");
    expect(toSpeakText("It costs $1,882.90 at 2:30 PM.")).toBe("It costs $1,882.90 at 2:30 PM.");
    expect(toSpeakText("Es gibt **63** Ideen [1].")).toBe("Es gibt 63 Ideen.");
    expect(toSpeakText("Claude: 6,3 Mrd. Tokens (~1.810 USD).")).toBe("Claude: 6,3 Milliarden Tokens (~1.810 USD).");
  });
});

describe("unklare Bitte → erst Rückfrage, dann Werkzeuge", () => {
  it("die Regel steht klar und kurz im Prompt, auch mit Bildschirm-Werkzeugen", () => {
    const tools = ["lage", "ui_navigate", "ui_click", "ui_type", "ui_read_screen"];
    for (const channel of ["web", "voice"] as const) {
      const p = buildNyxSystemPrompt({ memoryBlock: "", tools, channel, profile: DEFAULT_NYX_PROFILE });
      expect(p).toMatch(/Unklar, worauf sich eine Bitte bezieht/);
      expect(p).toMatch(/BEVOR du ein Werkzeug benutzt/);
      expect(p).toMatch(/höchstens zwei Möglichkeiten/);
      expect(p).toMatch(/Mach das mal fertig/);
      // Den Bildschirm liest er nicht, um eine unklare Bitte zu deuten.
      expect(p).toMatch(/nicht, um eine unklare Bitte zu deuten/);
    }
  });
  it("„erst selbst nachsehen statt zurückzufragen“ nimmt die unklare Bitte ausdrücklich aus", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "web", profile: DEFAULT_NYX_PROFILE });
    expect(p).toMatch(/erst selbst nachsehen statt zurückzufragen \(außer/);
  });
  it("klare Bitten ausdrücklich OHNE Rückfrage (Gegenbeispiele), die Längen-Regel bleibt am Ende", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "web", profile: DEFAULT_NYX_PROFILE });
    expect(p).toMatch(/Ist der Bezug klar \(„Wie steht der Build\?“, „Mach den Build fertig“.*erledigst du es ohne Rückfrage/);
    const short = { ...DEFAULT_NYX_PROFILE, sliders: { ...DEFAULT_NYX_PROFILE.sliders, length: 0 } };
    const k = buildNyxSystemPrompt({ memoryBlock: "", tools: ["lage"], channel: "web", profile: short });
    expect(k.trimEnd().endsWith("Mehr nur, wenn der Nutzer ausdrücklich nachfragt.")).toBe(true);
    expect(k.indexOf("Länge – zuletzt und verbindlich")).toBeGreaterThan(k.indexOf(languageRule()));
  });
});

describe("Englisch-Erkennung: keine Fehlalarme", () => {
  it("deutsche Nachrichten mit Anglizismen bleiben deutsch", () => {
    for (const m of ["check mal den Build", "mach ein Deploy", "Wie ist der Status?", "Deploy den Server", "Session fixen", "status?", "Merge den PR und dann weiter"]) {
      expect(messageLanguage(m), m).toBe("de");
    }
  });
  it("einzelne englische Grußwörter und Floskeln kippen nicht ins Englische", () => {
    for (const m of ["hi", "Hi Nyx", "nice", "sorry", "thanks", "ok cool", "perfect"]) expect(messageLanguage(m), m).toBe("de");
  });
  it("Code, Fehlermeldungen, Pfade und Links in einer deutschen Nachricht zählen nicht", () => {
    expect(messageLanguage("Warum geht `if (x) return the value of it` nicht?")).toBe("de");
    expect(messageLanguage("Was heißt das?\n```\nError: failed to connect to the database because the host is not reachable\n```")).toBe("de");
    expect(messageLanguage("Schau in ~/projects/the/path/for/it und sag mir, was fehlt")).toBe("de");
    expect(messageLanguage("Lies https://example.com/how-to-fix-the-build-when-it-is-broken und fass zusammen")).toBe("de");
  });
  it("echte englische Nachrichten, auch kurze, bleiben englisch", () => {
    for (const m of ["How many sessions are running?", "What's the state of the server right now?", "Is the build green?", "Give me a short summary.", "hi, how are you?", "Check the build please", "Why does `npm test` fail?"]) {
      expect(messageLanguage(m), m).toBe("en");
    }
  });
});
