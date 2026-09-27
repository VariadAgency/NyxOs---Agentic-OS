import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SESSION = {
  id: "claude:abc123",
  tool: "claude" as const,
  sessionId: "abc123",
  machineId: null,
  parentId: null,
  title: "Testsession im Archiv",
  titleSource: null,
  status: "running" as const,
  cwd: null,
  gitBranch: null,
  cliVersion: null,
  startedAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  endedAt: null,
  models: [],
  tokens: {},
  tokensTotal: 0,
  toolCalls: {},
  subagents: [],
  limits: null,
  parsedEventCount: 0,
  eventCount: 3,
  parseErrors: 0,
  state: "running" as const,
  closedAt: null,
  closedBy: null,
  categoryRuleId: null,
  categoryManual: false,
  art: "coding",
  baustelle: null,
  reason: [],
};

function setupFetch() {
  return stubFetchRoutes({
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    sessions: () => jsonResponse({ sessions: [SESSION] }),
  });
}

describe("Befehlspalette ⌘K", () => {
  it("öffnet mit ⌘K und springt zu einer Session", async () => {
    setupFetch();
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByPlaceholderText(/Suche alles/)).toBeInTheDocument();

    const item = await within(dialog).findByText("Testsession im Archiv");
    await user.click(item);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const crumbs = await screen.findByRole("navigation", { name: "Brotkrümel" });
    expect(within(crumbs).getByText("Coding")).toBeInTheDocument();
    // der Brotkrümel nennt die Session beim Namen (`sessionLabel`), nie die Kennung – solange die
    // Einzelansicht lädt (hier nicht gestubbt), steht schlicht „Session“.
    expect(within(crumbs).getByText("Session")).toBeInTheDocument();
    expect(crumbs.textContent).not.toContain("claude:abc123");
  });

  it("öffnet auch mit Strg+K", async () => {
    setupFetch();
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions"]}>
        <App />
      </MemoryRouter>,
    );

    await user.keyboard("{Control>}k{/Control}");

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
