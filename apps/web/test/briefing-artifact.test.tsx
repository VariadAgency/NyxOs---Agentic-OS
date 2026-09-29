// Briefing wie ein Artefakt — Kernaussage, Kennzahl-Kacheln, mindestens 3 Graphen aus `figures`
// (nie aus dem Modelltext), drei Abschnitte in einfacher Sprache, volle Breite; ohne Nyx genauso vollständig.
import type { BriefingFigures, HaikuReport } from "@nyxos/shared";
import { screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCountUpMemory } from "../src/components/charts/StatCard";
import { Briefing, BriefingPage } from "../src/features/haiku/Briefing";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCountUpMemory();
});

const days7 = ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];
const days14 = ["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", ...days7];

const FIGURES: BriefingFigures = {
  at: "2026-09-25T08:38:00.000Z",
  periodLabel: "seit gestern 0 Uhr",
  sessions: { running: 2, waiting: 1, idle: 3, crashed: 1, activeInPeriod: 7, closedInPeriod: 4 },
  commits: { today: 3, week: 17, prevWeek: 9 },
  tasks: {
    open: 11,
    byStage: [
      { stage: "geplant", count: 5 },
      { stage: "startklar", count: 2 },
      { stage: "laeuft", count: 3 },
      { stage: "pruefen", count: 1 },
      { stage: "erledigt", count: 8 },
    ],
  },
  usage: { today: { claude: 3_000_000, codex: 1_000_000 }, week: { claude: 21_000_000, codex: 6_000_000 }, prevWeek: { claude: 10_000_000, codex: 2_000_000 } },
  openQuestions: { approvals: 1, inbox: 1, conflicts: 0, total: 2 },
  conflicts: 1,
  buildsRed: 1,
  needsYou: 2,
  charts: {
    usage7d: days7.map((day, i) => ({ day, claude: (i + 1) * 1_000_000, codex: i * 500_000 })),
    sessionsHourly: Array.from({ length: 24 }, (_, i) => ({ at: new Date(Date.UTC(2026, 8, 24, 11 + i)).toISOString(), hour: (13 + i) % 24, claude: i % 3, codex: i % 2 })),
    commitsDaily: days14.map((day, i) => ({ day, repos: { app: i % 4, nyxos: i % 2 } })),
    commitRepos: [
      { key: "app", label: "Web-App" },
      { key: "nyxos", label: "NyxOS" },
    ],
  },
};

const needsItem = (id: string, kind: "question" | "crashed", title: string, minutes: number) => ({
  id,
  kind,
  title,
  detail: null,
  minutes,
  zeroEnergy: kind === "question",
  href: `/inbox#${id}`,
  sources: [],
  action: null,
});

const REPORT: HaikuReport = {
  id: 7,
  kind: "briefing",
  day: "2026-09-25",
  createdAt: "2026-09-25T08:38:00.000Z",
  greeting: "Guten Morgen, Alex",
  lage: "2 Sessions laufen, 1 wartet auf dich, 1 ist abgestürzt.",
  headline: { text: "Zwei Punkte brauchen dich, der Rest läuft von selbst.", sources: [], estimate: false, author: "haiku" },
  sections: [
    { title: "Was lief", statements: [{ text: "7 Sessions waren seit gestern 0 Uhr aktiv.", sources: [{ kind: "session", id: "s1", label: "Karte bauen", href: "/sessions/coding/app/s1" }], estimate: false, author: "regeln" }] },
    { title: "Was wartet", statements: [{ text: "1 Session wartet auf dich.", sources: [], estimate: false, author: "regeln" }] },
    { title: "Was ist kaputt", statements: [{ text: "1 Session ist abgestürzt.", sources: [], estimate: false, author: "regeln" }] },
    { title: "Als Nächstes", statements: [{ text: "Als Erstes: „Frage klären“ (ein Klick).", sources: [], estimate: false, author: "regeln" }] },
  ],
  runsWithoutYou: [],
  needsYou: [needsItem("inbox:1", "question", "Frage klären", 0), needsItem("crashed:2", "crashed", "Abgestürzt: Karte bauen", 2)],
  mode: "ok",
  callId: 3,
  snapshot: { at: "2026-09-25T08:38:00.000Z", counts: { running: 2, waiting: 1, idle: 3, crashed: 1, startklar: 2 }, lage: "", needsYouCount: 2, fingerprint: "fp" },
  stale: false,
  figures: FIGURES,
  highlights: ["commits"],
  chartOrder: ["commits_daily", "usage_7d", "sessions_hourly", "tasks_progress"],
};

function stub(report: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/haiku/report")) return jsonResponse({ report });
      if (url === "/health") return jsonResponse({ ok: true, checks: {} });
      if (url.startsWith("/api/changes")) return jsonResponse({ since: "2026-09-24T08:38:00.000Z", until: "2026-09-25T08:38:00.000Z", capped: false, groups: [] });
      return Promise.reject(new Error(`unerwartet ${url}`));
    }),
  );
}

const renderIn = (ui: React.ReactElement) => renderWithClient(<MemoryRouter>{ui}</MemoryRouter>);

describe("Briefing wie ein Artefakt", () => {
  it("Kopf: Kernaussage in einem Satz, Stand-Hinweis; „Braucht dich“ direkt darunter mit Knöpfen", async () => {
    stub(REPORT);
    renderIn(<Briefing />);
    expect(await screen.findByTestId("briefing-headline")).toHaveTextContent("Zwei Punkte brauchen dich, der Rest läuft von selbst.");
    expect(screen.getByTestId("briefing-lage")).toHaveTextContent(REPORT.lage);
    const needs = screen.getByRole("region", { name: "Braucht dich" });
    expect(within(needs).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/inbox#inbox:1", "/inbox#crashed:2"]);
    // Reihenfolge von oben nach unten: Kopf → Braucht dich → Kennzahlen → Graphen → Abschnitte.
    const order = ["briefing-head", "briefing-needs", "briefing-kpis", "briefing-charts", "briefing-story"].map((id) => screen.getByTestId(id));
    order.slice(1).forEach((el, i) => expect((order[i] as HTMLElement).compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
  });

  it("Kennzahl-Kacheln zeigen die Zahlen aus `figures` (Nutzung nach Anbieter), jede anklickbar, Hervorhebung von Nyx", async () => {
    stub(REPORT);
    renderIn(<Briefing />);
    const kpis = await screen.findByTestId("briefing-kpis");
    const tile = (k: string) => kpis.querySelector(`[data-brief-tile="${k}"]`) as HTMLElement;
    for (const k of ["needs_you", "sessions_active", "sessions_done", "commits", "tasks_open", "usage_today", "usage_week", "server", "conflicts"]) expect(tile(k)).not.toBeNull();
    expect(tile("sessions_active").dataset.value).toBe("3");
    expect(tile("sessions_done").dataset.value).toBe("4");
    expect(tile("commits").dataset.value).toBe("17");
    expect(tile("tasks_open").dataset.value).toBe("11");
    expect(tile("needs_you").dataset.value).toBe("2");
    expect(tile("conflicts").dataset.value).toBe("1");
    expect(tile("usage_today")).toHaveTextContent("Claude");
    expect(tile("usage_today")).toHaveTextContent("Codex");
    expect(tile("usage_today").dataset.value?.replace(/\s/g, " ")).toBe("4 Mio.");
    expect(tile("commits").dataset.highlight).toBe("true");
    expect(tile("usage_week").dataset.highlight).toBeUndefined();
    for (const k of ["commits", "tasks_open", "usage_today", "sessions_active"]) expect(tile(k).tagName).toBe("A");
  });

  it("mindestens 3 Graphen aus echten Reihen, in der Reihenfolge, die Nyx wichtig fand", async () => {
    stub(REPORT);
    renderIn(<Briefing />);
    const charts = await screen.findByTestId("briefing-charts");
    const figures = within(charts).getAllByRole("figure");
    expect(figures.length).toBeGreaterThanOrEqual(3);
    expect(figures.map((f) => f.dataset.briefChart)).toEqual(["commits_daily", "usage_7d", "sessions_hourly", "tasks_progress"]);
    expect(charts.querySelectorAll('[data-chart="area"]').length).toBe(2);
    expect(charts.querySelector('[data-chart="bar"]')).not.toBeNull();
    expect(charts.querySelector('[data-chart="donut"]')).not.toBeNull();
    // Die unsichtbare Tabelle nennt echte Werte (Claude am letzten Tag 7 Mio.).
    expect(within(figures[1] as HTMLElement).getAllByText(/7 Mio\./).length).toBeGreaterThan(0);
  });

  it("drei Abschnitte in einfacher Sprache mit Links", async () => {
    stub(REPORT);
    renderIn(<Briefing />);
    const story = await screen.findByTestId("briefing-story");
    expect(within(story).getByRole("region", { name: "Was lief" })).toHaveTextContent("7 Sessions waren");
    const hangs = within(story).getByRole("region", { name: "Was hängt" });
    expect(hangs).toHaveTextContent("wartet auf dich");
    expect(hangs).toHaveTextContent("abgestürzt");
    expect(within(story).getByRole("region", { name: "Was als Nächstes" })).toHaveTextContent("Als Erstes");
    expect(within(story).getByRole("link", { name: /Karte bauen/ })).toHaveAttribute("href", "/sessions/coding/app/s1");
  });

  it("ohne Nyx (Rückfall) genauso vollständig: Kernaussage aus Regeln, alle Kacheln und Graphen", async () => {
    stub({ ...REPORT, mode: "nur-daten", modeReason: "Nyx war nicht bereit.", headline: { text: "2 Punkte brauchen dich, davon 1 Störung – am besten zuerst die.", sources: [], estimate: false, author: "regeln" }, highlights: [], chartOrder: ["usage_7d", "sessions_hourly", "commits_daily", "tasks_progress"] });
    renderIn(<Briefing />);
    expect(await screen.findByTestId("briefing-headline")).toHaveTextContent("2 Punkte brauchen dich");
    expect(screen.getByTestId("briefing-kpis").querySelectorAll("[data-brief-tile]")).toHaveLength(9);
    expect(within(screen.getByTestId("briefing-charts")).getAllByRole("figure")).toHaveLength(4);
  });

  it("älterer Bericht ohne Kennzahlen: kein Absturz, ehrlicher Hinweis", async () => {
    stub({ ...REPORT, figures: undefined, headline: undefined, highlights: undefined, chartOrder: undefined });
    renderIn(<Briefing />);
    expect(await screen.findByText(/Kennzahlen und Graphen kommen mit dem nächsten Briefing/)).toBeInTheDocument();
    expect(screen.getByTestId("briefing-headline")).toHaveTextContent(REPORT.lage);
  });

  it("Seite nutzt die volle Breite (kein schmaler Rahmen mehr)", async () => {
    stub(REPORT);
    const { container } = renderIn(<BriefingPage />);
    await screen.findByTestId("briefing-headline");
    // „Seit du weg warst“ steht direkt UNTER dem Kopf mit der Kernaussage.
    const card = screen.getByTestId("since-card");
    expect(card.compareDocumentPosition(screen.getByTestId("briefing-head")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.getByTestId("briefing-head").nextElementSibling).toBe(card);
    expect(await within(card).findByText(/Nichts Neues seit/)).toBeInTheDocument();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toMatch(/max-w-\[880px\]/);
    expect(root.className).toMatch(/w-full/);
  });
});

describe("Nutzung im Briefing wie im Nutzung-Tab", () => {
  it("Claude und Codex als je eigene Linie, nicht gestapelt: die Skala reicht bis zum größten Einzelwert", async () => {
    stub(REPORT);
    renderIn(<Briefing />);
    const charts = await screen.findByTestId("briefing-charts");
    const usage = charts.querySelector('[data-brief-chart="usage_7d"]') as HTMLElement;
    // Letzter Tag: Claude 7 Mio., Codex 3 Mio. — gestapelt stünde die Skala bei 10 Mio.
    const ticks = [...usage.querySelectorAll("svg text")].map((t) => (t.textContent ?? "").replace(/\s/g, " "));
    expect(ticks.some((t) => /^10 Mio\.$/.test(t))).toBe(false);
    expect(ticks.some((t) => /^8 Mio\.$/.test(t))).toBe(true);
  });
});
