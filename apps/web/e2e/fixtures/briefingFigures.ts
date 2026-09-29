// Fester Beispiel-Stand der Briefing-Kennzahlen für einen lokalen Stack ohne Brücke (nur für die Gestaltung;
// mit echten Zahlen läuft briefing-figures.spec.ts ohne E2E_BRIEFING_FIXTURE).
import type { BriefingFigures } from "@nyxos/shared";

const day = (i: number) => new Date(Date.UTC(2026, 8, 25 - i)).toISOString().slice(0, 10);
const days = (n: number) => Array.from({ length: n }, (_, i) => day(n - 1 - i));
const hourOf = (d: Date) => Number(new Intl.DateTimeFormat("de-DE", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Berlin" }).formatToParts(d).find((p) => p.type === "hour")?.value ?? 0);
const USAGE_CLAUDE = [120, 160, 210, 140, 250, 178, 182];
const USAGE_CODEX = [30, 55, 42, 38, 61, 43, 41];
const COMMITS_APP = [2, 4, 1, 0, 5, 6, 3, 2, 7, 4, 6, 8, 5, 6];
const COMMITS_Z = [1, 3, 5, 2, 0, 4, 6, 3, 5, 7, 4, 6, 8, 3];

export const BRIEFING_FIGURES: BriefingFigures = {
  at: new Date().toISOString(),
  periodLabel: "seit gestern 0 Uhr",
  sessions: { running: 3, waiting: 2, idle: 4, crashed: 1, activeInPeriod: 14, closedInPeriod: 6 },
  commits: { today: 9, week: 47, prevWeek: 31 },
  tasks: {
    open: 23,
    byStage: [
      { stage: "geplant", count: 9 },
      { stage: "startklar", count: 4 },
      { stage: "laeuft", count: 6 },
      { stage: "pruefen", count: 4 },
      { stage: "erledigt", count: 38 },
    ],
  },
  usage: { today: { claude: 182_000_000, codex: 41_000_000 }, week: { claude: 1_240_000_000, codex: 310_000_000 }, prevWeek: { claude: 980_000_000, codex: 260_000_000 } },
  openQuestions: { approvals: 1, inbox: 2, conflicts: 0, total: 3 },
  conflicts: 1,
  buildsRed: 0,
  needsYou: 4,
  charts: {
    usage7d: days(7).map((d, i) => ({ day: d, claude: (USAGE_CLAUDE[i] ?? 0) * 1_000_000, codex: (USAGE_CODEX[i] ?? 0) * 1_000_000 })),
    sessionsHourly: Array.from({ length: 24 }, (_, i) => {
      const at = new Date(Date.now() - (23 - i) * 3_600_000);
      const hour = hourOf(at);
      const busy = hour >= 9 ? 1 : 0;
      return { at: at.toISOString(), hour, claude: busy * (2 + (i % 4)), codex: busy * (i % 3) };
    }),
    commitsDaily: days(14).map((d, i) => ({ day: d, repos: { app: COMMITS_APP[i] ?? 0, nyxos: COMMITS_Z[i] ?? 0 } })),
    commitRepos: [
      { key: "app", label: "Atlas" },
      { key: "nyxos", label: "NyxOS" },
    ],
  },
};

const item = (id: string, kind: "approval" | "question" | "session" | "crashed", title: string, minutes: number, href: string) => ({ id, kind, title, detail: null, minutes, zeroEnergy: minutes <= 1, href, sources: [], action: null });

/** Passende Text-Teile zum Beispiel-Stand (damit Kopf, „Braucht dich“ und Kacheln dasselbe sagen). */
export const BRIEFING_REPORT_PARTS = {
  lage: "3 Sessions laufen, 2 warten auf dich, 1 ist abgestürzt, 4 Aufgaben startklar.",
  headline: { text: "4 Punkte brauchen dich – zuerst die abgestürzte Karten-Session, der Rest läuft von selbst.", sources: [], estimate: false, author: "haiku" },
  highlights: ["needs_you", "commits"],
  needsYou: [
    item("approval:12", "approval", "Freigabe: git push origin auftrag/n7", 1, "/inbox#approval-12"),
    item("inbox:31", "question", "Soll das Briefing auch sonntags kommen?", 1, "/inbox#inbox-31"),
    item("session:w1", "session", "Wartet: Ideen-Tab neu bauen", 5, "/sessions"),
    item("crashed:c1", "crashed", "Abgestürzt: Karte mit Heatmap", 2, "/sessions"),
  ],
  sections: [
    {
      title: "Was lief",
      statements: [
        { text: "14 Sessions waren seit gestern 0 Uhr aktiv, zuletzt „Ideen-Tab neu bauen“, „Karte mit Heatmap“ und „Briefing wie ein Artefakt“.", sources: [{ kind: "session", id: "s1", label: "Briefing wie ein Artefakt", href: "/sessions" }], estimate: false, author: "haiku" },
        { text: "6 Sessions wurden seit gestern 0 Uhr geschlossen.", sources: [], estimate: false, author: "regeln" },
      ],
    },
    { title: "Was wartet", statements: [{ text: "2 Sessions warten auf dich: „Ideen-Tab neu bauen“ und „Server-Tab“.", sources: [{ kind: "session", id: "w1", label: "Ideen-Tab neu bauen", href: "/sessions" }], estimate: false, author: "haiku" }] },
    { title: "Was ist kaputt", statements: [{ text: "1 Session ist abgestürzt: „Karte mit Heatmap“.", sources: [], estimate: false, author: "regeln" }] },
    { title: "Vorschlag für heute", statements: [{ text: "Erst die Karten-Session neu starten, dann die Push-Freigabe – beides dauert zusammen keine 5 Minuten.", sources: [], estimate: true, author: "haiku" }] },
  ],
};
