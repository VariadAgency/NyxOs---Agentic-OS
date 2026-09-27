import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Kontrast-Regel (docs/UI.md): `--a-dim` (#5C5C5C) erreicht
// nur 2.3–3.1:1 auf den Hintergründen und ist damit für lesbaren Text unter WCAG AA (4.5:1)
// verboten — nur `bg-a-dim`/`border-a-dim` (Deko: Trenner, Icons, Status-Punkte) bleiben erlaubt.
// Dieser Test wirkt wie eine ESLint-Regel: er hält `text-a-dim` dauerhaft aus der
// Quelle raus, statt sich auf Einzel-Reviews zu verlassen.
const SRC_ROOT = join(__dirname, "..", "src");

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) collectFiles(full, acc);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

describe("Kontrast-Regel: kein text-a-dim", () => {
  it("keine Quelldatei nutzt die Klasse text-a-dim (nur bg-a-dim/border-a-dim für Deko erlaubt)", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      if (content.includes("text-a-dim")) offenders.push(file.slice(SRC_ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
