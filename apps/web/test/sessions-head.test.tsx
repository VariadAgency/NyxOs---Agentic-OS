// Sessions-Seitenkopf (eine Kopfzeile, Brotkrümel, Aktiv-Stil) + Filter Claude/Codex + „Zuletzt geöffnet“.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { Breadcrumbs } from "../src/components/Breadcrumbs";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import type { Session } from "../src/lib/api";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "claude:default",
    tool: "claude",
    sessionId: "default",
    machineId: null,
    parentId: null,
    title: "Titel",
    titleSource: null,
    status: "running",
    cwd: "/Users/alex/code/NyxOS",
    gitBranch: null,
    cliVersion: null,
    startedAt: minutesAgo(30),
    lastActivityAt: minutesAgo(2),
    endedAt: null,
    models: ["Sonnet 5"],
    tokens: {},
    tokensTotal: 12000,
    toolCalls: {},
    subagents: [],
    limits: null,
    parsedEventCount: 10,
    eventCount: 10,
    parseErrors: 0,
    state: "running",
    closedAt: null,
    closedBy: null,
    categoryRuleId: null,
    categoryManual: false,
    art: "coding",
    baustelle: { slug: "nyxos", label: "NyxOS" },
    reason: [],
    contextPct: null,
    contextWindow: null,
    contextWindowSource: null,
    ...overrides,
  };
}

const S_CLAUDE = makeSession({ id: "claude:a", sessionId: "a", title: "Claude-Arbeit", state: "waiting" });
const S_CODEX = makeSession({ id: "codex:b", sessionId: "b", tool: "codex", title: "Codex-Arbeit", baustelle: { slug: "atlas", label: "Atlas" } });

const CATEGORIES_ALL = [
  { art: "coding", count: 2, baustellen: [ { slug: "nyxos", label: "NyxOS", count: 1 }, { slug: "atlas", label: "Atlas", count: 1 } ] },
  { art: "audit", count: 3, baustellen: [{ slug: "audit", label: "Audit", count: 3 }] },
];
const CATEGORIES_CODEX = [{ art: "coding", count: 1, baustellen: [{ slug: "atlas", label: "Atlas", count: 1 }] }];

interface Setup {
  fetchMock: ReturnType<typeof stubFetchRoutes>;
  opened: { url: string; body: unknown }[];
}

function setup(opts: { recent?: unknown[]; signedIn?: boolean } = {}): Setup {
  const signedIn = opts.signedIn ?? true;
  const opened: Setup["opened"] = [];
  const fetchMock = stubFetchRoutes({
    sessions: () => jsonResponse({ sessions: [S_CLAUDE, S_CODEX] }),
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    fallback: (url, init) => {
      if (/\/opened$/.test(url) && init?.method === "POST") {
        opened.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        return jsonResponse({ ok: true });
      }
      if (/\/transcript/.test(url)) return jsonResponse({ items: [], nextCursor: null, prevCursor: null, archivedAt: null, sha256: null });
      const detail = /\/api\/sessions\/([^/?]+)(?:\?|$)/.exec(url);
      if (detail) {
        const id = decodeURIComponent(detail[1] ?? "");
        const s = [S_CLAUDE, S_CODEX].find((x) => x.id === id || x.sessionId === id);
        return s ? jsonResponse({ session: s, files: [], archive: [], events: [] }) : undefined;
      }
      return undefined;
    },
  });
  // Kategorien- und Zuletzt-geöffnet-Antworten hängen an der URL (Werkzeug-Filter).
  const base = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/auth/status")) return jsonResponse({ authenticated: signedIn, csrf: signedIn ? "test-csrf" : null, hasPasskey: true, authReads: false });
    if (url.startsWith("/api/categories")) return jsonResponse({ categories: url.includes("tool=codex") ? CATEGORIES_CODEX : CATEGORIES_ALL });
    if (url.startsWith("/api/recent-sessions")) {
      const items = (opts.recent ?? []) as { tool: string }[];
      return jsonResponse({ items: url.includes("tool=codex") ? items.filter((i) => i.tool === "codex") : items });
    }
    return base ? base(input, init) : Promise.reject(new Error("kein Stub"));
  });
  return { fetchMock, opened };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("eine Kopfzeile: Brotkrümel links, Suche/Regeln/Filter/Zuletzt rechts (ohne Vollbild-Knopf)", () => {
  it("alle Bedienelemente stehen in der Kopfleiste – keine eigene Zeile mehr über ART", async () => {
    setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("tablist", { name: "Art der Arbeit" });
    const bar = screen.getByTestId("topbar");
    expect(within(bar).getByRole("navigation", { name: "Brotkrümel" })).toBeInTheDocument();
    expect(within(bar).getByRole("combobox")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /Regeln/ })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Codex" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /Zuletzt geöffnet/ })).toBeInTheDocument();
    // Vollbild nur noch über ⌘K und Taste F – die Kopfleiste ist so nicht mehr übervoll.
    expect(within(bar).queryByRole("button", { name: /Vollbild/ })).toBeNull();
  });

  it("andere Seiten behalten ihre Kopfleiste ohne Sessions-Knöpfe", async () => {
    setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/tasks"]}>
        <App />
      </MemoryRouter>,
    );
    const bar = await screen.findByTestId("topbar");
    expect(within(bar).getByRole("navigation", { name: "Brotkrümel" })).toHaveTextContent("Aufgaben");
    expect(within(bar).queryByRole("button", { name: /Regeln/ })).not.toBeInTheDocument();
  });
});

describe("Brotkrümel ohne leere Stufen", () => {
  it("„_“-Stufen fallen weg, die Art steht mit ihrem Namen da", () => {
    stubFetchRoutes({ fallback: () => jsonResponse({ session: { id: "claude:a", title: "Claude-Arbeit" }, files: [], archive: [], events: [] }) });
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_"]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Brotkrümel" });
    expect(nav).toHaveTextContent("Coding");
    expect(nav).not.toHaveTextContent("–");
  });

  it("/sessions/_/_/:id zeigt nur „Sessions / Titel“", async () => {
    stubFetchRoutes({ fallback: () => jsonResponse({ session: { id: "claude:a", title: "Claude-Arbeit" }, files: [], archive: [], events: [] }) });
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/_/_/claude:a"]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Brotkrümel" });
    expect(await within(nav).findByText("Claude-Arbeit")).toBeInTheDocument();
    expect(nav).not.toHaveTextContent("–");
    expect(nav.textContent).toBe("Sessions/Claude-Arbeit");
  });
});

describe("Filter Claude/Codex wirkt auf Art UND Baustelle", () => {
  it("Codex-Filter holt die Zähler mit ?tool=codex; Art, „Alle“ und Baustellen stimmen", async () => {
    const { fetchMock } = setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_"]}>
        <App />
      </MemoryRouter>,
    );
    const artRow = await screen.findByRole("tablist", { name: "Art der Arbeit" });
    const bauRow = screen.getByRole("tablist", { name: "Baustelle" });
    expect(within(artRow).getByRole("tab", { name: /Coding/ })).toHaveTextContent("2");
    expect(within(bauRow).getByRole("tab", { name: /^Alle/ })).toHaveTextContent("2");

    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("topbar")).getByRole("button", { name: "Codex" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/categories?tool=codex"), undefined));
    await waitFor(() => expect(within(artRow).getByRole("tab", { name: /Coding/ })).toHaveTextContent("1"));
    expect(within(bauRow).getByRole("tab", { name: /^Alle/ })).toHaveTextContent("1");
    expect(within(bauRow).queryByRole("tab", { name: /NyxOS/ })).not.toBeInTheDocument();
    expect(within(bauRow).getByRole("tab", { name: /Atlas/ })).toBeInTheDocument();
    // Leere Art bleibt stehen, aber ausgegraut mit 0.
    const audit = within(artRow).getByRole("tab", { name: /Audit/ });
    expect(audit).toHaveTextContent("0");
    expect(audit).toHaveAttribute("data-empty", "true");
  });

  it("die aktive Baustelle bleibt sichtbar (mit 0), auch wenn der Filter sie leert", async () => {
    setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos?tool=codex"]}>
        <App />
      </MemoryRouter>,
    );
    const bauRow = await screen.findByRole("tablist", { name: "Baustelle" });
    const nyxos = await within(bauRow).findByRole("tab", { name: /NyxOS/ });
    expect(nyxos).toHaveAttribute("aria-selected", "true");
    expect(nyxos).toHaveTextContent("0");
  });

  it("Link ohne Art (/sessions/_/_/:id) springt auf die Art der Session – „Alle“ zeigt dann deren Zahl", async () => {
    setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/_/_/claude:a"]}>
        <App />
      </MemoryRouter>,
    );
    const artRow = await screen.findByRole("tablist", { name: "Art der Arbeit" });
    await waitFor(() => expect(within(artRow).getByRole("tab", { name: /Coding/ })).toHaveAttribute("aria-selected", "true"));
    const bauRow = screen.getByRole("tablist", { name: "Baustelle" });
    expect(within(bauRow).getByRole("tab", { name: /^Alle/ })).toHaveTextContent("2");
    expect(screen.getByRole("navigation", { name: "Brotkrümel" })).not.toHaveTextContent("–");
  });
});

describe("Verschieben und ältere Sessions trotz Filter", () => {
  it("„Verschieben nach …“ bietet trotz Codex-Filter ALLE Baustellen an", async () => {
    setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/codex:b?tool=codex"]}>
        <App />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Verschieben nach/ }));
    const group = screen.getByRole("group", { name: "Verschieben nach" });
    expect(within(group).getByRole("option", { name: "NyxOS" })).toBeInTheDocument();
  });

  it("Session außerhalb der Liste (älter) wird über die Detail-Abfrage einsortiert und gemerkt", async () => {
    const OLD = makeSession({ id: "claude:old", sessionId: "old", title: "Uralte Session", art: "audit", baustelle: null, state: "idle" });
    const { fetchMock, opened } = setup();
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/sessions/claude%3Aold") return jsonResponse({ session: OLD, files: [], archive: [], events: [] });
      return base ? base(input, init) : Promise.reject(new Error("kein Stub"));
    });
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/_/_/claude:old"]}>
        <App />
      </MemoryRouter>,
    );
    const artRow = await screen.findByRole("tablist", { name: "Art der Arbeit" });
    await waitFor(() => expect(within(artRow).getByRole("tab", { name: /Audit/ })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(opened.map((o) => o.url)).toContain("/api/sessions/claude%3Aold/opened"));
  });
});

describe("flacher Aktiv-Stil, eigener Tooltip", () => {
  it("aktive Tabs aller drei Zeilen tragen keinen Schatten", async () => {
    setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos/claude:a"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("tablist", { name: "Sessions" });
    for (const name of ["Art der Arbeit", "Baustelle", "Sessions"]) {
      const row = screen.getByRole("tablist", { name });
      const active = within(row).getAllByRole("tab", { selected: true });
      expect(active).toHaveLength(1);
      expect(active[0]?.className).not.toMatch(/shadow/);
    }
  });

  it("Session-Tab: kein nativer title, der Hinweis erscheint als eigener Tooltip", async () => {
    setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_"]}>
        <App />
      </MemoryRouter>,
    );
    const row = await screen.findByRole("tablist", { name: "Sessions" });
    const tab = within(row).getByRole("tab", { name: /Claude-Arbeit/ });
    expect(tab).not.toHaveAttribute("title");
    const user = userEvent.setup();
    await user.hover(tab);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Claude-Arbeit");
  });
});

describe("Zuletzt geöffnet", () => {
  it("Öffnen einer Session meldet es angemeldet an den Server", async () => {
    const { opened } = setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/claude:a"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(opened.map((o) => o.url)).toContain("/api/sessions/claude%3Aa/opened"));
  });

  it("ohne Anmeldung: kein Server-Aufruf, kein Anmelde-Dialog – still im Browser gemerkt", async () => {
    const { opened } = setup({ signedIn: false });
    __primeAuthForTests(null);
    const loginSpy = vi.fn();
    window.addEventListener("nyxos:login-required", loginSpy);
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/claude:a"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(window.localStorage.getItem("nyxos:recent-opens")).toContain("claude:a"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(opened).toHaveLength(0);
    expect(loginSpy).not.toHaveBeenCalled();
    window.removeEventListener("nyxos:login-required", loginSpy);
  });

  it("Knopf öffnet die Liste in Öffnen-Reihenfolge, filterbar, Klick öffnet die Session", async () => {
    setup({
      recent: [
        { sessionKey: "codex:b", sessionId: "b", tool: "codex", title: "Codex-Arbeit", state: "running", art: "coding", baustelle: { slug: "atlas", label: "Atlas" }, openedAt: minutesAgo(1), openCount: 1, lastActivityAt: minutesAgo(1) },
        { sessionKey: "claude:a", sessionId: "a", tool: "claude", title: "Claude-Arbeit", state: "waiting", art: "coding", baustelle: { slug: "nyxos", label: "NyxOS" }, openedAt: minutesAgo(30), openCount: 3, lastActivityAt: minutesAgo(2) },
      ],
    });
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/audit/_"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("tablist", { name: "Art der Arbeit" });
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("topbar")).getByRole("button", { name: /Zuletzt geöffnet/ }));
    const dialog = await screen.findByRole("dialog", { name: "Zuletzt geöffnet" });
    const items = await within(dialog).findAllByRole("link");
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("Codex-Arbeit"), expect.stringContaining("Claude-Arbeit")]);
    expect(items[1]).toHaveTextContent(/wartet/i);

    await user.click(within(dialog).getByRole("button", { name: "Codex" }));
    await waitFor(() => expect(within(dialog).getAllByRole("link")).toHaveLength(1));

    await user.click(within(dialog).getByRole("link", { name: /Codex-Arbeit/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Zuletzt geöffnet" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Brotkrümel" })).toHaveTextContent("Codex-Arbeit"));
  });
});
