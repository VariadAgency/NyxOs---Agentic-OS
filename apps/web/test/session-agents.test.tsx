// Agents in the session chat — grouping (active · done in this run · archive per run), bar at the bottom of the chat,
// popup with ticking elapsed time, detail with steps, full-screen suggestion, English texts. Sample data only here.
import { setLang, type LiveAgent, type SessionAgentLiveDetail, type SessionAgentsLiveResponse } from "@nyxos/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionAgentsBar } from "../src/features/session-agents/SessionAgentsBar";
import { SessionAgentsPage } from "../src/features/session-agents/SessionAgentsPage";
import { barSummary, formatCostUsd, formatTokensShort, groupAgents, runLabel } from "../src/features/session-agents/model";
import { useLiveSocket } from "../src/hooks/useLiveSocket";
import { emitLiveTick, subscribeLiveTick } from "../src/lib/liveBus";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLang("de");
});

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function agent(over: Partial<LiveAgent> & Pick<LiveAgent, "id">): LiveAgent {
  return {
    tool: "claude",
    name: `Agent ${over.id}`,
    type: "general-purpose",
    task: `Auftrag ${over.id}`,
    status: "done",
    startedAt: iso(T0 - 5 * 60_000),
    lastActivityAt: iso(T0 - 60_000),
    endedAt: iso(T0 - 60_000),
    toolCalls: 3,
    tokens: { input: 10, output: 20, cacheRead: 45_000, cacheCreation: 200, total: 45_230 },
    model: "claude-opus-5-5",
    costUsd: 0.42,
    lastAction: { kind: "tool", tool: "Read", label: "/x.ts", ts: iso(T0 - 60_000) },
    verdict: null,
    runId: "r2",
    hidden: false,
    sessionKey: null,
    ...over,
  };
}

const RUNS = [
  { id: "r2", startedAt: iso(T0 - 10 * 60_000), prompt: "Baue Paket A", current: true },
  { id: "r1", startedAt: iso(T0 - 60 * 60_000), prompt: "Prüfe Paket Z", current: false },
];

function data(agents: LiveAgent[]): SessionAgentsLiveResponse {
  return { agents, runs: RUNS, currentRunId: "r2", childKeys: [], now: iso(T0) };
}

describe("session agents: Gruppierung", () => {
  it("aktiv (egal welcher Lauf) · fertig in diesem Lauf · Archiv nach Lauf, Ausgeblendete nur auf Wunsch", () => {
    const d = data([
      agent({ id: "run", status: "running", endedAt: null }),
      agent({ id: "oldrun", status: "running", endedAt: null, runId: "r1" }),
      agent({ id: "fin", status: "done" }),
      agent({ id: "arch", runId: "r1" }),
      agent({ id: "gone", runId: "r1", hidden: true }),
      agent({ id: "hiddenNow", hidden: true }),
    ]);
    const g = groupAgents(d, false);
    expect(g.active.map((a) => a.id).sort()).toEqual(["oldrun", "run"]);
    // Hiding only works in the archive — in the current run the agent stays.
    expect(g.finished.map((a) => a.id).sort()).toEqual(["fin", "hiddenNow"]);
    expect(g.archive.map((x) => [x.run.id, x.agents.map((a) => a.id)])).toEqual([["r1", ["arch"]]]);
    expect(g.hiddenCount).toBe(1);
    expect(groupAgents(d, true).archive[0]?.agents.map((a) => a.id)).toEqual(["arch", "gone"]);
  });

  it("Tokens kurz, Kosten nur mit Preis", () => {
    expect(formatTokensShort(850)).toBe("850");
    expect(formatTokensShort(45_230)).toBe("45,2k");
    expect(formatTokensShort(1_234_567)).toBe("1,23 Mio.");
    expect(formatCostUsd(0.4234)).toBe("0,42\u00a0$");
    expect(formatCostUsd(0.004)).toBe("< 0,01\u00a0$");
    expect(formatCostUsd(null)).toBeNull();
  });

  it("English: numbers, cost, bar text and run label in the chosen language", () => {
    setLang("en");
    expect(formatTokensShort(45_230)).toBe("45.2k");
    expect(formatTokensShort(1_234_567)).toBe("1.23M");
    expect(formatCostUsd(0.4234)).toBe("$0.42");
    expect(formatCostUsd(0.004)).toBe("< $0.01");
    const g = groupAgents(data([agent({ id: "a", status: "running", endedAt: null }), agent({ id: "b", status: "running", endedAt: null }), agent({ id: "c" })]), false);
    expect(barSummary(g)).toBe("2 agents active · 1 done");
    expect(barSummary(groupAgents(data([agent({ id: "x", runId: "r1" })]), false))).toBe("1 agent from earlier runs");
    expect(runLabel({ id: "r", startedAt: null, prompt: null, current: false }, T0)).toBe("Before the first message");
    expect(runLabel(RUNS[0] ?? { id: "", startedAt: null, prompt: null, current: false }, T0)).toMatch(/^Run at \d{2}:\d{2}/);
  });
});

function stubFetch(live: () => SessionAgentsLiveResponse, detail?: SessionAgentLiveDetail) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/agents-live/")) return detail ? jsonResponse(detail) : jsonResponse({ error: "x" }, { status: 404 });
    if (url.includes("/agents-live")) return jsonResponse(live());
    if (url.includes("/transcript")) return jsonResponse({ items: [{ id: "t1", ts: iso(T0), role: "assistant", text: "Ich prüfe die Leiste.", thinking: false }], nextCursor: null, prevCursor: null, archivedAt: iso(T0), sha256: null });
    return Promise.reject(new Error(`unerwartete URL ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const SESSION = { id: "claude:p1", art: "entwicklung", baustelle: null } as const;

function renderBar() {
  return renderWithClient(
    <MemoryRouter>
      <SessionAgentsBar session={SESSION} />
    </MemoryRouter>,
  );
}

describe("session agents: Leiste im Chat", () => {
  it("zeigt nichts, wenn alle Agenten im Archiv ausgeblendet sind", async () => {
    const f = stubFetch(() => data([agent({ id: "arch", runId: "r1", hidden: true })]));
    const { container } = renderBar();
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("zeigt nichts, solange die Session keine Agenten hat", async () => {
    const f = stubFetch(() => data([]));
    const { container } = renderBar();
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("„2 aktiv · 1 fertig“ → Popup mit tickender Laufzeit, Tokens und Kosten daneben", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: T0 });
    stubFetch(() => data([agent({ id: "run", status: "running", endedAt: null, startedAt: iso(T0 - 65_000) }), agent({ id: "run2", status: "running", endedAt: null }), agent({ id: "fin" })]));
    renderBar();
    const bar = await screen.findByRole("button", { name: /2 Agenten aktiv · 1 fertig/ });
    expect(bar).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(bar);
    const dialog = await screen.findByRole("dialog", { name: "Agenten dieser Session" });
    const row = within(dialog).getByTestId("agent-row-run");
    expect(row).toHaveTextContent("Agent run");
    expect(row).toHaveTextContent("45,2k");
    expect(row).toHaveTextContent("0,42 $");
    expect(within(row).getByTestId("agent-elapsed")).toHaveTextContent("1:05");
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(within(row).getByTestId("agent-elapsed")).toHaveTextContent("1:07");
    expect(within(dialog).getByRole("heading", { name: /Fertig in diesem Lauf/ })).toBeInTheDocument();
    // Esc closes, focus back on the bar
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bar).toHaveFocus();
  });

  it("lädt bei einem Live-Signal dieser Session neu (neuer Agent erscheint)", async () => {
    let agents = [agent({ id: "a", status: "running", endedAt: null })];
    stubFetch(() => data(agents));
    renderBar();
    await screen.findByRole("button", { name: /1 Agent aktiv/ });
    agents = [...agents, agent({ id: "b", status: "running", endedAt: null })];
    act(() => emitLiveTick(new Set(["claude:p1"])));
    await screen.findByRole("button", { name: /2 Agenten aktiv/ });
  });

  it("nur Archiv: ruhiger Einstieg, Reiter Archiv gruppiert nach Lauf", async () => {
    stubFetch(() => data([agent({ id: "arch", runId: "r1" })]));
    renderBar();
    fireEvent.click(await screen.findByRole("button", { name: /1 Agent aus früheren Läufen/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("tab", { name: /Archiv/ }));
    expect(within(dialog).getByText(/Prüfe Paket Z/)).toBeInTheDocument();
    expect(within(dialog).getByTestId("agent-row-arch")).toBeInTheDocument();
  });

  it("ab 6 aktiven Agenten schlägt das Popup das Vollbild vor", async () => {
    stubFetch(() => data(Array.from({ length: 6 }, (_, i) => agent({ id: `r${i}`, status: "running", endedAt: null }))));
    renderBar();
    fireEvent.click(await screen.findByRole("button", { name: /6 Agenten aktiv/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("fullscreen-hint")).toHaveTextContent("6 Agenten");
    expect(within(dialog).getAllByRole("link", { name: /Vollbild/ })[0]).toHaveAttribute("href", "/sessions/entwicklung/_/claude%3Ap1/agenten");
  });

  it("Klick auf einen Agenten → was er gerade macht (aktueller Schritt markiert) und sein Chat", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: T0 });
    const run = agent({ id: "run", status: "running", endedAt: null });
    stubFetch(() => data([run]), {
      agent: run,
      steps: [
        { id: "s1", ts: iso(T0 - 50_000), kind: "tool", tool: "Read", label: "/x.ts", status: "ok", current: false },
        { id: "s2", ts: iso(T0 - 10_000), kind: "tool", tool: "Bash", label: "pnpm test", status: "open", current: true },
      ],
      prompt: "Baue die Leiste\n\nMit Details.",
      result: null,
      hasTranscript: true,
      archived: false,
      task: null,
    });
    renderBar();
    fireEvent.click(await screen.findByRole("button", { name: /1 Agent aktiv/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByTestId("agent-row-run"));
    const detail = await screen.findByTestId("agent-detail-live");
    const current = within(detail).getByTestId("agent-step-current");
    expect(current).toHaveTextContent("Bash");
    expect(current).toHaveTextContent("pnpm test");
    expect(detail).toHaveTextContent("Baue die Leiste");
    fireEvent.click(within(detail).getByRole("button", { name: /Verlauf anzeigen/ }));
    expect(await within(detail).findByText("Ich prüfe die Leiste.")).toBeInTheDocument();
    // Running agents can't be stopped one by one — it says so honestly, no button.
    expect(within(detail).queryByRole("button", { name: /Stopp/ })).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: /Alle Agenten/ }));
    expect(await screen.findByTestId("agent-row-run")).toBeInTheDocument();
  });
});

describe("session agents: Live-Signal einer Kind-Session", () => {
  it("ein Signal eines (neuen) Codex-Teamkollegen weckt auch die Eltern-Session", async () => {
    const sockets: { onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null }[] = [];
    class FakeWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    const seen: (string[] | null)[] = [];
    const off = subscribeLiveTick((ids) => seen.push(ids ? [...ids] : null));
    renderHook(() => useLiveSocket(), { wrapper: ({ children }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider> });
    act(() => sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "session", session: { id: "codex:kind", parentId: "codex:eltern" } }) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    off();
    expect(seen.at(-1)?.sort()).toEqual(["codex:eltern", "codex:kind"]);
  });
});

describe("session agents: Vollbild-Route", () => {
  it("/…/agenten zeigt die Liste, Klick → /agenten/:agentId, „Zurück zum Chat“ führt in die Session", async () => {
    const run = agent({ id: "run", status: "running", endedAt: null });
    stubFetch(() => data([run, agent({ id: "fin" })]), { agent: run, steps: [], prompt: "Baue", result: null, hasTranscript: false, archived: false, task: null });
    function Where() {
      return <span data-testid="where">{useLocation().pathname}</span>;
    }
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/entwicklung/_/claude%3Ap1/agenten"]}>
        <Routes>
          <Route path="/sessions/:art/:baustelle/:id/agenten" element={<SessionAgentsPage />} />
          <Route path="/sessions/:art/:baustelle/:id/agenten/:agentId" element={<SessionAgentsPage />} />
          <Route path="*" element={null} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Agenten", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Zurück zum Chat/ })).toHaveAttribute("href", "/sessions/entwicklung/_/claude%3Ap1");
    fireEvent.click(await screen.findByTestId("agent-row-run"));
    expect(await screen.findByTestId("agent-detail-live")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/entwicklung/_/claude%3Ap1/agenten/run");
    fireEvent.click(screen.getByRole("button", { name: /Alle Agenten/ }));
    await vi.waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/\/agenten$/));
  });
});
