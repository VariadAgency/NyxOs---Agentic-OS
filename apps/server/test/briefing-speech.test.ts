// Briefing zum Anhören — Sprechfassung vom Server.
// - Jeder Satz gehört zu einem Abschnitt (Kernaussage, Braucht dich, Kennzahlen, Was lief, Was hängt, Als Nächstes)
//   und nennt die Stelle der Seite (`target`), die beim Vorlesen hervorgehoben wird.
// - Jede Zahl steht im Bericht selbst (Kennzahlen aus `figures`, Sätze, Titel) – nie eine erfundene.
// - Gesprochen wird ohne Ziffern: Zahlen, Uhrzeiten, Token-Mengen und Kürzel deutsch ausgeschrieben.
import { BRIEF_SPEECH_SECTIONS, BRIEF_TILE_KEYS, type BriefingFigures, type BriefingSpeech, type HaikuReport } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { entries, gitCommits, gitRepos, sessions, usageDaily } from "../src/db/schema.js";
import { createInboxItem, YES_NO } from "../src/haiku/inbox.js";
import { generateReport } from "../src/haiku/report.js";
import { buildBriefingSpeech, reportNumbers, speakGerman, speechNumbersOk } from "../src/haiku/speech.js";
import { localDay } from "../src/usage/periods.js";
import { ToolRegistry, type ToolContext } from "../src/haiku/tools.js";
import { NyxUiBridge, registerNyxUiTools } from "../src/nyx/ui.js";
import { answer, FakeEngine, setupAssistant } from "./assistant/assistant-helpers.js";

const FIGURES: BriefingFigures = {
  at: "2026-09-25T08:38:00.000Z",
  periodLabel: "seit gestern 0 Uhr",
  sessions: { running: 2, waiting: 1, idle: 3, crashed: 1, activeInPeriod: 7, closedInPeriod: 4 },
  commits: { today: 3, week: 17, prevWeek: 9 },
  tasks: { open: 11, byStage: [{ stage: "startklar", count: 2 }, { stage: "laeuft", count: 3 }, { stage: "erledigt", count: 8 }] },
  usage: { today: { claude: 3_000_000, codex: 1_000_000 }, week: { claude: 21_000_000, codex: 6_000_000 }, prevWeek: { claude: 10_000_000, codex: 2_000_000 } },
  openQuestions: { approvals: 1, inbox: 1, conflicts: 0, total: 2 },
  conflicts: 1,
  buildsRed: 1,
  needsYou: 2,
  charts: { usage7d: [], sessionsHourly: [], commitsDaily: [], commitRepos: [] },
} as unknown as BriefingFigures;

const REPORT: HaikuReport = {
  id: 42,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: "2026-09-25T08:38:00.000Z",
  greeting: "Guten Morgen, Alex",
  lage: "2 Sessions arbeiten, 1 wartet auf dich.",
  headline: { text: "2 Punkte brauchen dich, davon 1 Störung – am besten zuerst die.", sources: [], estimate: false, author: "regeln" },
  sections: [
    { title: "Was lief", statements: [{ text: "7 Sessions waren seit gestern 0 Uhr aktiv, zuletzt „Karte bauen“, „Tests schreiben“ und 5 weitere.", sources: [], estimate: false, author: "regeln" }] },
    { title: "Was wartet", statements: [{ text: "1 Session wartet auf dich: „Dashboard“.", sources: [], estimate: false, author: "regeln" }] },
    { title: "Was ist kaputt", statements: [{ text: "1 Build-Fehler ist offen: Build #12 (iOS).", sources: [], estimate: false, author: "regeln" }] },
    { title: "Als Nächstes", statements: [{ text: "Als Erstes: „Darf T-01 die Tabelle umbenennen?“ (etwa 5 Min).", sources: [], estimate: false, author: "regeln" }] },
  ],
  runsWithoutYou: [],
  needsYou: [
    { id: "inbox:1", kind: "question", title: "Darf T-01 die Tabelle umbenennen?", detail: null, href: "/inbox#inbox-1", minutes: 5, zeroEnergy: true, sources: [] },
    { id: "build:12", kind: "build", title: "Build #12 ist rot", detail: null, href: "/server", minutes: 15, zeroEnergy: false, sources: [] },
  ] as unknown as HaikuReport["needsYou"],
  mode: "nur-daten",
  modeReason: null,
  callId: null,
  snapshot: { at: "2026-09-25T08:38:00.000Z", counts: {} as never, lage: "", needsYouCount: 2, fingerprint: "x" },
  figures: FIGURES,
  highlights: ["commits", "usage_today"],
  chartOrder: [],
};

const DIGIT = /\d/;

describe("Zahlen deutsch ausgesprochen", () => {
  it.each([
    ["1 Session wartet auf dich.", "Eine Session wartet auf dich."],
    ["1 Punkt braucht dich.", "Ein Punkt braucht dich."],
    ["2 Sessions arbeiten gerade, 1 wartet.", "Zwei Sessions arbeiten gerade, eine wartet."],
    ["Stand 10:38", "Stand zehn Uhr achtunddreißig"],
    ["Stand 09:00", "Stand neun Uhr"],
    ["3,9 Mrd. Tokens", "Drei Komma neun Milliarden Tokens"],
    ["1 Mio. Tokens", "Eine Million Tokens"],
    ["4 Mio. Tokens", "Vier Millionen Tokens"],
    ["21 Punkte", "Einundzwanzig Punkte"],
    ["1.234 Tokens", "Eintausendzweihundertvierunddreißig Tokens"],
    ["~5 Min", "Etwa fünf Minuten"],
    ["seit gestern 0 Uhr aktiv", "Seit gestern Mitternacht aktiv"],
    ["Build #12 ist rot", "Build Nummer zwölf ist rot"],
    ["17 Commits", "Siebzehn Commits"],
    ["Darf T-01 die Tabelle umbenennen?", "Darf T null eins die Tabelle umbenennen?"],
    ["z. B. 100 Stück", "Zum Beispiel hundert Stück"],
    // Stichproben + Datum aus „Session vom 25.09., 10:38“ (Titel ungenannter Sessions)
    ["101 Punkte", "Hunderteins Punkte"],
    ["Um 0:05 lief der Build.", "Um null Uhr fünf lief der Build."],
    ["Bis 23:59 offen.", "Bis dreiundzwanzig Uhr neunundfünfzig offen."],
    ["12 % mehr als letzte Woche", "Zwölf Prozent mehr als letzte Woche"],
    ["Session vom 25.09., 10:38", "Session vom fünfundzwanzigsten September, zehn Uhr achtunddreißig"],
    ["Am 01.03.2026 gestartet.", "Am ersten März zweitausendsechsundzwanzig gestartet."],
    ["Session vom 07.10.", "Session vom siebten Oktober."],
    ["Stand 10:38 Uhr.", "Stand zehn Uhr achtunddreißig."],
    ["Um 18:00 Uhr fertig.", "Um achtzehn Uhr fertig."],
    ["P7 ist fertig, dann T-12.", "P sieben ist fertig, dann T zwölf."],
    ["Offen 9-17 Uhr", "Offen neun bis siebzehn Uhr"],
  ])("%s → %s", (input, spoken) => {
    expect(speakGerman(input)).toBe(spoken);
  });
});

describe("Sprechfassung aus einem Bericht", () => {
  const speech = buildBriefingSpeech(REPORT);

  it("jeder Satz hat einen Abschnitt und eine Stelle auf der Seite; Abschnitte in fester Reihenfolge", () => {
    expect(speech.reportId).toBe(42);
    expect(speech.sentences.length).toBeGreaterThanOrEqual(6);
    const tiles = new Set(BRIEF_TILE_KEYS.map((k) => `tile:${k}`));
    for (const s of speech.sentences) {
      expect(BRIEF_SPEECH_SECTIONS).toContain(s.section);
      expect(s.target === "headline" || s.target === "needs" || tiles.has(s.target) || /^chart:[a-z0-9_]+$/.test(s.target) || /^group:(lief|haengt|naechstes)$/.test(s.target)).toBe(true);
      expect(s.text.trim().length).toBeGreaterThan(3);
    }
    const order = speech.sentences.map((s) => BRIEF_SPEECH_SECTIONS.indexOf(s.section));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // alle sechs Abschnitte kommen vor
    expect(new Set(speech.sentences.map((s) => s.section))).toEqual(new Set(BRIEF_SPEECH_SECTIONS));
  });

  it("Ziel passt zum Abschnitt: Kernaussage → Kopf, Braucht dich → Liste, Kennzahlen → Kacheln (zusammengefasst, keine Graphen-Erklärung)", () => {
    const by = (sec: string) => speech.sentences.filter((s) => s.section === sec);
    expect(by("kernaussage").every((s) => s.target === "headline")).toBe(true);
    expect(by("braucht_dich").every((s) => s.target === "needs")).toBe(true);
    const kpi = by("kennzahlen");
    expect(kpi.every((s) => s.target.startsWith("tile:"))).toBe(true);
    expect(kpi.length).toBeGreaterThanOrEqual(1);
    expect(kpi.length).toBeLessThanOrEqual(3);
    expect(by("lief").every((s) => s.target === "group:lief")).toBe(true);
    expect(by("haengt").every((s) => s.target === "group:haengt")).toBe(true);
    expect(by("naechstes").every((s) => s.target === "group:naechstes")).toBe(true);
  });

  it("jede Zahl steht im Bericht; gesprochen ohne Ziffern und ohne Markdown/Anführungszeichen", () => {
    const allowed = reportNumbers(REPORT);
    for (const s of speech.sentences) {
      expect(speechNumbersOk(s.written, allowed), s.written).toBe(true);
      expect(DIGIT.test(s.text), s.text).toBe(false);
      expect(s.text).not.toMatch(/[„“"*_#`~]/);
    }
    // Kennzahlen stimmen mit `figures` überein
    const kpi = speech.sentences
      .filter((s) => s.section === "kennzahlen")
      .map((s) => s.written)
      .join(" ")
      .replace(/\s/g, " ");
    expect(kpi).toContain("17");
    expect(kpi).toContain("4 Mio.");
  });

  it("die Prüfung lehnt eine Zahl ab, die nicht im Bericht steht", () => {
    const allowed = reportNumbers(REPORT);
    expect(speechNumbersOk("17 Commits in 7 Tagen.", allowed)).toBe(true);
    expect(speechNumbersOk("99 Commits in 7 Tagen.", allowed)).toBe(false);
    expect(speechNumbersOk("5 Mrd. Tokens.", allowed)).toBe(false);
  });

  it("kurz: höchstens 28 Sätze (alle 9 Kacheln + 4 Graphen), jeder Satz sprechbar lang (≤ 260 Zeichen)", () => {
    expect(speech.sentences.length).toBeLessThanOrEqual(28);
    for (const s of speech.sentences) expect(s.text.length).toBeLessThanOrEqual(260);
  });

  it("ruhiger Tag ohne Kennzahlen (älterer Bericht): trotzdem Kernaussage, „nichts wartet“ und Abschnitte", () => {
    const calm = buildBriefingSpeech({ ...REPORT, headline: null, figures: null, needsYou: [], highlights: [] });
    expect(calm.sentences[0]?.section).toBe("kernaussage");
    expect(calm.sentences.some((s) => s.section === "braucht_dich" && /nichts/i.test(s.text))).toBe(true);
    expect(calm.sentences.some((s) => s.section === "kennzahlen")).toBe(false);
  });
});

describe("Route GET /api/briefing/:id/speech", () => {
  const now = new Date("2026-09-25T12:30:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("liefert die Sprechfassung eines gespeicherten Berichts; latest je Art; 404 ohne Bericht; Anmeldung wie andere Lese-Wege", async () => {
    const engine = new FakeEngine(answer("x"));
    engine.ok = false;
    const t = await setupAssistant({ engine });
    await t.db.insert(sessions).values([
      { id: "claude:r1", tool: "claude", sessionId: "r1", title: "Karte bauen", status: "running", turnOpen: true, state: "running", categoryArt: "coding", lastActivityAt: ago(120_000), startedAt: ago(3_600_000) },
      { id: "claude:w1", tool: "claude", sessionId: "w1", title: "Dashboard", status: "running", turnOpen: false, state: "waiting", categoryArt: "coding", lastActivityAt: ago(300_000) },
    ]);
    await t.db.insert(usageDaily).values([{ day: localDay(now), tool: "claude", model: "opus", project: "shop", totalTokens: 3_000_000 }]);
    await t.db.insert(gitRepos).values([{ id: "app", label: "Shop", kind: "app", root: "/app" }]);
    await t.db.insert(gitCommits).values([{ repoId: "app", sha: "a1", authorDate: ago(3_600_000), subject: "a", branch: "main" }]);
    await t.db.insert(entries).values([{ kind: "aufgabe", title: "A", stage: "startklar" }]);
    await createInboxItem(t.db, { kind: "frage", title: "Darf T-01 die Tabelle umbenennen?", options: YES_NO, createdBy: "session", sessionKey: "claude:w1" });
    const report = await generateReport(t.runtime, "briefing", now);

    const res = await t.app.request(`/api/briefing/${report.id}/speech`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { speech: BriefingSpeech };
    expect(body.speech.reportId).toBe(report.id);
    expect(body.speech.sentences.length).toBeGreaterThanOrEqual(5);
    const allowed = reportNumbers(report);
    for (const s of body.speech.sentences) {
      expect(speechNumbersOk(s.written, allowed), s.written).toBe(true);
      expect(DIGIT.test(s.text), s.text).toBe(false);
    }

    const latest = await t.app.request("/api/briefing/latest/speech?kind=briefing");
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as { speech: BriefingSpeech }).speech.reportId).toBe(report.id);

    expect((await t.app.request("/api/briefing/latest/speech?kind=recap")).status).toBe(404);
    expect((await t.app.request("/api/briefing/99999/speech")).status).toBe(404);
    expect((await t.app.request("/api/briefing/abc/speech")).status).toBe(404);
    // Anmeldung wie die anderen Lese-Wege: dieselbe Antwort wie `GET /api/haiku/report` ohne gültige Sitzung.
    const bad = { headers: { cookie: "nyxos_session=falsch" } };
    const readStatus = (await t.app.request("/api/haiku/report?kind=briefing", bad)).status;
    expect((await t.app.request(`/api/briefing/${report.id}/speech`, bad)).status).toBe(readStatus);
  });
});

describe("Nyx: „Lies mir das Briefing vor“", () => {
  it("Werkzeug briefing_vorlesen öffnet das Briefing mit ?vorlesen=1 (abends Recap); ohne Fenster ehrlich", async () => {
    const sent: Record<string, unknown>[] = [];
    let viewers = 1;
    const hub = {
      get size() {
        return viewers;
      },
      broadcast(m: unknown) {
        const msg = m as { requestId: string; route: string };
        sent.push(m as Record<string, unknown>);
        queueMicrotask(() => bridge.receive({ type: "nyx.ui.result", requestId: msg.requestId, ok: true, route: msg.route }));
      },
    };
    const bridge = new NyxUiBridge({ hub, timeoutMs: 500 });
    const reg = new ToolRegistry();
    registerNyxUiTools(reg, bridge);
    const ctx = { db: null, scope: "full", ideaLink: null, ideas: null } as unknown as ToolContext;
    expect(reg.namesFor("full")).toContain("briefing_vorlesen");
    expect(reg.namesFor("idealink")).not.toContain("briefing_vorlesen");
    const r = (await reg.call("full", "briefing_vorlesen", {}, ctx)) as Record<string, unknown>;
    expect(sent.at(-1)).toMatchObject({ type: "nyx.ui", action: "navigate", route: "/briefing?vorlesen=1" });
    expect(r).toMatchObject({ erledigt: true });
    await reg.call("full", "briefing_vorlesen", { art: "recap" }, ctx);
    expect(sent.at(-1)).toMatchObject({ route: "/briefing?vorlesen=1&art=recap" });
    viewers = 0;
    const none = (await reg.call("full", "briefing_vorlesen", {}, ctx)) as Record<string, unknown>;
    expect(none).toMatchObject({ erledigt: false });
    expect(String(none.hinweis)).toMatch(/NyxOS/);
  });
});
