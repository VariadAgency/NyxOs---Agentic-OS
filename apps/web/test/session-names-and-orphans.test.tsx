// Lesbare Namen überall, verwaiste Geister-Sessions ruhig statt rot,
// gleiche Sortier-Vorschläge als EINE Karte.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Breadcrumbs } from "../src/components/Breadcrumbs";
import { ChatPanel } from "../src/components/sessions/ChatPanel";
import { SessionCard } from "../src/components/sessions/SessionCard";
import { InboxView } from "../src/features/inbox/InboxView";
import type { Session } from "../src/lib/api";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DAY = 86_400_000;
const GHOST: Session = {
  id: "claude:8dcb7b0e-e737-4168-b084-d6eb5262ec7c",
  tool: "claude",
  sessionId: "8dcb7b0e-e737-4168-b084-d6eb5262ec7c",
  machineId: null,
  parentId: null,
  title: null,
  titleSource: null,
  status: "running",
  cwd: null,
  gitBranch: null,
  cliVersion: null,
  startedAt: new Date(Date.now() - 2 * DAY).toISOString(),
  lastActivityAt: new Date(Date.now() - 2 * DAY).toISOString(),
  endedAt: null,
  models: [],
  tokens: {},
  tokensTotal: 0,
  toolCalls: {},
  subagents: [],
  limits: null,
  parsedEventCount: 0,
  eventCount: 1,
  parseErrors: 0,
  state: "waiting",
  closedAt: null,
  closedBy: null,
  categoryRuleId: null,
  categoryManual: false,
  art: "coding",
  baustelle: null,
  reason: [],
  contextPct: null,
  contextWindow: null,
  contextWindowSource: null,
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}/;

describe("Brotkrümel", () => {
  it("zeigt nie eine UUID – auch bei einer Session ohne Titel", async () => {
    const session = {
      ...GHOST,
      baustelle: { slug: "nyxos", label: "NyxOS" },
    };
    stubFetchRoutes({
      fallback: (url) => (url.includes("/api/sessions/") ? jsonResponse({ session, files: [], archive: [], events: [] }) : undefined),
    });
    renderWithClient(
      <MemoryRouter initialEntries={[`/sessions/coding/_/${GHOST.sessionId}`]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("crumb-title")).toHaveTextContent(/^NyxOS · Session vom/));
    expect(screen.getByRole("navigation", { name: "Brotkrümel" }).textContent).not.toMatch(UUID);
  });

  it("solange der Name lädt, steht „Session“ statt der Kennung", () => {
    stubFetchRoutes({ fallback: () => new Promise<Response>(() => undefined) });
    renderWithClient(
      <MemoryRouter initialEntries={[`/sessions/coding/_/${GHOST.sessionId}`]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("crumb-title").textContent).not.toMatch(UUID);
  });
});

describe("Session-Karte", () => {
  it("Geister-Session: ruhig „verwaist“ statt „wartet auf dich“, Name statt Platzhalter", () => {
    renderWithClient(<SessionCard session={GHOST} subagentCount={0} onOpen={() => undefined} />);
    expect(screen.getByText("verwaist")).toBeInTheDocument();
    expect(screen.queryByText("wartet auf dich")).not.toBeInTheDocument();
    expect(screen.queryByText("(noch ohne Titel)")).not.toBeInTheDocument();
    expect(screen.getByText(/^Session vom /)).toBeInTheDocument();
  });

  it("die Karte darf schrumpfen (390 px): min-w-0", () => {
    renderWithClient(<SessionCard session={{ ...GHOST, title: "Ein sehr langer Titel ".repeat(8) }} subagentCount={0} onOpen={() => undefined} />);
    expect(screen.getByRole("button").className).toContain("min-w-0");
  });
});

describe("Chat einer Session ohne Verlauf", () => {
  it("404 ist kein roter Fehler; bei einer verwaisten Session ein ruhiger Hinweis mit „Schließen“", async () => {
    stubFetchRoutes({
      fallback: (url) => {
        if (url.includes("/transcript")) return jsonResponse({ error: "Nicht gefunden" }, { status: 404 });
        if (url.includes("/api/sessions/"))
          return jsonResponse({
            session: GHOST,
            files: [],
            archive: [],
            events: [],
          });
        return undefined;
      },
    });
    renderWithClient(
      <MemoryRouter>
        <ChatPanel sessionId={GHOST.id} at={null} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Diese Session hat noch nichts geschrieben.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schließen" })).toBeInTheDocument();
    expect(screen.queryByText("Chat konnte nicht geladen werden.")).not.toBeInTheDocument();
  });
});

describe("Entscheidungen: Sortier-Vorschläge gebündelt", () => {
  const sortItem = (id: number, sessionKey: string) => ({
    id,
    kind: "frage",
    title: "Sortier-Vorschlag von Haiku: „Wie steht der Build?“ → Server & Deploy?",
    body: "Vorschlag von Haiku (nicht aus Regeln): Statusabfrage\nBei „Ja“ wird nur diese Session zugeordnet, keine Regel.",
    options: [
      { id: "ja", label: "Ja" },
      { id: "nein", label: "Nein" },
    ],
    status: "open",
    answer: null,
    sessionKey,
    entryId: null,
    baustelle: null,
    decisionFile: null,
    sources: [],
    createdBy: "haiku",
    estimateMinutes: 1,
    yesNo: true,
    escalation: null,
    delivery: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
  });

  it("zwei gleiche Vorschläge = eine Karte, Ja gilt für beide, keine rohe Kennung", async () => {
    const impl = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const answer = /^\/api\/inbox\/(\d+)\/answer$/.exec(url);
      if (answer)
        return jsonResponse({
          item: { ...sortItem(Number(answer[1]), "x"), status: "answered" },
        });
      if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
      if (url.startsWith("/api/inbox"))
        return jsonResponse({
          items: [sortItem(8, "claude:c26b526b-7847-4efd-a98e-b4e5b3bcad2f"), sortItem(7, "claude:bdccc84e-7b90-4e00-b1a2-204d9cff2ad5")],
        });
      if (url.startsWith("/api/sessions/"))
        return jsonResponse({
          session: {
            ...GHOST,
            title: "Wie steht der Build?",
            titleSource: "ai",
          },
          files: [],
          archive: [],
          events: [],
        });
      if (url.startsWith("/api/open-questions") || url.includes("open-questions"))
        return jsonResponse({
          approvals: 0,
          inbox: 0,
          conflicts: 0,
          sorting: 1,
          total: 0,
        });
      return Promise.reject(new Error(`unerwartet ${url}`));
    });
    vi.stubGlobal("fetch", impl);
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <InboxView />
      </MemoryRouter>,
    );
    const card = await screen.findByRole("article", {
      name: /2 Sessions nach „Server & Deploy“ sortieren\?/,
    });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(card.textContent).not.toMatch(UUID);
    await user.click(within(card).getByRole("button", { name: "Ja, beide" }));
    await waitFor(() => {
      const calls = impl.mock.calls.map(([u]) => String(u));
      expect(calls).toContain("/api/inbox/8/answer");
      expect(calls).toContain("/api/inbox/7/answer");
    });
  });

  it("klappt nur eine von zwei Antworten, sagt die Karte das – und schickt beim zweiten Klick nur die fehlende", async () => {
    let failSeven = true;
    const impl = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const answer = /^\/api\/inbox\/(\d+)\/answer$/.exec(url);
      if (answer) {
        if (answer[1] === "7" && failSeven) return jsonResponse({ error: "kaputt" }, { status: 500 });
        return jsonResponse({ item: { ...sortItem(Number(answer[1]), "x"), status: "answered" } });
      }
      if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
      if (url.startsWith("/api/inbox")) return jsonResponse({ items: [sortItem(8, "claude:a"), sortItem(7, "claude:b")] });
      if (url.startsWith("/api/sessions/")) return jsonResponse({ session: { ...GHOST, title: "Wie steht der Build?", titleSource: "ai" }, files: [], archive: [], events: [] });
      if (url.includes("open-questions")) return jsonResponse({ approvals: 0, inbox: 0, conflicts: 0, sorting: 1, total: 0 });
      return Promise.reject(new Error(`unerwartet ${url}`));
    });
    vi.stubGlobal("fetch", impl);
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <InboxView />
      </MemoryRouter>,
    );
    const card = await screen.findByRole("article", { name: /2 Sessions nach/ });
    await user.click(within(card).getByRole("button", { name: "Ja, beide" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("1 von 2 nicht gespeichert");
    const answered = (id: number) => impl.mock.calls.filter(([u]) => String(u) === `/api/inbox/${id}/answer`).length;
    expect(answered(8)).toBe(1);
    expect(answered(7)).toBe(1);
    failSeven = false;
    await user.click(within(card).getByRole("button", { name: "Ja, beide" }));
    await waitFor(() => expect(answered(7)).toBe(2));
    expect(answered(8)).toBe(1);
    await waitFor(() => expect(within(card).queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("EINE ApiError-Klasse", () => {
  it("lib/api und lib/http werfen dieselbe Klasse (instanceof stimmt überall)", async () => {
    const api = await import("../src/lib/api");
    const http = await import("../src/lib/http");
    expect(api.ApiError).toBe(http.ApiError);
  });
});
