import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { emitLiveTick } from "../src/lib/liveBus";
import type { Session } from "../src/lib/api";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SESSION: Session = {
  id: "claude:chat",
  tool: "claude",
  sessionId: "chat",
  machineId: null,
  parentId: null,
  title: "Chat-Session",
  titleSource: null,
  status: "running",
  cwd: "/Users/alex/code",
  gitBranch: null,
  cliVersion: null,
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastActivityAt: new Date().toISOString(),
  endedAt: null,
  models: ["Sonnet 5"],
  tokens: {},
  tokensTotal: 1000,
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
  baustelle: null,
  reason: [{ stage: "unsortiert", detail: "kein Treffer", ruleId: null }],
  contextPct: null,
  contextWindow: null,
  contextWindowSource: null,
};

const CATEGORIES = [{ art: "coding", count: 1, baustellen: [{ slug: null, label: "Ohne Baustelle", count: 1 }] }];

function item(id: string, text: string) {
  return { id, ts: new Date().toISOString(), role: "assistant" as const, text, thinking: false as const };
}

function systemItem(id: string, text: string, internal: boolean) {
  return { id, ts: new Date().toISOString(), role: "system" as const, text, internal, thinking: false as const };
}

const NEW_PAGE = { items: [item("m6", "Nachricht 6"), item("m7", "Nachricht 7")], nextCursor: null, prevCursor: "cursor-1", archivedAt: null, sha256: "abc" };
const OLD_PAGE = { items: [item("m1", "Nachricht 1"), item("m2", "Nachricht 2")], nextCursor: "cursor-1", prevCursor: null, archivedAt: null, sha256: "abc" };
const AROUND_PAGE = { items: [item("m3", "Nachricht 3"), item("m4", "Treffer-Nachricht"), item("m5", "Nachricht 5")], nextCursor: null, prevCursor: "cursor-1", anchorIndex: 1, archivedAt: null, sha256: "abc" };

function setupFetch() {
  return stubFetchRoutes({
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    sessions: () => jsonResponse({ sessions: [SESSION] }),
    categories: () => jsonResponse({ categories: CATEGORIES }),
    fallback: (url) => {
      if (url.includes("/transcript")) {
        if (url.includes("around=")) return jsonResponse(AROUND_PAGE);
        if (url.includes("cursor=cursor-1")) return jsonResponse(OLD_PAGE);
        return jsonResponse(NEW_PAGE);
      }
      if (/\/api\/sessions\/[^/?]+(?:\?|$)/.test(url)) return jsonResponse({ session: SESSION, files: [], archive: [], events: [] });
      return undefined;
    },
  });
}

describe("Chat", () => {
  it("öffnet unten und lädt beim Hochscrollen die ältere Seite nach", async () => {
    setupFetch();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/claude:chat"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Nachricht 6")).toBeInTheDocument();
    expect(screen.queryByText("Nachricht 1")).not.toBeInTheDocument();

    const scrollEl = screen.getByTestId("chat-scroll");
    fireEvent.scroll(scrollEl);

    expect(await screen.findByText("Nachricht 1")).toBeInTheDocument();
  });

  it("?at= lädt die Seite per `around` und zeigt die Fundstelle", async () => {
    setupFetch();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/claude:chat?at=42"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Treffer-Nachricht")).toBeInTheDocument();
    expect(screen.getByText("Markierung ausblenden")).toBeInTheDocument();
  });
});

// Chat wächst live mit ("unten kleben" vs. Knopf "N neue Nachrichten"), s. auch
// `useTranscript.test.tsx` für die Verwerfen-bei-Session-Wechsel-Fälle (dort direkter am Hook,
// hier über die echte UI).
describe("Chat: Live-Nachwachsen", () => {
  /** Wie `setupFetch` oben, aber die `/transcript`-Antwort ohne Cursor wächst mit jedem Aufruf
   * (simuliert, dass zwischenzeitlich neue Einträge archiviert wurden). */
  function setupLiveFetch(pages: { items: { id: string; ts: string; role: "assistant"; text: string; thinking: false }[]; nextCursor: null; prevCursor: null; archivedAt: null; sha256: string }[]) {
    let call = 0;
    return stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      machines: () => jsonResponse([]),
      sessions: () => jsonResponse({ sessions: [SESSION] }),
      categories: () => jsonResponse({ categories: CATEGORIES }),
      fallback: (url) => {
        if (url.includes("/transcript")) {
          const page = pages[Math.min(call, pages.length - 1)];
          call++;
          return jsonResponse(page);
        }
        if (/\/api\/sessions\/[^/?]+(?:\?|$)/.test(url)) return jsonResponse({ session: SESSION, files: [], archive: [], events: [] });
        return undefined;
      },
    });
  }

  it("hängt bei einem /live-Signal neue Einträge an, ohne zu doppeln — Nutzer ist unten, es scrollt automatisch mit", async () => {
    const PAGE_1 = { items: [item("m1", "Nachricht 1"), item("m2", "Nachricht 2")], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "a" };
    const PAGE_2 = { items: [item("m1", "Nachricht 1"), item("m2", "Nachricht 2"), item("m3", "Nachricht 3")], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "b" };
    setupLiveFetch([PAGE_1, PAGE_2]);
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/claude:chat"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Nachricht 2")).toBeInTheDocument();
    expect(screen.queryByText("Nachricht 3")).not.toBeInTheDocument();

    emitLiveTick();

    expect(await screen.findByText("Nachricht 3")).toBeInTheDocument();
    expect(screen.getAllByText("Nachricht 1")).toHaveLength(1); // kein Doppeln
    expect(screen.queryByTestId("chat-to-bottom")).not.toBeInTheDocument(); // unten → kein Knopf
  });

  // der Knopf heißt jetzt „Nach unten“ (mit Zähler neuer Nachrichten).
  it("Nutzer ist hochgescrollt: Knopf „Nach unten · N neue Nachrichten“ statt automatischem Mitscrollen; Klick blendet ihn aus", async () => {
    const PAGE_1 = { items: [item("m1", "Nachricht 1"), item("m2", "Nachricht 2")], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "a" };
    const PAGE_2 = { items: [item("m1", "Nachricht 1"), item("m2", "Nachricht 2"), item("m3", "Nachricht 3")], nextCursor: null, prevCursor: null, archivedAt: null, sha256: "b" };
    setupLiveFetch([PAGE_1, PAGE_2]);
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/claude:chat"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Nachricht 2")).toBeInTheDocument();

    // jsdom layoutet nicht — `scrollHeight` extra hoch setzen, damit `scrollTop` weit vom unteren
    // Rand entfernt ist (`clientHeight` ist in test/setup.ts fest auf 600 gestellt).
    const scrollEl = screen.getByTestId("chat-scroll");
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 5000 });
    scrollEl.scrollTop = 100;
    fireEvent.scroll(scrollEl);

    emitLiveTick();

    // „Nach unten“ steht schon, sobald der Nutzer hochgescrollt ist; der Zähler kommt mit der neuen Nachricht.
    const button = await screen.findByTestId("chat-to-bottom");
    await waitFor(() => expect(button).toHaveTextContent("1 neue Nachricht"));

    fireEvent.click(button);
    expect(screen.queryByTestId("chat-to-bottom")).not.toBeInTheDocument();
  });
});

// Interne Plumbing-Zeilen (Anhänge wie "total_tokens_reminder", generische
// "System: …"-Zeilen) erschienen zwischen echten Nachrichten. Jetzt standardmäßig ausgeblendet,
// über einen Knopf einblendbar; inhaltliche System-Hinweise ("Kontext komprimiert") bleiben immer sichtbar.
describe("Chat: interne Zeilen ausgeblendet", () => {
  function setupNoiseFetch() {
    const page = {
      items: [
        item("m1", "Echte Nutzerfrage"),
        systemItem("s1", "Anhang: total_tokens_reminder", true),
        systemItem("s2", "System: stop_hook_summary", true),
        systemItem("s3", "Kontext komprimiert", false),
        item("m2", "Echte Antwort"),
      ],
      nextCursor: null,
      prevCursor: null,
      archivedAt: null,
      sha256: "x",
    };
    return stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      machines: () => jsonResponse([]),
      sessions: () => jsonResponse({ sessions: [SESSION] }),
      categories: () => jsonResponse({ categories: CATEGORIES }),
      fallback: (url) => {
        if (url.includes("/transcript")) return jsonResponse(page);
        if (/\/api\/sessions\/[^/?]+(?:\?|$)/.test(url)) return jsonResponse({ session: SESSION, files: [], archive: [], events: [] });
        return undefined;
      },
    });
  }

  it("blendet interne Zeilen standardmäßig aus, „Kontext komprimiert“ bleibt sichtbar", async () => {
    setupNoiseFetch();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/claude:chat"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Echte Nutzerfrage")).toBeInTheDocument();
    expect(screen.getByText("Echte Antwort")).toBeInTheDocument();
    expect(screen.getByText("Kontext komprimiert")).toBeInTheDocument();
    expect(screen.queryByText("Anhang: total_tokens_reminder")).not.toBeInTheDocument();
    expect(screen.queryByText("System: stop_hook_summary")).not.toBeInTheDocument();
    expect(screen.getByText("2 interne Zeilen einblenden")).toBeInTheDocument();
  });

  it("Knopf blendet die internen Zeilen ein und wieder aus", async () => {
    setupNoiseFetch();
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/claude:chat"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText("Echte Nutzerfrage");

    await user.click(screen.getByText("2 interne Zeilen einblenden"));
    expect(await screen.findByText("Anhang: total_tokens_reminder")).toBeInTheDocument();
    expect(screen.getByText("System: stop_hook_summary")).toBeInTheDocument();

    await user.click(screen.getByText("Interne Zeilen ausblenden"));
    expect(screen.queryByText("Anhang: total_tokens_reminder")).not.toBeInTheDocument();
  });
});
