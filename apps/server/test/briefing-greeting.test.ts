// Server-Bericht und Vorlesen grüßen nach derselben Regel wie der Briefing-Kopf (um 01:24
// stand oben „Guten Abend“, gesprochen wurde „Guten Morgen“). Das Vorlesen grüßt nach der JETZIGEN Uhrzeit,
// nicht nach der Uhrzeit, zu der der Bericht geschrieben wurde.
import { setTimeZone, type HaikuReport } from "@nyxos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { greetingFor } from "../src/haiku/report.js";
import { buildBriefingSpeech } from "../src/haiku/speech.js";
import { greetingNameOf } from "../src/nyx/profile.js";

// Feste Zeitzone für die Uhrzeit-Grenzen (sonst hinge das Ergebnis von der Zone des Rechners ab).
beforeAll(() => setTimeZone("Europe/Berlin"));
afterAll(() => setTimeZone(null));

const REPORT = {
  id: 7,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: "2026-09-25T06:00:00.000Z",
  greeting: "Guten Morgen, Alex",
  lage: "Alles ruhig.",
  headline: null,
  sections: [],
  runsWithoutYou: [],
  needsYou: [],
  mode: "nur-daten",
  modeReason: null,
  callId: null,
  snapshot: null,
  figures: null,
  highlights: [],
  chartOrder: [],
} as unknown as HaikuReport;

describe("Gruß auf dem Server", () => {
  it("um 01:24 Berliner Zeit ist es Nacht, nicht Morgen", () => {
    expect(greetingFor(new Date("2026-09-25T23:24:00Z"), "Alex")).toBe("Noch wach, Alex?");
    expect(greetingFor(new Date("2026-09-25T23:24:00Z"))).toBe("Noch wach?");
  });

  it("Vorlesen grüßt nach der jetzigen Uhrzeit (Bericht von morgens, gelesen um 20 Uhr)", () => {
    const speech = buildBriefingSpeech(REPORT, new Date("2026-09-25T18:00:00Z"));
    expect(speech.sentences[0]?.written).toBe("Guten Abend.");
  });
});

describe("Name im Gruß aus dem Nyx-Profil", () => {
  it("Bericht und Vorlesen nehmen den Profilnamen", () => {
    expect(greetingFor(new Date("2026-09-25T06:00:00Z"), "Mia")).toBe("Guten Morgen, Mia");
    const speech = buildBriefingSpeech(REPORT, new Date("2026-09-25T18:00:00Z"), "Mia");
    expect(speech.sentences[0]?.written).toBe("Guten Abend, Mia.");
  });

  it("Profil nicht lesbar → kein Fehler, Gruß ohne Namen", async () => {
    const broken = { select: () => { throw new Error("relation nyx_profile does not exist"); } } as unknown as Parameters<typeof greetingNameOf>[0];
    expect(await greetingNameOf(broken)).toBeNull();
    expect(greetingFor(new Date("2026-09-25T06:00:00Z"), await greetingNameOf(broken))).toBe("Guten Morgen");
  });
});
