// Nyx erklärt – Konflikte: jede Gruppe der Kollisionskarte sagt in EINEM einfachen Satz, was dort passiert,
// und oben steht eine Zusammenfassung über alle Konflikte (fester Satz aus den Daten, Nyx kann sie ausführlicher sagen).
import type { ConflictGroupSummary, ConflictsSummary } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { conflictsFacts, conflictsOverview, groupSentence } from "../src/features/conflicts/decisionText";

const group = (over: Partial<ConflictGroupSummary>): ConflictGroupSummary => ({
  key: "apps/web/src",
  fileCount: 3,
  conflictCount: 0,
  sharedReadCount: 0,
  pastCount: 0,
  severity: null,
  writers: [],
  writerCount: 0,
  latestAt: null,
  ...over,
});

describe("groupSentence", () => {
  it("Konflikt: nennt Sessions und Zahl der Dateien", () => {
    const s = groupSentence(group({ conflictCount: 2, writers: [{ sessionKey: "claude:a", title: "Karte bauen" }, { sessionKey: "codex:b", title: "Tests" }], writerCount: 2 }));
    expect(s).toBe("„Karte bauen“ und „Tests“ ändern hier gleichzeitig 2 Dateien.");
  });

  it("nur mitlesen: kein Streit", () => {
    const s = groupSentence(group({ sharedReadCount: 1, writers: [{ sessionKey: "claude:a", title: "Karte bauen" }], writerCount: 1 }));
    expect(s).toBe("„Karte bauen“ schreibt hier, andere Sessions lesen 1 Datei mit – kein Streit.");
  });

  it("nur Rückblick: Sessions sind beendet", () => {
    expect(groupSentence(group({ pastCount: 4 }))).toBe("Beendete Sessions haben hier 4 Dateien gemeinsam geändert – nur noch Rückblick.");
  });

  it("sonst: eine Session arbeitet allein", () => {
    expect(groupSentence(group({ fileCount: 1, writers: [{ sessionKey: "codex:b", title: null }], writerCount: 1 }))).toMatch(/arbeitet hier allein an 1 Datei\.$/);
  });

  it("mehr als drei Sessions werden gekürzt", () => {
    const writers = ["A", "B", "C", "D"].map((t) => ({ sessionKey: `claude:${t}`, title: `Arbeit ${t}` }));
    expect(groupSentence(group({ conflictCount: 1, fileCount: 1, writers, writerCount: 5 }))).toBe("„Arbeit A“, „Arbeit B“, „Arbeit C“ und 2 weitere ändern hier gleichzeitig 1 Datei.");
  });
});

const summary = (over: Partial<ConflictsSummary>): ConflictsSummary => ({
  version: "v",
  generatedAt: "2026-09-26T09:00:00Z",
  bridgeOnline: true,
  totals: { files: 0, conflicts: 0, sharedRead: 0, groups: 0, openDecisions: 0, past: 0 },
  decisions: [],
  groups: [],
  reservations: [],
  ...over,
});

describe("conflictsOverview", () => {
  it("ruhig: nichts zu tun", () => {
    expect(conflictsOverview(summary({}))).toBe("Gerade ändern keine zwei laufenden Sessions dieselben Dateien – alles ruhig.");
  });

  it("mit Konflikten: Zahl der Fragen, Dateien und der wichtigste Ordner", () => {
    const s = conflictsOverview(
      summary({
        totals: { files: 12, conflicts: 5, sharedRead: 2, groups: 3, openDecisions: 2, past: 0 },
        groups: [group({ key: "apps/web", conflictCount: 1 }), group({ key: "apps/server", conflictCount: 4 })],
      }),
    );
    expect(s).toBe("2 Konflikt-Fragen warten auf dich. 5 Dateien werden von mehreren Sessions gleichzeitig geändert, die meisten im Ordner „apps/server“.");
  });

  it("Fakten für Nyx enthalten Zahlen und die Gruppen-Sätze", () => {
    const f = conflictsFacts(summary({ totals: { files: 3, conflicts: 2, sharedRead: 0, groups: 1, openDecisions: 1, past: 0 }, groups: [group({ conflictCount: 2, writers: [{ sessionKey: "claude:a", title: "Karte" }], writerCount: 1 })] }));
    expect(f).toContain("Offene Konflikt-Fragen: 1");
    expect(f).toContain("apps/web/src:");
  });
});
