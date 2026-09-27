// Aufträge mit `BERICHT.md` sind fertig. Vorher standen Aufträge auf „Geplant 0 %“ mit „Agent
// starten“, obwohl daneben ein Bericht lag (Gefahr doppelter Arbeit). Regel: BERICHT.md direkt neben der
// GOAL.md → der Import setzt den Auftrag EINMAL auf „Erledigt“ (nur aus „Geplant“/„Startklar“), mit
// Ereignis im Verlauf. Eine GOAL ohne BERICHT bleibt offen. Was danach jemand ändert, bleibt stehen.
// Dazu: Audit-Befunde zählen nie doppelt (gleiche Nummer in zwei Plänen, wiederholte Lieferungen).
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { docs, entries, entryEvents, links } from "../src/db/schema.js";
import { setup } from "./helpers.js";

const goal = (title: string) => `# ${title}\n\n## ZIEL\n\nEtwas bauen.\n\n## ABNAHME\n\n1. Test grün.\n`;
const P1 = "docs/tasks/P1-fundament/GOAL.md";
const P1_REPORT = "docs/tasks/P1-fundament/BERICHT.md";
const R2 = "docs/tasks/R2-nyx/GOAL.md";
const A01 = "App/docs/neubau/10-Aufgaben/A01-Aufraeumen/GOAL.md";

const FILES = [
  { path: P1, content: goal("P1 Fundament") },
  { path: P1_REPORT, content: "# Bericht P1\n\nAlles abgenommen.\n" },
  { path: R2, content: goal("R2 Nyx") },
  { path: A01, content: goal("A01 Aufräumen") },
];

function delivery(files: { path: string; content: string }[], complete = true) {
  return { complete, scannedAt: new Date().toISOString(), files, errors: [] };
}

async function bySource(t: Awaited<ReturnType<typeof setup>>, sourceId: string) {
  const [row] = await t.db.select().from(entries).where(eq(entries.sourceId, sourceId));
  if (!row) throw new Error(`Eintrag ${sourceId} fehlt`);
  return row;
}

describe("BERICHT.md → Auftrag erledigt", () => {
  it("GOAL mit BERICHT wird „Erledigt“, GOAL ohne BERICHT bleibt „Geplant“", async () => {
    const t = await setup();
    const res = await t.post("/ingest/entry-sources", delivery(FILES));
    expect(res.status).toBe(200);
    expect((await bySource(t, P1)).stage).toBe("erledigt");
    expect((await bySource(t, R2)).stage).toBe("geplant");
    expect((await bySource(t, A01)).stage).toBe("geplant");
    // Der Bericht selbst ist kein Auftrag.
    expect(await t.db.select().from(entries).where(eq(entries.sourceId, P1_REPORT))).toHaveLength(0);
    expect((await t.db.select().from(entries).where(eq(entries.kind, "aufgabe"))).length).toBe(3);
  });

  it("nachvollziehbar: Ereignis im Verlauf, Bericht verknüpft und im Doku-Spiegel lesbar", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(FILES));
    const p1 = await bySource(t, P1);
    const events = await t.db.select().from(entryEvents).where(eq(entryEvents.entryId, p1.id));
    const ev = events.find((e) => e.kind === "erledigt_durch_bericht");
    expect(ev).toBeDefined();
    expect(ev?.source).toBe("import");
    expect(ev?.data).toMatchObject({ bericht: P1_REPORT, vorher: "geplant" });
    const [link] = await t.db
      .select()
      .from(links)
      .where(and(eq(links.fromType, "entry"), eq(links.fromId, String(p1.id)), eq(links.toType, "doc"), eq(links.toId, P1_REPORT)));
    expect(link?.relation).toBe("bericht");
    const [doc] = await t.db.select().from(docs).where(eq(docs.path, P1_REPORT));
    expect(doc?.content).toContain("Alles abgenommen");
    const detail = (await (await t.app.request(`/api/entries/${p1.id}`)).json()) as { docs: { path: string }[] };
    expect(detail.docs.map((d) => d.path)).toContain(P1_REPORT);
  });

  it("zählt nicht als „heute fertig“: updatedAt bleibt (wann der Bericht kam, wissen wir nicht)", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(FILES.filter((f) => f.path !== P1_REPORT)));
    const before = await bySource(t, P1);
    await t.post("/ingest/entry-sources", delivery(FILES));
    const after = await bySource(t, P1);
    expect(after.stage).toBe("erledigt");
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("zweite gleiche Lieferung ändert nichts (kein zweites Ereignis, updated=0)", async () => {
    const t = await setup();
    const first = (await (await t.post("/ingest/entry-sources", delivery(FILES))).json()) as { dateien: { erledigt: number } };
    expect(first.dateien.erledigt).toBe(1);
    const second = (await (await t.post("/ingest/entry-sources", delivery(FILES))).json()) as { dateien: { created: number; updated: number; erledigt: number } };
    expect(second.dateien).toMatchObject({ created: 0, updated: 0, erledigt: 0 });
    const p1 = await bySource(t, P1);
    const events = await t.db.select().from(entryEvents).where(and(eq(entryEvents.entryId, p1.id), eq(entryEvents.kind, "erledigt_durch_bericht")));
    expect(events).toHaveLength(1);
  });

  it("von Hand geänderte Stufe bleibt: nach dem Zurücksetzen auf „Geplant“ setzt der Import nicht erneut", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(FILES));
    const p1 = await bySource(t, P1);
    await t.db.update(entries).set({ stage: "geplant" }).where(eq(entries.id, p1.id)); // der Nutzer öffnet ihn wieder
    await t.post("/ingest/entry-sources", delivery(FILES.map((f) => (f.path === P1_REPORT ? { ...f, content: `${f.content}\nNachtrag.\n` } : f))));
    expect((await bySource(t, P1)).stage).toBe("geplant");
  });

  it("was gerade läuft oder auf Abnahme wartet, überschreibt der Bericht nicht", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(FILES.filter((f) => f.path !== P1_REPORT)));
    await t.db.update(entries).set({ stage: "laeuft" }).where(eq(entries.sourceId, P1));
    await t.db.update(entries).set({ stage: "pruefen" }).where(eq(entries.sourceId, R2));
    await t.post(
      "/ingest/entry-sources",
      delivery([...FILES, { path: "docs/tasks/R2-nyx/BERICHT.md", content: "# Bericht R2\n" }]),
    );
    expect((await bySource(t, P1)).stage).toBe("laeuft");
    expect((await bySource(t, R2)).stage).toBe("pruefen");
  });

  it("Bericht kommt später dazu → beim nächsten Import erledigt; Bericht ohne GOAL daneben wird ignoriert", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(FILES.filter((f) => f.path !== P1_REPORT)));
    expect((await bySource(t, P1)).stage).toBe("geplant");
    const res = await t.post("/ingest/entry-sources", delivery([...FILES, { path: "App/docs/ohne-goal/BERICHT.md", content: "# Irgendwas\n" }]));
    expect(res.status).toBe(200);
    expect((await bySource(t, P1)).stage).toBe("erledigt");
    expect((await t.db.select().from(entries).where(eq(entries.kind, "aufgabe"))).length).toBe(3);
  });

  it("Stand bleibt nach „Jetzt importieren“ (Import aus dem Spiegel, ohne neue Lieferung)", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(FILES));
    const res = await t.app.request("/api/entries/import/run", { method: "POST" });
    expect(res.status).toBeLessThan(500);
    expect((await bySource(t, P1)).stage).toBe("erledigt");
  });

  it("BERICHT.md in Arbeitskopien oder außerhalb des Projekts wird abgelehnt (400)", async () => {
    const t = await setup();
    for (const path of [".worktrees/alt/BERICHT.md", "../alt/BERICHT.md", "node_modules/x/BERICHT.md"]) {
      const res = await t.post("/ingest/entry-sources", delivery([{ path, content: "x" }]));
      expect(res.status, path).toBe(400);
    }
  });
});

describe("Audit-Befunde zählen nie doppelt", () => {
  const plan = (rows: string[]) =>
    `| Rang | Stufe | Befund | Schwere | R | Aufwand | Paket | Vorher |\n|---:|---:|---|---|---:|---|---|---|\n${rows.join("\n")}\n`;
  const row = (rank: number, id: string, title: string) => `| ${rank} | 1 | [${id} — ${title}](../x.md) | Hoch | 3 | S | P-${id} | — |`;

  it("dieselbe Befund-Nummer in zwei Maßnahmenplänen und mehreren Lieferungen → genau ein Eintrag", async () => {
    const t = await setup();
    const a = { path: "App/docs/audit-2026-09/11-Plan/MASSNAHMENPLAN.md", content: plan([row(1, "B-1", "Eins"), row(2, "B-2", "Zwei")]) };
    const b = { path: "App/docs/audit-2026-10/11-Plan/MASSNAHMENPLAN.md", content: plan([row(1, "B-2", "Zwei"), row(2, "B-3", "Drei")]) };
    for (let i = 0; i < 3; i++) await t.post("/ingest/entry-sources", delivery([a, b, ...FILES]));
    const audits = await t.db.select().from(entries).where(eq(entries.kind, "audit"));
    expect(audits.map((x) => x.sourceId).sort()).toEqual(["B-1", "B-2", "B-3"]);
    const goals = await t.db.select().from(entries).where(eq(entries.kind, "aufgabe"));
    expect(goals).toHaveLength(3);
  });
});
