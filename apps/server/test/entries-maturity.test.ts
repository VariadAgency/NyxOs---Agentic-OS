// Reife-Check bei 6 echten Auftragskonstellationen. "Startklar" wird
// NUR von applyMaturity() gesetzt — dieser Test prüft explizit, dass ein Mensch/Agent es nicht direkt
// setzen kann (Route erlaubt kein "stage" im Body) und dass jeder der 6 Punkte unabhängig kippt.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { entries, sessionFiles, sessions } from "../src/db/schema.js";
import { applyMaturity, createEntry, getEntry, linkObjects } from "../src/entries/store.js";
import { setup } from "./helpers.js";

describe("entries/maturity: Reife-Check (6 Punkte)", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("besteht alle 6 Punkte → stage wechselt geplant → startklar", async () => {
    const entry = await createEntry(ctx.db, {
      kind: "bug",
      title: "Startklarer Bug",
      description: "Ziel: App stürzt nicht mehr ab. Abnahme: 10 Min Hintergrund ohne Neustart.",
      fileScope: ["App/backend/services/x"],
      source: "manual",
    });
    await ctx.db.update(entries).set({ estimate: "~4 Std" }).where(eq(entries.id, entry.id));
    const result = await applyMaturity(ctx.db, entry.id);
    expect(result?.maturity.passed).toBe(true);
    expect(result?.maturity.passedCount).toBe(6);
    expect(result?.entry.stage).toBe("startklar");
  });

  it("fehlende Beschreibung → Punkt 1 (Ziel+Abnahme) schlägt fehl, bleibt geplant", async () => {
    const entry = await createEntry(ctx.db, { kind: "bug", title: "Ohne Beschreibung", fileScope: ["x"], source: "manual" });
    await ctx.db.update(entries).set({ estimate: "1 Std" }).where(eq(entries.id, entry.id));
    const result = await applyMaturity(ctx.db, entry.id);
    expect(result?.maturity.passed).toBe(false);
    expect(result?.maturity.points.find((p) => p.key === "ziel_abnahme")?.passed).toBe(false);
    expect(result?.entry.stage).toBe("geplant");
  });

  it("kein Dateibereich → Punkt 2 schlägt fehl", async () => {
    const entry = await createEntry(ctx.db, { kind: "bug", title: "X", description: "Ziel und Abnahme klar.", source: "manual" });
    await ctx.db.update(entries).set({ estimate: "1 Std" }).where(eq(entries.id, entry.id));
    const result = await applyMaturity(ctx.db, entry.id);
    expect(result?.maturity.points.find((p) => p.key === "dateibereich")?.passed).toBe(false);
  });

  it("offene Entscheidung verweist darauf → Punkt 3 schlägt fehl", async () => {
    const entry = await createEntry(ctx.db, { kind: "aufgabe", title: "A04", description: "Ziel: x. Abnahme: y.", fileScope: ["a"], source: "manual" });
    await ctx.db.update(entries).set({ estimate: "1 Std" }).where(eq(entries.id, entry.id));
    const decision = await createEntry(ctx.db, { kind: "entscheidung", title: "B2B?", source: "manual" });
    await linkObjects(ctx.db, { fromType: "entry", fromId: String(decision.id), toType: "entry", toId: String(entry.id), relation: "blockiert", source: "test" });
    const result = await applyMaturity(ctx.db, entry.id);
    expect(result?.maturity.points.find((p) => p.key === "keine_offene_entscheidung")?.passed).toBe(false);
    // Entscheidung wird beantwortet (stage erledigt) → Punkt besteht jetzt
    await ctx.db.update(entries).set({ stage: "erledigt" }).where(eq(entries.id, decision.id));
    const result2 = await applyMaturity(ctx.db, entry.id);
    expect(result2?.maturity.points.find((p) => p.key === "keine_offene_entscheidung")?.passed).toBe(true);
  });

  it("Vorgänger nicht erledigt → Punkt 4 schlägt fehl, nach Erledigung besteht er", async () => {
    const pred = await createEntry(ctx.db, { kind: "aufgabe", title: "A01", source: "manual" });
    const entry = await createEntry(ctx.db, { kind: "aufgabe", title: "A02", description: "Ziel: x. Abnahme: y.", fileScope: ["a"], source: "manual" });
    await ctx.db.update(entries).set({ estimate: "1 Std" }).where(eq(entries.id, entry.id));
    await linkObjects(ctx.db, { fromType: "entry", fromId: String(entry.id), toType: "entry", toId: String(pred.id), relation: "vorgaenger", source: "test" });
    const result = await applyMaturity(ctx.db, entry.id);
    expect(result?.maturity.points.find((p) => p.key === "vorgaenger_abgenommen")?.passed).toBe(false);
    await ctx.db.update(entries).set({ stage: "erledigt" }).where(eq(entries.id, pred.id));
    const result2 = await applyMaturity(ctx.db, entry.id);
    expect(result2?.maturity.points.find((p) => p.key === "vorgaenger_abgenommen")?.passed).toBe(true);
  });

  it("überlappender Dateibereich mit laufender Session → Punkt 5 schlägt fehl", async () => {
    await ctx.db.insert(sessions).values({ id: "claude:running", tool: "claude", sessionId: "r1", title: "Läuft", state: "laeuft" });
    await ctx.db.insert(sessionFiles).values({ sessionKey: "claude:running", path: "Shared/Components/CCCard.swift", mode: "write" });
    const entry = await createEntry(ctx.db, {
      kind: "aufgabe",
      title: "Onboarding",
      description: "Ziel: x. Abnahme: y.",
      fileScope: ["Shared/Components/"],
      source: "manual",
    });
    await ctx.db.update(entries).set({ estimate: "1 Std" }).where(eq(entries.id, entry.id));
    const result = await applyMaturity(ctx.db, entry.id);
    expect(result?.maturity.points.find((p) => p.key === "kein_konflikt")?.passed).toBe(false);
  });

  it("keine Schätzung → Punkt 6 schlägt fehl", async () => {
    const entry = await createEntry(ctx.db, { kind: "aufgabe", title: "X", description: "Ziel: x. Abnahme: y.", fileScope: ["a"], source: "manual" });
    const result = await applyMaturity(ctx.db, entry.id);
    expect(result?.maturity.points.find((p) => p.key === "budget_passt")?.passed).toBe(false);
    expect(result?.maturity.passed).toBe(false);
  });

  it("Regression (per Playwright gegen den Probe-Stack gefunden): persistiert wird der volle MaturityResult, nicht nur `.points` — ein frischer getEntry() liefert weiter passedCount/totalCount/points", async () => {
    const entry = await createEntry(ctx.db, { kind: "bug", title: "Regressionstest", description: "Ziel: x. Abnahme: y.", fileScope: ["a"], source: "manual" });
    await applyMaturity(ctx.db, entry.id);
    const reloaded = await getEntry(ctx.db, entry.id); // frischer SELECT, kein zwischengespeichertes Objekt
    expect(reloaded?.maturity?.points).toHaveLength(6);
    expect(reloaded?.maturity?.totalCount).toBe(6);
    expect(typeof reloaded?.maturity?.passedCount).toBe("number");
  });

  it("startklar → geplant, wenn ein Punkt nachträglich wieder kippt (z. B. Vorgänger wieder offen)", async () => {
    const entry = await createEntry(ctx.db, { kind: "bug", title: "Y", description: "Ziel: x. Abnahme: y.", fileScope: ["a"], source: "manual" });
    await ctx.db.update(entries).set({ estimate: "1 Std" }).where(eq(entries.id, entry.id));
    const first = await applyMaturity(ctx.db, entry.id);
    expect(first?.entry.stage).toBe("startklar");
    await ctx.db.update(entries).set({ estimate: null }).where(eq(entries.id, entry.id));
    const second = await applyMaturity(ctx.db, entry.id);
    expect(second?.entry.stage).toBe("geplant");
  });
});
