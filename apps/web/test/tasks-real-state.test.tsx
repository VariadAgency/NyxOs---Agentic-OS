// Aufgaben-Seite zeigt den echten Stand.
// 1) Erledigte Aufträge (BERICHT.md da) haben statt „Agent starten“ den Knopf „Bericht lesen“.
// 2) Audit-Befunde haben ihren eigenen Tab — auf „Aufgaben“ zählen sie erst, wenn man sie per Chip
//    dazuholt (vorher: „423 offen“, davon 382 Befunde, die 41 echten Aufträge gingen unter).
// 3) Balken ohne Aussage (alles eine Stufe) entfallen, stattdessen ein Satz.
import type { Entry } from "@nyxos/shared";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageSpread } from "../src/features/tasks/model";
import { TasksView } from "../src/features/tasks/TasksView";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(over: Partial<Entry>): Entry {
  return {
    id: 1,
    kind: "aufgabe",
    title: "Auftrag",
    description: null,
    stage: "geplant",
    priority: null,
    baustelle: null,
    progressPercent: 0,
    progressDoneWeight: 0,
    progressTotalWeight: 0,
    maturity: null,
    maturityCheckedAt: null,
    sourceType: "goal",
    sourceId: "App/docs/a/GOAL.md",
    sourceRemovedAt: null,
    fileScope: [],
    modelSuggestion: null,
    estimate: null,
    worktreePath: null,
    gitBranch: null,
    tmuxName: null,
    startedSessionKey: null,
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:00:00.000Z",
    ...over,
  };
}

const GOALS: Entry[] = [
  entry({ id: 1, title: "P1 · Fundament", sourceId: "tools/NyxOS/auftraege/P1-fundament/GOAL.md", stage: "erledigt" }),
  entry({ id: 2, title: "R2 · Nyx", sourceId: "tools/NyxOS/auftraege/R2-nyx/GOAL.md" }),
  entry({ id: 3, title: "A01 · Aufräumen", sourceId: "App/docs/neubau/10-Aufgaben/A01-Aufraeumen/GOAL.md" }),
  entry({ id: 4, kind: "bug", title: "Bug Login", sourceType: "mcp", sourceId: null }),
];
const AUDITS: Entry[] = [
  entry({ id: 10, kind: "audit", title: "H-CUST-68 — Hintergrund", sourceType: "audit", sourceId: "H-CUST-68" }),
  entry({ id: 11, kind: "audit", title: "H-CUST-16 — Lieblingsclub", sourceType: "audit", sourceId: "H-CUST-16" }),
  entry({ id: 12, kind: "audit", title: "B-115 — Seitengröße", sourceType: "audit", sourceId: "B-115" }),
];

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.search}</output>;
}

/** Wie der Server: `?kind=` filtert, sonst alles. */
function render(list: Entry[] = [...GOALS, ...AUDITS]) {
  const urls: string[] = [];
  stubFetchRoutes({});
  const base = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/terminal/status") return jsonResponse({ online: true, machineId: "m1", since: null });
      if (url.startsWith("/api/entries") && !url.startsWith("/api/entries/")) {
        urls.push(url);
        const kind = new URL(url, "http://x").searchParams.get("kind");
        return jsonResponse({ entries: kind ? list.filter((e) => e.kind === kind) : list });
      }
      return base(input, init);
    }),
  );
  renderWithClient(
    <MemoryRouter initialEntries={["/tasks"]}>
      <TasksView />
      <Where />
    </MemoryRouter>,
  );
  return urls;
}

describe("erledigte Aufträge", () => {
  it("statt „Agent starten“ steht „Bericht lesen“ und öffnet die Großansicht", async () => {
    render();
    const read = await screen.findByRole("button", { name: "Bericht lesen: P1 · Fundament" });
    expect(screen.queryByRole("button", { name: "Agent starten für P1 · Fundament" })).toBeNull();
    // Offene Aufträge behalten ihren Knopf.
    expect(screen.getByRole("button", { name: "Agent starten für R2 · Nyx" })).toBeInTheDocument();
    fireEvent.click(read);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("?e=1"));
  });
});

describe("Audit-Befunde zählen nicht doppelt", () => {
  it("Standard „Aufträge + Bugs“: Kopf zählt nur Aufträge und Bugs, keine Audit-Karte", async () => {
    render();
    await screen.findByRole("article", { name: "NyxOS" });
    expect(screen.getByRole("button", { name: "Aufträge + Bugs" })).toHaveAttribute("aria-pressed", "true");
    const kpis = screen.getByRole("region", { name: "Kennzahlen" });
    await waitFor(() => expect(within(kpis).getByText("Offen gesamt").parentElement).toHaveTextContent("3"));
    expect(within(kpis).getByText("Offen gesamt").parentElement).not.toHaveTextContent("Audit");
    expect(screen.getByText(/3 Aufträge offen/)).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: /Audit-Bereich/ })).toBeNull();
    // Hinweis, wo die Befunde stehen — mit Zahl, damit nichts „verschwunden“ wirkt.
    expect(screen.getByRole("button", { name: /Audit 3/ })).toBeInTheDocument();
  });

  it("per Chip „Audit“ zuschaltbar", async () => {
    const urls = render();
    await screen.findByRole("article", { name: "NyxOS" });
    fireEvent.click(screen.getByRole("button", { name: /Audit 3/ }));
    await screen.findByRole("article", { name: "Audit-Bereich H-CUST" });
    expect(urls.some((u) => u.includes("kind=audit"))).toBe(true);
    expect(screen.queryByRole("article", { name: "NyxOS" })).toBeNull();
  });

  it("„Alles“ zeigt Aufträge und Befunde zusammen", async () => {
    render();
    await screen.findByRole("article", { name: "NyxOS" });
    fireEvent.click(screen.getByRole("button", { name: "Alles" }));
    await screen.findByRole("article", { name: "Audit-Bereich H-CUST" });
    expect(screen.getByRole("article", { name: "NyxOS" })).toBeInTheDocument();
    const kpis = screen.getByRole("region", { name: "Kennzahlen" });
    await waitFor(() => expect(within(kpis).getByText("Offen gesamt").parentElement).toHaveTextContent("6"));
  });

  it("Audits-Tab (fest auf Audit) bleibt unverändert: nur Befunde, Satz spricht von Befunden", async () => {
    stubFetchRoutes({ entries: () => jsonResponse({ entries: AUDITS }) });
    renderWithClient(
      <MemoryRouter>
        <TasksView fixedKind="audit" title="Audits" />
      </MemoryRouter>,
    );
    await screen.findByRole("article", { name: "Audit-Bereich H-CUST" });
    expect(screen.getByText(/3 Befunde offen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aufträge + Bugs" })).toBeNull();
  });
});

describe("Projekt-Balken nur mit Aussage", () => {
  it("stageSpread zählt die vorkommenden Stufen", () => {
    expect(stageSpread({ laeuft: 0, pruefen: 0, startklar: 0, geplant: 4, erledigt: 0 })).toBe(1);
    expect(stageSpread({ laeuft: 1, pruefen: 0, startklar: 0, geplant: 4, erledigt: 2 })).toBe(3);
    expect(stageSpread({ laeuft: 0, pruefen: 0, startklar: 0, geplant: 0, erledigt: 0 })).toBe(0);
  });

  it("alles in einer Stufe: kein Balken, ein Satz; Projekte bleiben als Filter klickbar", async () => {
    render(GOALS.filter((e) => e.stage === "geplant"));
    const byProject = await screen.findByRole("region", { name: "Nach Projekt" });
    expect(byProject.querySelector("[data-stagebar]")).toBeNull();
    expect(byProject).toHaveTextContent("Alles steht auf „Geplant“");
    fireEvent.click(within(byProject).getByRole("button", { name: /App/ }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "NyxOS" })).toBeNull());
    // Karten mit nur einer Stufe haben auch keinen Balken.
    expect(document.querySelector("article [data-stagebar]")).toBeNull();
  });

  it("gemischte Stufen: Balken je Projekt bleiben", async () => {
    render();
    const byProject = await screen.findByRole("region", { name: "Nach Projekt" });
    await waitFor(() => expect(byProject.querySelectorAll("[data-stagebar]").length).toBeGreaterThan(0));
    const nyxos = screen.getByRole("article", { name: "NyxOS" });
    expect(nyxos.querySelector("[data-stagebar]")).not.toBeNull();
  });
});
