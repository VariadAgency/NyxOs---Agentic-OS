// Modell-JSON robust lesen (Briefings fielen sonst auf „nur Daten“ zurück, wenn Haiku "…" in Sätze schrieb).
import { describe, expect, it } from "vitest";
import { extractJson } from "../../src/haiku/json.js";

describe("extractJson", () => {
  it("liest JSON mit Zaun, Text drumherum und ASCII-Anführungszeichen im Satz", () => {
    expect(extractJson('Hier:\n```json\n{"a":1}\n```\nFertig {x}')).toEqual({ a: 1 });
    expect(extractJson('{"saetze":[{"text":"3 Sessions warten: "Code review" und "Login".","fakten":["f1"]}]}')).toEqual({
      saetze: [{ text: "3 Sessions warten: „Code review“ und „Login“.", fakten: ["f1"] }],
    });
    expect(extractJson("kein json")).toBeNull();
    // Echter Fall aus dem Probe-Briefing: deutsches „ öffnet, ASCII " schließt – direkt vor Komma.
    const real = '```json\n{"saetze":[{"abschnitt":"Was lief","text":"Zuletzt „Neumorphic", „Code review" und 29 weitere.","fakten":["f1"]}]}\n```';
    expect(extractJson(real)).toEqual({ saetze: [{ abschnitt: "Was lief", text: "Zuletzt „Neumorphic“, „Code review“ und 29 weitere.", fakten: ["f1"] }] });
  });

  it("„Titel\" mitten im Satz → das GANZE Objekt, nicht nur der erste Satz", () => {
    // Echter Fall (Probe, Briefing #1): der naive Klammer-Zähler hielt das Ende von „…\" für ein
    // String-Ende, fand nur das erste innere Objekt balanciert und gab es zurück → kein `saetze` → „nur Daten“.
    const real =
      "```json\n{\n  \"saetze\": [\n    {\n      \"abschnitt\": \"Was lief\",\n      \"text\": \"56 Sessions waren seit gestern 0 Uhr aktiv, darunter „Neumorphic dashboard design inspiration\" und „Bildfarbe identifizieren\".\",\n      \"fakten\": [\"f1\"]\n    },\n    {\n      \"abschnitt\": \"Was wartet\",\n      \"text\": \"2 Sessions warten auf dich: „Software review audio analysis\" und „Projekt-Orchestrierung mit KI-Agenten\".\",\n      \"fakten\": [\"f2\"]\n    },\n    {\n      \"abschnitt\": \"Was wartet\",\n      \"text\": \"Außerdem laufen gerade 2 Sessions.\",\n      \"fakten\": [\"f3\"]\n    },\n    {\n      \"abschnitt\": \"Was ist kaputt\",\n      \"text\": \"1 Session ist abgestürzt: „OK\".\",\n      \"fakten\": [\"f4\"]\n    }\n  ],\n  \"vorschlag\": {\n    \"text\": \"Schau dir die 2 wartenden Sessions an – dann kannst du die abgestürzte Session wieder hochfahren.\",\n    \"fakten\": [\"f2\", \"f4\"]\n  }\n}\n```";
    const parsed = extractJson<{ saetze: { text: string }[]; vorschlag: { text: string } }>(real);
    expect(parsed?.saetze).toHaveLength(4);
    expect(parsed?.saetze[0]?.text).toBe("56 Sessions waren seit gestern 0 Uhr aktiv, darunter „Neumorphic dashboard design inspiration“ und „Bildfarbe identifizieren“.");
    expect(parsed?.saetze[3]?.text).toBe("1 Session ist abgestürzt: „OK“.");
    expect(parsed?.vorschlag.text).toMatch(/^Schau dir die 2 wartenden/);
  });
});
