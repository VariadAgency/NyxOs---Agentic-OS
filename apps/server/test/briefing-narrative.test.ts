// Das Vorlesen des Briefings soll zusammenfassen, in eigenen Worten, mit Zusammenhängen („Nutzung heute hoch –
// in der Nacht liefen bis zu fünf Sessions“), jeden „Braucht dich“-Punkt nennen, keine Graphen erklären und den Stand
// ausführlich erzählen. Nyx schreibt die Fassung; jede Zahl muss aus dem Bericht bzw. den gerechneten Vergleichen stammen.
import type { BriefingFigures, BriefingSpeech, HaikuReport } from "@nyxos/shared";
import type { EngineRequest } from "../src/haiku/engine.js";
import { beforeEach, describe, expect, it } from "vitest";
import { generateReport } from "../src/haiku/report.js";
import { clearNarrativeCache, narrateBriefing, parseNarrative, SPEECH_SYSTEM, speechContext, speechPrompt } from "../src/haiku/speechNarrative.js";
import { answer, FakeEngine, setupAssistant } from "./assistant/assistant-helpers.js";

const day = (d: string, claude: number, codex = 0) => ({ day: d, claude, codex });
const FIGURES = {
  at: "2026-09-26T07:00:00.000Z",
  periodLabel: "seit gestern 0 Uhr",
  sessions: { running: 1, waiting: 2, idle: 0, crashed: 0, activeInPeriod: 6, closedInPeriod: 3 },
  commits: { today: 4, week: 20, prevWeek: 10 },
  tasks: { open: 5, byStage: [{ stage: "startklar", count: 2 }] },
  usage: { today: { claude: 3_000_000_000, codex: 0 }, week: { claude: 9_000_000_000, codex: 0 }, prevWeek: { claude: 6_000_000_000, codex: 0 } },
  openQuestions: { approvals: 1, inbox: 2, conflicts: 0, total: 3 },
  conflicts: 0,
  buildsRed: 0,
  needsYou: 3,
  charts: {
    usage7d: [day("2026-09-20", 1_000_000_000), day("2026-09-21", 1_000_000_000), day("2026-09-22", 1_000_000_000), day("2026-09-23", 1_000_000_000), day("2026-09-24", 1_000_000_000), day("2026-09-25", 1_000_000_000), day("2026-09-26", 3_000_000_000)],
    sessionsHourly: [
      { at: "2026-09-26T01:00:00Z", hour: 3, claude: 5, codex: 0 },
      { at: "2026-09-26T06:00:00Z", hour: 8, claude: 1, codex: 0 },
    ],
    commitsDaily: [],
    commitRepos: [],
  },
} as unknown as BriefingFigures;

const item = (title: string) => ({ id: title, kind: "question", title, detail: null, minutes: 2, zeroEnergy: false, href: null, sources: [], action: null });
const REPORT = {
  id: 501,
  kind: "briefing",
  day: "2026-09-26",
  createdAt: "2026-09-26T07:00:00.000Z",
  greeting: "Guten Morgen",
  lage: "1 Session arbeitet, 2 warten.",
  headline: { text: "3 Punkte brauchen dich.", sources: [], estimate: false, author: "regeln" },
  sections: [
    { title: "Was lief", statements: [{ text: "6 Sessions waren aktiv, zuletzt „Heatmap“.", sources: [{ kind: "session", id: "s1", label: "Heatmap-Karte bauen", href: null }], estimate: false, author: "regeln" }] },
    { title: "Was wartet auf dich", statements: [{ text: "3 Punkte liegen in der Inbox.", sources: [], estimate: false, author: "regeln" }] },
  ],
  runsWithoutYou: [],
  needsYou: [item("Freigabe: Worktrees löschen"), item("Frage: Push auf main?"), item("Session „Heatmap“ wartet")],
  mode: "ok",
  modeReason: null,
  callId: null,
  snapshot: { at: "2026-09-26T07:00:00.000Z", counts: {}, lage: "", needsYouCount: 3, fingerprint: "x" },
  figures: FIGURES,
  highlights: [],
  chartOrder: [],
} as unknown as HaikuReport;

describe("Vergleiche aus den Graphen", () => {
  it("Nutzung heute gegen den Schnitt der Vortage, Sessions je Tageszeit", () => {
    const lines = speechContext(REPORT).lines.join("\n");
    expect(lines).toMatch(/heute etwa 3-mal so viel/);
    expect(lines).toMatch(/heute Nacht \(0–6 Uhr\) bis zu 5 gleichzeitig/);
    expect(lines).toMatch(/Commits diese 7 Tage 20, die 7 Tage davor 10/);
  });
  it("kein ISO-Datum (gesprochen „… bis null neun bis …“), morgens kein „heute X % weniger“ gegen ganze Tage", () => {
    const busy = { ...FIGURES, charts: { ...FIGURES.charts, usage7d: [...FIGURES.charts.usage7d.slice(0, 3), day("2026-09-23", 9_000_000_000), ...FIGURES.charts.usage7d.slice(4, 6), day("2026-09-26", 100_000_000)] } };
    const lines = speechContext({ ...REPORT, figures: { ...busy, usage: { ...FIGURES.usage, today: { claude: 100_000_000, codex: 0 } } } } as HaikuReport).lines.join("\n");
    expect(lines).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(lines).toMatch(/Mittwoch, 23\.09\./);
    expect(lines).not.toMatch(/heute \d+ % weniger/);
    expect(lines).toMatch(/Nutzung gestern/);
  });
});

describe("Auftrag an Nyx", () => {
  it("enthält JEDEN Braucht-dich-Punkt, die Quellen des Stands und die Regeln (keine Graphen-Erklärung)", () => {
    const p = speechPrompt(REPORT);
    for (const n of REPORT.needsYou) expect(p).toContain(n.title.replace(/"/g, '\\"'));
    expect(p).toContain("Heatmap-Karte bauen");
    expect(SPEECH_SYSTEM).toMatch(/JEDEN Punkt/);
    expect(SPEECH_SYSTEM).toMatch(/Nie erklären, wie ein Diagramm/);
  });
});

describe("Antwort prüfen", () => {
  const good = {
    saetze: [
      { ziel: "headline", text: "Drei Dinge brauchen dich heute." },
      { ziel: "needs", text: "Zuerst die Freigabe zum Löschen der Worktrees." },
      { ziel: "needs", text: "Dann die Frage, ob auf main gepusht werden darf." },
      { ziel: "tile:usage_today", text: "Die Nutzung ist heute etwa 3-mal so hoch wie sonst – in der Nacht liefen bis zu 5 Sessions gleichzeitig." },
      { ziel: "tile:usage_today", text: "Heute waren es 99 Milliarden Tokens." },
      { ziel: "irgendwo", text: "Das Ziel gibt es nicht." },
      { ziel: "group:lief", text: "Gelaufen ist vor allem die Heatmap-Karte, 6 Sessions waren aktiv." },
    ],
  };
  it("erfundene Zahl und unbekanntes Ziel fallen weg, der Rest wird fürs Ohr umgeschrieben", () => {
    const r = parseNarrative(good, REPORT);
    expect(r).not.toBeNull();
    const written = r?.sentences.map((s) => s.written) ?? [];
    expect(written.some((w) => w.includes("99"))).toBe(false);
    expect(written.some((w) => w.includes("Das Ziel gibt es nicht"))).toBe(false);
    expect(r?.dropped).toEqual(["Heute waren es 99 Milliarden Tokens."]);
    const usage = r?.sentences.find((s) => s.target === "tile:usage_today");
    expect(usage?.section).toBe("kennzahlen");
    expect(usage?.text).toMatch(/etwa drei-mal so hoch|etwa dreimal so hoch|etwa drei mal/);
    expect(usage?.text).not.toMatch(/\d/);
    expect(r?.sentences.find((s) => s.target === "group:lief")?.section).toBe("lief");
  });
  it("fehlen Braucht-dich-Punkte, kommt die vollständige Liste aus den Daten an dieselbe Stelle", () => {
    const r = parseNarrative(good, REPORT);
    const needs = r?.sentences.filter((s) => s.target === "needs").map((s) => s.written) ?? [];
    for (const n of REPORT.needsYou) expect(needs.join(" ")).toContain(n.title.replace(/:.*/, ""));
    expect(r?.sentences[0]?.target).toBe("headline");
    expect(r?.sentences[1]?.target).toBe("needs");
  });
  it("erfundenes Zeitwort fällt weg wie bei validateStatement („heute Nacht“ steht in den Vergleichen)", () => {
    const r = parseNarrative({ saetze: [...good.saetze, { ziel: "group:lief", text: "Vorhin lief die Heatmap-Karte." }, { ziel: "tile:usage_today", text: "Heute Nacht war viel los." }] }, REPORT);
    expect(r?.dropped).toContain("Vorhin lief die Heatmap-Karte.");
    expect(r?.sentences.map((s) => s.written)).toContain("Heute Nacht war viel los.");
  });
  it("zu wenig gültige Sätze oder kaputte Antwort → null (Rückfall auf die Daten-Fassung)", () => {
    expect(parseNarrative({ saetze: good.saetze.slice(4) }, REPORT)).toBeNull();
    expect(parseNarrative("kaputt", REPORT)).toBeNull();
    expect(parseNarrative(null, REPORT)).toBeNull();
  });
});

/** Eine Engine, die den Bericht ohne Modell-Sätze schreibt und die Sprechfassung als JSON liefert. */
function speechEngine(speech: unknown, calls: { speech: number }) {
  return new FakeEngine((req: EngineRequest) => {
    if (req.systemPrompt.includes("liest dem Nutzer sein Briefing vor")) {
      calls.speech++;
      return answer(JSON.stringify(speech))(req);
    }
    return answer('{"saetze":[]}')(req);
  });
}

describe("Route: Nyx' Fassung beim Vorlesen", () => {
  beforeEach(() => clearNarrativeCache());

  it("liefert Gruß + Nyx' Sätze (source nyx), einmal erzeugt und gemerkt", async () => {
    const calls = { speech: 0 };
    const sentences = [
      { ziel: "headline", text: "Heute ist wenig los." },
      { ziel: "needs", text: "Die offene Frage wartet auf dein Ja oder Nein." },
      { ziel: "tile:sessions_active", text: "Gerade arbeitet keine Session." },
      { ziel: "group:lief", text: "Gestern lief nicht viel, die Arbeit ruhte." },
      { ziel: "group:naechstes", text: "Als Nächstes lohnt sich die offene Frage." },
    ];
    const t = await setupAssistant({ engine: speechEngine({ saetze: sentences }, calls) });
    const report = await generateReport(t.runtime, "briefing", new Date("2026-09-26T07:00:00Z"));
    const res = await t.app.request(`/api/briefing/${report.id}/speech`);
    expect(res.status).toBe(200);
    const { speech } = (await res.json()) as { speech: BriefingSpeech };
    expect(speech.source).toBe("nyx");
    expect(speech.sentences[0]?.target).toBe("headline");
    expect(speech.sentences.map((s) => s.written)).toContain("Die offene Frage wartet auf dein Ja oder Nein.");
    expect(speech.sentences.some((s) => s.target.startsWith("chart:"))).toBe(false);
    await t.app.request(`/api/briefing/${report.id}/speech`);
    expect(calls.speech).toBe(1);
  });

  it("Modell liefert Unbrauchbares → Fassung aus den Daten (source daten), nächster Versuch fragt neu", async () => {
    const calls = { speech: 0 };
    const t = await setupAssistant({ engine: speechEngine({ quatsch: true }, calls) });
    const report = await generateReport(t.runtime, "briefing", new Date("2026-09-26T07:00:00Z"));
    const { speech } = (await (await t.app.request(`/api/briefing/${report.id}/speech`)).json()) as { speech: BriefingSpeech };
    expect(speech.source).toBe("daten");
    expect(speech.sentences.length).toBeGreaterThan(3);
    await t.app.request(`/api/briefing/${report.id}/speech`);
    expect(calls.speech).toBe(2);
  });

  it("narrateBriefing: gleichzeitige Aufrufe teilen sich einen Lauf", async () => {
    const calls = { speech: 0 };
    const t = await setupAssistant({ engine: speechEngine({ saetze: [] }, calls) });
    const report = await generateReport(t.runtime, "briefing", new Date("2026-09-26T07:00:00Z"));
    await Promise.all([narrateBriefing({ runtime: t.runtime }, report), narrateBriefing({ runtime: t.runtime }, report)]);
    expect(calls.speech).toBe(1);
  });
});

describe("Grenzfälle aus dem Betrieb", () => {
  it("Punkte unter „tile:needs_you“ zählen als Braucht-dich-Liste – nichts wird doppelt gesprochen", () => {
    const r = parseNarrative(
      {
        saetze: [
          { ziel: "headline", text: "Drei Dinge brauchen dich." },
          { ziel: "tile:needs_you", text: "Die Freigabe zum Löschen der Worktrees." },
          { ziel: "tile:needs_you", text: "Die Frage, ob auf main gepusht werden darf." },
          { ziel: "tile:needs_you", text: "Und die Session Heatmap wartet auf dich." },
          { ziel: "group:lief", text: "Gelaufen ist vor allem die Heatmap-Karte." },
        ],
      },
      REPORT,
    );
    const needs = r?.sentences.filter((s) => s.section === "braucht_dich") ?? [];
    expect(needs).toHaveLength(3);
    expect(needs.every((s) => s.target === "needs")).toBe(true);
  });

  it("große Sprünge als Vielfaches statt absurder Prozente", async () => {
    const { changeWords } = await import("../src/haiku/speechNarrative.js");
    expect(changeWords(5_100, 300, "gestern")).toBe("gestern etwa 17-mal so viel");
    expect(changeWords(140, 100, "heute")).toBe("heute 40 % mehr");
    expect(changeWords(60, 100, "heute")).toBe("heute 40 % weniger");
    expect(changeWords(5, 0, "heute")).toBeNull();
  });
});
