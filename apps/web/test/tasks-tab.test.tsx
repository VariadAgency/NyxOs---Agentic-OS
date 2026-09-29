// Aufgaben-Tab — Karten je Auftrag (Farbe je Projekt), Pakete mit Farbe je Status,
// Fortschritt, Kennzahlen im Kopf (offen / in Arbeit / fertig heute / nach Projekt), Schritte und
// verknüpfte Sessions/Commits als Chips. Fixtures wie die echten Daten (GOAL.md-Pfade, Audit-Nummern).
import type { Entry, EntryDetail } from "@nyxos/shared";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupOf, groupTasks, hashColor, packageTitle, projectOf, taskStats } from "../src/features/tasks/model";
import { TasksView } from "../src/features/tasks/TasksView";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-09-25T15:00:00").getTime();

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
    sourceId: "atlas-app/docs/a/GOAL.md",
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

const FIXTURES: Entry[] = [
  entry({ id: 1, title: "P3 · Terminal — `/goal`-Auftrag", sourceId: "nyxos/auftraege/terminal-ausbau/P3-terminal/GOAL.md", baustelle: { slug: "nyxos", label: "nyxos" }, stage: "laeuft", progressPercent: 40, startedSessionKey: "claude:s-terminal", gitBranch: "p3-terminal" }),
  entry({ id: 2, title: "P4 · Aufgaben + Ideen — `/goal`-Auftrag", sourceId: "nyxos/auftraege/terminal-ausbau/P4-aufgaben/GOAL.md", stage: "erledigt", updatedAt: new Date(NOW - 3_600_000).toISOString() }),
  entry({ id: 3, title: "GOAL A01 · Aufräumen & Streichen", sourceId: "atlas-app/docs/atlas-neubau-2026-09/10-Aufgaben/A01-Aufraeumen/GOAL.md", stage: "startklar" }),
  entry({ id: 4, title: "GOAL A02 · Baukasten I", sourceId: "atlas-app/docs/atlas-neubau-2026-09/10-Aufgaben/A02-Baukasten-I/GOAL.md" }),
  entry({ id: 5, title: "atlas-web/docs/technik/12_Kunden_Sprint/05_Anmeld", sourceId: "atlas-web/docs/technik/12_Kunden_Sprint/05_Anmeldung/GOAL.md" }),
  entry({ id: 6, kind: "audit", title: "H-CUST-68 — Der Hintergrund-Baukasten bestätigt Bilder", sourceType: "audit", sourceId: "H-CUST-68", baustelle: { slug: "P-SITZUNG", label: "P-SITZUNG" } }),
  entry({ id: 7, kind: "audit", title: "H-CUST-16 — Lieblingsclub-Karte", sourceType: "audit", sourceId: "H-CUST-16", stage: "pruefen", progressPercent: 90 }),
  entry({ id: 8, kind: "idee", title: "Rohe Idee", sourceType: "idea", sourceId: "idee-1", stage: "eingang" }),
];

describe("Aufgaben-Modell (Hierarchie, Projekte, Kennzahlen)", () => {
  it("Auftrag = sprechender Eltern-Ordner, Audits nach Bereich", () => {
    expect(groupOf(FIXTURES[0] as Entry)).toEqual({ key: "goal:nyxos/auftraege/terminal-ausbau", title: "Terminal Ausbau" });
    expect(groupOf(FIXTURES[2] as Entry)).toEqual({ key: "goal:atlas-app/docs/atlas-neubau-2026-09", title: "Atlas Neubau (2026-09)" });
    expect(groupOf(FIXTURES[4] as Entry).title).toBe("Kunden Sprint");
    expect(groupOf(FIXTURES[5] as Entry)).toEqual({ key: "audit:H-CUST", title: "Audit-Bereich H-CUST" });
  });

  it("Paket-Titel ohne Pfad und ohne „GOAL“/„/goal-Auftrag“", () => {
    expect(packageTitle(FIXTURES[0] as Entry)).toBe("P3 · Terminal");
    expect(packageTitle(FIXTURES[2] as Entry)).toBe("A01 · Aufräumen & Streichen");
    expect(packageTitle(FIXTURES[4] as Entry)).toBe("05 · Anmeldung");
  });

  it("Projekt-Farben sind bunt (nie grau) und fest je Bereich", () => {
    const colors = FIXTURES.map((e) => projectOf(e).color);
    expect(colors.every((c) => !/idle|dim|mut/.test(c))).toBe(true);
    expect(projectOf(FIXTURES[0] as Entry)).toMatchObject({ key: "nyxos", label: "Nyxos", color: hashColor("nyxos") });
    expect(projectOf(FIXTURES[2] as Entry)).toMatchObject({ key: "atlas-app", label: "Atlas App", color: hashColor("atlas-app") });
    expect(projectOf(FIXTURES[4] as Entry)).toMatchObject({ key: "atlas-web", label: "Atlas Web", color: hashColor("atlas-web") });
    // stabil: jedes Paket desselben Projekts hat dieselbe Farbe
    expect(projectOf(FIXTURES[3] as Entry).color).toBe(projectOf(FIXTURES[2] as Entry).color);
    expect(projectOf(FIXTURES[5] as Entry)).toMatchObject({ key: "audit", label: "Audits" });
  });

  it("gruppiert ohne rohe Ideen; was läuft steht oben, Audits nach Aufträgen", () => {
    const groups = groupTasks(FIXTURES);
    expect(groups.map((g) => g.title)).toEqual(["Terminal Ausbau", "Audit-Bereich H-CUST", "Atlas Neubau (2026-09)", "Kunden Sprint"]);
    const nyxos = groups[0];
    expect(nyxos?.items.map((e) => e.id)).toEqual([1, 2]);
    expect(nyxos?.progress).toBe(70); // (40 + 100) / 2
    expect(nyxos?.stageCounts).toMatchObject({ laeuft: 1, erledigt: 1 });
    expect(groups.flatMap((g) => g.items).some((e) => e.kind === "idee")).toBe(false);
  });

  it("Kennzahlen: offen, in Arbeit, fertig heute, nach Projekt", () => {
    const s = taskStats(FIXTURES, NOW);
    expect(s).toMatchObject({ total: 7, open: 6, inArbeit: 2, startklar: 1, erledigt: 1, fertigHeute: 1 });
    expect(s.byProject.map((p) => [p.project.label, p.total])).toEqual([
      ["Atlas App", 2],
      ["Audits", 2],
      ["Nyxos", 2],
      ["Atlas Web", 1],
    ]);
  });
});

const DETAIL: EntryDetail = {
  entry: FIXTURES[0] as Entry,
  subtasks: [
    { id: 11, entryId: 1, title: "Terminal im Browser", weight: 1, done: true, doneBySessionKey: "claude:s-terminal", doneAt: "2026-09-25T10:00:00.000Z", createdAt: "2026-09-24T08:00:00.000Z" },
    { id: 12, entryId: 1, title: "Sessions starten", weight: 1, done: false, doneBySessionKey: null, doneAt: null, createdAt: "2026-09-24T08:00:00.000Z" },
  ],
  links: [
    { id: 21, fromType: "entry", fromId: "1", toType: "session", toId: "claude:s-terminal", relation: "gestartet", createdAt: "2026-09-25T09:00:00.000Z", label: "Terminal bauen", direction: "out" },
    { id: 22, fromType: "entry", fromId: "1", toType: "commit", toId: "abc1234def", relation: "commit", createdAt: "2026-09-25T09:30:00.000Z", label: "P3: Terminal", direction: "out" },
  ],
  events: [],
  docs: [],
};

function renderTasks() {
  stubFetchRoutes({
    entries: () => jsonResponse({ entries: FIXTURES }),
  });
  // Die Großansicht eines Pakets (Schritte) kommt über /api/entries/:id — stubFetchRoutes leitet alle
  // /api/entries*-Aufrufe an `entries`, deshalb hier ein eigener fetch-Wrapper davor.
  const base = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/^\/api\/entries\/1(\?|$)/.test(url)) return jsonResponse(DETAIL);
      return base(input, init);
    }),
  );
  return renderWithClient(
    <MemoryRouter initialEntries={["/tasks"]}>
      <TasksView />
    </MemoryRouter>,
  );
}

describe("Aufgaben-Tab (Ansicht)", () => {
  it("Kopf zeigt offen / in Arbeit / fertig heute und die Verteilung nach Projekt", async () => {
    renderTasks();
    // Audit-Befunde erst per Chip (Standard „Aufträge + Bugs“) — hier alles zusammen.
    fireEvent.click(await screen.findByRole("button", { name: "Alles" }));
    const kpis = await screen.findByRole("region", { name: "Kennzahlen" });
    await waitFor(() => expect(within(kpis).getByText("Offen gesamt").parentElement).toHaveTextContent("6"));
    expect(within(kpis).getByText("In Arbeit").parentElement).toHaveTextContent("2");
    expect(within(kpis).getByText("Fertig heute").parentElement).toHaveTextContent(/\d/);
    const byProject = screen.getByRole("region", { name: "Nach Projekt" });
    expect(within(byProject).getByRole("button", { name: /Nyxos/ })).toBeInTheDocument();
    expect(within(byProject).getByRole("button", { name: /Audits/ })).toBeInTheDocument();
  });

  it("eine Karte je Auftrag mit Projekt-Farbe, Fortschritt und Paketen in Status-Farbe", async () => {
    renderTasks();
    const card = await screen.findByRole("article", { name: "Terminal Ausbau" });
    expect(card).toHaveAttribute("data-project", "nyxos");
    expect(card.getAttribute("style") ?? "").toContain(hashColor("nyxos"));
    expect(within(card).getByText("70 %")).toBeInTheDocument();
    const running = within(card).getByText("P3 · Terminal").closest("[data-stage]");
    expect(running).toHaveAttribute("data-stage", "laeuft");
    expect(running?.getAttribute("style") ?? "").toContain("--a-ok");
    // verknüpfte Session und Zweig direkt als Chips an der Zeile
    expect(within(card).getByRole("link", { name: /Session/ })).toHaveAttribute("href", "/sessions/_/_/claude%3As-terminal");
    expect(within(card).getByText("p3-terminal")).toBeInTheDocument();
    expect(screen.queryByText("Rohe Idee")).toBeNull();
  });

  it("Klick auf ein Projekt filtert die Karten", async () => {
    renderTasks();
    fireEvent.click(await screen.findByRole("button", { name: "Alles" }));
    const byProject = await screen.findByRole("region", { name: "Nach Projekt" });
    fireEvent.click(within(byProject).getByRole("button", { name: /Audits/ }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Terminal Ausbau" })).toBeNull());
    expect(screen.getByRole("article", { name: "Audit-Bereich H-CUST" })).toBeInTheDocument();
  });

  it("Schritte aufklappen: Häkchen-Liste plus Session- und Commit-Chips", async () => {
    renderTasks();
    const card = await screen.findByRole("article", { name: "Terminal Ausbau" });
    fireEvent.click(within(card).getByRole("button", { name: /Schritte von P3 · Terminal/ }));
    const steps = await within(card).findByRole("list", { name: "Schritte" });
    expect(within(steps).getByText("Terminal im Browser")).toBeInTheDocument();
    expect(within(steps).getByText("Sessions starten")).toBeInTheDocument();
    expect(within(card).getByText("1 / 2 Schritte")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Terminal bauen/ })).toHaveAttribute("href", "/sessions/_/_/claude%3As-terminal");
    expect(within(card).getByText("abc1234")).toBeInTheDocument();
  });

  // Eine Quelle, stimmige Summe: Eine Frage in Stufe „eingang“ steht in keiner Karte —
  // sie darf dann auch in der Unterzeile von „Offen gesamt“ nicht mitzählen.
  it("„Offen gesamt“ und seine Unterzeile zählen dieselben Einträge", async () => {
    stubFetchRoutes({
      entries: () =>
        jsonResponse({
          entries: [
            entry({ id: 1, kind: "bug", title: "Bug A", stage: "geplant" }),
            entry({ id: 2, kind: "frage", title: "Offene Frage", stage: "eingang", sourceType: "mcp", sourceId: null }),
          ],
        }),
    });
    renderWithClient(
      <MemoryRouter initialEntries={["/tasks"]}>
        <TasksView />
      </MemoryRouter>,
    );
    const kpis = await screen.findByRole("region", { name: "Kennzahlen" });
    const tile = within(kpis).getByText("Offen gesamt").parentElement;
    await waitFor(() => expect(tile).toHaveTextContent("1"));
    expect(tile).toHaveTextContent("1 Bug");
    expect(tile).not.toHaveTextContent("Sonstige");
  });
});
