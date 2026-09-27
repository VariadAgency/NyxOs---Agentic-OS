// Git-Wächter (Grundform) — Commit mit [<Kürzel>] verknüpft + protokolliert.
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { links } from "../src/db/schema.js";
import { applyCommitToEntries, extractEntryTokens } from "../src/entries/gitWatcher.js";
import { createEntry } from "../src/entries/store.js";
import { setup } from "./helpers.js";

describe("entries/gitWatcher", () => {
  it("extractEntryTokens findet mehrere Kürzel, dedupliziert", () => {
    expect(extractEntryTokens("fix: [BUG-42] behoben, siehe auch [a02] und nochmal [BUG-42]")).toEqual(["BUG-42", "a02"]);
    expect(extractEntryTokens("kein Kürzel hier")).toEqual([]);
  });

  it("applyCommitToEntries verknüpft per sourceId und protokolliert im Verlauf", async () => {
    const ctx = await setup();
    const entry = await createEntry(ctx.db, { kind: "bug", title: "X", sourceType: "import-test", sourceId: "BUG-42", source: "manual" });
    const matched = await applyCommitToEntries(ctx.db, { sha: "abc123", message: "fix: [BUG-42] Absturz behoben" });
    expect(matched).toEqual([entry.id]);
    const linkRows = await ctx.db.select().from(links).where(and(eq(links.fromId, String(entry.id)), eq(links.toType, "commit")));
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]).toMatchObject({ toId: "abc123", relation: "commit" });
  });

  it("applyCommitToEntries verknüpft auch per numerischer ID", async () => {
    const ctx = await setup();
    const entry = await createEntry(ctx.db, { kind: "bug", title: "Y", source: "manual" });
    const matched = await applyCommitToEntries(ctx.db, { sha: "def456", message: `P4: behebt [${entry.id}]` });
    expect(matched).toEqual([entry.id]);
  });

  it("unbekanntes Kürzel wird ignoriert, kein Fehler", async () => {
    const ctx = await setup();
    const matched = await applyCommitToEntries(ctx.db, { sha: "zzz", message: "chore: [NICHT-VORHANDEN] aufräumen" });
    expect(matched).toEqual([]);
  });

  it("doppelter Aufruf desselben Commits verknüpft nur einmal (idempotent)", async () => {
    const ctx = await setup();
    const entry = await createEntry(ctx.db, { kind: "bug", title: "Z", source: "manual" });
    await applyCommitToEntries(ctx.db, { sha: "same", message: `[${entry.id}] erster Versuch` });
    await applyCommitToEntries(ctx.db, { sha: "same", message: `[${entry.id}] erster Versuch` });
    const linkRows = await ctx.db.select().from(links).where(and(eq(links.fromId, String(entry.id)), eq(links.toId, "same")));
    expect(linkRows).toHaveLength(1);
  });
});
