// EINE Gruß-Regel für Überblick, Briefing-Kopf, Server-Bericht und Vorlesen (Kopf „Guten Abend“,
// gesprochen „Guten Morgen“ um 01:24). Immer in der Zeitzone des Nutzers, egal wo der Code läuft.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILD_KIND_LABEL, FINDER_ROOTS, greetingLine, greetingPeriod, setTimeZone } from "../src/index.js";

// Feste Zeitzone für die Tests (sonst hinge das Ergebnis von der Zone des Rechners ab).
beforeAll(() => setTimeZone("Europe/Berlin"));
afterAll(() => setTimeZone(null));

// Sommerzeit: Berlin = UTC + 2.
const berlin = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 26, h - 2, m));

describe("greetingLine (Zeitzone Europe/Berlin)", () => {
  it.each([
    [5, 0, "morning", "Guten Morgen, Alex"],
    [10, 59, "morning", "Guten Morgen, Alex"],
    [11, 0, "day", "Guten Tag, Alex"],
    [17, 59, "day", "Guten Tag, Alex"],
    [18, 0, "evening", "Guten Abend, Alex"],
    [21, 59, "evening", "Guten Abend, Alex"],
    [22, 0, "night", "Noch wach, Alex?"],
    [1, 24, "night", "Noch wach, Alex?"],
    [4, 59, "night", "Noch wach, Alex?"],
  ])("%i:%i Uhr → %s", (h, m, period, line) => {
    expect(greetingPeriod(berlin(h, m))).toBe(period);
    expect(greetingLine(berlin(h, m), "Alex")).toBe(line);
  });

  it("nimmt einen anderen Namen", () => {
    expect(greetingLine(berlin(8), "Mia")).toBe("Guten Morgen, Mia");
  });
});

describe("Anzeigenamen: NyxOS (Pfade/IDs bleiben)", () => {
  it("Build-Projekt heißt in der Anzeige NyxOS", () => {
    expect(BUILD_KIND_LABEL.nyxos).toBe("NyxOS");
  });
  it("der erste Finder-Favorit ist der Projektordner", () => {
    expect(FINDER_ROOTS[0]).toMatchObject({ id: "project", base: "project", rel: "" });
  });
});

describe("Gruß: Winterzeit und Name", () => {
  // Winterzeit: Berlin = UTC + 1 (Umstellung 25.10.2026 03:00 → 02:00).
  it("Grenzen stimmen auch in der Winterzeit", () => {
    expect(greetingLine(new Date("2026-12-01T03:59:00Z"), "Alex")).toBe("Noch wach, Alex?"); // 04:59
    expect(greetingLine(new Date("2026-12-01T04:00:00Z"), "Alex")).toBe("Guten Morgen, Alex"); // 05:00
    expect(greetingLine(new Date("2026-12-01T21:00:00Z"), "Alex")).toBe("Noch wach, Alex?"); // 22:00
  });
  it("am Tag der Umstellung (Sommer → Winter)", () => {
    expect(greetingLine(new Date("2026-10-25T03:59:00Z"), "Alex")).toBe("Noch wach, Alex?"); // 04:59 MEZ
    expect(greetingLine(new Date("2026-10-25T04:00:00Z"), "Alex")).toBe("Guten Morgen, Alex"); // 05:00 MEZ
  });
  it("leerer/fehlender Name → Gruß ohne Namen, Leerzeichen weg", () => {
    expect(greetingLine(new Date("2026-12-01T12:00:00Z"), "")).toBe("Guten Tag");
    expect(greetingLine(new Date("2026-12-01T12:00:00Z"), null)).toBe("Guten Tag");
    expect(greetingLine(new Date("2026-12-01T23:00:00Z"))).toBe("Noch wach?");
    expect(greetingLine(new Date("2026-12-01T12:00:00Z"), "  Mia ")).toBe("Guten Tag, Mia");
  });
});
