// Session-Seitenpanels: erst 5 geänderte Dateien + ausklappen, Suche filtert (mit Hervorhebung und
// „x von y"), Klick vergrößert die Agenten-Kachel (Auftrag, Ergebnis, Tokens, Werkzeuge), Bezüge mit „erledigt/behoben/offen/vergleichbar".
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { SessionAgentDetail, SessionAgentsResponse, SessionChangesResponse, SessionOutcomesResponse } from "@nyxos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsPanel } from "../src/components/sessions/AgentsPanel";
import { ChangesPanel } from "../src/components/sessions/ChangesPanel";
import { InfoPanel } from "../src/components/sessions/InfoPanel";
import { RefsPanel } from "../src/components/sessions/RefsPanel";
import type { Session, SessionDetail } from "../src/lib/api";
import { splitPath } from "../src/features/session-panels/FilePath";
import { jsonResponse, renderWithClient } from "./helpers";

vi.mock("../src/features/brain/LocalGraph", () => ({ LocalGraph: () => <div data-testid="local-graph" /> }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const CWD = "/Users/alex/projects/NyxOS";

const SESSION: Session = {
  id: "claude:s1",
  tool: "claude",
  sessionId: "s1",
  machineId: null,
  parentId: null,
  title: "Seitenpanels bauen",
  titleSource: null,
  status: "running",
  cwd: CWD,
  gitBranch: null,
  cliVersion: null,
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastActivityAt: new Date().toISOString(),
  endedAt: null,
  models: ["claude-opus-5-5"],
  tokens: {},
  tokensTotal: 1000,
  toolCalls: {},
  subagents: [],
  limits: null,
  parsedEventCount: 5,
  eventCount: 5,
  parseErrors: 0,
  state: "running",
  closedAt: null,
  closedBy: null,
  categoryRuleId: null,
  categoryManual: false,
  art: "coding",
  baustelle: { slug: "nyxos", label: "NyxOS" },
  reason: [{ stage: "folder", detail: "Ordner projects/NyxOS", ruleId: null }],
  contextPct: null,
  contextWindow: null,
  contextWindowSource: null,
};

const PATHS = Array.from({ length: 8 }, (_, i) => `${CWD}/apps/web/src/features/panel/Datei${i + 1}.tsx`);

const DETAIL: SessionDetail = {
  session: SESSION,
  files: PATHS.map((path) => ({ sessionKey: SESSION.id, path, mode: "write" as const, firstSeenAt: new Date().toISOString() })),
  archive: [],
  events: [],
};

function changesBody(files: string[], total = PATHS.length, query: string | null = null): SessionChangesResponse {
  return {
    total,
    query,
    files: files.map((path, i) => ({
      path,
      edits: i + 1,
      added: 10 + i,
      removed: i,
      lastTs: new Date().toISOString(),
      agentIds: [],
      matchedPath: false,
      contentMatches: query ? 1 : 0,
      snippets: query ? [{ kind: "+", text: `const zaehler = ${i};` }] : [],
    })),
  };
}

type Handler = (url: string) => Promise<Response> | undefined;

function stubFetch(handler: Handler) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      return handler(url) ?? Promise.resolve(new Response("{}", { status: 404 }));
    }),
  );
  return calls;
}

describe("splitPath (Pfade kurz und lesbar)", () => {
  it("kürzt auf Projekt bzw. Worktree, Ordner höchstens zwei Ebenen", () => {
    expect(splitPath(`${CWD}/apps/web/src/lib/api.ts`, CWD)).toEqual({ name: "api.ts", folder: "…/src/lib", worktree: null });
    expect(splitPath(`${CWD}/.claude/worktrees/agent-a0044331e886f968e/apps/server/src/app.ts`, CWD)).toEqual({ name: "app.ts", folder: "…/server/src", worktree: "agent-a0044331e886f968e" });
    expect(splitPath("/Users/alex/work/App/README.md", CWD)).toEqual({ name: "README.md", folder: "…/work/App", worktree: null });
    expect(splitPath(`${CWD}/.worktrees/fix-login/apps/web/src/main.ts`, CWD)).toEqual({ name: "main.ts", folder: "…/web/src", worktree: "fix-login" });
    expect(splitPath(`${CWD}/NOTICE`, CWD)).toEqual({ name: "NOTICE", folder: "", worktree: null });
  });
});

describe("Geänderte Dateien rechts", () => {
  it("zeigt erst 5 Dateien, „Alle 8 zeigen“ klappt aus; Name fett, Ordner gekürzt, voller Pfad im Tooltip, +/−", async () => {
    stubFetch((url) => (url.endsWith("/changes") ? jsonResponse(changesBody(PATHS)) : undefined));
    renderWithClient(
      <MemoryRouter>
        <InfoPanel detail={DETAIL} />
      </MemoryRouter>,
    );
    const box = screen.getByTestId("changed-files");
    await within(box).findByText("+10");
    expect(within(box).getAllByRole("listitem")).toHaveLength(5);
    const first = within(box).getByText("Datei1.tsx");
    expect(first.className).toContain("font-semibold");
    expect(first.closest("[title]")).toHaveAttribute("title", PATHS[0]);
    expect(within(box).getAllByTestId("file-folder")[0]).toHaveTextContent("…/features/panel");
    expect(within(box).getByText("−0")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(box).getByRole("button", { name: /Alle 8 zeigen/ }));
    expect(within(box).getAllByRole("listitem")).toHaveLength(8);
    await user.click(within(box).getByRole("button", { name: "Weniger zeigen" }));
    expect(within(box).getAllByRole("listitem")).toHaveLength(5);
  });

  it("ohne Server-Zahlen: Pfade aus der Session, keine erfundenen Zahlen", async () => {
    stubFetch(() => undefined);
    renderWithClient(
      <MemoryRouter>
        <InfoPanel detail={DETAIL} />
      </MemoryRouter>,
    );
    const box = screen.getByTestId("changed-files");
    expect(within(box).getAllByRole("listitem")).toHaveLength(5);
    expect(within(box).queryByText(/^\+\d/)).toBeNull();
  });
});

describe("Reiter „Änderungen“ durchsuchbar", () => {
  it("Suchfeld filtert (Server-Suche nach Datei und Inhalt), zeigt „x von y“ und hebt Treffer hervor", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/changes?q=zaehler")) return jsonResponse(changesBody([PATHS[2] as string], PATHS.length, "zaehler"));
      if (url.endsWith("/changes")) return jsonResponse(changesBody(PATHS));
      return undefined;
    });
    renderWithClient(
      <MemoryRouter>
        <ChangesPanel detail={DETAIL} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("changes-count")).toHaveTextContent("8 Dateien");
    expect(await screen.findByText("Datei1.tsx")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Änderungen durchsuchen" }), "zaehler");
    await waitFor(() => expect(screen.getByTestId("changes-count")).toHaveTextContent("1 von 8"));
    expect(calls.some((c) => c.endsWith("/changes?q=zaehler"))).toBe(true);
    expect(screen.queryByText("Datei1.tsx")).toBeNull();
    expect(screen.getByText("Datei3.tsx")).toBeInTheDocument();
    const mark = screen.getByText("zaehler", { selector: "mark" });
    expect(mark.parentElement).toHaveTextContent("const zaehler = 0;");
  });

  it("keine Treffer: klare Meldung mit Knopf „Suche leeren“", async () => {
    stubFetch((url) => {
      if (url.includes("?q=")) return jsonResponse({ files: [], total: PATHS.length, query: "gibtsnicht" });
      if (url.endsWith("/changes")) return jsonResponse(changesBody(PATHS));
      return undefined;
    });
    renderWithClient(
      <MemoryRouter>
        <ChangesPanel detail={DETAIL} />
      </MemoryRouter>,
    );
    await screen.findByText("Datei1.tsx");
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "gibtsnicht");
    expect(await screen.findByText(/Nichts gefunden/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Suche leeren" }));
    expect(await screen.findByText("Datei1.tsx")).toBeInTheDocument();
  });
});

const AGENTS: SessionAgentsResponse = {
  agents: [
    {
      id: "a1",
      tool: "claude",
      name: "Parser prüfen",
      type: "general-purpose",
      sessionKey: null,
      model: "claude-sonnet-5",
      startedAt: "2026-09-24T09:00:12.000Z",
      endedAt: "2026-09-24T09:00:30.000Z",
      durationMs: 18_000,
      toolCalls: 3,
      tokens: { input: 120, output: 380, cacheRead: 4450, cacheCreation: 200, total: 5150 },
      filesWritten: 1,
      verdict: "PASS",
      hasTranscript: true,
    },
  ],
};

const AGENT_DETAIL: SessionAgentDetail = {
  ...(AGENTS.agents[0] as SessionAgentDetail),
  prompt: "Prüfe den Parser gründlich.",
  result: "Ergebnis: Parser ist korrekt.",
  tools: [
    { name: "Edit", count: 2 },
    { name: "Read", count: 1 },
  ],
  toolErrors: 0,
  files: [{ path: `${CWD}/packages/shared/src/parse/claude.ts`, edits: 1, added: 3, removed: 1, lastTs: null, agentIds: ["a1"] }],
};

describe("Agenten anklickbar", () => {
  it("Klick vergrößert die Kachel: Auftrag, Ergebnis, Tokens (ein/aus/Cache), Werkzeuge, Dateien", async () => {
    stubFetch((url) => {
      if (url.endsWith("/agents")) return jsonResponse(AGENTS);
      if (url.endsWith("/agents/a1")) return jsonResponse(AGENT_DETAIL);
      return undefined;
    });
    renderWithClient(
      <MemoryRouter>
        <AgentsPanel detail={DETAIL} />
      </MemoryRouter>,
    );
    const tile = await screen.findByTestId("agent-tile");
    expect(within(tile).getByText("Parser prüfen")).toBeInTheDocument();
    // Einheitlich wie überall (formatTokensCompact) — unter 1 Mio. die ganze Zahl.
    expect(within(tile).getByText("5.150")).toBeInTheDocument();
    expect(within(tile).getByText("18 s")).toBeInTheDocument();
    expect(within(tile).getByText("PASS")).toBeInTheDocument();
    expect(tile).not.toHaveAttribute("data-open");

    const user = userEvent.setup();
    await user.click(within(tile).getByRole("button", { name: /Parser prüfen/ }));
    expect(tile).toHaveAttribute("data-open", "true");
    expect(await within(tile).findByTestId("agent-prompt")).toHaveTextContent("Prüfe den Parser gründlich.");
    expect(within(tile).getByTestId("agent-result")).toHaveTextContent("Ergebnis: Parser ist korrekt.");
    const tokens = within(tile).getByTestId("agent-tokens");
    expect(tokens).toHaveTextContent("Eingabe120");
    expect(tokens).toHaveTextContent("Ausgabe380");
    expect(tokens).toHaveTextContent("Cache gelesen4.450");
    expect(tokens).toHaveTextContent("Gesamt5.150");
    expect(within(tile).getByTestId("agent-tools")).toHaveTextContent("Edit2");
    expect(within(tile).getByText("claude.ts")).toBeInTheDocument();

    await user.click(within(tile).getByRole("button", { name: /Parser prüfen/ }));
    expect(tile).not.toHaveAttribute("data-open");
  });
});

const OUTCOMES: SessionOutcomesResponse = {
  done: [
    { id: "todo:1", kind: "todo", title: "Tests schreiben", detail: null, ts: null, confidence: "sicher", why: "In der Aufgabenliste der Session abgehakt", link: null },
    { id: "entry:4", kind: "entry", title: "Panels bauen", detail: null, ts: null, confidence: "sicher", why: "Verknüpfter Eintrag ist erledigt", link: { type: "entry", id: 4 } },
  ],
  fixed: [{ id: "fix-commit:abc", kind: "commit", title: "fix: Zähler zählt doppelt", detail: "abc1234 · main", ts: null, confidence: "wahrscheinlich", why: "Commit-Nachricht nennt eine Fehlerbehebung", link: null }],
  open: [{ id: "todo:2", kind: "todo", title: "Doku nachziehen", detail: null, ts: null, confidence: "sicher", why: "In der Aufgabenliste am Ende noch nicht abgehakt", link: null }],
  similar: [
    {
      sessionKey: "claude:s2",
      sessionId: "s2",
      title: "Zähler reparieren",
      tool: "claude",
      state: "idle",
      art: "coding",
      baustelle: { slug: "nyxos", label: "NyxOS" },
      lastActivityAt: null,
      score: 2.1,
      reasons: ["2 gemeinsame Dateien", "gleiche Baustelle „NyxOS“"],
      sharedFiles: [],
    },
  ],
  stats: { commits: 2, testRuns: 2, agentsFinished: 1, agentsTotal: 1 },
};

describe("Bezüge erweitert", () => {
  it("zeigt Erledigt, Erfolgreich behoben (mit Sicherheit), Offen geblieben, Vergleichbare Sessions — alles klickbar", async () => {
    stubFetch((url) => {
      if (url.endsWith("/related")) return jsonResponse({ parent: null, children: [], sameFiles: [] });
      if (url.endsWith("/outcomes")) return jsonResponse(OUTCOMES);
      return undefined;
    });
    renderWithClient(
      <MemoryRouter>
        <RefsPanel detail={DETAIL} />
      </MemoryRouter>,
    );
    const done = await screen.findByTestId("refs-done");
    expect(within(done).getByText("Erledigt (2)")).toBeInTheDocument();
    expect(within(done).getByText("Panels bauen").closest("a")).toHaveAttribute("href", "/tasks?e=4");
    const fixed = screen.getByTestId("refs-fixed");
    expect(within(fixed).getByText("wahrscheinlich")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(fixed).getByRole("button", { name: /fix: Zähler zählt doppelt/ }));
    expect(within(fixed).getByText(/Commit-Nachricht nennt eine Fehlerbehebung/)).toBeInTheDocument();
    expect(within(screen.getByTestId("refs-open")).getByText("Doku nachziehen")).toBeInTheDocument();
    const similar = screen.getByTestId("refs-similar");
    expect(within(similar).getByText("2 gemeinsame Dateien")).toBeInTheDocument();
    expect(within(similar).getByText("Zähler reparieren").closest("a")).toHaveAttribute("href", "/sessions/coding/nyxos/claude:s2");
    expect(screen.getByTestId("refs-stats")).toHaveTextContent("2 Commits · 2 Testläufe · 1 von 1 Agenten fertig");
  });
});

// „3.874,2 Mio. Tokens zusammen“ → „3,9 Mrd.“ wie überall.
describe("Token-Summe der Agenten im gemeinsamen Format", () => {
  it("zeigt Milliarden als „3,9 Mrd.“, nicht als „3.874,2 Mio.“", async () => {
    const base = AGENTS.agents[0] as SessionAgentsResponse["agents"][number];
    const big = { ...base, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 3_874_200_000 } };
    stubFetch((url) => (url.endsWith("/agents") ? jsonResponse({ agents: [big] }) : undefined));
    renderWithClient(
      <MemoryRouter>
        <AgentsPanel detail={DETAIL} />
      </MemoryRouter>,
    );
    await screen.findByTestId("agent-tile");
    const text = document.body.textContent?.replace(/\u00a0/g, " ") ?? "";
    expect(text).toContain("3,9 Mrd. Tokens zusammen");
    expect(text).not.toContain("Mio.");
  });
});
