// Agenten als Kacheln — je Agent eine Kachel (Name, Zweck, Modell, Farbe/Icon, wie oft
// und wann zuletzt genutzt, Zustand). Klick → Detail mit Beschreibung, Werkzeugen, formatiertem
// Prompt und den letzten Einsätzen (mit Link zur Eltern-Session).
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, CatalogRow } from "../src/features/agents/api";
import { buildAgentTiles } from "../src/features/agents/agentTileModel";
import { AgentsView } from "../src/features/agents/AgentsView";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-09-25T15:00:00.000Z");
const HOUR = 3_600_000;

function run(over: Partial<AgentRun>): AgentRun {
  return {
    id: "claude:s1:a1",
    tool: "claude",
    parentSessionKey: "claude:s1",
    parentTitle: "Baustelle NyxOS",
    agentName: "Recherche Hermes",
    agentType: "general-purpose",
    startedAt: new Date(NOW - 2 * HOUR).toISOString(),
    endedAt: new Date(NOW - 2 * HOUR + 60_000).toISOString(),
    durationMs: 60_000,
    toolCalls: 12,
    verdict: null,
    running: false,
    ...over,
  };
}

const RUNS: AgentRun[] = [
  run({ id: "r1", agentName: "Recherche Hermes" }),
  run({ id: "r2", agentName: "N13 Aufgaben", running: true, endedAt: null, durationMs: null, startedAt: new Date(NOW - 10 * 60_000).toISOString() }),
  run({ id: "r3", agentName: "scope-warden", agentType: "scope-warden", verdict: "PASS", parentSessionKey: "claude:kamera", parentTitle: "Moments-Kamera P5" }),
  run({ id: "r4", agentName: "scope-warden", agentType: "scope-warden", verdict: "BLOCK", startedAt: new Date(NOW - 20 * 24 * HOUR).toISOString(), endedAt: new Date(NOW - 20 * 24 * HOUR + 1000).toISOString() }),
  run({ id: "r5", tool: "codex", agentName: "Tesla: Die letzte Session …", agentType: null, parentSessionKey: "codex:c1" }),
  run({ id: "r6", tool: "codex", agentName: "Kant: Bevor wir …", agentType: null, parentSessionKey: "codex:c2" }),
];

const CATALOG: CatalogRow[] = [
  {
    kind: "agent",
    name: "scope-warden",
    description: "Scope-Wächter für die Moments-Kamera.",
    path: "/Users/dev/project/.claude/agents/scope-warden.md",
    source: "project",
    seenAt: "2026-09-25T10:00:00.000Z",
    details: { model: "sonnet", tools: ["Read", "Grep", "Glob", "Bash"], color: null, prompt: "Du bewachst die **Grenze** des Auftrags.\n\n## Was du prüfst\n- keine Foto-API\n- kein AR" },
  },
  { kind: "agent", name: "ux-critic", description: "UX-Kritiker.", path: "/x/ux-critic.md", source: "project", seenAt: "2026-09-25T10:00:00.000Z", details: { model: null, tools: [], color: "purple", prompt: "Prüfe Flows." } },
  { kind: "skill", name: "dataviz", description: "Diagramme", path: "/x/dataviz/SKILL.md", source: "user", seenAt: "2026-09-25T10:00:00.000Z" },
];

describe("buildAgentTiles", () => {
  it("fasst Läufe je Agent-Typ zusammen und verbindet sie mit dem Bestand", () => {
    const tiles = buildAgentTiles(RUNS, CATALOG, NOW);
    expect(tiles.map((t) => t.key)).toEqual(["general-purpose", "codex", "scope-warden", "ux-critic"]);
    const gp = tiles[0];
    expect(gp).toMatchObject({ label: "general-purpose", origin: "eingebaut", total: 2, running: 1, state: "laeuft", model: null });
    expect(gp?.description).toMatch(/Allzweck/);
    const sw = tiles[2];
    expect(sw).toMatchObject({ origin: "projekt", total: 2, runs7d: 1, passRate: 50, judged: 2, state: "aktiv", model: "sonnet", tools: ["Read", "Grep", "Glob", "Bash"] });
    expect(tiles[1]).toMatchObject({ label: "Codex-Helfer", origin: "codex", total: 2, color: "var(--a-codex)" });
    // Aus dem Bestand, aber nie gelaufen: trotzdem eine Kachel, Zustand ehrlich.
    expect(tiles[3]).toMatchObject({ total: 0, state: "neu", color: "var(--a-violet)" });
    expect(tiles.some((t) => t.key === "dataviz")).toBe(false); // Skills gehören in den Tab „Skills“
  });

  it("„mit Hinweisen“ zählt als bestanden – nur BLOCK senkt die Quote", () => {
    const runs = [
      run({ id: "p1", agentName: "scope-warden", agentType: "scope-warden", verdict: "PASS_WITH_NOTES" }),
      run({ id: "p2", agentName: "scope-warden", agentType: "scope-warden", verdict: "PASS_WITH_NOTES" }),
      run({ id: "p3", agentName: "scope-warden", agentType: "scope-warden", verdict: "PASS" }),
      run({ id: "p4", agentName: "scope-warden", agentType: "scope-warden", verdict: "BLOCK" }),
    ];
    const sw = buildAgentTiles(runs, CATALOG, NOW).find((t) => t.key === "scope-warden");
    expect(sw).toMatchObject({ judged: 4, passRate: 75 });
  });

  it("jede Kachel ist bunt, nie grau", () => {
    for (const t of buildAgentTiles(RUNS, CATALOG, NOW)) expect(t.color).not.toMatch(/idle|dim|mut|line/);
  });
});

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/agents/runs")) return jsonResponse({ runs: RUNS });
      if (url.startsWith("/api/agents/catalog")) return jsonResponse({ catalog: CATALOG });
      if (url.startsWith("/api/agents/skills/usage")) return jsonResponse({ skills: [] });
      if (url.startsWith("/api/agents/anomalies")) return jsonResponse({ anomalies: [] });
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
}

describe("Agenten-Kacheln (Ansicht)", () => {
  it("zeigt je Agent eine Kachel mit Modell, Nutzung und Zustand", async () => {
    stub();
    renderWithClient(
      <MemoryRouter initialEntries={["/agents"]}>
        <AgentsView />
      </MemoryRouter>,
    );
    const grid = await screen.findByRole("region", { name: "Alle Agenten" });
    const tile = await within(grid).findByRole("button", { name: /scope-warden/ });
    expect(tile).toHaveAttribute("data-agent-tile", "scope-warden");
    expect(tile).toHaveTextContent("Sonnet");
    expect(tile).toHaveTextContent("2×");
    expect(within(grid).getByRole("button", { name: /general-purpose/ })).toHaveTextContent("läuft");
    expect(within(grid).getByRole("button", { name: /ux-critic/ })).toHaveTextContent("unbenutzt");
  });

  it("Klick → Detail mit Werkzeugen, formatiertem Prompt und letzten Einsätzen mit Link", async () => {
    stub();
    renderWithClient(
      <MemoryRouter initialEntries={["/agents"]}>
        <AgentsView />
      </MemoryRouter>,
    );
    const grid = await screen.findByRole("region", { name: "Alle Agenten" });
    fireEvent.click(await within(grid).findByRole("button", { name: /scope-warden/ }));
    const detail = await screen.findByTestId("agent-tile-detail");
    expect(within(detail).getByText("Scope-Wächter für die Moments-Kamera.")).toBeInTheDocument();
    for (const tool of ["Read", "Grep", "Glob", "Bash"]) expect(within(detail).getByText(tool)).toBeInTheDocument();
    // Prompt als formatierter Text (Überschrift, Liste, fett) statt rohem Markdown
    expect(within(detail).getByText("Grenze").tagName).toBe("B");
    expect(within(detail).getByText("keine Foto-API").tagName).toBe("LI");
    const runs = within(detail).getByRole("list", { name: "Letzte Einsätze" });
    expect(within(runs).getAllByRole("listitem")).toHaveLength(2);
    expect(within(runs).getByRole("link", { name: /Moments-Kamera P5/ })).toHaveAttribute("href", "/sessions/_/_/claude%3Akamera");
  });
});
