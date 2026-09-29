// Terminal übernehmen: nie mehr „nicht in tmux“, stattdessen „In der NyxOS übernehmen“ mit
// ehrlichem Dialog (altes Fenster beenden oder nur mitlesen). Nach dem Übernehmen verbindet sich das
// Terminal von selbst.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { TakeoverButton } from "../src/features/terminal/TakeoverButton";
import type { Session } from "../src/lib/api";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

function session(p: Partial<Session> = {}): Session {
  return {
    id: "claude:s1",
    tool: "claude",
    sessionId: "s1",
    machineId: "m1",
    parentId: null,
    title: "Übernahme-Test",
    titleSource: "prompt",
    status: "running",
    cwd: "/home/user/projects/App",
    gitBranch: null,
    cliVersion: null,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
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
    tmuxName: null,
    attachable: false,
    startedVia: null,
    contextPct: null,
    contextWindow: null,
    contextWindowSource: null,
    ...p,
  };
}

interface Opts {
  preview?: unknown;
  /** Stand der Session vor dem Übernehmen (Standard: wartet, Programm läuft außerhalb). */
  initial?: Partial<Session>;
  takeover?: () => Promise<Response>;
}

/** fetch-/WebSocket-Attrappe: nach erfolgreichem Übernehmen liefert der Server die Session als anhängbar. */
function stub(o: Opts = {}) {
  let current = session(o.initial);
  const calls: { url: string; init?: RequestInit }[] = [];
  const sockets: string[] = [];
  const id = encodeURIComponent(current.id);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      if (url.startsWith("/api/auth/status")) return jsonResponse({ authenticated: true, csrf: "csrf-123", hasPasskey: true, authReads: false });
      if (url.startsWith("/api/terminal/status")) return jsonResponse({ online: true, machineId: "m1", since: null });
      if (url.startsWith("/health")) return jsonResponse({ ok: true });
      if (url.startsWith("/api/machines")) return jsonResponse([]);
      if (url.startsWith("/api/categories")) return jsonResponse({ categories: [{ art: "coding", count: 1, baustellen: [] }] });
      if (url.startsWith("/api/sessions?")) return jsonResponse({ sessions: [current] });
      if (url === `/api/sessions/${id}/takeover/preview`) return jsonResponse(o.preview ?? { attachable: false, tool: "claude", processes: [], inNyxOS: null, working: false, recommended: "resume" });
      if (url === `/api/sessions/${id}/takeover`) {
        if (o.takeover) return o.takeover();
        current = session({ attachable: true, tmuxName: "zc-claude-takeov01", startedVia: "nyxos" });
        return jsonResponse({ tmuxName: "zc-claude-takeov01", tool: "claude", sessionId: "s1", startedMs: 30 });
      }
      if (url.startsWith(`/api/sessions/${id}/related`)) return jsonResponse({ parent: null, children: [], sameFiles: [] });
      if (url.startsWith(`/api/sessions/${id}/transcript`)) return jsonResponse({ items: [], nextCursor: null, prevCursor: null, archivedAt: null, sha256: null });
      if (url === `/api/sessions/${id}`) return jsonResponse({ session: current, files: [], archive: [], events: [] });
      return Promise.reject(new Error(`keine Antwort für ${url}`));
    }),
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      constructor(url: string) {
        sockets.push(url);
      }
      close() {}
      send() {}
    },
  );
  return { calls, sockets, takeoverCalls: () => calls.filter((c) => c.url.endsWith("/takeover")) };
}

const renderAt = (tab: "chat" | "terminal" = "chat") =>
  renderWithClient(
    <MemoryRouter initialEntries={[`/sessions/coding/_/claude:s1${tab === "terminal" ? "?tab=terminal" : ""}`]}>
      <App />
    </MemoryRouter>,
  );

/** Sichtbarer Text + Hover-Hinweise der ganzen Seite. */
const pageText = () => document.body.textContent + " " + [...document.querySelectorAll("[title]")].map((e) => e.getAttribute("title")).join(" ");

// Ganze App mit xterm im jsdom: unter Last (parallele Pakete) dauert ein Test > 5 s → großzügigeres Budget.
describe("keine Technik-Meldung mehr", { timeout: 20_000 }, () => {
  it("Session außerhalb der NyxOS: nirgends „tmux“, Terminal-Reiter bleibt anklickbar", async () => {
    stub();
    renderAt();
    const tab = await screen.findByRole("tab", { name: /Terminal/ });
    await screen.findAllByRole("button", { name: "In NyxOS übernehmen" });
    expect(pageText()).not.toMatch(/tmux/i);
    await waitFor(() => expect(tab).toBeEnabled());
    await userEvent.setup().click(tab);
    expect(await screen.findByText(/läuft in einem eigenen Fenster auf deinem Rechner/)).toBeInTheDocument();
    expect(pageText()).not.toMatch(/tmux/i);
  });
});

describe("Übernehmen-Text sagt die Wahrheit", { timeout: 20_000 }, () => {
  it("läuft die Session gar nicht mehr, behauptet der Reiter kein „eigenes Fenster“", async () => {
    stub({ initial: { state: null, status: "ended" } });
    renderAt("terminal");
    const panel = await screen.findByTestId("terminal-panel");
    await within(panel).findByRole("button", { name: "In NyxOS übernehmen" });
    expect(panel).toHaveTextContent(/läuft gerade nicht/);
    expect(panel).not.toHaveTextContent(/eigenen Fenster/);
  });

  it("zwei Programme an der Session: der Dialog spricht nicht von „dieses eine Programm“", async () => {
    stub({ preview: { attachable: false, tool: "claude", processes: [{ pid: 4242, app: "Terminal" }, { pid: 4243, app: "iTerm" }], inNyxOS: null, working: false, recommended: "end_old" } });
    renderAt("terminal");
    const user = userEvent.setup();
    const panel = await screen.findByTestId("terminal-panel");
    await user.click(await within(panel).findByRole("button", { name: "In NyxOS übernehmen" }));
    const dlg = await screen.findByRole("dialog", { name: /übernehmen/ });
    expect(dlg).not.toHaveTextContent(/dieses eine Programm/);
    expect(dlg).toHaveTextContent(/2 Programme/);
    expect(dlg).toHaveTextContent(/4242/);
    expect(dlg).toHaveTextContent(/4243/);
  });
});

describe("„In NyxOS übernehmen“", { timeout: 20_000 }, () => {
  it("läuft das alte Fenster noch: ehrlicher Dialog, nichts passiert ohne Klick; „beenden“ schickt genau diese PID", async () => {
    const s = stub({ preview: { attachable: false, tool: "claude", processes: [{ pid: 4242, app: "Terminal" }], inNyxOS: null, working: false, recommended: "end_old" } });
    renderAt("terminal");
    const user = userEvent.setup();
    const panel = await screen.findByTestId("terminal-panel");
    await user.click(await within(panel).findByRole("button", { name: "In NyxOS übernehmen" }));
    const dlg = await screen.findByRole("dialog", { name: /übernehmen/ });
    expect(dlg).toHaveTextContent(/Terminal/);
    expect(dlg).toHaveTextContent(/Zwei Programme/);
    expect(s.takeoverCalls()).toHaveLength(0);
    const endBtn = within(dlg).getByRole("button", { name: /Altes Fenster beenden/ });
    expect(endBtn).toHaveFocus(); // Empfehlung vorausgewählt — ausgelöst wird aber erst mit dem Klick
    await user.click(endBtn);
    await waitFor(() => expect(s.takeoverCalls()).toHaveLength(1));
    expect(JSON.parse(String(s.takeoverCalls()[0]?.init?.body))).toMatchObject({ endPids: [4242] });
    expect(new Headers(s.takeoverCalls()[0]?.init?.headers).get("x-nyxos-csrf")).toBe("csrf-123");
    // Danach verbindet sich das Terminal von selbst.
    await waitFor(() => expect(s.sockets.some((u) => u.includes("/terminal/claude%3As1"))).toBe(true));
    expect(screen.queryByRole("dialog", { name: /übernehmen/ })).not.toBeInTheDocument();
  });

  it("arbeitet die Session gerade: „Nur mitlesen“ ist vorausgewählt, beendet nichts und zeigt den Chat", async () => {
    const s = stub({ preview: { attachable: false, tool: "claude", processes: [{ pid: 77, app: null }], inNyxOS: null, working: true, recommended: "watch" } });
    renderAt("terminal");
    const user = userEvent.setup();
    const panel = await screen.findByTestId("terminal-panel");
    await user.click(await within(panel).findByRole("button", { name: "In NyxOS übernehmen" }));
    const dlg = await screen.findByRole("dialog", { name: /übernehmen/ });
    expect(dlg).toHaveTextContent(/arbeitet gerade/);
    const watch = within(dlg).getByRole("button", { name: /Nur mitlesen/ });
    expect(watch).toHaveFocus();
    await user.click(watch);
    expect(s.takeoverCalls()).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true"));
  });

  it("läuft nirgends mehr: ohne Dialog direkt fortsetzen, danach verbindet das Terminal", async () => {
    const s = stub();
    renderAt("terminal");
    const user = userEvent.setup();
    const panel = await screen.findByTestId("terminal-panel");
    await user.click(await within(panel).findByRole("button", { name: "In NyxOS übernehmen" }));
    await waitFor(() => expect(s.takeoverCalls()).toHaveLength(1));
    expect(JSON.parse(String(s.takeoverCalls()[0]?.init?.body))).toMatchObject({ endPids: [] });
    expect(screen.queryByRole("dialog", { name: /übernehmen/ })).not.toBeInTheDocument();
    await waitFor(() => expect(s.sockets.some((u) => u.includes("/terminal/claude%3As1"))).toBe(true));
  });

  it("Fehler kommt als verständlicher Satz an", async () => {
    stub({ takeover: () => jsonResponse({ error: "Am alten Fenster hat sich gerade etwas geändert. Bitte noch einmal klicken.", code: "process_changed" }, { status: 409 }) });
    renderAt("terminal");
    const panel = await screen.findByTestId("terminal-panel");
    await userEvent.setup().click(await within(panel).findByRole("button", { name: "In NyxOS übernehmen" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(/etwas geändert/);
  });

  it("wiederverwendbar (z. B. im Chat-Eingabefeld): TakeoverButton({ session }) allein", async () => {
    stub();
    renderWithClient(
      <MemoryRouter>
        <TakeoverButton session={session()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: "In NyxOS übernehmen" })).toBeInTheDocument();
  });
});
