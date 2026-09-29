// Haiku-Knopf und -Panel: Motor-Zustand schon am Knopf, der zuletzt benutzte Faden kommt beim Öffnen
// zurück, Fadenliste mit Suche und Restzeit, Schalter „Temporär“ für einen neuen Wegwerf-Faden.
import type { HaikuEngineState, HaikuStatus, HaikuThread } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { LAST_THREAD_KEY } from "../src/features/haiku/useHaikuChat";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function status(state: HaikuEngineState): HaikuStatus {
  return {
    settings: { engine: "claude-cli", dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
    engine: { kind: "claude-cli", state, available: state === "ready", reason: state === "ready" ? null : "Wartet auf deinen Token.", model: state === "ready" ? "haiku" : null },
    reserve: { configured: false, baseUrl: null, model: null },
    today: { day: "2026-09-25", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, budgetUsd: 2 },
    queue: { running: 0, waiting: 0 },
    lastRundgang: null,
  };
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const THREADS: HaikuThread[] = [
  { id: 7, title: "Was wartet gerade?", topic: "sessions", day: "2026-09-25", updatedAt: ago(5), temporary: false, expiresAt: null },
  { id: 3, title: "Kurzer Test mit Codex", topic: "overview", day: "2026-09-25", updatedAt: ago(90), temporary: true, expiresAt: inHours(4.2) },
  { id: 2, title: "Deploy-Plan für Freitag", topic: "server", day: "2026-09-24", updatedAt: ago(60 * 20), temporary: false, expiresAt: null },
];

function stub(opts: { state?: HaikuEngineState; threads?: HaikuThread[] } = {}) {
  const threadLoads: number[] = [];
  const chatBodies: Record<string, unknown>[] = [];
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/haiku/status") return jsonResponse(status(opts.state ?? "ready"));
    if (url.startsWith("/api/inbox")) return jsonResponse({ items: [] });
    if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
    if (url === "/api/haiku/threads") return jsonResponse({ threads: opts.threads ?? THREADS });
    const m = /^\/api\/haiku\/threads\/(\d+)$/.exec(url);
    if (m && !init?.method) {
      const id = Number(m[1]);
      threadLoads.push(id);
      const thread = (opts.threads ?? THREADS).find((t) => t.id === id);
      return jsonResponse({
        thread,
        messages: [
          { id: id * 10, role: "user", text: `Frage aus Faden ${id}`, sources: [], estimate: false, createdAt: ago(10) },
          { id: id * 10 + 1, role: "assistant", text: `Antwort aus Faden ${id}`, sources: [], estimate: true, createdAt: ago(9) },
        ],
      });
    }
    if (url === "/api/context-guard/settings") return jsonResponse({ default: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, haiku: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, models: [], sessions: [] });
    if (url === "/api/haiku/chat" && init?.method === "POST") {
      chatBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(new Response('{"type":"thread","threadId":11}\n{"type":"done","messageId":1,"text":"Ok.","sources":[],"estimate":true,"usage":{"inputTokens":1,"outputTokens":1,"costUsd":0,"durationMs":1}}\n', { status: 200 }));
    }
    return Promise.reject(new Error(`unerwartet ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return { impl, threadLoads, chatBodies };
}

function renderRoot() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/sessions"]}>
      <HaikuRoot />
    </MemoryRouter>,
  );
}

const launcher = () => screen.getByRole("button", { name: /^Nyx/ });

/**
 * Stabil auch unter Last: Panel öffnen und warten, bis es WIRKLICH offen ist (`data-state="open"`).
 * Das Panel blendet im nächsten Frame ein und setzt dann den Fokus ins Eingabefeld. Tippte der Test vorher
 * schon in die Fadensuche, landete der Rest der Buchstaben im Eingabefeld („de“ statt „deploy“ → Filter
 * griff nicht). Dasselbe gilt für dich: erst wenn das Panel offen ist, steht der Fokus fest.
 */
async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(launcher());
  const panel = await screen.findByRole("dialog", { name: "Nyx" });
  await waitFor(() => expect(panel).toHaveAttribute("data-state", "open"));
  await waitFor(() => expect(within(panel).getByRole("textbox", { name: "Frage an Nyx" })).toHaveFocus());
  return panel;
}

describe("Knopf zeigt den Motor-Zustand, bevor man schreibt", () => {
  it("wartet auf Token: sichtbar am Knopf (Name + Zustand), ohne das Panel zu öffnen", async () => {
    stub({ state: "waiting_token" });
    renderRoot();
    await waitFor(() => expect(launcher()).toHaveAttribute("data-engine-state", "waiting_token"));
    expect(launcher()).toHaveAccessibleName(/nicht verbunden/i);
    expect(screen.queryByRole("dialog", { name: "Nyx" })).not.toBeInTheDocument();
  });

  it("bereit: Knopf meldet „bereit“", async () => {
    stub({ state: "ready" });
    renderRoot();
    await waitFor(() => expect(launcher()).toHaveAttribute("data-engine-state", "ready"));
    expect(launcher()).toHaveAccessibleName(/bereit/i);
  });
});

describe("der zuletzt benutzte Faden kommt zurück", () => {
  it("gemerkter Faden wird beim Öffnen geladen – auch nach Schließen und erneutem Öffnen", async () => {
    localStorage.setItem(LAST_THREAD_KEY, "3");
    const { threadLoads } = stub();
    const user = userEvent.setup();
    renderRoot();
    const panel = await openPanel(user);
    expect(await within(panel).findByText("Antwort aus Faden 3")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nyx" })).not.toBeInTheDocument());
    await user.keyboard("{Meta>}j{/Meta}");
    const again = await screen.findByRole("dialog", { name: "Nyx" });
    expect(within(again).getByText("Antwort aus Faden 3")).toBeInTheDocument();
    expect(threadLoads).toEqual([3]);
  });

  it("nichts gemerkt → der jüngste Faden", async () => {
    stub();
    const user = userEvent.setup();
    renderRoot();
    const panel = await openPanel(user);
    expect(await within(panel).findByText("Antwort aus Faden 7")).toBeInTheDocument();
  });

  it("gemerkter Faden existiert nicht mehr (abgelaufen) → leer statt Fehler (wie der Nyx-Tab, kein fremder Faden)", async () => {
    localStorage.setItem(LAST_THREAD_KEY, "99");
    stub();
    const user = userEvent.setup();
    renderRoot();
    const panel = await openPanel(user);
    const list = await within(panel).findByRole("list", { name: "Fäden" });
    expect(within(list).getByText("Was wartet gerade?")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(within(panel).queryByText("Antwort aus Faden 7")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Fadenliste mit Titel, Zeit, Suche und Restzeit", () => {
  it("Liste zeigt Titel + Zeit, temporäre mit ⏳ und Restzeit; Suche filtert; Klick öffnet", async () => {
    stub();
    const user = userEvent.setup();
    renderRoot();
    const panel = await openPanel(user);
    // Fäden stehen immer oben im Panel (von oben nach unten: Fäden, darunter das Gespräch).
    const list = await within(panel).findByRole("list", { name: "Fäden" });
    expect(within(list).getByText("Was wartet gerade?")).toBeInTheDocument();
    expect(within(list).getByText("vor 5 Min")).toBeInTheDocument();
    const temp = within(list).getByText("Kurzer Test mit Codex").closest("li") as HTMLElement;
    expect(within(temp).getByText(/⏳\s*4 Std/)).toBeInTheDocument();

    await user.type(within(panel).getByRole("searchbox", { name: "Fäden durchsuchen" }), "deploy");
    expect(within(list).queryByText("Was wartet gerade?")).not.toBeInTheDocument();
    await user.click(within(list).getByText("Deploy-Plan für Freitag"));
    expect(await within(panel).findByText("Antwort aus Faden 2")).toBeInTheDocument();
    expect(localStorage.getItem(LAST_THREAD_KEY)).toBe("2");
  });

  it("„Neuer Faden“ + Schalter „Temporär“ → erste Frage legt einen temporären Faden an", async () => {
    const { chatBodies } = stub();
    const user = userEvent.setup();
    renderRoot();
    const panel = await openPanel(user);
    await within(panel).findByText("Antwort aus Faden 7");
    await user.click(within(panel).getByRole("button", { name: "Neuer Faden" }));
    const toggle = within(panel).getByRole("switch", { name: /Temporär/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.type(within(panel).getByRole("textbox", { name: "Frage an Nyx" }), "Nur kurz testen{Enter}");
    await waitFor(() => expect(chatBodies).toHaveLength(1));
    expect(chatBodies[0]).toMatchObject({ threadId: null, message: "Nur kurz testen", temporary: true });
    await waitFor(() => expect(localStorage.getItem(LAST_THREAD_KEY)).toBe("11"));
  });
});
