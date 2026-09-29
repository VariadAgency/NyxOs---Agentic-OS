import { fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsView } from "../src/features/agents/AgentsView";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const RUNS = [
  {
    id: "claude:s1:a1",
    tool: "claude",
    parentSessionKey: "claude:s1",
    parentTitle: "Baustelle NyxOS",
    agentName: "test-coverage-critic",
    agentType: "test-coverage-critic",
    startedAt: "2026-09-24T10:00:00.000Z",
    endedAt: "2026-09-24T10:00:10.000Z",
    durationMs: 10_000,
    toolCalls: 3,
    verdict: "PASS_WITH_NOTES" as const,
    running: false,
  },
];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/agents/runs")) return jsonResponse({ runs: RUNS });
      if (url.startsWith("/api/agents/catalog")) return jsonResponse({ catalog: [{ kind: "skill", name: "dataviz", description: "Diagramme richtig gestalten", path: "/x/dataviz/SKILL.md", source: "user", seenAt: "2026-09-24T10:00:00.000Z" }] });
      if (url.startsWith("/api/agents/skills/usage")) return jsonResponse({ skills: [{ skill: "dataviz", runs7d: 2, lastUsedAt: "2026-09-24T10:00:00.000Z" }] });
      if (url.startsWith("/api/agents/anomalies")) return jsonResponse({ anomalies: [] });
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
}

describe("AgentsView", () => {
  // „Alle Agenten“ sind jetzt Kacheln je Agent-Typ. Kachel → Agenten-Großansicht mit den
  // letzten Einsätzen; ein Einsatz → Lauf-Großansicht (Urteil, Eltern-Session) wie bisher.
  it("zeigt Agenten als Kachel, Kachel → Einsätze, Einsatz → Lauf-Großansicht", async () => {
    stub();
    renderWithClient(
      <MemoryRouter initialEntries={["/agents"]}>
        <AgentsView />
      </MemoryRouter>,
    );
    const tile = await screen.findByRole("button", { name: /test-coverage-critic/ });
    expect(tile).toHaveAttribute("data-agent-tile", "test-coverage-critic");

    fireEvent.click(tile);
    const detail = await screen.findByTestId("agent-tile-detail");
    expect(detail).toHaveTextContent("Baustelle NyxOS");
    fireEvent.click(within(detail).getByRole("button", { name: "test-coverage-critic" }));
    expect(await screen.findByTestId("agent-detail")).toBeInTheDocument();
    expect(screen.getByTestId("agent-detail")).toHaveTextContent("Baustelle NyxOS");
    expect(screen.getByText("PASS mit Hinweisen")).toBeInTheDocument();
  });

  it("Dauer lesbar statt Sekunden, PASS-Quote als Ring, Suche filtert die Kacheln", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...RUNS[0], id: `claude:s1:x${i}`, agentName: `Einsatz ${i}`, agentType: `agent-${String(i).padStart(2, "0")}`, durationMs: 11_053_000, verdict: "PASS" as const }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/agents/runs")) return jsonResponse({ runs: many });
        if (url.startsWith("/api/agents/catalog")) return jsonResponse({ catalog: [] });
        if (url.startsWith("/api/agents/skills/usage")) return jsonResponse({ skills: [] });
        return jsonResponse({ anomalies: [] });
      }),
    );
    renderWithClient(
      <MemoryRouter initialEntries={["/agents"]}>
        <AgentsView />
      </MemoryRouter>,
    );
    expect(await screen.findByText("agent-00")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-agent-tile]")).toHaveLength(25);
    expect(screen.getAllByText("100 %").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /agent-07/ }));
    expect(within(await screen.findByTestId("agent-tile-detail")).getAllByText(/3 h 4 min/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/11053s/)).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Agent suchen" }), { target: { value: "agent-24" } });
    expect(document.querySelectorAll("[data-agent-tile]")).toHaveLength(1);
  });

  it("zeigt Skill-Nutzung und öffnet die Skill-Großansicht", async () => {
    stub();
    renderWithClient(
      <MemoryRouter initialEntries={["/agents"]}>
        <AgentsView />
      </MemoryRouter>,
    );
    const skillRow = await screen.findByText("/dataviz");
    fireEvent.click(skillRow);
    expect(await screen.findByTestId("agent-detail")).toBeInTheDocument();
    expect(screen.getByText("Diagramme richtig gestalten")).toBeInTheDocument();
  });
});
