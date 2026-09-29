import type { Entry, MetricTile, OverviewSnapshot } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Overview, greetingFor, situationSentence } from "../src/features/overview/Overview";
import { resetCountUpMemory } from "../src/components/charts/StatCard";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  resetCountUpMemory();
});

const tile = (over: Partial<MetricTile> & Pick<MetricTile, "key" | "label" | "value" | "href">): MetricTile => ({
  format: "count",
  trend: null,
  sparkline: [],
  sparklineLabel: null,
  caption: null,
  captionTone: null,
  placeholder: false,
  placeholderReason: null,
  ...over,
});

const SNAPSHOT: OverviewSnapshot = {
  greetingName: "Alex",
  generatedAt: "2026-09-25T08:00:00.000Z",
  counts: { running: 2, waiting: 1, idle: 0, crashed: 1, startklar: 3 },
  // der Lage-Satz kommt vom Server (derselbe wie im Briefing).
  lage: "2 Sessions laufen, 1 wartet auf dich, 1 ist abgestürzt, 3 Aufgaben startklar.",
  needsYouCount: 2,
  openQuestions: { approvals: 0, inbox: 0, conflicts: 0, total: 0 },
  fingerprint: "fp",
  recentDone: [],
  metrics: [
    tile({ key: "sessions_open", label: "Sessions offen", value: 3, trend: { current: 5, previous: 0, period: "Starts ggü. Vortag", upIsGood: null }, sparkline: [1, 2, 3], sparklineLabel: "Starts je Tag · 14 T", href: "/sessions" }),
    tile({ key: "commits_7d", label: "Commits · 7 Tage", value: 12, trend: { current: 12, previous: 10, period: "ggü. Vorwoche", upIsGood: true }, href: "/git" }),
    tile({ key: "max_window", label: "Max-Fenster · 5 Std", value: 1_500_000, format: "tokens", caption: "Limit erreicht · frei ab 14:30", captionTone: "wait", href: "/usage" }),
  ],
  commits: [{ date: "2026-09-24", claude: 0, codex: 0, human: 4 }],
  orphanedSessions: [],
  orphanedTotal: 0,
  criticalSessions: [{ sessionKey: "claude:c", sessionId: "c", title: "kaputte Session", label: "kaputte Session", tool: "claude", state: "crashed", reason: "abgestürzt", href: "/sessions/coding/_/c" }],
  baustellen: [{ slug: "nyxos", label: "NyxOS", progressPct: null, openSessions: 2 }],
  pendingDeliveries: { count: 0, sessions: 0, href: null, title: null },
  serverOk: true,
};

describe("Überblick: Kopf-Helfer (UX-C)", () => {
  it("Gruß nach Tageszeit (Berliner Zeit, gemeinsame Regel mit dem Briefing)", () => {
    expect(greetingFor(new Date("2026-09-26T05:00:00Z"), "Alex")).toBe("Guten Morgen, Alex");
    expect(greetingFor(new Date("2026-09-26T11:00:00Z"), "Alex")).toBe("Guten Tag, Alex");
    expect(greetingFor(new Date("2026-09-26T19:00:00Z"), "Alex")).toBe("Guten Abend, Alex");
    expect(greetingFor(new Date("2026-09-26T00:00:00Z"), "Alex")).toBe("Noch wach, Alex?");
    expect(greetingFor(new Date("2026-09-26T05:00:00Z"), "Mia")).toBe("Guten Morgen, Mia");
  });

  it("Lage-Satz: Einzahl/Mehrzahl stimmen, ruhiger Satz ohne Zahlen", () => {
    expect(situationSentence({ running: 1, waiting: 1, idle: 0, crashed: 0, startklar: 1 })).toBe("1 Session läuft, 1 wartet auf dich, 1 Aufgabe startklar.");
    expect(situationSentence({ running: 4, waiting: 2, idle: 0, crashed: 0, startklar: 0 })).toBe("4 Sessions laufen, 2 warten auf dich.");
    expect(situationSentence({ running: 0, waiting: 1, idle: 0, crashed: 0, startklar: 0 })).toBe("Keine Session läuft, 1 wartet auf dich.");
    expect(situationSentence({ running: 0, waiting: 0, idle: 0, crashed: 0, startklar: 0 })).toBe("Alles ruhig, gerade läuft nichts.");
  });

});

describe("Überblick-Dashboard", () => {
  it("„Seit du weg warst“ steht ganz oben, direkt unter dem Gruß", async () => {
    stubFetchRoutes({ overview: () => jsonResponse(SNAPSHOT) });
    renderWithClient(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    const card = await screen.findByTestId("since-card");
    const header = screen.getByRole("heading", { level: 1 }).closest("header");
    expect(header?.nextElementSibling).toBe(card);
    expect(await within(card).findByText(/Nichts Neues seit/)).toBeInTheDocument();
  });

  it("Kopf: Gruß nach Tageszeit + Lage-Satz aus echten Zahlen; jede Kachel ist ein Link zu ihrem Tab", async () => {
    stubFetchRoutes({ overview: () => jsonResponse(SNAPSHOT) });
    renderWithClient(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: /^(Guten Morgen, Alex|Guten Tag, Alex|Guten Abend, Alex|Noch wach, Alex\?)$/ })).toBeInTheDocument();
    expect(screen.getByText(/2 Sessions laufen, 1 wartet auf dich, 1 ist abgestürzt, 3 Aufgaben startklar\./)).toBeInTheDocument();
    const realTile = await screen.findByText("Sessions offen");
    expect(realTile.closest("a")).toHaveAttribute("href", "/sessions");
    expect(screen.getByText("Max-Fenster · 5 Std").closest("a")).toHaveAttribute("href", "/usage");
    expect(screen.getByText("Limit erreicht · frei ab 14:30")).toHaveClass("text-a-wait");
    // Trend gegen eine Null-Basis: absolute Änderung statt „▲ ∞ %"; sonst Prozent.
    expect(screen.getByText("+5")).toBeInTheDocument();
    expect(screen.getByText("20 %")).toBeInTheDocument();
    // Haiku-Briefing: ohne Bericht ein ehrlicher Leerzustand mit Weg zum Briefing, kein „folgt“.
    const teaser = await screen.findByTestId("briefing-teaser");
    expect(teaser).toHaveTextContent("Noch kein Briefing für heute");
    expect(teaser).not.toHaveTextContent("folgt");
    expect(teaser.querySelector('a[href="/briefing"]')).not.toBeNull();
    expect(screen.queryByText(/kommt mit P\d/)).toBeNull();

    const critical = await screen.findByText("kaputte Session");
    expect(critical.closest("a")).toHaveAttribute("href", "/sessions/coding/_/c");
  });

  it("Betrieb zeigt die Zustell-Warteschlange mit Link zur Session", async () => {
    stubFetchRoutes({ overview: () => jsonResponse({ ...SNAPSHOT, pendingDeliveries: { count: 3, sessions: 2, href: "/sessions/coding/_/q1", title: "Warteschlange A" } }) });
    renderWithClient(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    const row = await screen.findByText("3 Nachrichten warten auf Zustellung");
    expect(row.closest("a")).toHaveAttribute("href", "/sessions/coding/_/q1");
    expect(screen.getByText(/Warteschlange A \(\+1 weitere Sessions\)/)).toBeInTheDocument();
  });

  it("zeigt den Lage-Satz des echten Haiku-Briefings mit Uhrzeit und Link (Endprüfung: vorher Platzhalter „Briefing folgt“)", async () => {
    stubFetchRoutes({
      overview: () => jsonResponse(SNAPSHOT),
      haikuReport: () =>
        jsonResponse({
          report: { id: 1, kind: "briefing", day: "2026-09-25", createdAt: "2026-09-25T04:30:00.000Z", greeting: "Guten Morgen", lage: "5 Sessions laufen, nichts wartet auf dich.", sections: [], runsWithoutYou: [], needsYou: [], mode: "ok", callId: 1 },
        }),
    });
    renderWithClient(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    const teaser = await screen.findByTestId("briefing-teaser");
    expect(await within(teaser).findByText("5 Sessions laufen, nichts wartet auf dich.")).toBeInTheDocument();
    expect(teaser).toHaveTextContent("Briefing von 06:30");
    expect(teaser.querySelector('a[href="/briefing"]')).not.toBeNull();
  });

  // "Startklar" war früher eine Leer-Kachel —
  // jetzt echte Einträge aus /api/entries?stage=startklar mit demselben Start-Knopf wie im Aufgaben-Tab.
  it("Startklar zeigt echte startklare Aufträge mit Start-Knopf, der /api/entries/:id/start aufruft", async () => {
    const startklarEntry: Entry = {
      id: 42,
      kind: "bug",
      title: "Startklarer Bug",
      description: null,
      stage: "startklar",
      priority: "p1",
      baustelle: { slug: "nyxos", label: "NyxOS" },
      progressPercent: 0,
      progressDoneWeight: 0,
      progressTotalWeight: 0,
      maturity: { points: [], passed: true, passedCount: 6, totalCount: 6 },
      maturityCheckedAt: "2026-09-25T08:00:00.000Z",
      sourceType: "manual",
      sourceId: null,
      sourceRemovedAt: null,
      fileScope: [],
      modelSuggestion: null,
      estimate: null,
      worktreePath: null,
      gitBranch: null,
      tmuxName: null,
      startedSessionKey: null,
      createdAt: "2026-09-25T08:00:00.000Z",
      updatedAt: "2026-09-25T08:00:00.000Z",
    };
    const impl = stubFetchRoutes({
      overview: () => jsonResponse({ ...SNAPSHOT, metrics: [] }),
      entries: () => jsonResponse({ entries: [startklarEntry] }),
    });
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Startklarer Bug")).toBeInTheDocument();

    impl.mockImplementationOnce(() => jsonResponse({ ok: true, plan: {}, command: "" }));
    await user.click(screen.getByRole("button", { name: "Starten" }));

    await waitFor(() => {
      const startCall = impl.mock.calls.find(([input]) => (typeof input === "string" ? input : input.toString()).includes("/api/entries/42/start"));
      expect(startCall).toBeDefined();
    });
  });
});
