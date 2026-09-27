// Import ist vollständig UND wiederholbar (zweiter Lauf ändert nichts).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries } from "../src/db/schema.js";
import { importAudit, importGoals } from "../src/entries/import.js";
import { one } from "../src/entries/util.js";
import { setup } from "./helpers.js";

function writeGoal(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const GOAL_TEXT = `# GOAL Testauftrag — ein Beispiel

Modell: Sonnet · Dauer: 3-4 Std · Vorgänger: keiner

## ZIEL

Baue eine kleine Testfunktion, die \`App/backend/services/test-service/index.ts\` betrifft.

## ABNAHME

1. Test grün.
`;

describe("entries/import: Aufträge (GOAL.md)", () => {
  it("importiert jede gefundene GOAL.md als 'aufgabe' mit ZIEL/ABNAHME-Beschreibung und Dateibereich-Hinweis", async () => {
    const ctx = await setup();
    const root = mkdtempSync(join(tmpdir(), "nyxos-goals-"));
    writeGoal(root, "App/docs/testfeature/GOAL.md", GOAL_TEXT);
    writeGoal(root, ".worktrees/kopie/App/docs/testfeature/GOAL.md", GOAL_TEXT); // Arbeitskopie, NICHT importieren
    writeGoal(root, "node_modules/pkg/GOAL.md", GOAL_TEXT); // Abhängigkeit, NICHT importieren
    const result = await importGoals(ctx.db, { root });
    expect(result.found).toBe(1); // Worktree-Kopie und Abhängigkeiten werden übersprungen
    expect(result.created).toBe(1);
    const rows = await ctx.db.select().from(entries).where(eq(entries.kind, "aufgabe"));
    expect(rows).toHaveLength(1);
    const row = one(rows);
    expect(row.title).toContain("Testauftrag");
    expect(row.fileScope).toContain("App/backend/services/test-service/index.ts");
    expect(row.estimate).toBe("3-4 Std"); // aus "Dauer: …" in der Kopfzeile (Reife-Check Punkt 6)
    expect(row.stage).toBe("geplant");
  });

  it("zweiter Lauf ist idempotent: kein neuer Eintrag, nichts geändert ('unchanged')", async () => {
    const ctx = await setup();
    const root = mkdtempSync(join(tmpdir(), "nyxos-goals-2-"));
    writeGoal(root, "App/docs/testfeature/GOAL.md", GOAL_TEXT);
    const first = await importGoals(ctx.db, { root, includeDirs: ["App/docs"] });
    const second = await importGoals(ctx.db, { root, includeDirs: ["App/docs"] });
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    const rows = await ctx.db.select().from(entries).where(eq(entries.kind, "aufgabe"));
    expect(rows).toHaveLength(1); // keine Dopplung
  });

  it("ändert nie von Hand gesetzte Felder (priority) bei erneutem Import", async () => {
    const ctx = await setup();
    const root = mkdtempSync(join(tmpdir(), "nyxos-goals-3-"));
    writeGoal(root, "App/docs/testfeature/GOAL.md", GOAL_TEXT);
    await importGoals(ctx.db, { root, includeDirs: ["App/docs"] });
    const row = one(await ctx.db.select().from(entries).where(eq(entries.kind, "aufgabe")));
    await ctx.db.update(entries).set({ priority: "p0" }).where(eq(entries.id, row.id));
    await importGoals(ctx.db, { root, includeDirs: ["App/docs"] });
    const after = one(await ctx.db.select().from(entries).where(eq(entries.kind, "aufgabe")));
    expect(after.priority).toBe("p0");
  });
});

const AUDIT_FIXTURE = `## Gesamtreihenfolge sämtlicher Befunde

| Rang | Stufe | Befund / zu behebendes Problem | Schwere | R | Originalaufwand | Paket | Vorher abschließen |
|---:|---:|---|---|---:|---|---|---|
| 1 | 0 | [B-115 — Eine negative Feed-Seitengröße führt in einen Absturz](../02-Sicherheit/x.md) | Kritisch | 5 | S | P-B-115 | — |
| 2 | 0 | [B-60 — Fremde Stempelkarten lesbar](../02-Sicherheit/y.md) | Kritisch | 5 | M | P-B-60 | — |
| 3 | 1 | [C-50 — Schlüssellesefehler löscht DB](../04-Speicher/z.md) | Kritisch | 5 | L | P-C-50 | — |
`;

describe("entries/import: Audit-Befunde", () => {
  it("importiert jede Zeile der Tabelle als 'audit' mit Schwere/Paket/Stufe", async () => {
    const ctx = await setup();
    const dir = mkdtempSync(join(tmpdir(), "nyxos-audit-"));
    const path = join(dir, "MASSNAHMENPLAN.md");
    writeFileSync(path, AUDIT_FIXTURE, "utf8");
    const result = await importAudit(ctx.db, path);
    expect(result.found).toBe(3);
    expect(result.created).toBe(3);
    const rows = await ctx.db.select().from(entries).where(eq(entries.kind, "audit"));
    expect(rows).toHaveLength(3);
    const b115 = rows.find((r) => r.sourceId === "B-115");
    expect(b115?.priority).toBe("p0"); // Stufe 0 → P0
    expect(b115?.baustelleSlug).toBe("P-B-115");
    const c50 = rows.find((r) => r.sourceId === "C-50");
    expect(c50?.priority).toBe("p1"); // Stufe 1 → P1
  });

  it("zweiter Lauf ist idempotent", async () => {
    const ctx = await setup();
    const dir = mkdtempSync(join(tmpdir(), "nyxos-audit-2-"));
    const path = join(dir, "MASSNAHMENPLAN.md");
    writeFileSync(path, AUDIT_FIXTURE, "utf8");
    await importAudit(ctx.db, path);
    const second = await importAudit(ctx.db, path);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(3);
    const rows = await ctx.db.select().from(entries).where(eq(entries.kind, "audit"));
    expect(rows).toHaveLength(3);
  });
});
