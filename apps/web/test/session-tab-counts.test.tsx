// Die Zähler der Reiter (Art, „Alle“, Baustelle) zählten nach einer
// anderen Regel als die Liste darunter: ausgeblendete Test-Sessions zählten mit („Unsortiert 57“, sichtbar 2),
// Beendete und Kind-Sessions nicht („Coding 11“, Liste 1 offen + „Beendet (16)“; Codex „Coding 0“ und
// trotzdem „Beendet (6)“), und die Baustelle der Kind-Sessions („audit“) war nie erreichbar.
// Soll: Zähler = was die Liste beim Klick auf den Reiter zeigt (offen + geschlossen + beendet, gleicher
// Temporär-Filter), jede Baustelle mit Sessions hat einen Reiter.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/lib/api";
import { SessionsView } from "../src/routes/SessionsView";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: overrides.id ?? "claude:default",
    tool: "claude",
    sessionId: "default",
    machineId: null,
    parentId: null,
    title: "Titel",
    titleSource: null,
    status: "running",
    cwd: null,
    gitBranch: null,
    cliVersion: null,
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    models: [],
    tokens: {},
    tokensTotal: 0,
    toolCalls: {},
    subagents: [],
    limits: null,
    parsedEventCount: 0,
    eventCount: 0,
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
    temporarySince: null,
    temporaryReason: null,
    temporaryExpiresAt: null,
    ...overrides,
  };
}

const s = (id: string, over: Partial<Session> = {}) => makeSession({ id: `claude:${id}`, sessionId: id, title: `Session ${id}`, ...over });
const SESSIONS = [
  s("offen"),
  s("beendet1", { state: null }),
  s("beendet2", { state: null }),
  s("zu", { state: "closed" }),
  // Kind der offenen Session, aber in der Baustelle „audit“ — dort ist sie ein eigener Eintrag.
  s("kind", { state: null, parentId: "claude:offen", baustelle: { slug: "audit", label: "Audit" } }),
  s("test", { temporarySince: new Date().toISOString(), temporaryReason: "haiku_run" }),
  makeSession({ id: "codex:c1", tool: "codex", sessionId: "c1", title: "Codex beendet", state: null }),
];

function renderAt(url: string) {
  stubFetchRoutes({
    sessions: () => jsonResponse({ sessions: SESSIONS }),
    // Server-Zähler bewusst falsch: die Reiter dürfen sich nicht mehr darauf verlassen.
    categories: () => jsonResponse({ categories: [{ art: "coding", count: 11, baustellen: [{ slug: null, label: "Ohne Baustelle", count: 11 }] }] }),
  });
  return renderWithClient(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/sessions/:art/:baustelle" element={<SessionsView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const artRow = () => screen.getByRole("tablist", { name: "Art der Arbeit" });
const bauRow = () => screen.getByRole("tablist", { name: "Baustelle" });

describe("Reiter-Zähler = sichtbare Liste", () => {
  it("Art und „Alle“ zählen offen + geschlossen + beendet, ohne ausgeblendete Tests; Kind-Baustelle erreichbar", async () => {
    const user = userEvent.setup();
    renderAt("/sessions/coding/_");
    await screen.findByRole("list", { name: /Sessions in/ });
    // offen (mit Kind), zu, beendet1, beendet2, Codex beendet = 5
    expect(within(artRow()).getByRole("tab", { name: /Coding/ })).toHaveTextContent(/Coding\s*5$/);
    expect(within(bauRow()).getByRole("tab", { name: /^Alle/ })).toHaveTextContent(/Alle\s*5$/);
    expect(within(bauRow()).getByRole("tab", { name: /Ohne Baustelle/ })).toHaveTextContent(/Ohne Baustelle\s*5$/);
    expect(within(bauRow()).getByRole("tab", { name: /Audit/ })).toHaveTextContent(/Audit\s*1$/);

    await user.click(screen.getByRole("switch", { name: /Temporäre zeigen/ }));
    expect(within(artRow()).getByRole("tab", { name: /Coding/ })).toHaveTextContent(/Coding\s*6$/);
    expect(within(bauRow()).getByRole("tab", { name: /^Alle/ })).toHaveTextContent(/Alle\s*6$/);

    await user.click(within(bauRow()).getByRole("tab", { name: /Audit/ }));
    await user.click(await screen.findByText(/Beendet \(1\)/));
    expect(await screen.findByText("Session kind")).toBeInTheDocument();
  });

  it("Codex-Filter: Zähler passt zu „Beendet“", async () => {
    renderAt("/sessions/coding/_?tool=codex");
    await screen.findByText(/Beendet \(1\)/);
    expect(within(artRow()).getByRole("tab", { name: /Coding/ })).toHaveTextContent(/Coding\s*1$/);
    expect(within(bauRow()).getByRole("tab", { name: /^Alle/ })).toHaveTextContent(/Alle\s*1$/);
  });
});
