// Überblick, Briefing, Git, Nutzung — Zahlen, die stimmen und zum Handeln führen.
// (1) Überblick: oben höchstens 4 Kacheln, die Handeln auslösen, alle Null-Werte in EINER Zeile, jede Kachel ein Link.
// (2) „Ungesichert“ auf Git mit derselben Kontextzeile wie im Überblick (eine Quelle: `kpis.uncommitted`).
// (3) Tages-Trend nur, wenn der Server einen fairen Vergleich hat (gestern bis zur gleichen Uhrzeit, ab 06:00).
// (4) Briefing-Kacheln: keine bunten Rahmen, „wichtig“ nie bei 0.
import type { BriefingFigures, MetricTile, OverviewSnapshot } from "@nyxos/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatCard, resetCountUpMemory } from "../src/components/charts/StatCard";
import { KpiGrid } from "../src/features/haiku/BriefingFigures";
import { Overview } from "../src/features/overview/Overview";
import { SinceCard } from "../src/features/overview/SinceCard";
import { UsageView } from "../src/features/usage/UsageView";
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

function snapshot(metrics: MetricTile[]): OverviewSnapshot {
  return {
    greetingName: "Alex",
    generatedAt: "2026-09-26T08:00:00.000Z",
    counts: { running: 3, waiting: 2, idle: 0, crashed: 0, startklar: 0 },
    lage: "3 Sessions laufen, 2 warten auf dich.",
    needsYouCount: 2,
    openQuestions: { approvals: 0, inbox: 2, conflicts: 0, total: 2 },
    fingerprint: "fp",
    recentDone: [],
    metrics,
    commits: [{ date: "2026-09-26", claude: 0, codex: 0, human: 4 }],
    criticalSessions: [],
    orphanedSessions: [],
    orphanedTotal: 0,
    baustellen: [],
    pendingDeliveries: { count: 0, sessions: 0, href: null, title: null },
    serverOk: true,
  };
}

const BASE = [
  tile({ key: "sessions_open", label: "Sessions offen", value: 5, href: "/sessions" }),
  tile({ key: "sessions_waiting", label: "Wartet auf dich", value: 2, href: "/sessions?state=waiting" }),
  tile({ key: "tokens_today", label: "Tokens heute", value: 63_600_000, format: "tokens", href: "/usage" }),
  tile({ key: "commits_7d", label: "Commits · 7 Tage", value: 633, href: "/git" }),
  tile({ key: "uncommitted", label: "Ungesichert", value: 2657, caption: "635 in Repos · 2.022 in Worktrees", href: "/git" }),
  tile({ key: "conflicts", label: "Konflikte", value: 0, href: "/conflicts" }),
  tile({ key: "builds_red", label: "Builds rot", value: 0, href: "/server" }),
  tile({ key: "open_questions", label: "Offene Fragen", value: 2, href: "/inbox" }),
  tile({ key: "audits_critical", label: "Audit kritisch", value: 147, href: "/audits" }),
  tile({ key: "max_window", label: "Max-Fenster · 5 Std", value: 762_400_000, format: "tokens", href: "/usage" }),
  tile({ key: "haiku_briefing", label: "Nyx heute", value: 0, href: "/briefing" }),
];

function renderOverview(metrics: MetricTile[]) {
  stubFetchRoutes({ overview: () => jsonResponse(snapshot(metrics)) });
  renderWithClient(
    <MemoryRouter>
      <Overview />
    </MemoryRouter>,
  );
}

describe("Überblick: oben nur, was zum Handeln führt", () => {
  it("höchstens 4 Handeln-Kacheln, Null-Werte in einer Zeile („Sonst ruhig“, weil oben etwas wartet), keine große Uhr", async () => {
    renderOverview(BASE);
    const action = await screen.findByRole("region", { name: "Zum Handeln" });
    const keys = [...action.querySelectorAll("[data-metric]")].map((el) => el.getAttribute("data-metric"));
    expect(keys.length).toBeLessThanOrEqual(4);
    expect(keys).toEqual(["sessions_waiting", "open_questions", "max_window", "uncommitted"]);
    for (const a of action.querySelectorAll("[data-metric]")) expect(a.tagName).toBe("A");

    const calm = screen.getByTestId("overview-calm-line");
    expect(calm).toHaveTextContent(/^Sonst ruhig: 0 Konflikte · 0 Builds rot · 0 Nyx-Aufrufe heute$/);
    expect(within(calm).getByRole("link", { name: "0 Konflikte" })).toHaveAttribute("href", "/conflicts");
    expect(within(calm).getByRole("link", { name: "0 Builds rot" })).toHaveAttribute("href", "/server");
    // Null-Kacheln stehen nicht zusätzlich groß da.
    expect(document.querySelector('[data-metric="conflicts"]')).toBeNull();
    expect(document.querySelector('[data-metric="builds_red"]')).toBeNull();
    // Der Rest steht ruhiger darunter, ebenfalls als Link.
    const rest = screen.getByRole("region", { name: "Weitere Kennzahlen" });
    expect([...rest.querySelectorAll("[data-metric]")].map((el) => el.getAttribute("data-metric"))).toEqual(["sessions_open", "tokens_today", "commits_7d", "audits_critical"]);
    expect(screen.queryByLabelText("Uhrzeit")).toBeNull();
  });

  it("rote Builds und Konflikte rücken nach oben, sobald sie > 0 sind", async () => {
    renderOverview(BASE.map((m) => (m.key === "builds_red" ? { ...m, value: 1 } : m.key === "conflicts" ? { ...m, value: 3 } : m)));
    const action = await screen.findByRole("region", { name: "Zum Handeln" });
    const keys = [...action.querySelectorAll("[data-metric]")].map((el) => el.getAttribute("data-metric"));
    expect(keys).toEqual(["builds_red", "conflicts", "sessions_waiting", "max_window"]);
    expect(screen.getByTestId("overview-calm-line")).not.toHaveTextContent("Konflikte");
    // Rote Builds oben und daneben „Alles ruhig“ widersprach sich.
    expect(screen.getByTestId("overview-calm-line")).toHaveTextContent(/^Sonst ruhig:/);
  });

  it("„Alles ruhig“ nur, wenn oben nichts Dringendes steht", async () => {
    renderOverview(BASE.map((m) => (m.key === "sessions_waiting" || m.key === "open_questions" ? { ...m, value: 0 } : m)));
    const calm = await screen.findByTestId("overview-calm-line");
    expect(calm).toHaveTextContent(/^Alles ruhig: 0 wartet auf dich · 0 Konflikte · 0 Builds rot · 0 offene Fragen/);
  });
});

describe("Kennzahl-Kachel", () => {
  it("ohne Vergleich kein Trend-Chip; Sparkline erst ab 3 Tagen mit Werten", () => {
    renderWithClient(
      <MemoryRouter>
        <StatCard id="tokens_today" label="Tokens heute" value={10} format={String} trend={null} sparkline={[0, 0, 0, 0, 5]} sparklineLabel="Tokens je Tag · 14 T" />
        <StatCard id="commits_7d" label="Commits" value={12} format={String} sparkline={[1, 0, 2, 3]} sparklineLabel="Commits je Tag" />
      </MemoryRouter>,
    );
    const today = document.querySelector('[data-metric="tokens_today"]') as HTMLElement;
    expect(today.textContent).not.toMatch(/[▲▼]/);
    expect(today.querySelector("svg")).toBeNull();
    const commits = document.querySelector('[data-metric="commits_7d"]') as HTMLElement;
    expect(commits.querySelector("svg")).not.toBeNull();
  });
});

describe("Nutzung: „Heute“ gegen gestern bis zur gleichen Uhrzeit", () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const totals = (tokens: number, claude: number, codex: number) => ({ fromDay: today, toDay: today, tokens, byTool: { claude, codex } });
  function stubUsage(day: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/usage/daily")) return jsonResponse({ days: [{ day: today, tool: "claude", model: "claude-opus-5", project: "andere", totalTokens: 80, inputTokens: 80, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }] });
        if (url.startsWith("/api/usage/compare")) return jsonResponse({ now: new Date().toISOString(), day });
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    renderWithClient(
      <MemoryRouter initialEntries={["/usage"]}>
        <UsageView />
      </MemoryRouter>,
    );
  }

  it("vor 06:00 (kein fairer Vergleich) steht kein Chip, auch wenn gestern viel mehr war", async () => {
    stubUsage({ today: totals(80, 80, 0), previous: totals(5_000_000, 5_000_000, 0), comparable: false, until: "00:41", deltaPct: null });
    const card = await screen.findByText("Heute");
    const el = card.closest("[data-metric]") as HTMLElement;
    await new Promise((r) => setTimeout(r, 50));
    expect(el.textContent).not.toMatch(/[▲▼]/);
  });

  it("später am Tag: Chip gegen gestern bis zur gleichen Uhrzeit, mit Uhrzeit im Hinweis", async () => {
    stubUsage({ today: totals(80, 80, 0), previous: totals(100, 100, 0), comparable: true, until: "14:00", deltaPct: -20 });
    const el = (await screen.findByText("Heute")).closest("[data-metric]") as HTMLElement;
    expect(await within(el).findByText("20 %")).toBeInTheDocument();
    expect(within(el).getByTitle(/gestern bis 14:00: vorher 100, jetzt 80/)).toBeInTheDocument();
  });
});

const FIGURES: BriefingFigures = {
  at: "2026-09-26T08:38:00.000Z",
  periodLabel: "seit gestern 0 Uhr",
  sessions: { running: 2, waiting: 3, idle: 0, crashed: 0, activeInPeriod: 9, closedInPeriod: 0 },
  commits: { today: 12, week: 628, prevWeek: 0 },
  tasks: { open: 423, byStage: [{ stage: "startklar", count: 0 }] },
  usage: { today: { claude: 44_800_000, codex: 0 }, week: { claude: 6_300_000_000, codex: 207_100_000 }, prevWeek: { claude: 0, codex: 0 } },
  openQuestions: { approvals: 0, inbox: 2, conflicts: 0, total: 2 },
  conflicts: 0,
  buildsRed: 0,
  needsYou: 5,
  charts: { usage7d: [], sessionsHourly: [], commitsDaily: [], commitRepos: [] },
};

describe("Briefing-Kacheln", () => {
  it("keine bunten Rahmen; „wichtig“ nur bei Wert > 0, dann mit schmalem Streifen links", async () => {
    stubFetchRoutes({ health: () => jsonResponse({ ok: true, checks: {} }) });
    renderWithClient(
      <MemoryRouter>
        <KpiGrid figures={FIGURES} highlights={["needs_you", "sessions_active", "sessions_done"]} />
      </MemoryRouter>,
    );
    const kpis = await screen.findByTestId("briefing-kpis");
    const t = (k: string) => kpis.querySelector(`[data-brief-tile="${k}"]`) as HTMLElement;
    for (const k of ["needs_you", "sessions_active", "sessions_done"]) {
      expect(t(k).style.boxShadow).toBe("");
      expect(t(k).className).not.toMatch(/border-transparent/);
    }
    expect(within(t("needs_you")).getByText("wichtig")).toBeInTheDocument();
    expect(t("needs_you").querySelector("[data-brief-stripe]")).not.toBeNull();
    // „Sessions fertig 0“ ist nicht wichtig, auch wenn Nyx sie hervorhebt.
    expect(within(t("sessions_done")).queryByText("wichtig")).toBeNull();
    expect(t("sessions_done").dataset.highlight).toBeUndefined();
    expect(t("sessions_done").querySelector("[data-brief-stripe]")).toBeNull();
  });
});

describe("„Seit du weg warst“ eingeklappt", () => {
  const item = (label: string) => ({ label, detail: null, at: new Date().toISOString(), path: "/sessions" });
  const CHANGES = {
    since: new Date(Date.now() - 86_400_000).toISOString(),
    until: new Date().toISOString(),
    capped: false,
    groups: [
      { kind: "sessions_waiting", title: "Wartet auf dich", count: 2, items: [item("A"), item("B")], more: 0 },
      { kind: "sessions_done", title: "Sessions fertig", count: 3, items: [item("C"), item("D"), item("E")], more: 0 },
    ],
  };

  it("startet als eine Zeile je Art, klappt per Knopf auf und merkt sich das", async () => {
    localStorage.clear();
    stubFetchRoutes({ changes: () => jsonResponse(CHANGES) });
    const { unmount } = renderWithClient(
      <MemoryRouter>
        <SinceCard collapsible place="test" />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole("button", { name: /5 Änderungen/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("list", { name: "Kurzfassung" })).toHaveTextContent("Wartet auf dich2Sessions fertig3");
    expect(screen.queryByRole("region", { name: "Wartet auf dich" })).toBeNull();
    await userEvent.click(toggle);
    expect(await screen.findByRole("region", { name: "Wartet auf dich" })).toBeInTheDocument();
    unmount();
    renderWithClient(
      <MemoryRouter>
        <SinceCard collapsible place="test" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: /Zuklappen/ })).toHaveAttribute("aria-expanded", "true");
  });
});
