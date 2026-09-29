// Aufgaben/Audits kommen wirklich an. Die Brücke liefert die Quelldateien
// (`POST /ingest/entry-sources`), der Server importiert daraus — idempotent, fehlende Quellen werden
// markiert statt gelöscht.
import type { EntryImportStatus } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries } from "../src/db/schema.js";
import { setup } from "./helpers.js";

async function j<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const goal = (title: string) => `# ${title}\n\n## ZIEL\n\nEtwas bauen in \`App/backend/x/y.ts\`.\n\n## ABNAHME\n\n1. Test grün.\n`;

const AUDIT = `## Gesamtreihenfolge sämtlicher Befunde

| Rang | Stufe | Befund / zu behebendes Problem | Schwere | R | Originalaufwand | Paket | Vorher abschließen |
|---:|---:|---|---|---:|---|---|---|
| 1 | 0 | [B-115 — Negative Seitengröße stürzt ab](../02-Sicherheit/x.md) | Kritisch | 5 | S | P-B-115 | — |
| 2 | 1 | [C-50 — Schlüssellesefehler löscht DB](../04-Speicher/z.md) | Kritisch | 5 | L | P-C-50 | — |
`;

const AUDIT_PATH = "App/docs/audit-2026-09/11-Priorisierter-Massnahmenplan/MASSNAHMENPLAN.md";

function delivery(files: { path: string; content: string }[], complete = true) {
  return { complete, scannedAt: new Date().toISOString(), files, errors: [] };
}

const BASE_FILES = [
  { path: "App/docs/feature-a/GOAL.md", content: goal("Auftrag A") },
  { path: "docs/tasks/P1-fundament/GOAL.md", content: goal("P1 Fundament") },
  { path: AUDIT_PATH, content: AUDIT },
];

describe("Brücken-Lieferung → Server-Import", () => {
  it("Status vor der ersten Lieferung: sagt einfach, dass die Brücke noch nichts geschickt hat", async () => {
    const t = await setup();
    const status = await j<EntryImportStatus>(await t.app.request("/api/entries/import/status"));
    expect(status.dateien.state).toBe("wartet");
    expect(status.dateien.message).toBe("Die Brücke hat die Dateien noch nicht geschickt.");
  });

  it("Lieferung legt Aufgaben + Audit-Befunde an; Status zeigt Zahlen", async () => {
    const t = await setup();
    const res = await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    expect(res.status).toBe(200);
    const rows = await t.db.select().from(entries);
    expect(rows.filter((r) => r.kind === "aufgabe").map((r) => r.title).sort()).toEqual(["Auftrag A", "P1 Fundament"]);
    expect(rows.filter((r) => r.kind === "audit")).toHaveLength(2);
    const status = await j<EntryImportStatus>(await t.app.request("/api/entries/import/status"));
    expect(status.dateien.state).toBe("ok");
    expect(status.dateien.lastDeliveryAt).not.toBeNull();
    expect(status.dateien.counts).toMatchObject({ aufgaben: 2, audits: 2 });
  });

  it("ohne Maschinen-Token: 401, nichts importiert", async () => {
    const t = await setup();
    const res = await t.post("/ingest/entry-sources", delivery(BASE_FILES), {});
    expect(res.status).toBe(401);
    expect(await t.db.select().from(entries)).toHaveLength(0);
  });

  it("Pfade außerhalb der Quell-Ordner werden abgelehnt (400), nichts importiert", async () => {
    const t = await setup();
    for (const path of ["../etc/GOAL.md", ".worktrees/x/App/docs/GOAL.md", "App/docs/.env", "/Users/x/projects/App/docs/a/GOAL.md"]) {
      const res = await t.post("/ingest/entry-sources", delivery([{ path, content: goal("Böse") }]));
      expect(res.status, path).toBe(400);
    }
    expect(await t.db.select().from(entries)).toHaveLength(0);
  });

  it("zweite gleiche Lieferung ist idempotent: keine Dopplung, kein Eintrag verändert (updatedAt bleibt)", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    const before = await t.db.select().from(entries);
    const second = await j<{ dateien: { created: number; updated: number } }>(await t.post("/ingest/entry-sources", delivery(BASE_FILES)));
    expect(second.dateien.created).toBe(0);
    expect(second.dateien.updated).toBe(0);
    const after = await t.db.select().from(entries);
    expect(after).toHaveLength(before.length);
    for (const row of after) expect(row.updatedAt).toBe(before.find((b) => b.id === row.id)?.updatedAt);
  });

  it("geänderter Titel in der GOAL.md wird nachgezogen (updated=1), Rest unverändert", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    const changed = BASE_FILES.map((f) => (f.path === "App/docs/feature-a/GOAL.md" ? { ...f, content: goal("Auftrag A (neu)") } : f));
    const r = await j<{ dateien: { created: number; updated: number } }>(await t.post("/ingest/entry-sources", delivery(changed)));
    expect(r.dateien).toMatchObject({ created: 0, updated: 1 });
    const [row] = await t.db.select().from(entries).where(eq(entries.sourceId, "App/docs/feature-a/GOAL.md"));
    expect(row?.title).toBe("Auftrag A (neu)");
  });

  it("gelöschte Quelle → „Quelle entfernt“ markiert, nicht gelöscht; taucht sie wieder auf, ist die Markierung weg", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    const withoutA = BASE_FILES.filter((f) => f.path !== "App/docs/feature-a/GOAL.md");
    await t.post("/ingest/entry-sources", delivery(withoutA));
    const [gone] = await t.db.select().from(entries).where(eq(entries.sourceId, "App/docs/feature-a/GOAL.md"));
    expect(gone).toBeDefined();
    expect(gone?.sourceRemovedAt).not.toBeNull();
    const list = await j<{ entries: { sourceId: string; sourceRemovedAt: string | null }[] }>(await t.app.request("/api/entries?kind=aufgabe"));
    expect(list.entries.find((e) => e.sourceId === "App/docs/feature-a/GOAL.md")?.sourceRemovedAt).not.toBeNull();
    await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    const [back] = await t.db.select().from(entries).where(eq(entries.sourceId, "App/docs/feature-a/GOAL.md"));
    expect(back?.sourceRemovedAt).toBeNull();
    expect(await t.db.select().from(entries).where(eq(entries.sourceId, "App/docs/feature-a/GOAL.md"))).toHaveLength(1);
  });

  it("Audit-Zeile verschwindet aus dem Maßnahmenplan → nur dieser Befund wird markiert", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    const shorter = AUDIT.split("\n")
      .filter((l) => !l.includes("C-50"))
      .join("\n");
    await t.post("/ingest/entry-sources", delivery(BASE_FILES.map((f) => (f.path === AUDIT_PATH ? { ...f, content: shorter } : f))));
    const audits = await t.db.select().from(entries).where(eq(entries.kind, "audit"));
    expect(audits.find((a) => a.sourceId === "C-50")?.sourceRemovedAt).not.toBeNull();
    expect(audits.find((a) => a.sourceId === "B-115")?.sourceRemovedAt).toBeNull();
  });

  it("unvollständige Lieferung (Lesefehler) markiert nichts als entfernt", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    await t.post("/ingest/entry-sources", delivery(BASE_FILES.slice(1), false));
    const rows = await t.db.select().from(entries);
    expect(rows.every((r) => r.sourceRemovedAt === null)).toBe(true);
  });

  it("leere Lieferung (Brücke findet gar nichts) markiert nichts — eher falscher Ordner als alles gelöscht", async () => {
    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    await t.post("/ingest/entry-sources", delivery([]));
    const rows = await t.db.select().from(entries);
    expect(rows.every((r) => r.sourceRemovedAt === null)).toBe(true);
    const status = await j<EntryImportStatus>(await t.app.request("/api/entries/import/status"));
    expect(status.dateien.state).toBe("leer");
  });

  it("„Jetzt importieren“ braucht eine Anmeldung und läuft dann aus dem letzten Stand der Brücke", async () => {
    const anon = await setup({ signedIn: false });
    const denied = await anon.app.request("/api/entries/import/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect([401, 403]).toContain(denied.status);

    const t = await setup();
    await t.post("/ingest/entry-sources", delivery(BASE_FILES));
    const res = await t.app.request("/api/entries/import/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const body = await j<{ status: EntryImportStatus }>(res);
    expect(body.status.dateien.state).toBe("ok");
    expect(Object.keys(body.status)).toEqual(["dateien"]);
  });
});
