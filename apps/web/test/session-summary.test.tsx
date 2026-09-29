// „Nyx fasst zusammen“ – Knopf in den Session-Infos (und als Symbol im Kopf) → Nyx schreibt eine ausführliche
// Zusammenfassung, die als aufklappbare Karte oben im Chat bleibt (Vorlesen, Kopieren, Zeitpunkt). Neue Nachrichten
// seitdem → Hinweis + „Neu erstellen“. Fehler → ehrlicher Satz in der Karte.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { __resetPendingForTests } from "../src/features/session-chat/pending";
import type { Session } from "../src/lib/api";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

const NOW = Date.now();
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function makeSession(): Session {
  return {
    id: "claude:sum",
    tool: "claude",
    sessionId: "sum",
    machineId: null,
    parentId: null,
    title: "Zusammenfassung bauen",
    titleSource: null,
    status: "running",
    cwd: "/Users/alex/projekt",
    gitBranch: null,
    cliVersion: null,
    startedAt: iso(60),
    lastActivityAt: iso(1),
    endedAt: null,
    models: ["claude-opus-5-5"],
    lastUsageModel: "claude-opus-5-5",
    tokens: {},
    tokensTotal: 1000,
    toolCalls: { Bash: 3 },
    subagents: [],
    limits: null,
    parsedEventCount: 10,
    eventCount: 10,
    parseErrors: 0,
    state: "waiting",
    closedAt: null,
    closedBy: null,
    categoryRuleId: null,
    categoryManual: false,
    art: "coding",
    baustelle: null,
    reason: [],
    attachable: true,
    tmuxName: "zc-claude-sum",
    contextPct: 30,
    contextWindow: 1_000_000,
    contextWindowSource: "model",
  };
}

const MD = "## Ziel der Session\nAlex wollte eine Zusammenfassung.\n## Was erledigt wurde\n- Route gebaut\n## Nächster sinnvoller Schritt\nIm Browser prüfen.";
const ENGINE = { ready: true, state: "ready", reason: null };
const base = { id: 1, sessionKey: "claude:sum", error: null, messagesCovered: 2, coveredUntil: iso(5), itemsRead: 2, itemsTotal: 2, dropped: 0, createdAt: iso(0) };
const done = (over: Record<string, unknown> = {}) => ({ ...base, status: "done", text: MD, finishedAt: iso(0), ...over });
const running = (text = "") => ({ ...base, status: "running", text, finishedAt: null });

interface Opts {
  summary: () => Record<string, unknown>;
  onPost?: (url: string) => Promise<Response> | undefined;
}

function setup(o: Opts) {
  const session = makeSession();
  const items = [
    { id: "m1", ts: iso(5), role: "user", text: "Hallo Claude", thinking: false },
    { id: "m2", ts: iso(5), role: "assistant", text: "Hallo Alex", thinking: false },
  ];
  const fetchMock = stubFetchRoutes({
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    sessions: () => jsonResponse({ sessions: [session] }),
    categories: () => jsonResponse({ categories: [{ art: "coding", count: 1, baustellen: [{ slug: null, label: "Ohne Baustelle", count: 1 }] }] }),
    fallback: (url, init) => {
      if (init?.method === "POST") {
        const r = o.onPost?.(url);
        if (r) return r;
      }
      if (url.includes("/transcript")) return jsonResponse({ items, nextCursor: null, prevCursor: null, archivedAt: null, sha256: "a" });
      if (url.endsWith("/chat")) return jsonResponse({ canSend: true, reason: null, message: null, busy: false });
      if (url.endsWith("/audits")) return jsonResponse({ engine: ENGINE, audits: [] });
      if (url.endsWith("/summary")) return jsonResponse(o.summary());
      if (/\/api\/sessions\/[^/?]+(?:\?|$)/.test(url)) return jsonResponse({ session, files: [], archive: [], events: [] });
      return undefined;
    },
  });
  const inner = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/context-guard/sessions/")) return jsonResponse({ sessionKey: session.id, thresholds: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80, source: "default" }, pct: 30, hint: false, forced: false, attachable: true, state: session.state });
    if (url.startsWith("/api/terminal/status")) return jsonResponse({ online: true, machineId: "m1", since: iso(10) });
    return (inner as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>)(input, init);
  });
  renderWithClient(
    <MemoryRouter initialEntries={[`/sessions/coding/_/${session.id}`]}>
      <App />
    </MemoryRouter>,
  );
  return { fetchMock };
}

beforeEach(() => {
  __resetPendingForTests();
  try {
    localStorage.clear();
  } catch {
    // kein Speicher
  }
});
afterEach(() => vi.unstubAllGlobals());

describe("Nyx fasst zusammen", { timeout: 20_000 }, () => {
  it("Knopf in den Session-Infos → Karte oben im Chat: erst „schreibt“, dann gegliederter Text mit Vorlesen/Kopieren", async () => {
    let state: Record<string, unknown> | null = null;
    const posts: string[] = [];
    setup({
      summary: () => ({ engine: ENGINE, summary: state, newMessages: 0 }),
      onPost: (url) => {
        if (!url.endsWith("/summary")) return undefined;
        posts.push(url);
        state = running("## Ziel der Session\nAlex woll");
        return jsonResponse(state, { status: 202 });
      },
    });
    const info = await screen.findByTestId("session-info");
    expect(screen.queryByTestId("session-summary")).not.toBeInTheDocument();
    await userEvent.click(within(info).getByRole("button", { name: /Nyx fasst zusammen/ }));
    await waitFor(() => expect(posts).toEqual(["/api/sessions/claude%3Asum/summary"]));
    const card = await screen.findByTestId("session-summary");
    // Die Karte steht im Chat (nicht in der Seitenleiste) – oben über dem Verlauf.
    expect(screen.getByTestId("session-main")).toContainElement(card);
    expect(card).toHaveTextContent(/Nyx schreibt/);
    state = done();
    await waitFor(() => expect(screen.getByTestId("session-summary")).toHaveTextContent("Alex wollte eine Zusammenfassung."), { timeout: 6000 });
    const c = screen.getByTestId("session-summary");
    expect(within(c).getByRole("heading", { name: "Ziel der Session" })).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: /vorlesen/i })).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: /Kopieren/ })).toBeInTheDocument();
    // Zuklappen und wieder auf – die Karte bleibt (schließt sich nicht von selbst).
    await userEvent.click(within(c).getByRole("button", { name: /Zusammenfassung zuklappen/ }));
    expect(screen.getByTestId("session-summary")).not.toHaveTextContent("Alex wollte eine Zusammenfassung.");
    await userEvent.click(within(screen.getByTestId("session-summary")).getByRole("button", { name: /Zusammenfassung aufklappen/ }));
    expect(screen.getByTestId("session-summary")).toHaveTextContent("Alex wollte eine Zusammenfassung.");
  }, 20_000);

  it("neue Nachrichten seit der Zusammenfassung → Hinweis und „Neu erstellen“ startet einen neuen Lauf", async () => {
    let state: Record<string, unknown> = done();
    let fresh = 3;
    const posts: string[] = [];
    setup({
      summary: () => ({ engine: ENGINE, summary: state, newMessages: fresh }),
      onPost: (url) => {
        if (!url.endsWith("/summary")) return undefined;
        posts.push(url);
        state = running();
        fresh = 0;
        return jsonResponse(state, { status: 202 });
      },
    });
    const card = await screen.findByTestId("session-summary");
    await waitFor(() => expect(card).toHaveTextContent("3 neue Nachrichten seit der Zusammenfassung"));
    await userEvent.click(within(card).getByRole("button", { name: /Neu erstellen/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("session-summary")).toHaveTextContent(/Nyx schreibt/));
  });

  it("Nyx nicht bereit → ehrlicher Satz in der Karte statt stiller Fehler", async () => {
    setup({
      summary: () => ({ engine: ENGINE, summary: null, newMessages: 0 }),
      onPost: (url) => (url.endsWith("/summary") ? jsonResponse({ error: "Tages-Budget erreicht (0.50 von 0.50 USD)." }, { status: 409 }) : undefined),
    });
    const info = await screen.findByTestId("session-info");
    await userEvent.click(within(info).getByRole("button", { name: /Nyx fasst zusammen/ }));
    const card = await screen.findByTestId("session-summary");
    await waitFor(() => expect(card).toHaveTextContent("Tages-Budget erreicht"));
  });

  it("Symbol-Knopf im Kopf startet ebenfalls", async () => {
    const posts: string[] = [];
    setup({
      summary: () => ({ engine: ENGINE, summary: null, newMessages: 0 }),
      onPost: (url) => {
        if (!url.endsWith("/summary")) return undefined;
        posts.push(url);
        return jsonResponse(running(), { status: 202 });
      },
    });
    const head = await screen.findByTestId("session-head");
    await userEvent.click(within(head).getByRole("button", { name: /Nyx fasst zusammen/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });
});
