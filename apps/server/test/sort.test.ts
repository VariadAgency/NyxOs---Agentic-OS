import type { IngestItem, SessionSummary } from "@nyxos/shared";
import { emptyTokens } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessions, sortRules } from "../src/db/schema.js";
import { resortAll, SkillsCache } from "../src/store.js";
import { setup } from "./helpers.js";

/**
 * Einsortierung über den Server: Ingest → `category_*`-Spalten, Korrektur per
 * `POST /api/sessions/:id/assign` legt eine Regel an und zieht Bestandssessions sowie neue
 * Sessions nach, `category_manual` bleibt vor Neuberechnung geschützt.
 */

/** Arbeitsordner wie in echten Sessions: das Projekt der ersten geänderten/gelesenen Datei
 * (`/Users/alex/projects/<projekt>/…`), sonst keiner. */
function projectCwd(over: Partial<SessionSummary>): string | null {
  const first = over.filesWritten?.[0] ?? over.filesRead?.[0];
  const m = first ? /^(\/Users\/alex\/(?:projects|code)\/[^/]+)\//.exec(first) : null;
  return m?.[1] ?? null;
}

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "sessionId">): SessionSummary => ({
  tool: "claude",
  parentSessionId: null,
  cwd: projectCwd(over),
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

/**
 * "Füll"-Sessions mit je einem eigenen, nirgendwo sonst vorkommenden Ordner und Titel-Wort — nur
 * dafür da, den Nenner (alle Haupt-Sessions) zu vergrößern, damit die eigentlich getesteten Ordner/
 * Titel-Wörter realistisch SELTEN sind (die 25-%-/15-%-Schwellen greifen bei
 * 1–2 Sessions in einer winzigen Test-DB IMMER — das bildet die echten Verhältnisse (Dutzende
 * Sessions) nicht ab). Jede Füll-Session trägt nichts zu den gemessenen Anteilen der Test-Sessions bei.
 */
function fillerItems(prefix: string, n: number): IngestItem[] {
  return Array.from({ length: n }, (_, i) =>
    summaryItem(
      summary({
        sessionId: `${prefix}-filler-${i}`,
        title: `Kaiserschmarrn${i} Sitzung${i}`,
        filesWritten: [`/Users/alex/projects/kaiserschmarrn${i}/a.ts`],
      }),
    ),
  );
}

async function row(t: Awaited<ReturnType<typeof setup>>, id: string) {
  const [s] = await t.db.select().from(sessions).where(eq(sessions.id, `claude:${id}`));
  return s;
}

describe("Einsortierung beim Ingest", () => {
  it("Titel-Wortfeld setzt Art 'server', Ordner setzt Baustelle 'nyxos'", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(
          summary({
            sessionId: "s-server",
            title: "Postgres 18 upgrade",
            cwd: "/Users/alex/code/NyxOS",
            filesWritten: ["/Users/alex/code/NyxOS/a.ts"],
          }),
        ),
      ],
    });
    const s = await row(t, "s-server");
    expect(s?.categoryArt).toBe("server");
    expect(s?.categoryBaustelleSlug).toBe("nyxos");
    expect(s?.categoryBaustelleLabel).toBe("NyxOS");
    expect(s?.categoryManual).toBe(false);
    expect(s?.categoryReason).toEqual([
      { stage: "folder", detail: "Ordner NyxOS", ruleId: null, dim: "baustelle" },
      { stage: "keyword", detail: 'Titel-Wort „postgres"', ruleId: null, dim: "art" },
    ]);
  });

  it("ohne jeden Treffer bleibt eine Session 'unsortiert' mit 'Ohne Baustelle'", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-leer", title: "xyz" }))] });
    const s = await row(t, "s-leer");
    expect(s?.categoryArt).toBe("unsortiert");
    expect(s?.categoryBaustelleSlug).toBeNull();
  });

  it("liefert art/baustelle/reason über GET /api/sessions und /api/sessions/:id", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-api", title: "Shop Recherche Bar-Systeme" }))] });
    const list = (await (await t.app.request("/api/sessions")).json()) as { sessions: { art: string; baustelle: unknown }[] };
    expect(list.sessions[0]?.art).toBe("recherche");
    expect(list.sessions[0]).not.toHaveProperty("categoryArt");
    const detail = (await (await t.app.request("/api/sessions/s-api")).json()) as { session: { art: string } };
    expect(detail.session.art).toBe("recherche");
  });
});

describe("Thema innerhalb eines Projekts über den Ingest", () => {
  it("ein Feature-Ordner im Projekt ergibt eine feinere Baustelle als das ganze Projekt", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(
          summary({
            sessionId: "s-messenger",
            title: "Messenger Bugfix",
            filesWritten: [
              "/Users/alex/projects/shop/Features/Messenger/Core/MessengerService.swift",
              "/Users/alex/projects/shop/Features/Messenger/Views/ChatView.swift",
            ],
          }),
        ),
      ],
    });
    const s = await row(t, "s-messenger");
    expect(s?.categoryBaustelleSlug).toBe("messenger");
    expect(s?.categoryBaustelleLabel).toBe("Messenger");
  });

  it("eine spätere Session ohne Datei-Evidenz, aber mit passendem Titel-Wort, bekommt dieselbe (jetzt bekannte) Baustelle", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(
          summary({
            sessionId: "s-messenger-code",
            title: "Messenger Fix",
            filesWritten: [
              "/Users/alex/projects/shop/Features/Messenger/Core/MessengerService.swift",
              "/Users/alex/projects/shop/Features/Messenger/Views/ChatView.swift",
            ],
          }),
        ),
      ],
    });
    expect((await row(t, "s-messenger-code"))?.categoryBaustelleSlug).toBe("messenger");

    // Reine Besprechung ohne jede Datei-Änderung — Baustelle kommt nur noch über das Titel-Wort.
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-messenger-talk", title: "Messenger Planung mit dem Team" }))] });
    const talk = await row(t, "s-messenger-talk");
    expect(talk?.categoryBaustelleSlug).toBe("messenger");
    expect(talk?.categoryReason).toContainEqual(expect.objectContaining({ stage: "baustelle-titel" }));
  });
});

describe("POST /api/sessions/:id/assign (Korrektur, getrennte Dimensionen)", () => {
  it("Ziehen auf einen BAUSTELLEN-Tab (nur 'baustelle' im Body) setzt NUR die Baustelle — die Art bleibt automatisch", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("a", 8) });
    // Zwei Sessions mit demselben (seltenen) dominanten Ordner, die ohne Regel beide "coding" und das
    // Projekt „archiv“ als Baustelle hätten — die Regel unten setzt eine andere, beobachtbare Baustelle.
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-1", title: "Feature A", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/a.ts"] })),
        summaryItem(summary({ sessionId: "s-2", title: "Feature B", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/b.ts"] })),
      ],
    });
    expect((await row(t, "s-1"))?.categoryArt).toBe("coding");
    expect((await row(t, "s-1"))?.categoryBaustelleSlug).toBe("archiv");

    const res = await t.post("/api/sessions/s-1/assign", { baustelle: { slug: "neuprojekt", label: "Neuprojekt" }, asRule: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: { id: number; dimension: string; origin: string }[]; resorted: string[]; manualOnly: string[] };
    expect(body.rules).toHaveLength(1);
    const [rule] = body.rules;
    expect(rule?.dimension).toBe("baustelle");
    expect(rule?.origin).toBe("korrektur");
    expect(body.manualOnly).toEqual([]);
    expect(body.resorted).toContain("claude:s-2");

    const s1 = await row(t, "s-1");
    expect(s1?.categoryBaustelleSlug).toBe("neuprojekt");
    expect(s1?.categoryArt).toBe("coding"); // unverändert — nur die Baustelle wurde korrigiert
    expect(s1?.categoryManualBaustelle).toBe(true);
    expect(s1?.categoryManualArt).toBe(false);
    expect(s1?.categoryReason).toEqual([
      { stage: "korrektur", detail: "Ordner archiv", ruleId: rule?.id, dim: "baustelle" },
      { stage: "fallback", detail: "Datei-Änderungen ohne anderen Treffer", ruleId: null, dim: "art" },
    ]);

    const s2 = await row(t, "s-2");
    expect(s2?.categoryBaustelleSlug).toBe("neuprojekt"); // per Regel nachgezogen (vorher: das Projekt)
    expect(s2?.categoryArt).toBe("coding"); // weiterhin automatisch — die Regel hat nie die Art berührt
    expect(s2?.categoryManualBaustelle).toBe(false);
  });

  it("Ziehen auf einen ART-Tab (nur 'art' im Body) setzt NUR die Art — die Baustelle bleibt automatisch", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("b", 8) });
    await t.post("/ingest/events", {
      items: [summaryItem(summary({ sessionId: "s-art", title: "Zoomarkt Bugfix", filesWritten: ["/Users/alex/projects/zoomarkt/a.ts"] }))],
    });
    expect((await row(t, "s-art"))?.categoryBaustelleSlug).toBe("zoomarkt"); // alter Worktree-Name als Baustelle

    const res = await t.post("/api/sessions/s-art/assign", { art: "recherche", asRule: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: { dimension: string }[]; manualOnly: string[] };
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]?.dimension).toBe("art");
    expect(body.manualOnly).toEqual([]);

    const after = await row(t, "s-art");
    expect(after?.categoryArt).toBe("recherche");
    expect(after?.categoryBaustelleSlug).toBe("zoomarkt"); // unverändert
    expect(after?.categoryManualArt).toBe(true);
    expect(after?.categoryManualBaustelle).toBe(false);
  });

  it("beide Dimensionen in einem Aufruf (z. B. 'Verschieben nach…') legen ZWEI getrennte Regeln an, nie eine breite Regel für beides", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("c", 8) });
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-1", title: "Regenbogen Alpha", filesWritten: ["/Users/alex/projects/regenbogen/a.ts"] })),
        summaryItem(summary({ sessionId: "s-2", title: "Regenbogen Beta", filesWritten: ["/Users/alex/projects/regenbogen/b.ts"] })),
      ],
    });

    const res = await t.post("/api/sessions/s-1/assign", { art: "recherche", baustelle: { slug: "regenbogen-projekt", label: "Regenbogen-Projekt" }, asRule: true });
    const body = (await res.json()) as { rules: { dimension: string; condition: unknown }[]; resorted: string[] };
    expect(body.rules.map((r) => r.dimension).sort()).toEqual(["art", "baustelle"]);

    const s1 = await row(t, "s-1");
    expect(s1?.categoryArt).toBe("recherche");
    expect(s1?.categoryBaustelleSlug).toBe("regenbogen-projekt");
    expect(s1?.categoryManualArt).toBe(true);
    expect(s1?.categoryManualBaustelle).toBe(true);

    // s-2 teilt den Ordner → die BAUSTELLE-Regel trifft (nachgezogen). Die ART-Regel hängt an einem
    // Titel-Wort, das nur s-1 hatte ("Alpha") — s-2 ("Beta") trifft sie NICHT: getrennte Dimensionen,
    // getrennte, eigene Bedingungen, kein automatischer Übertrag der Art nur weil die Baustelle passt.
    const s2 = await row(t, "s-2");
    expect(s2?.categoryBaustelleSlug).toBe("regenbogen-projekt");
    expect(s2?.categoryArt).toBe("coding");
  });

  it("Beispiel: eine NyxOS-Audit-Session per Art-Korrektur nach 'Audit' ziehen darf eine NyxOS-Coding-Session NICHT umsortieren", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("g", 8) });
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-audit", title: "NyxOS Datenschutzpruefung", cwd: "/Users/alex/code/NyxOS" })),
        summaryItem(
          summary({ sessionId: "s-coding", title: "NyxOS Feature bauen", filesWritten: ["/Users/alex/code/NyxOS/apps/server/src/app.ts"] }),
        ),
      ],
    });
    expect((await row(t, "s-coding"))?.categoryArt).toBe("coding");

    // Ziehen auf den Audit-Tab: nur "art" im Body — nie ein Ordner als Bedingung (buildCorrectionCondition).
    const res = await t.post("/api/sessions/s-audit/assign", { art: "audit", asRule: true });
    const body = (await res.json()) as { rules: { dimension: string; condition: { stage: string } }[]; resorted: string[] };
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]?.condition.stage).not.toBe("folder");
    expect(body.resorted).not.toContain("claude:s-coding");

    expect((await row(t, "s-coding"))?.categoryArt).toBe("coding"); // unverändert
  });

  it("Baustellen-Korrektur mit dominantem Ordner 'App' (Oberbereich, > 25 %) erzeugt KEINE Regel — nur diese Session wird zugeordnet", async () => {
    const t = await setup();
    // 9 Sessions mit generischen, unerkannten Dateien direkt unter App/ (kein Xcode/backend/docs-Muster) → Ordner "App".
    await t.post("/ingest/events", {
      items: Array.from({ length: 9 }, (_, i) => summaryItem(summary({ sessionId: `s-app-${i}`, title: `App-Session${i}`, filesWritten: [`/Users/alex/projects/shop/f${i}.md`] }))),
    });
    const res = await t.post("/api/sessions/s-app-0/assign", { baustelle: { slug: "sonstiges", label: "Sonstiges" }, asRule: true });
    const body = (await res.json()) as { rules: unknown[]; manualOnly: string[]; resorted: string[] };
    expect(body.rules).toEqual([]);
    expect(body.manualOnly).toEqual(["baustelle"]);
    expect(body.resorted).toEqual([]); // keine Regel → keine andere Session zieht mit

    const s0 = await row(t, "s-app-0");
    expect(s0?.categoryBaustelleSlug).toBe("sonstiges"); // diese eine Session ist trotzdem zugeordnet
    expect(s0?.categoryManualBaustelle).toBe(true);
    const s1 = await row(t, "s-app-1");
    expect(s1?.categoryBaustelleSlug).toBe("shop"); // unverändert, kein stiller Umzug
  });

  it("'projects Meeting' (beide Titel-Wörter über 15 % Häufigkeit) erzeugt KEINE Art-Teilwort-Regel", async () => {
    const t = await setup();
    // Beide Wörter aus dem Titel kommen bewusst in > 15 % der Titel vor (nicht nur "projects") —
    // damit bleibt wirklich kein Kandidat übrig, statt nur zufällig auf ein anderes Wort auszuweichen.
    // "Meeting" ist bewusst kein Wort aus einem Standard-Wortfeld (kein Server/Audit/Recherche/Planung-
    // Treffer), damit der Test nicht zufällig über die Standard-Pipeline dasselbe Ergebnis bekäme.
    await t.post("/ingest/events", {
      items: [
        ...Array.from({ length: 7 }, (_, i) => summaryItem(summary({ sessionId: `s-cc-${i}`, title: `projects Meeting Thema${i}` }))),
        summaryItem(summary({ sessionId: "s-meeting", title: "projects Meeting" })),
      ],
    });
    expect((await row(t, "s-cc-0"))?.categoryArt).toBe("unsortiert"); // kein Standard-Treffer vorab

    const res = await t.post("/api/sessions/s-meeting/assign", { art: "planung", asRule: true });
    const body = (await res.json()) as { rules: unknown[]; manualOnly: string[] };
    expect(body.rules).toEqual([]);
    expect(body.manualOnly).toEqual(["art"]);

    const s = await row(t, "s-meeting");
    expect(s?.categoryArt).toBe("planung"); // diese eine Session ist trotzdem zugeordnet (keine Regel)
    // Eine andere Session mit denselben Titel-Wörtern darf NICHT mit umgezogen sein — ohne Regel gibt
    // es nichts, das sie treffen könnte.
    const other = await row(t, "s-cc-0");
    expect(other?.categoryArt).toBe("unsortiert");
  });

  it("asRule=false korrigiert nur diese eine Session, legt nie eine Regel an", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("h", 8) });
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-1", title: "Feature A", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/a.ts"] })),
        summaryItem(summary({ sessionId: "s-2", title: "Feature B", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/b.ts"] })),
      ],
    });
    const before = await t.db.select().from(sortRules);

    const res = await t.post("/api/sessions/s-1/assign", { baustelle: { slug: "neuprojekt", label: "Neuprojekt" }, asRule: false });
    const body = (await res.json()) as { rules: unknown[]; manualOnly: string[]; resorted: string[] };
    expect(body.rules).toEqual([]);
    expect(body.manualOnly).toEqual(["baustelle"]);
    expect(body.resorted).toEqual([]); // keine Regel → s-2 zieht nicht mit

    const after = await t.db.select().from(sortRules);
    expect(after).toHaveLength(before.length);

    const s1 = await row(t, "s-1");
    expect(s1?.categoryBaustelleSlug).toBe("neuprojekt");
    expect(s1?.categoryManualBaustelle).toBe(true);
    const s2 = await row(t, "s-2");
    expect(s2?.categoryBaustelleSlug).toBe("archiv"); // keine Regel angelegt → bleibt bei der Standard-Ableitung (das Projekt)
  });

  it("category_manual_* wird von resort/erneutem Ingest nie überschrieben — je Dimension getrennt", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("i", 8) });
    await t.post("/ingest/events", {
      items: [summaryItem(summary({ sessionId: "s-1", title: "Feature A", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/a.ts"] }))],
    });
    await t.post("/api/sessions/s-1/assign", { baustelle: null, asRule: true });
    expect((await row(t, "s-1"))?.categoryBaustelleSlug).toBeNull();

    // Erneutes Einspielen derselben Zusammenfassung (z. B. Nachimport) darf die manuelle Baustelle
    // nicht kippen — die Art bleibt weiterhin automatisch (unberührt von der Baustelle-Regel).
    await t.post("/ingest/events", {
      items: [summaryItem(summary({ sessionId: "s-1", title: "Feature A ganz anders", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/a.ts"] }))],
    });
    const s1 = await row(t, "s-1");
    expect(s1?.categoryBaustelleSlug).toBeNull();
    expect(s1?.categoryManualBaustelle).toBe(true);
    expect(s1?.categoryArt).toBe("coding");
    expect(s1?.categoryManualArt).toBe(false);

    const changed = await resortAll(t.db);
    expect(changed).not.toContain("claude:s-1");
  });

  it("400 ohne 'art' oder 'baustelle', bei unbekannter Art oder kaputter Baustelle; 404 bei unbekannter Session", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-1" }))] });
    expect((await t.post("/api/sessions/s-1/assign", {})).status).toBe(400);
    expect((await t.post("/api/sessions/s-1/assign", { art: "quatsch" })).status).toBe(400);
    expect((await t.post("/api/sessions/s-1/assign", { art: "coding", baustelle: { slug: 5 } })).status).toBe(400);
    expect((await t.post("/api/sessions/gibtsnicht/assign", { art: "coding", baustelle: null })).status).toBe(404);
  });
});

/**
 * Schutztest für manuelle Zuordnungen, in der heutigen Semantik: früher nutzte er die alte, kombinierte
 * `/assign`-Bedingung (ein Body mit `art` UND `baustelle`, eine gemeinsame Regel). Heute korrigiert
 * jeder Aufruf NUR eine Dimension; die Regeln sind dimensionsscharf (`sort_rules.dimension`).
 */
describe("category_manual_* schützt auch gegen eine NEUERE, widersprechende Regel derselben Dimension", () => {
  it("eine zweite BAUSTELLEN-Korrektur für denselben Ordner überschreibt eine ältere manuelle Baustellen-Zuordnung nicht — die Art bleibt bei beiden Sessions frei/automatisch", async () => {
    const t = await setup();
    // Genug Füll-Sessions, damit der geteilte Ordner unter der 25-%-Schwelle bleibt (realistische
    // Verhältnisse statt einer winzigen Test-DB, in der die Schwelle immer greift).
    await t.post("/ingest/events", { items: fillerItems("schutz", 8) });
    // s-1 und s-2 teilen denselben (seltenen) dominanten Ordner — ohne Regel wären beide "coding"
    // und "Ohne Baustelle".
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-1", title: "Feature A", filesWritten: ["/Users/alex/projects/archiv/geteilt/a.ts"] })),
        summaryItem(summary({ sessionId: "s-2", title: "Feature B", filesWritten: ["/Users/alex/projects/archiv/geteilt/b.ts"] })),
      ],
    });
    expect((await row(t, "s-1"))?.categoryArt).toBe("coding");
    expect((await row(t, "s-2"))?.categoryArt).toBe("coding");

    // Erste Korrektur: NUR die Baustelle von s-1 → "eins" (Körper enthält kein "art" — die andere
    // Dimension bleibt unangetastet). Legt Regel R1 an (Ordner 04_Archiv → Baustelle eins);
    // recomputeCategories("all") zieht s-2 automatisch mit (dessen categoryManualBaustelle bleibt false).
    const res1 = await t.post("/api/sessions/s-1/assign", { baustelle: { slug: "eins", label: "Eins" }, asRule: true });
    expect(res1.status).toBe(200);
    expect((await row(t, "s-1"))?.categoryManualBaustelle).toBe(true);
    expect((await row(t, "s-1"))?.categoryManualArt).toBe(false); // andere Dimension frei geblieben
    expect((await row(t, "s-2"))?.categoryBaustelleSlug).toBe("eins"); // automatisch nachgezogen
    expect((await row(t, "s-2"))?.categoryManualBaustelle).toBe(false);
    expect((await row(t, "s-2"))?.categoryArt).toBe("coding");

    // Zweite, widersprechende Korrektur: NUR die Baustelle von s-2 → "zwei". Legt eine NEUERE Regel
    // für denselben Ordner an — `loadActiveSortRules` sortiert nach `desc(id)`, R2 gewinnt also
    // künftig gegen R1 für jede nicht-manuelle Session mit diesem Ordner.
    const res2 = await t.post("/api/sessions/s-2/assign", { baustelle: { slug: "zwei", label: "Zwei" }, asRule: true });
    expect(res2.status).toBe(200);

    // s-1 ist selbst manuell zugeordnet (categoryManualBaustelle = true seit der ersten Korrektur) und
    // darf durch die neuere Regel R2 NICHT umsortiert werden — sonst würde jede weitere Korrektur an
    // einer anderen Session mit demselben Ordner stillschweigend eine schon getroffene Entscheidung kippen.
    const s1 = await row(t, "s-1");
    expect(s1?.categoryManualBaustelle).toBe(true);
    expect(s1?.categoryBaustelleSlug).toBe("eins");
    // Die andere Dimension bleibt frei: keine der beiden Korrekturen hat je die Art berührt.
    expect(s1?.categoryManualArt).toBe(false);
    expect(s1?.categoryArt).toBe("coding");

    // s-2 (die Session der neuen Korrektur) trägt natürlich das neue Ziel.
    const s2 = await row(t, "s-2");
    expect(s2?.categoryBaustelleSlug).toBe("zwei");
    expect(s2?.categoryManualBaustelle).toBe(true);
    expect(s2?.categoryManualArt).toBe(false);
    expect(s2?.categoryArt).toBe("coding");
  });
});

afterEach(() => vi.restoreAllMocks());

describe("assign/preview/resort nutzen den App-weiten SkillsCache", () => {
  it("previewAssign scannt für schon berührte (per Ingest gecachte) Sessions NICHT erneut alle tool_call-Events (kein Voll-Scan je Session)", async () => {
    const t = await setup();
    // `SkillsCache.seed()` läuft NUR bei einem Fehltreffer (voller Scan, s. Kommentar an der Klasse in
    // store.ts) — ein Zähler hier deckt genau den Regressionsfall auf: eine frische `new SkillsCache()`
    // je Aufruf (statt der App-weiten Instanz) verpasst JEDEN Cache-Treffer und scannt jede der 10
    // "anderen" Sessions in der Vorschau voll neu.
    const seedSpy = vi.spyOn(SkillsCache.prototype, "seed");
    await t.post("/ingest/events", { items: fillerItems("h7", 10) });
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-h7-ziel", title: "H7-Ziel" }))] });
    // Jede der 11 Sessions wurde beim Ingest schon einmal (Fehltreffer) gescannt — das ist der EINZIGE
    // volle Scan, den jede Session je erleben soll.
    const seedCallsNachIngest = seedSpy.mock.calls.length;
    expect(seedCallsNachIngest).toBeGreaterThanOrEqual(11);

    // `previewAssign` lädt für JEDE nicht vollständig manuelle "andere" Session (hier: die 10 Filler)
    // die Merkmale neu, um zu simulieren, ob sie sich änderten (unabhängig davon, ob am Ende
    // tatsächlich ein Treffer herauskommt) — genau dabei griff der Regressionsfall (frischer Cache
    // je Aufruf) für jede einzelne von ihnen voll daneben.
    const res = await t.post("/api/sessions/s-h7-ziel/assign/preview", { art: "audit" });
    expect(res.status).toBe(200);

    // Kein einziger neuer voller Scan — alle 11 Sessions kamen aus dem (App-weiten) Cache-Treffer.
    expect(seedSpy.mock.calls.length).toBe(seedCallsNachIngest);
  });
});

describe("POST /api/sessions/:id/assign/preview (Vorschau schreibt nichts)", () => {
  it("zeigt die Bedingung (lesbar + strukturiert) und zählt betroffene Sessions richtig, ohne zu schreiben", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("j", 8) });
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-1", title: "Feature A", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/a.ts"] })),
        summaryItem(summary({ sessionId: "s-2", title: "Feature B", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/b.ts"] })),
      ],
    });
    const rulesBefore = await t.db.select().from(sortRules);
    const sessionsBefore = await t.db.select({ id: sessions.id, art: sessions.categoryArt, baustelle: sessions.categoryBaustelleSlug }).from(sessions);

    const res = await t.post("/api/sessions/s-1/assign/preview", { baustelle: { slug: "neuprojekt", label: "Neuprojekt" } });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as {
      art: unknown;
      baustelle: { condition: { text: string; structured: { stage: string; value: string } } | null; reason: string | null };
      affected: { sessionId: string; toBaustelle: { slug: string } | null }[];
      affectedCount: number;
    };
    expect(preview.art).toBeNull(); // "art" war nicht im Body → keine Aussage zu dieser Dimension
    expect(preview.baustelle.condition).toEqual({ text: "Baustelle über Ordner archiv", structured: { stage: "folder", value: "archiv" } });
    expect(preview.affectedCount).toBe(1);
    expect(preview.affected.map((a) => a.sessionId)).toEqual(["claude:s-2"]);
    expect(preview.affected[0]?.toBaustelle).toEqual({ slug: "neuprojekt", label: "Neuprojekt" });

    // Nichts geschrieben: weder eine neue Regel noch eine veränderte Session.
    const rulesAfter = await t.db.select().from(sortRules);
    expect(rulesAfter).toHaveLength(rulesBefore.length);
    const sessionsAfter = await t.db.select({ id: sessions.id, art: sessions.categoryArt, baustelle: sessions.categoryBaustelleSlug }).from(sessions);
    expect(sessionsAfter).toEqual(sessionsBefore);

    // Der echte assign trifft danach genau das, was die Vorschau angekündigt hat.
    const real = await t.post("/api/sessions/s-1/assign", { baustelle: { slug: "neuprojekt", label: "Neuprojekt" }, asRule: true });
    const realBody = (await real.json()) as { resorted: string[] };
    expect(realBody.resorted).toEqual(preview.affected.map((a) => a.sessionId));
  });

  it("ohne tragfähige Bedingung zeigt die Vorschau den Grund, affected bleibt leer", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: Array.from({ length: 9 }, (_, i) => summaryItem(summary({ sessionId: `s-app-${i}`, title: `App-Session${i}`, filesWritten: [`/Users/alex/projects/shop/f${i}.md`] }))),
    });
    const res = await t.post("/api/sessions/s-app-0/assign/preview", { baustelle: { slug: "sonstiges", label: "Sonstiges" } });
    const preview = (await res.json()) as { baustelle: { condition: unknown; reason: string | null }; affected: unknown[]; affectedCount: number };
    expect(preview.baustelle.condition).toBeNull();
    expect(preview.baustelle.reason).toBeTruthy();
    expect(preview.affected).toEqual([]);
    expect(preview.affectedCount).toBe(0);
  });

  it("404 bei unbekannter Session, 400 ohne 'art'/'baustelle'", async () => {
    const t = await setup();
    expect((await t.post("/api/sessions/gibtsnicht/assign/preview", { art: "coding" })).status).toBe(404);
    expect((await t.post("/api/sessions/gibtsnicht/assign/preview", {})).status).toBe(400);
  });
});

describe("POST /api/sessions/:id/unassign (Rückgängig)", () => {
  it("schaltet die angelegte Regel ab, hebt die Sperre für die korrigierte Dimension auf und stellt den vorherigen Zustand her", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("k", 8) });
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-1", title: "Feature A", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/a.ts"] })),
        summaryItem(summary({ sessionId: "s-2", title: "Feature B", filesWritten: ["/Users/alex/projects/archiv/neuprojekt/b.ts"] })),
      ],
    });
    const vorher = await row(t, "s-2");
    expect(vorher?.categoryBaustelleSlug).toBe("archiv");

    const assign = await t.post("/api/sessions/s-1/assign", { baustelle: { slug: "neuprojekt", label: "Neuprojekt" }, asRule: true });
    const assignBody = (await assign.json()) as { rules: { id: number }[] };
    expect((await row(t, "s-1"))?.categoryManualBaustelle).toBe(true);
    expect((await row(t, "s-2"))?.categoryBaustelleSlug).toBe("neuprojekt");

    const undo = await t.post("/api/sessions/s-1/unassign", { ruleIds: assignBody.rules.map((r) => r.id), dims: ["baustelle"] });
    expect(undo.status).toBe(200);
    const undoBody = (await undo.json()) as { ok: true; resorted: string[] };
    expect(undoBody.resorted).toContain("claude:s-1");
    expect(undoBody.resorted).toContain("claude:s-2");

    const [assignedRule] = assignBody.rules;
    expect(assignedRule).toBeDefined();
    const [dbRule] = await t.db.select().from(sortRules).where(eq(sortRules.id, assignedRule?.id ?? -1));
    expect(dbRule?.active).toBe(false);

    const s1 = await row(t, "s-1");
    expect(s1?.categoryManualBaustelle).toBe(false);
    expect(s1?.categoryBaustelleSlug).toBe("archiv"); // fällt zurück auf die Standard-Ableitung (das Projekt)

    const s2 = await row(t, "s-2");
    expect(s2?.categoryBaustelleSlug).toBe(vorher?.categoryBaustelleSlug); // wieder wie vor der Korrektur
  });

  it("404 bei unbekannter Session", async () => {
    const t = await setup();
    expect((await t.post("/api/sessions/gibtsnicht/unassign", { ruleIds: [], dims: [] })).status).toBe(404);
  });

  it("Rückgängig der ZWEITEN Korrektur stellt die ERSTE (manuelle) Zuordnung wieder her, nicht die Automatik", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("h3a", 8) });
    await t.post("/ingest/events", {
      items: [summaryItem(summary({ sessionId: "s-h3", title: "H3-Session", filesWritten: ["/Users/alex/projects/archiv/h3folder/a.ts"] }))],
    });
    expect((await row(t, "s-h3"))?.categoryBaustelleSlug).toBe("archiv");

    const first = await t.post("/api/sessions/s-h3/assign", { baustelle: { slug: "projekt-a", label: "Projekt A" }, asRule: true });
    const firstBody = (await first.json()) as { rules: { id: number }[] };
    const ruleA = firstBody.rules[0];
    expect(ruleA).toBeDefined();
    expect((await row(t, "s-h3"))?.categoryBaustelleSlug).toBe("projekt-a");

    const second = await t.post("/api/sessions/s-h3/assign", { baustelle: { slug: "projekt-b", label: "Projekt B" }, asRule: true });
    const secondBody = (await second.json()) as { rules: { id: number }[] };
    const ruleB = secondBody.rules[0];
    expect(ruleB).toBeDefined();
    expect((await row(t, "s-h3"))?.categoryBaustelleSlug).toBe("projekt-b");

    // Rückgängig der ZWEITEN Korrektur — der Client nennt (versehentlich oder böswillig) BEIDE
    // Regel-IDs; nur die der zweiten Korrektur (ruleB) darf abgeschaltet werden.
    const undo = await t.post("/api/sessions/s-h3/unassign", { ruleIds: [ruleA?.id, ruleB?.id], dims: ["baustelle"] });
    expect(undo.status).toBe(200);

    const after = await row(t, "s-h3");
    expect(after?.categoryBaustelleSlug).toBe("projekt-a"); // Vorzustand, NICHT die Automatik
    expect(after?.categoryManualBaustelle).toBe(true); // war vorher manuell — bleibt manuell

    const [dbRuleA] = await t.db.select().from(sortRules).where(eq(sortRules.id, ruleA?.id ?? -1));
    const [dbRuleB] = await t.db.select().from(sortRules).where(eq(sortRules.id, ruleB?.id ?? -1));
    expect(dbRuleA?.active).toBe(true); // NICHT durch diese Korrektur entstanden — bleibt aktiv
    expect(dbRuleB?.active).toBe(false); // durch GENAU diese Korrektur entstanden — abgeschaltet

    // Ein zweites Rückgängig auf dieselbe Dimension hat nichts mehr zu tun (Undo-Eintrag verbraucht).
    const undoAgain = await t.post("/api/sessions/s-h3/unassign", { ruleIds: [ruleA?.id], dims: ["baustelle"] });
    expect(undoAgain.status).toBe(200);
    expect((await row(t, "s-h3"))?.categoryBaustelleSlug).toBe("projekt-a"); // unverändert
    const [dbRuleAAfter] = await t.db.select().from(sortRules).where(eq(sortRules.id, ruleA?.id ?? -1));
    expect(dbRuleAAfter?.active).toBe(true); // immer noch nicht abgeschaltet — kein Eintrag mehr, der das erlaubt
  });
});

describe("GET/PATCH /api/sort-rules", () => {
  it("listet Regeln (mit Dimension) und PATCH active=false sortiert sofort neu", async () => {
    const t = await setup();
    await t.post("/ingest/events", { items: fillerItems("f", 8) });
    await t.post("/ingest/events", {
      items: [summaryItem(summary({ sessionId: "s-1", title: "Marzipan Fix", filesWritten: ["/Users/alex/projects/shop/a.ts"] }))],
    });
    expect((await row(t, "s-1"))?.categoryArt).toBe("coding");

    const assign = await t.post("/api/sessions/s-1/assign", { art: "recherche", asRule: true });
    const { rules } = (await assign.json()) as { rules: { id: number; dimension: string }[] };
    expect(rules).toHaveLength(1);
    const [firstRule] = rules;
    expect(firstRule).toBeDefined();
    const ruleId = firstRule?.id ?? -1;

    const list = (await (await t.app.request("/api/sort-rules")).json()) as { rules: { id: number; active: boolean; dimension: string }[] };
    expect(list.rules.map((r) => r.id)).toContain(ruleId);
    expect(list.rules.find((r) => r.id === ruleId)?.dimension).toBe("art");

    const res = await t.app.request(`/api/sort-rules/${ruleId}`, {
      method: "PATCH",
      headers: { ...t.auth, "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(200);
    const patchBody = (await res.json()) as { ok: true; resorted: string[] };

    const [dbRule] = await t.db.select().from(sortRules).where(eq(sortRules.id, ruleId));
    expect(dbRule?.active).toBe(false);

    // s-1 ist manuell (assign) und bleibt unangetastet; für eine neue Session mit demselben Titel-Wort
    // greift die Regel nun nicht mehr → Standard-Pipeline (Datei-Änderung ohne anderen Treffer → "coding").
    await t.post("/ingest/events", {
      items: [summaryItem(summary({ sessionId: "s-2", title: "Marzipan Feature", filesWritten: ["/Users/alex/projects/App/b.ts"] }))],
    });
    const s2 = await row(t, "s-2");
    expect(s2?.categoryArt).toBe("coding");
    // PATCH selbst löst schon eine Neusortierung aus (für s-1 gibt es hier nichts nachzuziehen, da
    // s-1 weiterhin manuell gesperrt ist — resorted kann also leer sein, das ist korrekt).
    expect(Array.isArray(patchBody.resorted)).toBe(true);
  });

  it("PATCH mit unbekannter ID ist 404, ohne 'active' ist 400", async () => {
    const t = await setup();
    expect((await t.app.request("/api/sort-rules/999999", { method: "PATCH", headers: { ...t.auth, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    const res = await t.app.request("/api/sort-rules/999999", {
      method: "PATCH",
      headers: { ...t.auth, "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/categories", () => {
  it("zählt Arten und Baustellen nur bei offenen Haupt-Sessions (keine geschlossenen, keine Sub-Agenten)", async () => {
    const t = await setup();
    await t.post("/ingest/events", {
      items: [
        summaryItem(summary({ sessionId: "s-1", title: "Postgres upgrade" })),
        summaryItem(summary({ sessionId: "s-2", title: "Postgres migr" })),
        summaryItem(summary({ sessionId: "s-3", title: "wird geschlossen: server backup" })),
      ],
    });
    await t.post("/api/sessions/s-3/close", { by: "alex" });

    const body = (await (await t.app.request("/api/categories")).json()) as {
      categories: { art: string; count: number; baustellen: { slug: string | null; count: number }[] }[];
    };
    const server = body.categories.find((c) => c.art === "server");
    expect(server?.count).toBe(2); // s-3 ist geschlossen, zählt nicht mit
  });
});

/** Ein `tool_call`-Event für einen Skill-Aufruf (`Skill`-Werkzeug mit Ziel-Namen), wie der Parser es
 * aus `tool_call name=Skill` erzeugt (s. GESAMT-STAND.md). */
const skillCallEvent = (sessionId: string, target: string, minutesOffset: number): IngestItem => ({
  type: "event",
  event: {
    id: `skill:${sessionId}:${minutesOffset}`,
    tool: "claude",
    sessionId,
    ts: new Date(Date.UTC(2026, 8, 24, 10, minutesOffset)).toISOString(),
    kind: "tool_call",
    source: "file",
    data: { name: "Skill", target },
  },
});

describe("Skill-Regel über zwei getrennte Ingests", () => {
  it("Skill-Regel greift erst NACH dem Ingest des Skill-Aufrufs — auch wenn er in einem SPÄTEREN, separaten Ingest kommt (Zwischenspeicher bleibt korrekt)", async () => {
    const t = await setup();
    // Eine Regel setzt nur EINE Dimension (nie Art+Baustelle gemeinsam über eine
    // Bedingung) — zwei getrennte Regeln für dieselbe Skill-Bedingung statt der alten,
    // kombinierten Regel (die es in dieser Form nicht mehr gibt).
    await t.db.insert(sortRules).values([
      {
        condition: { stage: "skill", value: "obsidian" },
        dimension: "art",
        targetArt: "planung",
        origin: "manuell",
        active: true,
      },
      {
        condition: { stage: "skill", value: "obsidian" },
        dimension: "baustelle",
        targetBaustelleSlug: "obsidian-notizen",
        targetBaustelleLabel: "Obsidian-Notizen",
        origin: "manuell",
        active: true,
      },
    ]);

    // Erster Ingest: Session existiert, aber noch KEIN Skill-Aufruf — die Regel darf noch nicht greifen.
    await t.post("/ingest/events", { items: [summaryItem(summary({ sessionId: "s-skill-spaeter", title: "Irgendeine Sache" }))] });
    let s = await row(t, "s-skill-spaeter");
    expect(s?.categoryArt).not.toBe("planung");

    // Zweiter, GETRENNTER Ingest (wie ein weiterer Hook): jetzt kommt der Skill-Aufruf dazu. Der
    // Zwischenspeicher aus dem ersten Ingest (leer, echter Fehltreffer-Scan) muss den neuen Namen aus
    // dem Batch übernehmen, nicht bei seinem alten (leeren) Stand bleiben.
    await t.post("/ingest/events", { items: [skillCallEvent("s-skill-spaeter", "obsidian", 1)] });
    s = await row(t, "s-skill-spaeter");
    expect(s?.categoryArt).toBe("planung");
    expect(s?.categoryBaustelleSlug).toBe("obsidian-notizen");
  });
});
