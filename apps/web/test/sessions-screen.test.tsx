import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { Session } from "../src/lib/api";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

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
    startedAt: minutesAgo(30),
    lastActivityAt: minutesAgo(2),
    endedAt: null,
    models: ["Sonnet 5"],
    tokens: {},
    tokensTotal: 12000,
    toolCalls: { Read: 3 },
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
    reason: [{ stage: "folder", detail: "Ordner tools/NyxOS", ruleId: null }],
    contextPct: null,
    contextWindow: null,
    contextWindowSource: null,
    ...overrides,
  };
}

const S_WAIT = makeSession({ id: "claude:wait", sessionId: "wait", title: "Wartet auf Antwort", state: "waiting" });
const S_RUN = makeSession({ id: "claude:run", sessionId: "run", title: "Läuft gerade", state: "running" });
const S_CHILD = makeSession({ id: "claude:child", sessionId: "child", title: "Sub-Agent-Session", state: "running", parentId: "claude:run" });
const S_CLOSED = makeSession({ id: "claude:closed", sessionId: "closed", title: "Alt geschlossen", state: "closed", closedAt: minutesAgo(500), closedBy: "user" });
const S_ENDED = makeSession({ id: "claude:ended", sessionId: "ended", title: "Sauber beendet", state: null, status: "ended", endedAt: minutesAgo(600) });
// Eine Session OHNE Baustelle, um "Alle" vs. "Ohne Baustelle" zu unterscheiden.
const S_NOBAU = makeSession({ id: "claude:nobau", sessionId: "nobau", title: "Ohne Baustelle", state: "idle", baustelle: null });

const ALL_SESSIONS = [S_WAIT, S_RUN, S_CHILD, S_CLOSED, S_ENDED, S_NOBAU];

const CATEGORIES = [
  {
    art: "coding",
    count: 3,
    baustellen: [
      { slug: "nyxos", label: "NyxOS", count: 2 },
      { slug: null, label: "Ohne Baustelle", count: 1 },
    ],
  },
  { art: "audit", count: 0, baustellen: [] },
  { art: "planung", count: 0, baustellen: [] },
  { art: "ideen", count: 0, baustellen: [] },
  { art: "recherche", count: 0, baustellen: [] },
  { art: "server", count: 0, baustellen: [] },
];

function detailFor(session: Session) {
  return {
    session,
    files: [{ sessionKey: session.id, path: "apps/web/src/App.tsx", mode: "write" as const, firstSeenAt: minutesAgo(10) }],
    archive: [],
    events: [],
  };
}

interface Store {
  sessions: Session[];
}

function setupStore(): { store: Store; fetchMock: ReturnType<typeof stubFetchRoutes> } {
  const store: Store = { sessions: ALL_SESSIONS.map((s) => ({ ...s })) };
  const fetchMock = stubFetchRoutes({
    sessions: () => jsonResponse({ sessions: store.sessions }),
    categories: () => jsonResponse({ categories: CATEGORIES }),
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    fallback: (url, init) => {
      const closeMatch = /\/api\/sessions\/([^/]+)\/close$/.exec(url);
      if (closeMatch) {
        const id = decodeURIComponent(closeMatch[1] ?? "");
        const s = store.sessions.find((x) => x.id === id);
        if (s) {
          s.state = "closed";
          s.closedAt = new Date().toISOString();
          s.closedBy = "user";
        }
        return jsonResponse({ ok: true });
      }
      const reopenMatch = /\/api\/sessions\/([^/]+)\/reopen$/.exec(url);
      if (reopenMatch) {
        const id = decodeURIComponent(reopenMatch[1] ?? "");
        const s = store.sessions.find((x) => x.id === id);
        if (s) {
          s.state = "running";
          s.closedAt = null;
          s.closedBy = null;
        }
        return jsonResponse({ ok: true });
      }
      const previewMatch = /\/api\/sessions\/([^/]+)\/assign\/preview$/.exec(url);
      if (previewMatch && init?.body) {
        const body = JSON.parse(String(init.body)) as { art?: string; baustelle?: { slug: string; label: string } | null };
        return jsonResponse({
          art: "art" in body ? { condition: { text: `Art über Titel-Wort „${body.art}"`, structured: { stage: "keyword", anyOf: [body.art] } }, reason: null } : null,
          baustelle: "baustelle" in body ? { condition: null, reason: "Keine Datei-Evidenz — nur diese Session wird zugeordnet." } : null,
          affected: [],
          affectedCount: 0,
        });
      }
      const assignMatch = /\/api\/sessions\/([^/]+)\/assign$/.exec(url);
      if (assignMatch && init?.body) {
        const id = decodeURIComponent(assignMatch[1] ?? "");
        const body = JSON.parse(String(init.body)) as { art?: string; baustelle?: { slug: string; label: string } | null; asRule: boolean };
        const s = store.sessions.find((x) => x.id === id);
        if (s) {
          if ("art" in body) s.art = body.art as string;
          if ("baustelle" in body) s.baustelle = body.baustelle ?? null;
        }
        const rules =
          body.asRule && "art" in body
            ? [{ id: 1, dimension: "art", condition: {}, targetArt: body.art ?? null, targetBaustelleSlug: null, targetBaustelleLabel: null, origin: "korrektur", active: true, createdAt: new Date().toISOString() }]
            : [];
        return jsonResponse({ rules, resorted: rules.length > 0 ? [id] : [], manualOnly: rules.length > 0 ? [] : Object.keys(body).filter((k) => k === "art" || k === "baustelle") });
      }
      const unassignMatch = /\/api\/sessions\/([^/]+)\/unassign$/.exec(url);
      if (unassignMatch) {
        return jsonResponse({ ok: true, resorted: [] });
      }
      const transcriptMatch = /\/api\/sessions\/([^/]+)\/transcript/.exec(url);
      if (transcriptMatch) {
        return jsonResponse({ items: [], nextCursor: null, prevCursor: null, archivedAt: null, sha256: null });
      }
      const detailMatch = /\/api\/sessions\/([^/?]+)(?:\?|$)/.exec(url);
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1] ?? "");
        const s = store.sessions.find((x) => x.id === id);
        return s ? jsonResponse(detailFor(s)) : Promise.resolve(new Response(JSON.stringify({ error: "Nicht gefunden" }), { status: 404 }));
      }
      return undefined;
    },
  });
  return { store, fetchMock };
}

describe("Sessions-Tab: Übersicht", () => {
  it("zeigt Karten sortiert nach Zustand und Sub-Agenten nicht als eigene Karte", async () => {
    setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos"]}>
        <App />
      </MemoryRouter>,
    );

    const list = await screen.findByRole("list", { name: /Sessions in/ });
    const cards = within(list).getAllByRole("button");
    expect(cards.map((c) => within(c).getByText(/Wartet auf Antwort|Läuft gerade/i).textContent)).toEqual(["Wartet auf Antwort", "Läuft gerade"]);
    expect(screen.queryByText("Sub-Agent-Session")).not.toBeInTheDocument();
    expect(within(cards.at(1) as HTMLElement).getByText(/Sub-Agent/)).toBeInTheDocument();
  });

  it("klappt Geschlossen und Beendet ein", async () => {
    setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("list", { name: /Sessions in/ });
    expect(screen.queryByText("Alt geschlossen")).not.toBeInTheDocument();
    expect(screen.queryByText("Sauber beendet")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Geschlossen in diesem Bereich \(1\)/));
    expect(await screen.findByText("Alt geschlossen")).toBeInTheDocument();

    await user.click(screen.getByText(/Beendet \(1\)/));
    expect(await screen.findByText("Sauber beendet")).toBeInTheDocument();
  });

  it("Art-Tab schreibt die URL (Brotkrümel wechselt)", async () => {
    setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("list", { name: /Sessions in/ });
    const user = userEvent.setup();
    const artTab = screen.getByRole("tab", { name: /Audit/ });
    await user.click(artTab);

    const crumbs = screen.getByRole("navigation", { name: "Brotkrümel" });
    expect(await within(crumbs).findByText("Audit")).toBeInTheDocument();
  });
});

describe("Sessions-Tab: Vollbild", () => {
  it("zeigt den Einsortier-Grund", async () => {
    setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos/claude:wait"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/einsortiert wegen: Ordner tools\/NyxOS/)).toBeInTheDocument();
  });

  it("öffnet das Vollbild auch mit der nackten sessionId in der URL (Suche, ⌘K, Gehirn verlinken so)", async () => {
    setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos/wait"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/einsortiert wegen: Ordner tools\/NyxOS/)).toBeInTheDocument();
  });

  it("Session außerhalb der NyxOS bei offlinem Mac → Terminal-Reiter aus mit Hinweis, Übernehmen gesperrt", async () => {
    setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos/claude:wait"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(/einsortiert wegen/);
    const terminalTab = screen.getByRole("tab", { name: /Terminal/ });
    expect(terminalTab).toBeDisabled();
    expect(terminalTab).toHaveTextContent(/Rechner offline/);
    // „In NyxOS fortsetzen“ heißt jetzt „In der NyxOS übernehmen“.
    // je nach Ladereihenfolge steht der Knopf im Kopf UND in der Chat-Karte — gesperrt sind beide.
    const takeover = screen.getAllByRole("button", { name: "In NyxOS übernehmen" });
    expect(takeover.length).toBeGreaterThan(0);
    for (const button of takeover) expect(button).toBeDisabled();
  });

  it("schließt mit Bestätigung und öffnet danach wieder (echte API-Aufrufe)", async () => {
    const { fetchMock } = setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos/claude:wait"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(/einsortiert wegen/);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Schließen" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Schließen" }));

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/sessions/claude%3Await/close"), expect.objectContaining({ method: "POST" }));

    const reopenBtn = await screen.findByRole("button", { name: "Wieder öffnen" });
    await user.click(reopenBtn);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/sessions/claude%3Await/reopen"), expect.objectContaining({ method: "POST" }));
  });
});

describe("Sessions-Tab: Ziehen zum Umsortieren (getrennte Dimensionen, Vorschau vor dem Speichern)", () => {
  it("Ziehen auf einen ART-Tab zeigt die Bedingung in der Vorschau und ruft assign NUR mit 'art' auf (kein 'baustelle' im Body)", async () => {
    const { fetchMock } = setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos"]}>
        <App />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: /Sessions in/ });

    const card = within(list).getByText("Wartet auf Antwort").closest("button") as HTMLElement;
    const artTab = screen.getByRole("tab", { name: /Audit/ });

    const dataTransfer = { getData: vi.fn(() => "claude:wait"), setData: vi.fn() };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(artTab, { dataTransfer });
    fireEvent.drop(artTab, { dataTransfer });

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: /Audit/ })).toBeInTheDocument();

    // Vorschau zeigt die Bedingung, bevor irgendetwas gespeichert wird.
    expect(await within(dialog).findByText(/Bedingung: Art über Titel-Wort/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "Als Regel speichern" }));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/claude%3Await/assign"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ art: "audit", asRule: true }) }),
    );
    expect(await screen.findByText(/neu sortiert/)).toBeInTheDocument();

    // Toast bietet "Rückgängig" an.
    const undo = await screen.findByRole("button", { name: "Rückgängig" });
    await user.click(undo);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/sessions/claude%3Await/unassign"), expect.objectContaining({ method: "POST" }));
  });

  it("'Nur diese Session' schickt asRule=false", async () => {
    const { fetchMock } = setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos"]}>
        <App />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: /Sessions in/ });
    const card = within(list).getByText("Wartet auf Antwort").closest("button") as HTMLElement;
    const artTab = screen.getByRole("tab", { name: /Audit/ });
    const dataTransfer = { getData: vi.fn(() => "claude:wait"), setData: vi.fn() };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(artTab, { dataTransfer });
    fireEvent.drop(artTab, { dataTransfer });

    const dialog = await screen.findByRole("alertdialog");
    const user = userEvent.setup();
    const checkbox = await within(dialog).findByRole("checkbox");
    await user.click(checkbox); // "Als Regel speichern" abwählen
    await user.click(within(dialog).getByRole("button", { name: "Nur diese Session" }));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/claude%3Await/assign"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ art: "audit", asRule: false }) }),
    );
  });
});

describe("Sessions-Tab: Regeln-Bereich", () => {
  it("listet Regeln und schaltet eine Regel ab", async () => {
    const rulesStore = {
      rules: [
        { id: 1, dimension: "art", condition: { stage: "skill", value: "gitnexus" }, targetArt: "recherche", targetBaustelleSlug: null, targetBaustelleLabel: null, origin: "korrektur", active: true, createdAt: new Date().toISOString() },
      ],
    };
    const { fetchMock } = setupStore();
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/sort-rules/") && init?.method === "PATCH") {
        const id = Number(url.split("/").pop());
        const rule = rulesStore.rules.find((r) => r.id === id);
        if (rule) rule.active = (JSON.parse(String(init.body)) as { active: boolean }).active;
        return jsonResponse({ ok: true, resorted: ["claude:wait"] });
      }
      if (url.startsWith("/api/sort-rules")) return jsonResponse(rulesStore);
      return original ? original(input, init) : Promise.reject(new Error(`Test hat keine Antwort für ${url} vorgesehen`));
    });

    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/nyxos"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("list", { name: /Sessions in/ });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Regeln" }));

    const dialog = await screen.findByRole("dialog", { name: "Regeln" });
    expect(within(dialog).getByText(/Skill gitnexus/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Art: Recherche/)).toBeInTheDocument();

    const toggle = within(dialog).getByRole("checkbox");
    await user.click(toggle);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/sort-rules/1"), expect.objectContaining({ method: "PATCH" }));
    expect(await screen.findByText(/neu einsortiert/)).toBeInTheDocument();
  });
});

describe("Sessions-Tab: BAUSTELLE-Zeile — „Alle“ vs. „Ohne Baustelle“", () => {
  it("„Alle“ ist ausgewählt, wenn keine Baustelle in der URL steht — „Ohne Baustelle“ NICHT gleichzeitig", async () => {
    setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("list", { name: /Sessions in/ });

    const baustelleRow = screen.getByRole("tablist", { name: "Baustelle" });
    const alle = within(baustelleRow).getByRole("tab", { name: /^Alle/ });
    const ohne = within(baustelleRow).getByRole("tab", { name: /^Ohne Baustelle/ });
    expect(alle).toHaveAttribute("aria-selected", "true");
    expect(ohne).toHaveAttribute("aria-selected", "false");
    // Genau EIN Tab in der Zeile ist ausgewählt.
    expect(within(baustelleRow).getAllByRole("tab", { selected: true })).toHaveLength(1);
  });

  it("Klick auf „Ohne Baustelle“ wählt NUR diesen Tab aus und filtert auf Sessions ohne Baustelle", async () => {
    setupStore();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("list", { name: /Sessions in/ });
    const user = userEvent.setup();

    const baustelleRow = screen.getByRole("tablist", { name: "Baustelle" });
    await user.click(within(baustelleRow).getByRole("tab", { name: /^Ohne Baustelle/ }));

    const alle = within(baustelleRow).getByRole("tab", { name: /^Alle/ });
    const ohne = within(baustelleRow).getByRole("tab", { name: /^Ohne Baustelle/ });
    expect(ohne).toHaveAttribute("aria-selected", "true");
    expect(alle).toHaveAttribute("aria-selected", "false");
    expect(within(baustelleRow).getAllByRole("tab", { selected: true })).toHaveLength(1);

    // URL trägt ein eigenes Segment (nicht dasselbe wie "Alle").
    const crumbs = screen.getByRole("navigation", { name: "Brotkrümel" });
    expect(within(crumbs).getByText("Ohne Baustelle")).toBeInTheDocument();

    // Gefiltert: nur die Session ohne Baustelle, nicht die mit "nyxos".
    const list = await screen.findByRole("list", { name: /Sessions in/ });
    expect(within(list).getByText("Ohne Baustelle")).toBeInTheDocument();
    expect(within(list).queryByText("Wartet auf Antwort")).not.toBeInTheDocument();
  });
});
