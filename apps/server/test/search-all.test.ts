// `GET /api/search/all?q=` — ⌘K sucht alles. Saat-Daten je Art, Grenze 5 je Gruppe,
// Sonderzeichen sicher, deutsche Wortformen, immer nur mit Anmeldung.
import type { IngestItem, SearchAllResponse, SessionSummary } from "@nyxos/shared";
import { emptyTokens, SEARCH_ALL_KINDS, SEARCH_ALL_PER_KIND } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { agentCatalog, docs, entries, nyxMemory, skills } from "../src/db/schema.js";
import { needsAuth } from "../src/terminal/auth.js";
import { setup } from "./helpers.js";

type App = Awaited<ReturnType<typeof setup>>;

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: null,
  title: null,
  titleSource: null,
  startedAt: "2026-09-24T10:00:00.000Z",
  lastActivityAt: "2026-09-24T10:00:00.000Z",
  models: [],
  tokens: emptyTokens(),
  toolCalls: {},
  filesWritten: [],
  filesRead: [],
  subagents: [],
  gitBranch: null,
  cliVersion: null,
  eventCount: 0,
  parseErrors: 0,
  limits: null,
  lastUsage: null,
  lastUsageModel: null,
  modelContextWindow: null,
  ...over,
});
const summaryItem = (s: SessionSummary): IngestItem => ({ type: "summary", summary: s });

async function all(t: App, q: string): Promise<SearchAllResponse> {
  const res = await t.app.request(`/api/search/all?${new URLSearchParams({ q }).toString()}`);
  expect(res.status).toBe(200);
  return (await res.json()) as SearchAllResponse;
}

const group = (r: SearchAllResponse, kind: string) => r.groups.find((g) => g.kind === kind);

async function seed(t: App) {
  await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-heat", title: "Heatmap-Farben nachziehen" }))] });
  await t.db.insert(entries).values([
    { kind: "idee", title: "Heatmap zeigt Freunde live", description: "Punkte auf der Karte", sourceType: "idea", sourceId: "0b8f0a8e-5d1e-4c1a-9a51-6f1f5a0c7e11" },
    { kind: "idee", title: "Eigene Idee ohne Postfach", description: "Heatmap nur lokal" },
    { kind: "aufgabe", title: "P9 · Karten-Ansicht", description: "Die Heatmap wird schneller", sourceType: "goal", sourceId: "auftraege/P9-karte/GOAL.md" },
    { kind: "aufgabe", title: "P10 · Nur im Dokument", description: "Kurztext ohne Treffer", sourceType: "goal", sourceId: "auftraege/P10-doku/GOAL.md" },
    { kind: "audit", title: "A-12 — Heatmap lädt doppelt", description: "Schwere: hoch", sourceType: "audit", sourceId: "A-12" },
    { kind: "bug", title: "Absturz beim Speichern", description: "Hängt an der Stimme" },
  ]);
  await t.db.insert(docs).values({ path: "auftraege/P10-doku/GOAL.md", content: "# P10\n\nViel Text. Hier steht das Wort Zauberwürfel mitten im Auftrag.\n", sha256: "x", sizeBytes: 10 });
  await t.db.insert(nyxMemory).values([
    { category: "preference", fact: "Alex mag die Stimme von Nyx ruhig und tief." },
    { category: "project", fact: "Shop startet in Lisbon." },
  ]);
  await t.db.insert(skills).values([
    { key: "heatmap-check", name: "heatmap-check", description: "Prüft die Heatmap auf Lücken", source: "user" },
    { key: "weg-skill", name: "weg-skill", description: "Heatmap alt", source: "user", missingSince: "2026-09-01T00:00:00.000Z" },
  ]);
  await t.db.insert(agentCatalog).values([
    { kind: "agent", name: "heatmap-reviewer", description: "Kritiker für die Heatmap", path: "/x/heatmap-reviewer.md", source: "user", machineId: "m1" },
    { kind: "skill", name: "nur-katalog", description: "Heatmap im Katalog (kein Agent)", path: "/x/nur-katalog", source: "user", machineId: "m1" },
  ]);
}

describe("GET /api/search/all", () => {
  it("findet „Heatmap“ gruppiert in Sessions, Ideen, Aufträgen, Audits, Skills und Agenten — mit Sprungziel", async () => {
    const t = await setup();
    await seed(t);
    const r = await all(t, "Heatmap");
    expect(r.q).toBe("Heatmap");
    // Reihenfolge der Gruppen folgt SEARCH_ALL_KINDS, leere Gruppen fallen weg.
    const kinds = r.groups.map((g) => g.kind);
    expect(kinds).toEqual(SEARCH_ALL_KINDS.filter((k) => kinds.includes(k)));
    expect(kinds).toEqual(["session", "idee", "auftrag", "audit", "skill", "agent"]);

    expect(group(r, "session")?.hits[0]?.title).toBe("Heatmap-Farben nachziehen");
    expect(group(r, "session")?.hits[0]?.path).toMatch(/^\/sessions\/[^/]+\/[^/]+\/s-heat$/);
    const ideas = group(r, "idee")?.hits ?? [];
    expect(ideas.length).toBeGreaterThan(0);
    for (const h of ideas) expect(h.path).toMatch(/^\/tasks\?e=\d+$/);
    expect(group(r, "auftrag")?.hits).toEqual([expect.objectContaining({ title: "P9 · Karten-Ansicht", snippet: "Die Heatmap wird schneller" })]);
    expect(group(r, "auftrag")?.hits[0]?.path).toMatch(/^\/tasks\?e=\d+$/);
    expect(group(r, "audit")?.hits[0]).toMatchObject({ title: "A-12 — Heatmap lädt doppelt" });
    expect(group(r, "audit")?.hits[0]?.path).toMatch(/^\/audits\?e=\d+$/);
    // Verschwundene Skills (missing_since) und Katalog-Skills tauchen nicht auf.
    expect(group(r, "skill")?.hits).toEqual([{ kind: "skill", title: "heatmap-check", snippet: "Prüft die Heatmap auf Lücken", path: "/skills/heatmap-check" }]);
    expect(group(r, "agent")?.hits).toEqual([{ kind: "agent", title: "heatmap-reviewer", snippet: "Kritiker für die Heatmap", path: "/agents?agent=heatmap-reviewer" }]);
    expect(r.tookMs).toBeGreaterThanOrEqual(0);
  });

  it("„Stimme“ findet eine Gedächtnis-Zeile (und den Bug) — deutsche Wortform „Stimmen“ trifft auch", async () => {
    const t = await setup();
    await seed(t);
    const r = await all(t, "Stimme");
    expect(group(r, "gedaechtnis")?.hits).toEqual([
      { kind: "gedaechtnis", title: "Vorlieben", snippet: "Alex mag die Stimme von Nyx ruhig und tief.", path: "/nyx?r=gedaechtnis" },
    ]);
    expect(group(r, "auftrag")?.hits.map((h) => h.title)).toEqual(["Absturz beim Speichern"]);
    const plural = await all(t, "Stimmen");
    expect(group(plural, "gedaechtnis")?.hits).toHaveLength(1);
  });

  it("Auftrag wird auch über den Text seiner GOAL.md gefunden (Ausschnitt um den Treffer)", async () => {
    const t = await setup();
    await seed(t);
    const r = await all(t, "Zauberwürfel");
    const hit = group(r, "auftrag")?.hits[0];
    expect(hit?.title).toBe("P10 · Nur im Dokument");
    expect(hit?.snippet).toContain("Zauberwürfel");
  });

  it("höchstens 5 Treffer je Gruppe", async () => {
    const t = await setup();
    await t.db.insert(nyxMemory).values(Array.from({ length: 9 }, (_, i) => ({ category: "user", fact: `Kaffee Nummer ${i}` })));
    await t.db.insert(entries).values(Array.from({ length: 8 }, (_, i) => ({ kind: "aufgabe", title: `Kaffee-Auftrag ${i}` })));
    const r = await all(t, "Kaffee");
    expect(group(r, "gedaechtnis")?.hits).toHaveLength(SEARCH_ALL_PER_KIND);
    expect(group(r, "auftrag")?.hits).toHaveLength(SEARCH_ALL_PER_KIND);
  });

  it("Sonderzeichen % _ ' \\ sind sicher und wörtlich", async () => {
    const t = await setup();
    await t.db.insert(entries).values([
      { kind: "aufgabe", title: "Rabatt 50% für alle" },
      { kind: "aufgabe", title: "Rabatt 50 Euro" },
      { kind: "aufgabe", title: "datei_name umbenennen" },
      { kind: "aufgabe", title: "dateiXname anders" },
      { kind: "aufgabe", title: "Alex' Liste" },
    ]);
    expect(group(await all(t, "50%"), "auftrag")?.hits.map((h) => h.title)).toEqual(["Rabatt 50% für alle"]);
    expect(group(await all(t, "i_n"), "auftrag")?.hits.map((h) => h.title)).toEqual(["datei_name umbenennen"]);
    expect(group(await all(t, "Alex'"), "auftrag")?.hits.map((h) => h.title)).toEqual(["Alex' Liste"]);
    for (const q of ["%%", "__", "''", "\\\\", "'; drop table entries; --", "a:*|b", "<script>"]) {
      const res = await t.app.request(`/api/search/all?${new URLSearchParams({ q }).toString()}`);
      expect(res.status, q).toBe(200);
    }
    expect((await all(t, "%%")).groups).toEqual([]);
  });

  it("unter 2 Zeichen: leer ohne Fehler; über 200 Zeichen: 400 mit deutschem Satz", async () => {
    const t = await setup();
    await seed(t);
    expect((await all(t, "")).groups).toEqual([]);
    expect((await all(t, " H ")).groups).toEqual([]);
    const res = await t.app.request(`/api/search/all?q=${"x".repeat(201)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/zu lang/);
  });

  it("immer nur mit Anmeldung (liefert Nyx-Gedächtnis) — ohne Anmeldung 401, auch wenn Lesen sonst frei ist", async () => {
    for (const authReads of [true, false]) expect(needsAuth("GET", "/api/search/all", authReads)).toBe(true);
    const anon = await setup({ signedIn: false });
    await anon.db.insert(nyxMemory).values({ category: "preference", fact: "Geheime Stimme" });
    const res = await anon.app.request(`/api/search/all?q=Stimme`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("Geheime");
  });
});
