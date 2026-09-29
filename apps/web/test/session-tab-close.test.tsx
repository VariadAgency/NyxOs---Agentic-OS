// Session schließen wie einen Browser-Tab. Lang (≥ 450 ms) auf den Status-Punkt im Session-Tab
// drücken → er wird zum ✕ → Klick → Rückfrage im Tab → erst „Schließen“ ruft den Schließen-Weg auf.
// Loslassen ohne Klick bricht nach 4 s ab. Nie ohne Bestätigung schließen.
import { act, fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabRows } from "../src/components/sessions/TabRows";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import type { SessionsRoute } from "../src/hooks/useSessionsRoute";
import type { Session } from "../src/lib/api";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeSession(over: Partial<Session>): Session {
  return {
    id: "claude:s1",
    tool: "claude",
    sessionId: "s1",
    machineId: null,
    parentId: null,
    title: "Deploy vorbereiten",
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
    ...over,
  } as Session;
}

function setup(opts: { selectedId?: string | null } = {}) {
  __primeAuthForTests();
  const posts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST") posts.push(url);
      if (url.endsWith("/close")) return jsonResponse({ ok: true });
      return jsonResponse({});
    }),
  );
  const goTo = vi.fn();
  const route: SessionsRoute = { art: "coding", baustelle: null, id: opts.selectedId ?? null, tool: "alle", at: null, goTo, setTool: vi.fn() };
  const s1 = makeSession({});
  const s2 = makeSession({ id: "claude:s2", sessionId: "s2", title: "Zweite Session", state: "running" });
  renderWithClient(
    <MemoryRouter>
      <TabRows categories={[]} openRows={[{ session: s1, subagents: [] }, { session: s2, subagents: [] }]} route={route} activeBaustelleLabel={null} onDropOnArt={vi.fn()} onDropOnBaustelle={vi.fn()} onOpenRules={vi.fn()} />
    </MemoryRouter>,
  );
  return { posts, goTo };
}

const dot = (title: string) => screen.getByTestId(`tab-dot-${title}`);
const closeBtn = (title: string) => screen.queryByRole("button", { name: `Session „${title}“ schließen` });

/** Ein echter Klick: eigener Druck, loslassen, Klick. */
function tap(el: HTMLElement) {
  fireEvent.pointerDown(el, { pointerId: 2, pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(el, { pointerId: 2, pointerType: "mouse" });
  fireEvent.click(el);
}

/** Lang drücken: Zeiger runter, Zeit laufen lassen. */
function longPress(el: HTMLElement, ms = 450, pointerType = "mouse") {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType, button: 0 });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("Status-Punkt lang drücken → ✕ → Rückfrage → schließen", () => {
  it("kurzer Druck (< 450 ms) zeigt kein ✕", () => {
    vi.useFakeTimers();
    setup();
    fireEvent.pointerDown(dot("Deploy vorbereiten"), { pointerId: 1, pointerType: "mouse", button: 0 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerUp(dot("Deploy vorbereiten"), { pointerId: 1, pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(closeBtn("Deploy vorbereiten")).toBeNull();
  });

  it("≥ 450 ms (Maus) → ✕; Klick → Rückfrage; Abbrechen schließt NICHT; Schließen schließt", () => {
    vi.useFakeTimers();
    const { posts } = setup();
    longPress(dot("Deploy vorbereiten"));
    fireEvent.pointerUp(dot("Deploy vorbereiten"), { pointerId: 1, pointerType: "mouse" });
    const x = closeBtn("Deploy vorbereiten");
    expect(x).not.toBeNull();
    expect(x).toHaveTextContent("✕");
    // Nur die gedrückte Session – die andere bleibt ein Punkt.
    expect(closeBtn("Zweite Session")).toBeNull();

    tap(x as HTMLElement);
    const ask = screen.getByRole("alertdialog", { name: /Session „Deploy vorbereiten“ endgültig schließen\?/ });
    expect(posts).toEqual([]);
    fireEvent.click(within(ask).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts).toEqual([]);

    longPress(dot("Deploy vorbereiten"));
    tap(closeBtn("Deploy vorbereiten") as HTMLElement);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Schließen" }));
    expect(posts).toEqual([]); // erst nach dem Klick geht die Anfrage raus (asynchron)
  });

  it("Bestätigen ruft den bestehenden Schließen-Weg auf", async () => {
    const { posts } = setup();
    vi.useFakeTimers();
    longPress(dot("Deploy vorbereiten"));
    vi.useRealTimers();
    tap(closeBtn("Deploy vorbereiten") as HTMLElement);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Schließen" }));
    await vi.waitFor(() => expect(posts).toEqual(["/api/sessions/claude%3As1/close"]));
  });

  it("Touch: langer Druck funktioniert genauso", () => {
    vi.useFakeTimers();
    setup();
    longPress(dot("Zweite Session"), 460, "touch");
    expect(closeBtn("Zweite Session")).not.toBeNull();
  });

  it("losgelassen ohne Klick → nach 4 s wieder der Punkt; solange der Zeiger drauf ist, bleibt das ✕", () => {
    vi.useFakeTimers();
    setup();
    longPress(dot("Deploy vorbereiten"));
    fireEvent.pointerUp(dot("Deploy vorbereiten"), { pointerId: 1, pointerType: "mouse" });
    const x = closeBtn("Deploy vorbereiten") as HTMLElement;
    fireEvent.pointerEnter(x, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(closeBtn("Deploy vorbereiten")).not.toBeNull();
    fireEvent.pointerLeave(x, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(3900);
    });
    expect(closeBtn("Deploy vorbereiten")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(closeBtn("Deploy vorbereiten")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offene Session geschlossen → zurück zur Übersicht", async () => {
    const { goTo } = setup({ selectedId: "claude:s1" });
    vi.useFakeTimers();
    longPress(dot("Deploy vorbereiten"));
    vi.useRealTimers();
    tap(closeBtn("Deploy vorbereiten") as HTMLElement);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Schließen" }));
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith("coding", null, null));
  });

  it("der Klick, der zum langen Druck gehört (Loslassen), fragt noch nicht nach", () => {
    vi.useFakeTimers();
    setup();
    longPress(dot("Deploy vorbereiten"));
    fireEvent.pointerUp(dot("Deploy vorbereiten"), { pointerId: 1, pointerType: "mouse" });
    fireEvent.click(dot("Deploy vorbereiten"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(closeBtn("Deploy vorbereiten")).not.toBeNull();
  });

  it("Tastatur: Entf auf dem Tab fragt nach, schließt aber nicht von selbst", () => {
    const { posts } = setup();
    const tab = screen.getByRole("tab", { name: /Deploy vorbereiten/ });
    fireEvent.keyDown(tab, { key: "Delete" });
    expect(screen.getByRole("alertdialog", { name: /endgültig schließen/ })).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  // Die Rückfrage war per Tastatur kaum bedienbar – Fokus blieb hinter dem Dialog, Esc tat nichts.
  it("Tastatur: Rückfrage startet auf „Abbrechen“, Esc bricht ab, ohne zu schließen", () => {
    const { posts } = setup();
    const tab = screen.getByRole("tab", { name: /Deploy vorbereiten/ });
    fireEvent.keyDown(tab, { key: "Delete" });
    const ask = screen.getByRole("alertdialog", { name: /endgültig schließen/ });
    expect(within(ask).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts).toEqual([]);
  });

  it("langes Drücken öffnet die Session nicht", () => {
    vi.useFakeTimers();
    const { goTo } = setup();
    longPress(dot("Deploy vorbereiten"));
    fireEvent.pointerUp(dot("Deploy vorbereiten"), { pointerId: 1, pointerType: "mouse" });
    expect(goTo).not.toHaveBeenCalled();
  });
});
