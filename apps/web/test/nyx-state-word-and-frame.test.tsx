// „Rahmen & Nyx-Feinschliff“:
//   • Nyx-Tab: EIN Weck-Knopf, dasselbe Zustandswort wie im Nyx-Zentrum (eine Zuordnung in features/nyx/),
//     der Tab setzt den zuletzt benutzten Faden fort, „Neues Gespräch“ steht nur einmal im Chat-Fuß.
//   • Rahmen: Skills nur einmal in der Leiste, kein Vollbild-Knopf mehr (Vollbild über ⌘K und Taste F).
//   • PageHeader-Baustein (Titel in text-title, Unterzeile, Aktionen), zuerst auf der Agenten-Seite.
import type { HaikuEngineState, HaikuStatus, HaikuThread } from "@nyxos/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { PageHeader } from "../src/components/PageHeader";
import { AgentsView } from "../src/features/agents/AgentsView";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { LAST_THREAD_KEY } from "../src/features/haiku/useHaikuChat";
import { nyxStateWord } from "../src/features/nyx/stateWord";
import { NyxTab } from "../src/features/nyx/tab/NyxTab";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { NAV_ITEMS } from "../src/nav";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function status(state: HaikuEngineState): HaikuStatus {
  return {
    settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
    engine: { kind: "claude-cli", state, available: state === "ready", reason: null, model: state === "ready" ? "haiku" : null },
    reserve: { configured: false, baseUrl: null, model: null },
    today: { day: "2026-09-25", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, budgetUsd: 2 },
    queue: { running: 0, waiting: 0 },
    lastRundgang: null,
  };
}

const THREADS: HaikuThread[] = [
  { id: 7, title: "hallo", topic: "overview", day: "2026-09-25", updatedAt: ago(120), temporary: false, expiresAt: null },
  { id: 3, title: "Deploy-Plan", topic: "server", day: "2026-09-24", updatedAt: ago(60 * 20), temporary: false, expiresAt: null },
];

function stubNyx(opts: { state?: HaikuEngineState; threads?: HaikuThread[] } = {}) {
  __primeAuthForTests();
  const threadLoads: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/haiku/status") return jsonResponse(status(opts.state ?? "ready"));
      if (url === "/api/haiku/threads") return jsonResponse({ threads: opts.threads ?? THREADS });
      const m = /^\/api\/haiku\/threads\/(\d+)$/.exec(url);
      if (m && !init?.method) {
        const id = Number(m[1]);
        threadLoads.push(id);
        return jsonResponse({
          thread: (opts.threads ?? THREADS).find((t) => t.id === id),
          messages: [
            { id: id * 10, role: "user", text: `Frage aus Faden ${id}`, sources: [], estimate: false, createdAt: ago(10) },
            { id: id * 10 + 1, role: "assistant", text: `Antwort aus Faden ${id}`, sources: [], estimate: false, createdAt: ago(9) },
          ],
        });
      }
      if (url.startsWith("/api/graph")) return jsonResponse({ version: 1, nodes: [], links: [], stats: { nodes: 0, links: 0, orphans: 0, byType: {}, byKind: {}, builtAt: "", buildMs: 0, sources: [] } });
      if (url.startsWith("/api/haiku/tools")) return jsonResponse({ tools: [] });
      if (url.startsWith("/api/nyx/live")) return jsonResponse({ state: { state: "idle", at: new Date(0).toISOString() }, tasks: [] });
      if (url.startsWith("/api/nyx/files")) return jsonResponse({ files: [] });
      if (url === "/api/open-questions") return jsonResponse({ approvals: 0, inbox: 0, conflicts: 0, total: 0 });
      if (url.startsWith("/api/inbox")) return jsonResponse({ items: [] });
      if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
      if (url === "/api/context-guard/settings") return jsonResponse({ default: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, haiku: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, models: [], sessions: [] });
      return jsonResponse({}, { status: 404 });
    }),
  );
  return { threadLoads };
}

function renderTab() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/nyx"]}>
      <Routes>
        <Route path="/nyx" element={<NyxTab />} />
        <Route path="/overview" element={<p>Überblick-Seite</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ein Zustandswort für Nyx (Tab, Zentrum, Leiste)", () => {
  it("eine Zuordnung: Motor bereit + nichts los → „bereit“, Tätigkeiten haben eigene Wörter und Farben", () => {
    expect(nyxStateWord("ready", "idle").word).toBe("bereit");
    expect(nyxStateWord("ready", "listening").word).toBe("hört zu");
    expect(nyxStateWord("ready", "thinking").word).toBe("denkt nach");
    expect(nyxStateWord("ready", "speaking").word).toBe("spricht");
    expect(nyxStateWord("ready", "tool").word).toBe("arbeitet");
    expect(nyxStateWord("waiting_token", "idle").word).toBe("nicht verbunden");
    expect(nyxStateWord("off", "idle").word).toBe("aus");
    expect(nyxStateWord("error", "idle").word).toBe("gestört");
    expect(nyxStateWord(undefined, "idle").word).toBe("wird geprüft");
    // Nie „ruht“: das Wort gab es nur im Tab, das Zentrum sagte gleichzeitig „Bereit“.
    const all = (["ready", "waiting_token", "off", "error", undefined] as const).flatMap((e) => (["idle", "listening", "thinking", "speaking", "tool"] as const).map((a) => nyxStateWord(e, a).word));
    expect(all).not.toContain("ruht");
    // Farben nur aus Tokens (a-*), je Wort eine eigene Farbe.
    for (const a of ["idle", "listening", "thinking", "speaking", "tool"] as const) expect(nyxStateWord("ready", a).text).toMatch(/^text-a-/);
    expect(new Set((["idle", "listening", "thinking", "speaking"] as const).map((a) => nyxStateWord("ready", a).text)).size).toBe(4);
  });

  it("Nyx-Tab und Nyx-Zentrum zeigen im Ruhezustand dasselbe Wort", async () => {
    stubNyx();
    const tab = renderTab();
    const chip = await screen.findByRole("status");
    await waitFor(() => expect(chip).toHaveTextContent("bereit"));
    expect(chip).not.toHaveTextContent("ruht");
    tab.unmount();

    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/overview"]}>
        <HaikuRoot />
      </MemoryRouter>,
    );
    await user.keyboard("{Meta>}j{/Meta}");
    const panel = await screen.findByRole("dialog", { name: "Nyx" });
    const word = await within(panel).findByTestId("nyx-zustandswort");
    await waitFor(() => expect(word).toHaveTextContent(/^bereit/));
  });

  it("Zentrum: die technische Wächter-Zeile steht nicht mehr im Kopf (gehört in die Einstellungen)", async () => {
    stubNyx();
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/overview"]}>
        <HaikuRoot />
      </MemoryRouter>,
    );
    await user.keyboard("{Meta>}j{/Meta}");
    const panel = await screen.findByRole("dialog", { name: "Nyx" });
    await within(panel).findByTestId("nyx-zustandswort");
    expect(within(panel).queryByText(/Kontext-Wächter/)).toBeNull();
  });

  it("Nyx-Leiste: der Zustand steht in der Textschrift, nicht in Monoschrift", async () => {
    stubNyx();
    renderWithClient(
      <MemoryRouter initialEntries={["/overview"]}>
        <HaikuRoot />
      </MemoryRouter>,
    );
    const bar = await screen.findByTestId("nyx-bar");
    await waitFor(() => expect(bar).toHaveAttribute("data-engine-state", "ready"));
    const word = within(bar).getByText("bereit");
    expect(word.className).not.toMatch(/font-mono/);
    expect(word.closest(".font-mono")).toBeNull();
  });
});

describe("Nyx-Tab: ein Weck-Knopf, Faden fortsetzen", () => {
  it("es gibt genau EINEN Knopf zum Wecken (unten, der große Mikro-Knopf)", async () => {
    stubNyx();
    renderTab();
    await screen.findByRole("status");
    const wake = screen.getAllByRole("button", { name: /weck/i });
    expect(wake).toHaveLength(1);
    expect(wake[0]).toHaveAttribute("data-nyx", "nyx-sprechen");
    expect(document.querySelector('[data-nyx="nyx-aufwecken"]')).toBeNull();
  });

  it("öffnet den zuletzt benutzten Faden (wie das Zentrum) statt leer zu beginnen", async () => {
    const { threadLoads } = stubNyx();
    renderTab();
    expect(await screen.findByText("Antwort aus Faden 7")).toBeInTheDocument();
    expect(threadLoads).toEqual([7]);
    expect(screen.queryByText("Noch kein Gespräch.")).toBeNull();
  });

  it("gemerkter Faden aus dem Zentrum gilt auch im Tab (ein gemeinsames Gedächtnis)", async () => {
    localStorage.setItem(LAST_THREAD_KEY, "3");
    const { threadLoads } = stubNyx();
    renderTab();
    expect(await screen.findByText("Antwort aus Faden 3")).toBeInTheDocument();
    expect(threadLoads).toEqual([3]);
  });

  it("„Neues Gespräch“ steht nur einmal im Fuß; Klick leert den Chat und merkt „neu“ für Tab und Zentrum", async () => {
    stubNyx();
    renderTab();
    await screen.findByText("Antwort aus Faden 7");
    const panel = screen.getByRole("tabpanel", { name: "Chat" });
    expect(within(panel).getAllByText("Neues Gespräch")).toHaveLength(1);
    // Der Fuß sagt, welcher Faden gerade läuft (Titel statt „Gespräch #7“).
    expect(within(panel).getByText("hallo")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Neues Gespräch" }));
    await waitFor(() => expect(screen.queryByText("Antwort aus Faden 7")).toBeNull());
    expect(localStorage.getItem(LAST_THREAD_KEY)).toBe("neu");
    expect(within(panel).getAllByText("Neues Gespräch")).toHaveLength(1);
  });

  it("„neu“ gemerkt → der Tab bleibt leer und lädt keinen alten Faden", async () => {
    localStorage.setItem(LAST_THREAD_KEY, "neu");
    const { threadLoads } = stubNyx();
    renderTab();
    expect(await screen.findByText("Noch kein Gespräch.")).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(threadLoads).toEqual([]);
  });
});

describe("Rahmen: Leiste, Kopfzeile, Vollbild", () => {
  it("Skills steht nur einmal in der Leiste; der Agenten-Eintrag heißt nur „Agenten“", () => {
    expect(NAV_ITEMS.filter((i) => /skill/i.test(i.label))).toHaveLength(1);
    expect(NAV_ITEMS.find((i) => i.id === "agent")?.label).toBe("Agenten");
    expect(NAV_ITEMS.find((i) => i.id === "skills")).toMatchObject({ path: "/skills" });
  });

  it("die Kopfzeile hat keinen Vollbild-Knopf mehr", async () => {
    stubFetchRoutes({});
    renderWithClient(
      <MemoryRouter initialEntries={["/tasks"]}>
        <App />
      </MemoryRouter>,
    );
    const bar = await screen.findByTestId("topbar");
    expect(within(bar).queryByRole("button", { name: /Vollbild/ })).toBeNull();
  });

  it("Vollbild geht über ⌘K („Vollbild“) und über die Taste F", async () => {
    stubFetchRoutes({});
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", { value: request, configurable: true });
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/tasks"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByTestId("topbar");
    fireEvent.keyDown(document.body, { key: "f" });
    expect(request).toHaveBeenCalledTimes(1);

    // Beim Tippen ist F ein Buchstabe, kein Vollbild.
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "f" });
    expect(request).toHaveBeenCalledTimes(1);
    input.remove();

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "Befehlspalette" });
    const row = within(dialog).getByRole("option", { name: /Vollbild/ });
    expect(row).toHaveTextContent("F");
    await user.click(row);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("PageHeader", () => {
  it("Titel in text-title, Unterzeile und Aktionen", () => {
    renderWithClient(<PageHeader title="Agenten" sub="2 laufen gerade" actions={<button type="button">Tu was</button>} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Agenten" });
    expect(h1.className).toMatch(/\btext-title\b/);
    expect(screen.getByText("2 laufen gerade")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tu was" })).toBeInTheDocument();
  });

  it("die Agenten-Seite nutzt ihn: Titel „Agenten“, Link zu den Skills", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/agents/runs")) return jsonResponse({ runs: [] });
        if (url.startsWith("/api/agents/catalog")) return jsonResponse({ catalog: [] });
        if (url.startsWith("/api/agents/skills/usage")) return jsonResponse({ skills: [] });
        if (url.startsWith("/api/agents/anomalies")) return jsonResponse({ anomalies: [] });
        return Promise.reject(new Error(`unerwartete URL ${url}`));
      }),
    );
    renderWithClient(
      <MemoryRouter initialEntries={["/agents"]}>
        <AgentsView />
      </MemoryRouter>,
    );
    const h1 = await screen.findByRole("heading", { level: 1, name: "Agenten" });
    expect(h1.closest("[data-page-header]")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Skills/ })).toHaveAttribute("href", "/skills");
  });
});
