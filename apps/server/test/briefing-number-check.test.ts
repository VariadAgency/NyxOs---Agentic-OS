// Briefing-Zahlenprüfung, Grenzfälle:
// 1. Zahlenprüfung: Haiku schreibt Zahlen auch als Wort („drei“) oder verneint („Keine Session läuft“,
//    ein echter Widerspruch im Briefing) — beides rutschte durch, weil nur Ziffern geprüft wurden.
// 2. Haiku-Werkzeug `builds_liste` (nurRot) zählte selbst: 3 Tage, ohne „im selben Ordner wieder grün“ —
//    Haiku nannte dann Build-Fehler, die Überblick und Briefing längst als behoben zeigen.
import { describe, expect, it } from "vitest";
import { buildRuns } from "../src/db/schema.js";
import { validateStatement, type Fact } from "../src/haiku/report.js";
import { buildDefaultRegistry } from "../src/haiku/tools.js";
import { takeSnapshot } from "../src/overview/snapshot.js";
import { setupAssistant } from "./assistant/assistant-helpers.js";

const fact = (id: string, text: string): Fact => ({ id, section: "Was wartet", text, sources: [] });

describe("Zahlenprüfung erkennt Zahlwörter und Verneinungen", () => {
  const facts = [
    fact("f1", "2 Sessions warten auf dich: „A“ und „B“."),
    fact("f2", "1 Session läuft gerade."),
    fact("f3", "Keine Abstürze und keine offenen Build-Fehler."),
    fact("f4", "12 Sessions waren seit gestern 0 Uhr aktiv, zuletzt „A“."),
  ];

  it("falsches Zahlwort wird abgelehnt, richtiges angenommen", () => {
    expect(validateStatement("Drei Sessions warten auf dich.", ["f1"], facts).ok).toBe(false);
    expect(validateStatement("Zwei Sessions warten auf dich.", ["f1"], facts).ok).toBe(true);
    expect(validateStatement("Zwölf Sessions waren seit gestern 0 Uhr aktiv.", ["f4"], facts).ok).toBe(true);
    expect(validateStatement("Zehn Sessions waren seit gestern 0 Uhr aktiv.", ["f4"], facts).ok).toBe(false);
  });

  it("„Keine Session läuft“ gegen „1 Session läuft“ wird abgelehnt; belegte Verneinung bleibt erlaubt", () => {
    expect(validateStatement("Keine Session läuft gerade.", ["f2"], facts).ok).toBe(false);
    expect(validateStatement("Gerade läuft nichts.", ["f2"], facts).ok).toBe(false);
    expect(validateStatement("Nichts ist abgestürzt, kein Build ist rot.", ["f3"], facts).ok).toBe(true);
    expect(validateStatement("1 Session läuft gerade.", ["f2"], facts).ok).toBe(true);
  });

  it("keine Falsch-Treffer bei gewöhnlichen Wörtern", () => {
    // „einer“, „eine“, „dreist“, „Zweig“ sind keine Zahlen im Sinne der Prüfung.
    expect(validateStatement("Eine davon läuft gerade, einer der Zweige ist dreist.", ["f2"], facts).ok).toBe(true);
  });
});

describe("Haiku-Werkzeug builds_liste zählt wie der Überblick", () => {
  it("nurRot = die offenen Build-Fehler des Schnappschusses (behobene und > 24 h alte fehlen)", async () => {
    const t = await setupAssistant();
    const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const log = "src/x.ts(1,1): error TS2322: kaputt";
    await t.db.insert(buildRuns).values([
      // Ordner A: rot, danach grün → behoben.
      { kind: "nyxos", command: "pnpm -r typecheck", status: "red", logExcerpt: log, trigger: "stop_hook", startedAt: at(3), endedAt: at(3), folder: "/wt/a" },
      { kind: "nyxos", command: "pnpm -r typecheck", status: "green", logExcerpt: "", trigger: "stop_hook", startedAt: at(2), endedAt: at(2), folder: "/wt/a" },
      // Backend: rot vor 2 Tagen → außerhalb des 24-h-Fensters.
      { kind: "backend", command: "swift build", status: "red", logExcerpt: "error: x", trigger: "stop_hook", startedAt: at(48), endedAt: at(48), folder: "/wt/backend" },
    ]);
    const snap = await takeSnapshot(t.db);
    expect(snap.redBuilds).toHaveLength(0);
    const res = (await buildDefaultRegistry().call("full", "builds_liste", { nurRot: true }, { db: t.db, scope: "full", ideaLink: null, ideas: null })) as unknown[];
    expect(res).toHaveLength(snap.redBuilds.length);
  }, 60_000); // erster PGlite-Aufbau der Datei (Migrationen) braucht auf belasteten Rechnern > 20 s
});
