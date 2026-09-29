// Doku-Spiegel enthält keine Geheimnisse (Köder-Datei-Test).
import { describe, expect, it } from "vitest";
import { docs } from "../src/db/schema.js";
import { getDoc, isMirrorable, mirrorDocs } from "../src/entries/docMirror.js";
import { setup } from "./helpers.js";

describe("entries/docMirror", () => {
  it("mirrorDocs schreibt erlaubte Markdown-Pfade, lehnt Köder-Geheimnis-Dateien ab", async () => {
    const ctx = await setup();
    const result = await mirrorDocs(ctx.db, [
      { path: "App/docs/audit-2026-09/README.md", content: "# Audit" },
      { path: "App/backend/.env", content: "DB_PASSWORD=geheim" }, // Köder
      { path: "App/backend/.env.production", content: "TOKEN=xyz" }, // Köder
      { path: "memory.md", content: "# Gedächtnis" },
    ]);
    expect(result.written.sort()).toEqual(["App/docs/audit-2026-09/README.md", "memory.md"]);
    expect(result.rejected.map((r) => r.path).sort()).toEqual(["App/backend/.env", "App/backend/.env.production"]);
    const rows = await ctx.db.select().from(docs);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.path.includes(".env"))).toBe(false);
  });

  it("isMirrorable lehnt Pfade außerhalb der erlaubten Wurzeln ab", () => {
    expect(isMirrorable("App/docs/x.md")).toBe(true);
    expect(isMirrorable("tools/NyxOS/docs/y.md")).toBe(true);
    expect(isMirrorable("01_Dokumentation/z.md")).toBe(true);
    expect(isMirrorable("memory.md")).toBe(true);
    expect(isMirrorable("App/backend/secrets/keys.md")).toBe(false);
    expect(isMirrorable("App/backend/id_rsa")).toBe(false);
    expect(isMirrorable("02_Business/plan.md")).toBe(true); // jedes Markdown im Projekt
    expect(isMirrorable("../outside/plan.md")).toBe(false); // nie außerhalb des Projektordners
    expect(isMirrorable("/etc/plan.md")).toBe(false);
    expect(isMirrorable(".worktrees/x/docs/plan.md")).toBe(false); // Arbeitskopien nicht
    expect(isMirrorable("node_modules/pkg/README.md")).toBe(false);
    expect(isMirrorable("App/docs/notes.txt")).toBe(false); // kein Markdown
  });

  it("ist idempotent (unveränderte Datei zweimal spiegeln → zweiter Lauf schreibt nichts neu)", async () => {
    const ctx = await setup();
    await mirrorDocs(ctx.db, [{ path: "memory.md", content: "Stand A" }]);
    const second = await mirrorDocs(ctx.db, [{ path: "memory.md", content: "Stand A" }]);
    expect(second.written).toEqual([]);
    expect(second.skippedUnchanged).toEqual(["memory.md"]);
    const third = await mirrorDocs(ctx.db, [{ path: "memory.md", content: "Stand B" }]);
    expect(third.written).toEqual(["memory.md"]);
    expect((await getDoc(ctx.db, "memory.md"))?.content).toBe("Stand B");
  });
});
