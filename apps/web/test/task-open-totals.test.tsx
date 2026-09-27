// Aufgaben-Kopf: früher „Offen gesamt 484“, Unterzeile „0 Bugs · 40 Aufgaben · 382 Audit“ = 422. Die 62 Ideen
// fehlten in der Unterzeile, und die Unterzeile zählte auch Erledigtes. Eine Quelle, stimmige Summe.
import type { EntryKind } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { taskCounts } from "../src/features/tasks/counts";

const e = (kind: EntryKind, stage = "startklar") => ({ kind, stage, sourceRemovedAt: null });

describe("Aufgaben-Kopf: Offen gesamt = Summe der Unterzeile", () => {
  // Rohe Ideen stehen nicht in den Zeilen darunter („tauchen hier nie auf“) → zählen auch nicht mit.
  it("Ideen zählen nicht mit (stehen nicht in der Liste), Erledigtes nicht", () => {
    const rows = [e("aufgabe"), e("aufgabe", "erledigt"), e("audit"), e("audit"), e("idee"), e("idee", "konzept_fertig"), e("bug", "laeuft"), e("frage")];
    const c = taskCounts(rows);
    expect(c.open).toBe(5);
    expect(c.parts.reduce((s, p) => s + p.n, 0)).toBe(c.open);
    expect(c.detail).toBe("1 Bug · 1 Aufgabe · 2 Audit · 1 Sonstige");
    expect(c.startklar).toBe(4); // ohne die Idee
    expect(c.erledigt).toBe(1);
  });
  it("ohne Einträge: 0 und kurze Unterzeile", () => {
    expect(taskCounts([])).toMatchObject({ open: 0, detail: "nichts offen" });
  });
});
