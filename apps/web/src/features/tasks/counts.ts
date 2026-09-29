// EINE Zählung für den Aufgaben-Kopf. „Offen gesamt“ ist genau die Summe der
// Unterzeile (vorher fehlten die Ideen, und die Unterzeile zählte auch Erledigtes mit).
import type { EntryKind } from "@nyxos/shared";
import { t } from "@nyxos/shared";

interface Row {
  kind: EntryKind;
  stage: string;
}

/** Beschriftung je Anzahl: [eins, mehrere], jeweils mit `{n}` (Schlüssel für `t()`). */
const PARTS: { label: [string, string]; kinds: EntryKind[] }[] = [
  { label: ["{n} Bug", "{n} Bugs"], kinds: ["bug"] },
  { label: ["{n} Aufgabe", "{n} Aufgaben"], kinds: ["aufgabe"] },
  { label: ["{n} Audit", "{n} Audit"], kinds: ["audit"] },
  { label: ["{n} Sonstige", "{n} Sonstige"], kinds: ["entscheidung", "frage", "problem"] },
];

export function taskCounts(all: Row[]) {
  // Rohe Ideen stehen nicht in den Zeilen darunter („tauchen hier nie auf“) — sie zählen
  // deshalb auch oben nicht mit; sonst stimmt „Offen gesamt“ nicht mit der Liste überein.
  const rows = all.filter((r) => r.kind !== "idee");
  const open = rows.filter((r) => r.stage !== "erledigt");
  const parts = PARTS.map((p) => ({ label: p.label, n: open.filter((r) => p.kinds.includes(r.kind)).length }));
  const shown = parts.filter((p) => p.n > 0);
  return {
    open: open.length,
    parts,
    detail: shown.length === 0 ? t("nichts offen") : shown.map((p) => t(p.n === 1 ? p.label[0] : p.label[1], { n: p.n })).join(" · "),
    startklar: rows.filter((r) => r.stage === "startklar").length,
    laeuft: rows.filter((r) => r.stage === "laeuft").length,
    pruefen: rows.filter((r) => r.stage === "pruefen").length,
    erledigt: rows.filter((r) => r.stage === "erledigt").length,
  };
}
