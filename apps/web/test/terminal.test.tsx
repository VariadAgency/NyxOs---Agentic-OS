// Terminal-Knöpfe im Session-Vollbild, CSRF-Kopf + Anmelde-Dialog bei 401, „+ Neue Session".
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { defaultReadOnly } from "../src/features/terminal/TerminalPanel";
import type { Session } from "../src/lib/api";
import { closeSession } from "../src/lib/api";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

/**
 * Knopf finden UND auf „bedienbar“ warten, dabei jedes Mal neu suchen. Vorher
 * wurde der Knopf einmal gegriffen und dann auf „enabled“ gewartet — lädt die Seite dazwischen neu (Anmelde-
 * Status, Brücken-Status), hängt React ihn neu ein und der alte Griff zeigt ins Leere.
 */
async function enabledButton(name: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
  return screen.getByRole("button", { name });
}

function session(p: Partial<Session>): Session {
  return {
    id: "claude:s1",
    tool: "claude",
    sessionId: "s1",
    machineId: "m1",
    parentId: null,
    title: "Terminal-Test",
    titleSource: "prompt",
    status: "running",
    cwd: "/home/user/projects",
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
    state: "running",
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

/** fetch-Attrappe mit Protokoll aller Anfragen. */
function stub(s: Session, extra: (url: string, init?: RequestInit) => Promise<Response> | undefined = () => undefined, online = true) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const e = extra(url, init);
    if (e) return e;
    if (url.startsWith("/api/auth/status")) return jsonResponse({ authenticated: true, csrf: "csrf-123", hasPasskey: true, authReads: false });
    if (url.startsWith("/api/terminal/status")) return jsonResponse({ online, machineId: online ? "m1" : null, since: null });
    if (url.startsWith("/health")) return jsonResponse({ ok: true });
    if (url.startsWith("/api/machines")) return jsonResponse([]);
    if (url.startsWith("/api/categories")) return jsonResponse({ categories: [{ art: "coding", count: 1, baustellen: [] }] });
    if (url.startsWith("/api/sessions?")) return jsonResponse({ sessions: [s] });
    if (url.startsWith(`/api/sessions/${encodeURIComponent(s.id)}/related`)) return jsonResponse({ parent: null, children: [], sameFiles: [] });
    if (url.startsWith(`/api/sessions/${encodeURIComponent(s.id)}/transcript`)) return jsonResponse({ items: [], nextCursor: null, prevCursor: null, archivedAt: null, sha256: null });
    if (url === `/api/sessions/${encodeURIComponent(s.id)}`) return jsonResponse({ session: s, files: [], archive: [], events: [] });
    return Promise.reject(new Error(`keine Antwort für ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
    },
  );
  return calls;
}

const renderAt = (s: Session) =>
  renderWithClient(
    <MemoryRouter initialEntries={[`/sessions/coding/_/${s.id}`]}>
      <App />
    </MemoryRouter>,
  );

describe("Terminal im Session-Vollbild", () => {
  it("Session in tmux + Brücke online → Reiter an, „Im Terminal öffnen“ klickbar", async () => {
    stub(session({ tmuxName: "zc-claude-abcd1234", attachable: true }));
    renderAt(session({ tmuxName: "zc-claude-abcd1234", attachable: true }));
    await enabledButton("Im Terminal öffnen");
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeEnabled();
  });

  // „Neu starten“/„In NyxOS fortsetzen“ sind in „In der NyxOS übernehmen“ aufgegangen.
  it("abgestürzte Session → „In NyxOS übernehmen“; lehnt der Server ab, steht dort ein verständlicher Satz", async () => {
    const s = session({ state: "crashed", status: "ended" });
    const calls = stub(s, (url) => {
      if (url.endsWith("/takeover/preview")) return jsonResponse({ attachable: false, tool: "claude", processes: [], inNyxOS: null, working: false, recommended: "resume" });
      if (url.endsWith("/takeover")) return jsonResponse({ error: "Das alte Fenster arbeitet noch an dieser Session.", code: "process_running" }, { status: 409 });
      return undefined;
    });
    renderAt(s);
    await userEvent.setup().click(await enabledButton("In NyxOS übernehmen"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/altes Fenster|alte Fenster/);
    const takeover = calls.find((c) => c.url.endsWith("/takeover"));
    expect(new Headers(takeover?.init?.headers).get("x-nyxos-csrf")).toBe("csrf-123");
  });

  it("„Prozess beenden“ nur mit Bestätigung", async () => {
    const s = session({ tmuxName: "zc-claude-abcd1234", attachable: true });
    const calls = stub(s, (url) => (url.endsWith("/kill") ? jsonResponse({ killed: true, via: "tmux" }) : undefined));
    renderAt(s);
    const user = userEvent.setup();
    await user.click(await enabledButton("Prozess beenden"));
    expect(calls.some((c) => c.url.endsWith("/kill"))).toBe(false);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Prozess beenden" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/kill") && c.init?.body === '{"confirm":true}')).toBe(true));
  });

  it("„Nur ansehen“: an bei Sessions aus dem Terminal-Programm, aus bei Sessions aus der NyxOS", () => {
    expect(defaultReadOnly({ startedVia: null })).toBe(true);
    expect(defaultReadOnly({ startedVia: "nyxos" })).toBe(false);
  });
});

describe("Anmeldung im Browser", () => {
  it("401 auf eine schreibende Anfrage öffnet „Bitte anmelden“; ohne Anmeldung geschlossen → freundlicher Fehler", async () => {
    const s = session({});
    stub(s, (url) => (url.endsWith("/close") ? jsonResponse({ error: "Bitte anmelden", code: "auth_required" }, { status: 401 }) : undefined));
    renderAt(s);
    await screen.findByRole("button", { name: "Schließen" });
    // die Aktion wartet auf die Anmeldung (danach liefe sie weiter, s. auth-retry.test.tsx).
    const pending = closeSession("claude:s1");
    const rejected = expect(pending).rejects.toThrow(/anmelden/i);
    const dlg = await screen.findByRole("dialog", { name: "Bitte anmelden" });
    await userEvent.setup().click(within(dlg).getByRole("button", { name: "Später" }));
    await rejected;
  });

  it("offenes Terminal ohne Anmeldung: EIN Dialog, „Später“ schließt ihn dauerhaft, kein Dauerfeuer auf den Status", async () => {
    const s = session({ tmuxName: "zc-claude-abcd1234", attachable: true });
    const calls = stub(s, (url) => (url.startsWith("/api/auth/status") ? jsonResponse({ authenticated: false, csrf: null, hasPasskey: true, authReads: false }) : undefined));
    renderWithClient(
      <MemoryRouter initialEntries={[`/sessions/coding/_/${s.id}?tab=terminal`]}>
        <App />
      </MemoryRouter>,
    );
    const dlg = await screen.findByRole("dialog", { name: "Bitte anmelden" });
    await userEvent.setup().click(within(dlg).getByRole("button", { name: "Später" }));
    const before = calls.filter((c) => c.url.startsWith("/api/auth/status")).length;
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole("dialog", { name: "Bitte anmelden" })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url.startsWith("/api/auth/status")).length - before).toBeLessThanOrEqual(2);
  });
});

describe("+ Neue Session", () => {
  it("öffnet den Dialog aus Tab-Zeile 3 und startet mit Werkzeug, Ordner und erster Nachricht", async () => {
    const s = session({});
    const calls = stub(s, (url) => {
      if (url.startsWith("/api/terminal/folders")) return jsonResponse({ folders: [{ label: "projects", path: "/home/user/projects" }, { label: "App", path: "/home/user/projects/App" }] });
      if (url === "/api/terminal/start") return jsonResponse({ tmuxName: "zc-codex-abcd1234", tool: "codex", sessionId: null, startedMs: 40 });
      return undefined;
    });
    renderAt(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Neue Session" }));
    const dialog = await screen.findByRole("dialog", { name: "Neue Session" });
    await user.click(within(dialog).getByRole("radio", { name: "Codex" }));
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "App" })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText("Ordner"), "/home/user/projects/App");
    await user.type(within(dialog).getByLabelText(/Erste Nachricht/), "Hallo");
    await user.click(within(dialog).getByRole("button", { name: "Starten" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/terminal/start")).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.url === "/api/terminal/start")?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ tool: "codex", model: null, cwd: "/home/user/projects/App", prompt: "Hallo" });
  });
});
