// Fortschritt: "Der Balken bewegt sich von selbst" — ein Bug mit 3 Teilaufgaben wird
// angelegt und nacheinander per MCP-äquivalenten Store-Aufrufen erledigt, ohne dass jemand von Hand
// den Fortschritt einträgt. Getestet auf Store-Ebene (dieselben Funktionen ruft `routes/entries.ts`
// UND die Brücken-MCP-Werkzeuge auf).
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { entryEvents, links, sessions } from "../src/db/schema.js";
import { completeSubtask, createEntry, getEntryDetail, linkObjects, reportProgress } from "../src/entries/store.js";
import { setup } from "./helpers.js";

describe("entries/store: Fortschritt bewegt sich von selbst", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("createEntry legt Bug mit 3 Teilaufgaben an, stage=geplant, progress=0", async () => {
    const entry = await createEntry(ctx.db, {
      kind: "bug",
      title: "App wird nach 10s beendet",
      subtasks: ["Auf Gerät nachstellen", "Speicherbericht auswerten", "Ursache beheben"],
      source: "mcp",
    });
    expect(entry.stage).toBe("geplant");
    expect(entry.progressPercent).toBe(0);
    expect(entry.kind).toBe("bug");
  });

  it("completeSubtask x3 bewegt den Balken 0 → 33 → 67 → 100 und die Stufe geplant → laeuft → pruefen, ohne manuellen Eingriff", async () => {
    await ctx.db.insert(sessions).values({ id: "claude:s1", tool: "claude", sessionId: "s1", title: "Bug-Session" });
    const created = await createEntry(ctx.db, { kind: "bug", title: "3-Schritt-Bug", subtasks: ["A", "B", "C"], source: "mcp", sessionKey: "claude:s1" });
    const detail1 = await getEntryDetail(ctx.db, created.id);
    if (!detail1) throw new Error("Eintrag wurde gerade angelegt, muss vorhanden sein");
    expect(detail1.subtasks).toHaveLength(3);
    const ids = detail1.subtasks.map((s) => s.id);

    const after1 = await completeSubtask(ctx.db, { entryId: created.id, subtaskId: ids[0], sessionKey: "claude:s1", source: "mcp" });
    expect(after1?.progressPercent).toBe(33);
    expect(after1?.stage).toBe("laeuft"); // erster Fortschritt hebt automatisch von "geplant"

    const after2 = await completeSubtask(ctx.db, { entryId: created.id, subtaskId: ids[1], sessionKey: "claude:s1", source: "mcp" });
    expect(after2?.progressPercent).toBe(67);
    expect(after2?.stage).toBe("laeuft");

    const after3 = await completeSubtask(ctx.db, { entryId: created.id, subtaskId: ids[2], sessionKey: "claude:s1", source: "mcp" });
    expect(after3?.progressPercent).toBe(100);
    expect(after3?.stage).toBe("pruefen"); // alle Teilaufgaben erledigt → Prüfen, NIE automatisch "erledigt"

    // Verlauf zeigt jede Teilaufgabe mit der verursachenden Session, nichts erfunden.
    const events = await ctx.db.select().from(entryEvents).where(eq(entryEvents.entryId, created.id));
    const doneEvents = events.filter((e) => e.kind === "teilaufgabe_erledigt");
    expect(doneEvents).toHaveLength(3);
    for (const e of doneEvents) expect((e.data as { sessionKey: string }).sessionKey).toBe("claude:s1");

    // Subtasks tragen die erledigende Session (nie behauptet, nur vom Store gesetzt).
    const finalDetail = await getEntryDetail(ctx.db, created.id);
    if (!finalDetail) throw new Error("Eintrag muss noch vorhanden sein");
    for (const s of finalDetail.subtasks) expect(s.doneBySessionKey).toBe("claude:s1");
  });

  it("completeSubtask per Titel (Codex hat keine numerische Teilaufgaben-ID zur Hand) funktioniert gleich", async () => {
    const created = await createEntry(ctx.db, { kind: "bug", title: "Codex-Bug", subtasks: ["Erster Schritt"], source: "mcp" });
    await ctx.db.insert(sessions).values({ id: "codex:c1", tool: "codex", sessionId: "c1", title: "Codex-Session" });
    const after = await completeSubtask(ctx.db, { entryId: created.id, subtaskTitle: "erster schritt", sessionKey: "codex:c1", source: "mcp" });
    expect(after?.progressPercent).toBe(100);
    expect(after?.stage).toBe("pruefen");
  });

  it("reportProgress hebt geplant→laeuft ohne Teilaufgaben und verknüpft die Session", async () => {
    const created = await createEntry(ctx.db, { kind: "frage", title: "Offene Frage", source: "mcp" });
    await ctx.db.insert(sessions).values({ id: "claude:s2", tool: "claude", sessionId: "s2", title: "Frage-Session" });
    const after = await reportProgress(ctx.db, { entryId: created.id, note: "Recherche läuft", sessionKey: "claude:s2", source: "mcp" });
    expect(after?.stage).toBe("laeuft");
    const rows = await ctx.db.select().from(links).where(eq(links.fromId, String(created.id)));
    expect(rows.some((r) => r.toId === "claude:s2" && r.relation === "session")).toBe(true);
  });

  it("linkObjects ist idempotent (gleicher Link zweimal → nur eine Zeile)", async () => {
    const a = await createEntry(ctx.db, { kind: "bug", title: "A", source: "mcp" });
    const b = await createEntry(ctx.db, { kind: "bug", title: "B", source: "mcp" });
    await linkObjects(ctx.db, { fromType: "entry", fromId: String(a.id), toType: "entry", toId: String(b.id), relation: "verwandt", source: "test" });
    await linkObjects(ctx.db, { fromType: "entry", fromId: String(a.id), toType: "entry", toId: String(b.id), relation: "verwandt", source: "test" });
    const rows = await ctx.db.select().from(links).where(eq(links.fromId, String(a.id)));
    expect(rows).toHaveLength(1);
  });

  it("getEntryDetail liefert weiterklickbare Verknüpfungen in beide Richtungen mit Label", async () => {
    const a = await createEntry(ctx.db, { kind: "entscheidung", title: "B2B ja/nein?", source: "mcp" });
    const b = await createEntry(ctx.db, { kind: "aufgabe", title: "A04 Rollen", source: "manual" });
    await linkObjects(ctx.db, { fromType: "entry", fromId: String(a.id), toType: "entry", toId: String(b.id), relation: "blockiert", source: "test" });
    const detailA = await getEntryDetail(ctx.db, a.id);
    expect(detailA?.links[0]).toMatchObject({ label: "A04 Rollen", relation: "blockiert", direction: "out" });
    const detailB = await getEntryDetail(ctx.db, b.id);
    expect(detailB?.links[0]).toMatchObject({ label: "B2B ja/nein?", relation: "blockiert", direction: "in" });
  });
});
