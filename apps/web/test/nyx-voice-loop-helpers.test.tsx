// Reine Bausteine der Gesprächsschleife im Nyx-Tab (übernommen aus adewaskar/jarvis, MIT, deutsch
// angepasst — s. NOTICE): Satzende-Erkennung fürs Vorlesen, Turn-Ende auf Deutsch, Echo-Filter, Pegel-Hüllkurve
// und „was hat der Nutzer gehört“, wenn er Nyx unterbricht.
import { describe, expect, it } from "vitest";
import { createSentenceChunker } from "../src/features/nyx/voice/chunker";
import { followEnvelope, normalizeDb } from "../src/features/nyx/tab/voice/level";
import { heardText, holdFor, isEcho, OVERRIDE_DE } from "../src/features/nyx/voice/turn";

describe("Satz-für-Satz vorlesen (Chunker)", () => {
  it("gibt fertige Sätze sofort heraus, den Rest erst am Ende", () => {
    const out: string[] = [];
    const c = createSentenceChunker((s) => out.push(s));
    c.push("Der Build ist grün. Zwei Sess");
    expect(out).toEqual(["Der Build ist grün."]);
    c.push("ions warten auf dich");
    expect(out).toHaveLength(1);
    c.end();
    expect(out).toEqual(["Der Build ist grün.", "Zwei Sessions warten auf dich"]);
  });

  it("schneidet nicht bei deutschen Abkürzungen, Ordinalzahlen und Datumsangaben", () => {
    const out: string[] = [];
    const c = createSentenceChunker((s) => out.push(s));
    c.push("Das ist z. B. am 3. Oktober fällig, ca. 25.09.2026 begonnen. Fertig! ");
    c.end();
    expect(out).toEqual(["Das ist z. B. am 3. Oktober fällig, ca. 25.09.2026 begonnen.", "Fertig!"]);
  });

  it("entfernt Markdown und Links vor dem Sprechen, lange Sätze ohne Punkt werden am Wort geschnitten", () => {
    const out: string[] = [];
    const c = createSentenceChunker((s) => out.push(s));
    c.push("**Wichtig:** siehe [Auftrag](https://x.y/z) und [[session:claude:abc]]. ");
    const long = "wort ".repeat(60);
    c.push(long);
    c.end();
    expect(out[0]).toBe("Wichtig: siehe Auftrag und.");
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const s of out.slice(1)) expect(s.length).toBeLessThanOrEqual(230);
  });
});

describe("Turn-Ende auf Deutsch (holdFor)", () => {
  it("Satzzeichen am Ende = sofort senden", () => {
    expect(holdFor("Was läuft gerade?")).toBe(0);
  });
  it("endet auf „und/der/mit …“ = Satz ist nicht fertig, länger warten", () => {
    expect(holdFor("Zeig mir die Sessions und")).toBe(1600);
    expect(holdFor("Öffne die Session mit")).toBe(1600);
  });
  it("kurze Befehle wie „Stopp“ zählen sofort als fertig, sonstige 1–2 Wörter nicht", () => {
    expect(holdFor("Stopp")).toBe(250);
    expect(holdFor("Zeig mir")).toBe(1600);
    expect(holdFor("Wie viele Sessions laufen gerade")).toBe(250);
  });
});

describe("Echo-Filter", () => {
  it("erkennt Nyx' eigene Worte über den Lautsprecher", () => {
    expect(isEcho("drei Sessions warten auf dich", "Gerade warten drei Sessions auf dich.")).toBe(true);
  });
  it("lässt echte Fragen durch — auch mit Umlauten", () => {
    expect(isEcho("Öffne die zuletzt geöffnete Session", "Gerade warten drei Sessions auf dich.")).toBe(false);
  });
  it("„Stopp“ und „Nyx“ kommen immer durch", () => {
    expect(OVERRIDE_DE.test("stopp")).toBe(true);
    expect(isEcho("Stopp, warte", "Stopp, warte")).toBe(false);
  });
});

describe("Was hat der Nutzer gehört?", () => {
  it("fertige Sätze ganz, vom laufenden Satz nur den abgespielten Anteil (ganze Wörter)", () => {
    expect(heardText(["Der Build ist grün."], { text: "Zwei Sessions warten auf dich.", fraction: 0.5 })).toBe("Der Build ist grün. Zwei Sessions …");
    expect(heardText([], null)).toBe("");
    expect(heardText(["Eins."], { text: "Zwei drei vier.", fraction: 0 })).toBe("Eins.");
  });
});

describe("Pegel (orb-ui/ElevenLabs, MIT)", () => {
  it("Hüllkurve steigt schnell (100 ms) und fällt langsam (400 ms), unabhängig von der Bildrate", () => {
    const up = followEnvelope(0, 1, 100, 100);
    const down = followEnvelope(1, 0, 400, 100);
    expect(up).toBeCloseTo(0.9, 5);
    expect(down).toBeGreaterThan(0.4);
    expect(followEnvelope(0.3, 0.8, 0, 16)).toBe(0.8);
  });
  it("dB-Werte werden auf 0–1 gebracht", () => {
    expect(normalizeDb(-Infinity)).toBe(0);
    expect(normalizeDb(-10)).toBeCloseTo(Math.sqrt(0.9), 5);
    expect(normalizeDb(-200)).toBe(0);
  });
});
