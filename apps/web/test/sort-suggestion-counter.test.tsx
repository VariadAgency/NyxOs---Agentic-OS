// Sortier-Vorschläge sind Kleinkram. Der farbige Zähler an „Entscheidungen“ und in
// der Nyx-Leiste zählt nur `openQuestions.total`; die Sortier-Vorschläge stehen als kleiner grauer Zusatz „+2“
// daneben – nur wenn es welche gibt.
import { screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { InboxNavBadge } from "../src/features/inbox/InboxNavBadge";
import { COMPANION_KEY } from "../src/features/nyx/companionSettings";
import { renderWithClient } from "./helpers";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const STATUS = {
  settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
  engine: { kind: "claude-cli", state: "ready", available: true, reason: null, model: "haiku" },
  reserve: { configured: false, baseUrl: null, model: null },
  today: { day: "2026-09-25", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, budgetUsd: 2 },
  queue: { running: 0, waiting: 0 },
  lastRundgang: null,
};

function stub(q: { total: number; sorting: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/status") return json({ signedIn: true, csrf: "x" });
      if (url === "/api/haiku/status") return json(STATUS);
      if (url === "/api/haiku/threads") return json({ threads: [] });
      if (url === "/api/open-questions") return json({ approvals: 0, inbox: q.total, conflicts: 0, sorting: q.sorting, total: q.total });
      return new Response("{}", { status: 404 });
    }),
  );
}

beforeEach(() => localStorage.setItem(COMPANION_KEY, JSON.stringify({ listening: false, speak: false })));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("Seitenleiste „Entscheidungen“", () => {
  it("farbig nur die echten Fragen, Sortier-Vorschläge als grauer Zusatz", async () => {
    stub({ total: 1, sorting: 2 });
    renderWithClient(<InboxNavBadge />);
    expect(await screen.findByLabelText("1 offen")).toHaveTextContent(/^1$/);
    const extra = await screen.findByLabelText("2 Sortier-Vorschläge");
    expect(extra).toHaveTextContent("+2");
    expect(extra.className).toContain("text-a-mut");
  });

  it("nur Sortier-Vorschläge: kein farbiger Zähler, nur „+2“ in Grau", async () => {
    stub({ total: 0, sorting: 2 });
    renderWithClient(<InboxNavBadge />);
    expect(await screen.findByLabelText("2 Sortier-Vorschläge")).toHaveTextContent("+2");
    expect(screen.queryByLabelText(/offen$/)).toBeNull();
  });

  it("ein Vorschlag heißt „1 Sortier-Vorschlag“; ohne Vorschläge kein Zusatz", async () => {
    stub({ total: 3, sorting: 1 });
    const { unmount } = renderWithClient(<InboxNavBadge />);
    expect(await screen.findByLabelText("1 Sortier-Vorschlag")).toHaveTextContent("+1");
    unmount();
    stub({ total: 3, sorting: 0 });
    renderWithClient(<InboxNavBadge />);
    expect(await screen.findByLabelText("3 offen")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Sortier-Vorschl/)).toBeNull();
  });
});

describe("Nyx-Leiste", () => {
  const renderBar = () =>
    renderWithClient(
      <MemoryRouter initialEntries={["/overview"]}>
        <HaikuRoot />
      </MemoryRouter>,
    );

  it("farbiger Zähler = offene Fragen, daneben grau „+2“ für Sortier-Vorschläge", async () => {
    stub({ total: 1, sorting: 2 });
    renderBar();
    await waitFor(() => expect(screen.getByTestId("nyx-bar-badge")).toHaveTextContent(/^1$/));
    const extra = screen.getByTestId("nyx-bar-sorting");
    expect(extra).toHaveTextContent("+2");
    expect(extra.className).toContain("text-a-mut");
    expect(screen.getByRole("button", { name: /^Nyx öffnen/ })).toHaveAccessibleName(expect.stringContaining("1 offen, 2 Sortier-Vorschläge"));
  });

  it("nur Sortier-Vorschläge: kein farbiger Zähler in der Leiste", async () => {
    stub({ total: 0, sorting: 2 });
    renderBar();
    await waitFor(() => expect(screen.getByTestId("nyx-bar-sorting")).toHaveTextContent("+2"));
    expect(screen.queryByTestId("nyx-bar-badge")).toBeNull();
  });
});
