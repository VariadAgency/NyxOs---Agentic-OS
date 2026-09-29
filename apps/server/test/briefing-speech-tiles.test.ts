// Nyx erklärt: Das Vorlesen überspringt keine Kachel mehr. Jede sichtbare Kennzahl-Kachel (BRIEF_TILE_KEYS,
// in der Reihenfolge der Seite) bekommt genau einen Satz – auch „Braucht dich“ („Du hast 5 offene Punkte …“).
import { briefTileTarget, type BriefingFigures, type HaikuReport } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { buildBriefingSpeech } from "../src/haiku/speech.js";

const FIGURES = {
  at: "2026-09-25T08:38:00.000Z",
  periodLabel: "seit gestern 0 Uhr",
  sessions: { running: 2, waiting: 1, idle: 3, crashed: 1, activeInPeriod: 7, closedInPeriod: 4 },
  commits: { today: 3, week: 17, prevWeek: 9 },
  tasks: { open: 11, byStage: [{ stage: "startklar", count: 2 }, { stage: "laeuft", count: 3 }, { stage: "erledigt", count: 8 }] },
  usage: { today: { claude: 3_000_000, codex: 1_000_000 }, week: { claude: 21_000_000, codex: 6_000_000 }, prevWeek: { claude: 10_000_000, codex: 2_000_000 } },
  openQuestions: { approvals: 1, inbox: 4, conflicts: 0, total: 5 },
  conflicts: 1,
  buildsRed: 1,
  needsYou: 5,
  charts: { usage7d: [], sessionsHourly: [], commitsDaily: [], commitRepos: [] },
} as unknown as BriefingFigures;

const REPORT = {
  id: 7,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: "2026-09-25T08:38:00.000Z",
  greeting: "Guten Morgen",
  lage: "2 Sessions arbeiten.",
  headline: null,
  sections: [],
  runsWithoutYou: [],
  needsYou: [],
  mode: "nur-daten",
  modeReason: null,
  callId: null,
  snapshot: { at: "2026-09-25T08:38:00.000Z", counts: {}, lage: "", needsYouCount: 5, fingerprint: "x" },
  figures: FIGURES,
  highlights: ["usage_today"],
  chartOrder: [],
} as unknown as HaikuReport;

// Gewünscht: nicht mehr Kachel für Kachel und keine Graphen-Erklärungen – die Zahlen zusammengefasst,
// „Braucht dich“ mit JEDEM Punkt, unten der ganze Stand statt nur Stichpunkte. (Die Fassung aus den Daten ist der
// Rückfall; im Normalfall schreibt Nyx selbst, s. briefing-narrative.test.ts.)
const NEEDS = ["Freigabe: 126 Worktrees löschen", "Frage: Push auf main?", "Session „Heatmap“ wartet", "Build web ist rot", "Sortier-Vorschlag Audit", "Frage: Deploy heute?", "Idee prüfen", "Konflikt ansehen"].map(
  (title, i) => ({ id: `n${i}`, kind: "question", title, detail: null, minutes: i === 0 ? 0 : 2, zeroEnergy: i === 0, href: null, sources: [], action: null }),
);

describe("Fassung aus den Daten", () => {
  const speech = buildBriefingSpeech(REPORT, new Date("2026-09-25T08:40:00Z"));

  it("Kennzahlen zusammengefasst in höchstens drei Sätzen, keine Graphen-Sätze", () => {
    const kpi = speech.sentences.filter((s) => s.section === "kennzahlen");
    expect(kpi.length).toBeGreaterThanOrEqual(2);
    expect(kpi.length).toBeLessThanOrEqual(3);
    expect(speech.sentences.some((s) => s.target.startsWith("chart:"))).toBe(false);
    expect(speech.sentences.map((s) => s.text).join(" ")).not.toMatch(/Graph|Diagramm|zeigt die letzten/);
    expect(kpi.map((s) => s.target)).toContain(briefTileTarget("sessions_active"));
  });

  it("„Braucht dich“: jeder Punkt einzeln (bis sechs), der Rest als Anzahl – keiner fällt still weg", () => {
    const s = buildBriefingSpeech({ ...REPORT, needsYou: NEEDS } as unknown as HaikuReport, new Date("2026-09-25T08:40:00Z"));
    const needs = s.sentences.filter((x) => x.section === "braucht_dich").map((x) => x.written);
    expect(needs[0]).toMatch(/^8 Punkte brauchen dich/);
    for (const t of NEEDS.slice(0, 6)) expect(needs.join(" ")).toContain(t.title.replace(/[.!?:;,]+$/u, ""));
    expect(needs.at(-1)).toMatch(/2 weitere Punkte/);
  });

  it("Was lief/hängt/als Nächstes: bis zu fünf ganze Sätze je Gruppe", () => {
    const sections = [{ title: "Was lief", statements: [1, 2, 3, 4].map((n) => ({ text: `Satz ${n} über den Stand der Arbeit, ausführlich.`, sources: [], estimate: false, author: "regeln" })) }];
    const s = buildBriefingSpeech({ ...REPORT, sections } as unknown as HaikuReport, new Date("2026-09-25T08:40:00Z"));
    expect(s.sentences.filter((x) => x.section === "lief")).toHaveLength(4);
  });
});
