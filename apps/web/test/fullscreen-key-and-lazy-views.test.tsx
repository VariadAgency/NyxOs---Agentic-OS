// Grenzfälle: Vollbild-Taste F, letzter Faden im Nyx-Tab, nachgeladene Ansichten.
//   1. Taste F: ein VERSTECKTER Dialog (Nyx-Zentrum bleibt nach dem ersten Öffnen mit `hidden` + aria-modal im DOM)
//      darf F nicht für immer sperren; Umschalt+F (und ⌘F/⌥F) bleiben frei; in Terminal/role=textbox nie.
//   2. Nyx-Tab, letzter Faden: kein Telegram-Faden im Tab; gemerkter, aber gelöschter/archivierter Faden → leer.
//   3. Nachgeladene Ansichten (Finder, Gehirn): Fehler beim Laden → Hinweis statt weißer Seite.
import type { HaikuStatus, HaikuThread } from "@nyxos/shared";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { LazyView } from "../src/components/LazyView";
import { LAST_THREAD_KEY } from "../src/features/haiku/useHaikuChat";
import { NyxTab } from "../src/features/nyx/tab/NyxTab";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { isModalOpen, isTypingTarget } from "../src/lib/keyboard";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const STATUS: HaikuStatus = {
  settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
  engine: { kind: "claude-cli", state: "ready", available: true, reason: null, model: "haiku" },
  reserve: { configured: false, baseUrl: null, model: null },
  today: { day: "2026-09-25", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, budgetUsd: 2 },
  queue: { running: 0, waiting: 0 },
  lastRundgang: null,
};

function stubTab(threads: HaikuThread[]) {
  __primeAuthForTests();
  const loads: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/haiku/status") return jsonResponse(STATUS);
      if (url === "/api/haiku/threads") return jsonResponse({ threads });
      const m = /^\/api\/haiku\/threads\/(\d+)$/.exec(url);
      if (m && !init?.method) {
        const id = Number(m[1]);
        loads.push(id);
        return jsonResponse({ thread: threads.find((t) => t.id === id), messages: [{ id: id * 10, role: "assistant", text: `Antwort aus Faden ${id}`, sources: [], estimate: false, createdAt: ago(5) }] });
      }
      if (url.startsWith("/api/graph")) return jsonResponse({ version: 1, nodes: [], links: [], stats: { nodes: 0, links: 0, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } });
      if (url.startsWith("/api/haiku/tools")) return jsonResponse({ tools: [] });
      if (url.startsWith("/api/nyx/live")) return jsonResponse({ state: { state: "idle", at: new Date(0).toISOString() }, tasks: [] });
      if (url.startsWith("/api/nyx/files")) return jsonResponse({ files: [] });
      return jsonResponse({}, { status: 404 });
    }),
  );
  return { loads };
}

function renderTab() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/nyx"]}>
      <Routes>
        <Route path="/nyx" element={<NyxTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Taste F", () => {
  function setup() {
    stubFetchRoutes({});
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", { value: request, configurable: true });
    renderWithClient(
      <MemoryRouter initialEntries={["/tasks"]}>
        <App />
      </MemoryRouter>,
    );
    return request;
  }

  it("ein versteckter Dialog (Nyx-Zentrum nach dem Schließen) sperrt F nicht", async () => {
    const request = setup();
    await screen.findByTestId("topbar");
    const hiddenSheet = document.createElement("div");
    hiddenSheet.setAttribute("role", "dialog");
    hiddenSheet.setAttribute("aria-modal", "true");
    hiddenSheet.hidden = true;
    document.body.appendChild(hiddenSheet);
    fireEvent.keyDown(document.body, { key: "f" });
    expect(request).toHaveBeenCalledTimes(1);
    // Sichtbar offen → F bleibt ein Buchstabe des Dialogs.
    hiddenSheet.hidden = false;
    fireEvent.keyDown(document.body, { key: "f" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("mit Umschalt-, Befehls-, Control- oder Wahltaste passiert nichts (⌘F bleibt die Browser-Suche)", async () => {
    const request = setup();
    await screen.findByTestId("topbar");
    for (const mod of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const ev = new KeyboardEvent("keydown", { key: mod.shiftKey ? "F" : "f", bubbles: true, cancelable: true, ...mod });
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("im Terminal, in role=textbox und während einer Eingabe-Komposition kein Vollbild", async () => {
    const request = setup();
    await screen.findByTestId("topbar");
    const term = document.createElement("div");
    term.className = "xterm";
    const inner = document.createElement("div");
    inner.tabIndex = 0;
    term.appendChild(inner);
    const box = document.createElement("div");
    box.setAttribute("role", "textbox");
    box.tabIndex = 0;
    document.body.append(term, box);
    fireEvent.keyDown(inner, { key: "f" });
    fireEvent.keyDown(box, { key: "f" });
    fireEvent.keyDown(document.body, { key: "f", isComposing: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("Hilfen: isTypingTarget / isModalOpen", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isModalOpen()).toBe(false);
  });
});

describe("Nyx-Tab, letzter Faden", () => {
  const web: HaikuThread = { id: 7, title: "hallo", topic: "overview", day: "2026-09-25", updatedAt: ago(120), temporary: false, expiresAt: null };
  const telegram: HaikuThread = { id: 9, title: "Telegram: bin unterwegs", topic: "telegram", day: "2026-09-25", updatedAt: ago(5), temporary: false, expiresAt: null };

  it("der jüngste Faden ist ein Telegram-Faden → der Tab nimmt den jüngsten Web-Faden", async () => {
    const { loads } = stubTab([telegram, web]);
    renderTab();
    expect(await screen.findByText("Antwort aus Faden 7")).toBeInTheDocument();
    expect(loads).toEqual([7]);
  });

  it("gemerkt ist ein Telegram-Faden → der Tab bleibt leer (setzt nie im Telegram-Faden fort)", async () => {
    localStorage.setItem(LAST_THREAD_KEY, "9");
    const { loads } = stubTab([telegram, web]);
    renderTab();
    expect(await screen.findByText("Noch kein Gespräch.")).toBeInTheDocument();
    await settle();
    expect(loads).toEqual([]);
  });

  it("gemerkter Faden wurde gelöscht/archiviert (nicht mehr in der Liste) → sauber leer, kein fremder Faden", async () => {
    localStorage.setItem(LAST_THREAD_KEY, "42");
    const { loads } = stubTab([web]);
    renderTab();
    expect(await screen.findByText("Noch kein Gespräch.")).toBeInTheDocument();
    await settle();
    expect(loads).toEqual([]);
  });
});

describe("nachgeladene Ansicht", () => {
  it("Laden scheitert (z. B. altes Bundle nach Deploy) → Hinweis mit „Neu laden“ statt weißer Seite", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw new Error("Failed to fetch dynamically imported module");
    }
    render(
      <LazyView>
        <Broken />
      </LazyView>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/konnte nicht geladen werden/i);
    expect(screen.getByRole("button", { name: "Neu laden" })).toBeInTheDocument();
  });
});
