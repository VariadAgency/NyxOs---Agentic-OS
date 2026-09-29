// Reiter "Bezüge" — Eltern-/Kind-Session und Sessions mit gemeinsam geschriebenen Dateien,
// jetzt vom Server (GET /api/sessions/:id/related) statt nur aus der schon geladenen Liste.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { RelatedResponse, Session } from "../src/lib/api";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: overrides.id ?? "claude:default",
    tool: "claude",
    sessionId: overrides.sessionId ?? "default",
    machineId: null,
    parentId: null,
    title: "Titel",
    titleSource: null,
    status: "running",
    cwd: "/Users/alex/code/NyxOS",
    gitBranch: null,
    cliVersion: null,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    endedAt: null,
    models: ["Sonnet 5"],
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
    reason: [{ stage: "folder", detail: "Ordner tools/NyxOS", ruleId: null }],
    contextPct: null,
    contextWindow: null,
    contextWindowSource: null,
    ...overrides,
  };
}

const CURRENT = makeSession({ id: "claude:current", sessionId: "current", title: "Aktuelle Session" });
const PARENT = makeSession({ id: "claude:parent", sessionId: "parent", title: "Vorherige Recherche" });
const BEZUG = makeSession({ id: "claude:bezug", sessionId: "bezug", title: "Teilt Dateien", tool: "codex", art: "audit", baustelle: null });

const CATEGORIES = [{ art: "coding", count: 1, baustellen: [{ slug: "nyxos", label: "NyxOS", count: 1 }] }];

const RELATED: RelatedResponse = {
  parent: PARENT,
  children: [],
  sameFiles: [
    {
      sessionKey: BEZUG.id,
      sessionId: BEZUG.sessionId,
      title: BEZUG.title,
      tool: BEZUG.tool,
      state: BEZUG.state,
      art: BEZUG.art,
      baustelle: BEZUG.baustelle,
      sharedFiles: ["apps/web/src/App.tsx", "apps/server/src/app.ts"],
      sharedCount: 2,
    },
  ],
};

function setupFetch() {
  return stubFetchRoutes({
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    sessions: () => jsonResponse({ sessions: [CURRENT, PARENT, BEZUG] }),
    categories: () => jsonResponse({ categories: CATEGORIES }),
    fallback: (url) => {
      if (url.includes("/related")) return jsonResponse(RELATED);
      if (url.includes("/transcript")) return jsonResponse({ items: [], nextCursor: null, prevCursor: null, archivedAt: null, sha256: null });
      const detailMatch = /\/api\/sessions\/([^/?]+)(?:\?|$)/.exec(url);
      if (detailMatch) return jsonResponse({ session: CURRENT, files: [], archive: [], events: [] });
      return undefined;
    },
  });
}

describe("Bezüge-Reiter", () => {
  it("zeigt Eltern-Session und Sessions mit gemeinsam geschriebenen Dateien, Klick springt zur Session", async () => {
    setupFetch();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos/claude:current"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(/einsortiert wegen/);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Bezüge" }));

    const panel = await screen.findByRole("tabpanel", { name: "Bezüge" });
    expect(await within(panel).findByText("Vorherige Recherche")).toBeInTheDocument();
    expect(await within(panel).findByText("Teilt Dateien")).toBeInTheDocument();
    expect(within(panel).getByText(/2 gemeinsame Dateien/)).toBeInTheDocument();
    expect(within(panel).getByText(/apps\/web\/src\/App\.tsx/)).toBeInTheDocument();

    const bezugLink = within(panel).getByText("Teilt Dateien").closest("a");
    expect(bezugLink).toHaveAttribute("href", "/sessions/audit/_/claude:bezug");

    await user.click(bezugLink as HTMLElement);
    expect(await screen.findByText("Kind-Sessions (0)")).toBeInTheDocument();
  });

  it("zeigt Leerzustand ohne Eltern/Kinder/Bezüge", async () => {
    setupFetch();
    // Überschreibt die Bezüge-Antwort für diesen Test mit einer leeren Antwort.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/health")) return jsonResponse({ ok: true });
        if (url.startsWith("/api/machines")) return jsonResponse([]);
        if (url.startsWith("/api/categories")) return jsonResponse({ categories: CATEGORIES });
        if (url.startsWith("/api/sessions") && url.includes("/related")) return jsonResponse({ parent: null, children: [], sameFiles: [] } satisfies RelatedResponse);
        // neue Bezüge-Listen (erledigt/behoben/offen/vergleichbar) — hier ebenfalls leer.
        if (url.includes("/outcomes")) return jsonResponse({ done: [], fixed: [], open: [], similar: [], stats: { commits: 0, testRuns: 0, agentsFinished: 0, agentsTotal: 0 } });
        if (url.includes("/changes")) return jsonResponse({ files: [], total: 0, query: null });
        if (url.includes("/transcript")) return jsonResponse({ items: [], nextCursor: null, prevCursor: null, archivedAt: null, sha256: null });
        if (/\/api\/sessions\/[^/?]+(?:\?|$)/.test(url)) return jsonResponse({ session: CURRENT, files: [], archive: [], events: [] });
        if (url.startsWith("/api/sessions")) return jsonResponse({ sessions: [CURRENT] });
        return Promise.reject(new Error(`Test hat keine Antwort für ${url} vorgesehen`));
      }),
    );
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos/claude:current"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(/einsortiert wegen/);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Bezüge" }));

    expect(await screen.findByText("Keine — das ist eine Haupt-Session.")).toBeInTheDocument();
    expect(screen.getByText("Kind-Sessions (0)")).toBeInTheDocument();
    expect(screen.getByText(/Keine — diese Session teilt keine geschriebene Datei/)).toBeInTheDocument();
  });
});
