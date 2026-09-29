// Wegwerf-Sessions (temporär) im Web: sichtbare Marke „⏳ 4 Std“, Filter „Temporäre ausblenden“ auf der
// Sessions-Seite, Schalter „Temporär“ im Dialog „Neue Session“, Einstellung „nach X Stunden“ (1–72).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NEW_SESSION_EVENT } from "../src/features/terminal/terminalApi";
import { NewSessionDialog } from "../src/features/terminal/NewSessionDialog";
import { TemporarySettingsPanel } from "../src/features/temporary/TemporarySettingsPanel";
import type { Session } from "../src/lib/api";
import { SessionsView } from "../src/routes/SessionsView";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";
import { __primeAuthForTests } from "../src/features/terminal/authClient";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

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

const SESSIONS = [
  makeSession({ id: "claude:echt", sessionId: "echt", title: "Echte Arbeit am Onboarding" }),
  makeSession({ id: "claude:wegwerf", sessionId: "wegwerf", title: "Kurzer Codex-Test", temporarySince: new Date().toISOString(), temporaryReason: "manual", temporaryExpiresAt: inHours(4.1) }),
  makeSession({ id: "claude:probe", sessionId: "probe", title: "Antworte nur mit OK.", temporarySince: new Date().toISOString(), temporaryReason: "selftest", temporaryExpiresAt: inHours(0.5) }),
];

function renderSessions() {
  stubFetchRoutes({
    sessions: () => jsonResponse({ sessions: SESSIONS }),
    categories: () => jsonResponse({ categories: [{ art: "coding", count: 3, baustellen: [] }] }),
  });
  return renderWithClient(
    <MemoryRouter initialEntries={["/sessions/coding/_"]}>
      <Routes>
        <Route path="/sessions/:art/:baustelle" element={<SessionsView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("temporäre Sessions sind markiert und ausblendbar", () => {
  it("Marke mit Sanduhr und Restzeit an temporären Karten, nicht an normalen", async () => {
    const user = userEvent.setup();
    renderSessions();
    const list = await screen.findByRole("list", { name: /Sessions in/ });
    const card = (title: string) => within(list).getByText(title).closest("[data-session-id]") as HTMLElement;
    expect(within(card("Kurzer Codex-Test")).getByText(/⏳\s*4 Std/)).toBeInTheDocument();
    expect(within(card("Echte Arbeit am Onboarding")).queryByText(/⏳/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /Temporäre zeigen/ }));
    expect(within(card("Antworte nur mit OK.")).getByText(/⏳\s*30 Min/)).toBeInTheDocument();
  });

  // Automatisch erkannte Test-Sessions sind standardmäßig aus; bewusst temporäre (manual) bleiben.
  it("Test-Sessions sind standardmäßig ausgeblendet, „Temporäre zeigen“ holt sie und merkt sich die Wahl", async () => {
    const user = userEvent.setup();
    const first = renderSessions();
    const list = await screen.findByRole("list", { name: /Sessions in/ });
    const chip = screen.getByRole("switch", { name: /Temporäre zeigen/ });
    expect(chip).toHaveAttribute("aria-checked", "false");
    expect(within(list).queryByText("Antworte nur mit OK.")).not.toBeInTheDocument();
    expect(within(list).getByText("Kurzer Codex-Test")).toBeInTheDocument();
    expect(within(list).getByText("Echte Arbeit am Onboarding")).toBeInTheDocument();
    // Zähler zeigt, was ausgeblendet ist – nichts verschwindet heimlich.
    expect(chip).toHaveAccessibleName(/1 Test-Session/);
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-checked", "true");
    expect(within(list).getByText("Antworte nur mit OK.")).toBeInTheDocument();

    first.unmount();
    renderSessions();
    const list2 = await screen.findByRole("list", { name: /Sessions in/ });
    expect(within(list2).getByText("Antworte nur mit OK.")).toBeInTheDocument();
  });
});

describe("Schalter „Temporär“ im Dialog „Neue Session“", () => {
  it("an → der Start schickt temporary: true mit", async () => {
    __primeAuthForTests();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/terminal/status") return jsonResponse({ online: true, machineId: "m1", since: null });
        if (url === "/api/terminal/folders") return jsonResponse({ folders: [{ path: "/Users/dev/project", label: "project" }] });
        if (url === "/api/terminal/start" && init?.method === "POST") {
          bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ tmuxName: "zc-codex-aa11bb22", tool: "codex", sessionId: null, startedMs: 5 });
        }
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <NewSessionDialog />
      </MemoryRouter>,
    );
    act(() => {
      window.dispatchEvent(new Event(NEW_SESSION_EVENT));
    });
    const dlg = await screen.findByRole("dialog", { name: "Neue Session" });
    const toggle = within(dlg).getByRole("switch", { name: /Temporär/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    await waitFor(() => expect(within(dlg).getByRole("button", { name: "Starten" })).toBeEnabled());
    await user.click(within(dlg).getByRole("button", { name: "Starten" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ temporary: true });
  });
});

describe("Einstellung „nach X Stunden“", () => {
  it("zeigt 6 h, speichert 12 h, lehnt 0 und 73 ab (ohne Server-Aufruf)", async () => {
    __primeAuthForTests();
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/temporary/settings" && !init?.method) return jsonResponse({ hours: 6 });
        if (url === "/api/temporary/settings" && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { hours: number };
          patches.push(body);
          return jsonResponse(body);
        }
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<TemporarySettingsPanel />);
    const input = await screen.findByRole("spinbutton", { name: /Stunden/ });
    await waitFor(() => expect(input).toHaveValue(6));
    for (const bad of ["0", "73"]) {
      await user.clear(input);
      await user.type(input, bad);
      await user.click(screen.getByRole("button", { name: "Speichern" }));
      expect(screen.getByRole("alert")).toHaveTextContent(/1 bis 72/);
    }
    expect(patches).toHaveLength(0);
    await user.clear(input);
    await user.type(input, "12");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(patches).toEqual([{ hours: 12 }]));
  });
});
