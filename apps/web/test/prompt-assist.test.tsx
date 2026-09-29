// Prompt verbessern im Session-Chat: Entwurf → Sonnet-Ergebnis, Rückfragen anhaken → Antworten gehen
// mit, Abschicken über den bestehenden Chat-Weg (mit Bestätigung, wenn die Session arbeitet), Kopieren.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { __resetPendingForTests } from "../src/features/session-chat/pending";
import type { Session } from "../src/lib/api";
import { isRiskyElement } from "../src/features/nyx/uiExecutor";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

const NOW = Date.now();
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "claude:chat",
    tool: "claude",
    sessionId: "chat",
    machineId: null,
    parentId: null,
    title: "Chat-Eingabe bauen",
    titleSource: null,
    status: "running",
    cwd: "/home/alex/projects/NyxOS",
    gitBranch: null,
    cliVersion: null,
    startedAt: iso(60),
    lastActivityAt: iso(1),
    endedAt: null,
    models: ["claude-opus-4-1", "claude-opus-5-5"],
    lastUsageModel: "claude-opus-5-5",
    tokens: {},
    tokensTotal: 1_234_567,
    toolCalls: { Bash: 3 },
    subagents: [{ id: "a1", name: "Prüfer", type: null }],
    limits: null,
    parsedEventCount: 10,
    eventCount: 10,
    parseErrors: 0,
    state: "waiting",
    closedAt: null,
    closedBy: null,
    categoryRuleId: null,
    categoryManual: false,
    art: "coding",
    baustelle: null,
    reason: [],
    attachable: true,
    tmuxName: "zc-claude-abcd1234",
    contextPct: 42,
    contextWindow: 1_000_000,
    contextWindowSource: "model",
    ...over,
  };
}

const CATEGORIES = [{ art: "coding", count: 1, baustellen: [{ slug: null, label: "Ohne Baustelle", count: 1 }] }];
const msg = (id: string, role: "user" | "assistant", text: string, minAgo = 5) => ({ id, ts: iso(minAgo), role, text, thinking: false as const });

interface Opts {
  session?: Session;
  items?: ReturnType<typeof msg>[];
  chat?: Record<string, unknown>;
  audits?: Record<string, unknown> | (() => Record<string, unknown>);
  guard?: Record<string, unknown>;
  onPost?: (url: string, body: unknown, init?: RequestInit) => Promise<Response> | undefined;
}

function setup(o: Opts = {}) {
  const session = o.session ?? makeSession();
  const items = o.items ?? [msg("m1", "user", "Hallo Claude"), msg("m2", "assistant", "Hallo Alex")];
  const fetchMock = stubFetchRoutes({
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    sessions: () => jsonResponse({ sessions: [session] }),
    categories: () => jsonResponse({ categories: CATEGORIES }),
    fallback: (url, init) => {
      if (init?.method === "POST") {
        const r = o.onPost?.(url, init.body ? JSON.parse(String(init.body)) : null, init);
        if (r) return r;
      }
      if (url.includes("/transcript")) return jsonResponse({ items, nextCursor: null, prevCursor: null, archivedAt: null, sha256: "a" });
      if (url.endsWith("/chat")) return jsonResponse(o.chat ?? { canSend: true, reason: null, message: null, busy: false });
      if (url.endsWith("/audits")) return jsonResponse((typeof o.audits === "function" ? o.audits() : o.audits) ?? { engine: { ready: true, state: "ready", reason: null }, audits: [] });
      if (/\/api\/sessions\/[^/?]+(?:\?|$)/.test(url)) return jsonResponse({ session, files: [], archive: [], events: [] });
      return undefined;
    },
  });
  // Kontext-Wächter + Brücken-Status liegen nicht unter /api/sessions — eigene Weiche davor.
  const inner = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/context-guard/sessions/") && init?.method !== "POST")
      return jsonResponse(o.guard ?? { sessionKey: session.id, thresholds: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80, source: "default" }, pct: 42, hint: false, forced: false, attachable: true, state: session.state });
    if (url.startsWith("/api/context-guard/sessions/") && init?.method === "POST") {
      const r = o.onPost?.(url, init.body ? JSON.parse(String(init.body)) : null, init);
      if (r) return r;
    }
    if (url.startsWith("/api/terminal/status")) return jsonResponse({ online: true, machineId: "m1", since: iso(10) });
    return (inner as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>)(input, init);
  });
  const view = renderWithClient(
    <MemoryRouter initialEntries={[`/sessions/coding/_/${session.id}`]}>
      <App />
    </MemoryRouter>,
  );
  return { fetchMock, view, session };
}

beforeEach(() => {
  __resetPendingForTests();
  try {
    localStorage.clear();
  } catch {
    // kein Speicher
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const RESULT = {
  prompt: "Ziel: Chat-Eingabe mit Anhängen fertig bauen.\n\nAbnahme: Tests grün.",
  aenderungen: ["Tippfehler geglättet", "Abnahme ergänzt"],
  verstaendnis: "mittel",
  fragen: [] as unknown[],
  model: "claude-sonnet-5",
  effort: "high",
  costUsd: 0.01,
  durationMs: 1200,
};
const QUESTIONS = [
  { id: "f1", frage: "Welche Dateitypen?", optionen: ["Bilder", "PDF", "Videos"], mehrfach: true },
  { id: "f2", frage: "Tests zuerst?", optionen: ["Ja", "Nein"], mehrfach: false },
  { id: "f3", frage: "Was noch?", optionen: [], mehrfach: false },
];

type Post = { url: string; body: Record<string, unknown> };

function withAssist(posts: Post[], answer: (body: Record<string, unknown>) => unknown = () => RESULT) {
  return (url: string, body: unknown) => {
    posts.push({ url, body: body as Record<string, unknown> });
    if (url.endsWith("/prompt-assist")) return jsonResponse(answer(body as Record<string, unknown>));
    if (url.endsWith("/message")) return jsonResponse({ sent: true, queued: false, attachments: [] });
    return undefined;
  };
}

async function openAssist(draft: string) {
  await userEvent.click(await screen.findByRole("button", { name: "✦ Prompt verbessern" }));
  const panel = await screen.findByTestId("prompt-assist");
  await userEvent.type(within(panel).getByLabelText(/Dein Entwurf/), draft);
  return panel;
}

beforeEach(() => {
  __resetPendingForTests();
  try {
    localStorage.clear();
  } catch {
    // kein Speicher
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Prompt verbessern", { timeout: 30_000 }, () => {
  it("Verbessern schickt den Entwurf an Sonnet und zeigt Prompt + „Was ich verbessert habe“; Entwurf bleibt gemerkt", async () => {
    const posts: Post[] = [];
    setup({ onPost: withAssist(posts) });
    const panel = await openAssist("mach die chat eingabe fertig bidde");
    expect(within(panel).getByText("Sonnet 5 · Reasoning hoch")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: /^Verbessern/ }));
    const result = await within(panel).findByLabelText("Verbesserter Prompt");
    expect(result).toHaveValue(RESULT.prompt);
    expect(within(panel).getByText("Tippfehler geglättet")).toBeInTheDocument();
    const call = posts.find((p) => p.url.endsWith("/prompt-assist"));
    expect(call?.url).toBe("/api/sessions/claude%3Achat/prompt-assist");
    expect(call?.body).toEqual({ entwurf: "mach die chat eingabe fertig bidde", modus: "verbessern" });
    // je Session gemerkt
    expect(localStorage.getItem("nyx.prompt-assist.claude:chat")).toContain("mach die chat eingabe fertig bidde");
  });

  it("Fragen stellen → Optionen anhaken + Freitext → „Antworten übernehmen“ schickt die Antworten mit, neue Version", async () => {
    const posts: Post[] = [];
    setup({ onPost: withAssist(posts, (b) => (b.modus === "fragen" ? { ...RESULT, fragen: QUESTIONS } : { ...RESULT, prompt: "Version mit Antworten" })) });
    const panel = await openAssist("irgendwas mit anhängen");
    await userEvent.click(within(panel).getAllByRole("button", { name: "Fragen stellen" })[0] as HTMLElement);
    const questions = await within(panel).findByTestId("prompt-assist-questions");
    await userEvent.click(within(questions).getByRole("checkbox", { name: /Bilder/ }));
    await userEvent.click(within(questions).getByRole("checkbox", { name: /PDF/ }));
    await userEvent.click(within(questions).getByRole("radio", { name: /Ja/ }));
    await userEvent.type(within(questions).getByLabelText("Eigene Antwort: Was noch?"), "keine Videos");
    await userEvent.click(within(panel).getByRole("button", { name: "Antworten übernehmen" }));
    await waitFor(() => expect(within(panel).getByLabelText("Verbesserter Prompt")).toHaveValue("Version mit Antworten"));
    const last = posts.filter((p) => p.url.endsWith("/prompt-assist")).at(-1);
    expect(last?.body).toMatchObject({
      modus: "verbessern",
      bisher: RESULT.prompt,
      antworten: [
        { frage: "Welche Dateitypen?", auswahl: ["Bilder", "PDF"] },
        { frage: "Tests zuerst?", auswahl: ["Ja"] },
        { frage: "Was noch?", text: "keine Videos" },
      ],
    });
    expect(within(panel).getByTestId("prompt-assist-version")).toHaveTextContent("Version 2 von 2");
    await userEvent.click(within(panel).getByRole("button", { name: "Vorige Version" }));
    expect(within(panel).getByLabelText("Verbesserter Prompt")).toHaveValue(RESULT.prompt);
  });

  it("Abschicken nutzt den bestehenden Session-Weg (/message) mit dem verbesserten Prompt", async () => {
    const posts: Post[] = [];
    setup({ onPost: withAssist(posts) });
    const panel = await openAssist("fertig machen");
    await userEvent.click(within(panel).getByRole("button", { name: /^Verbessern/ }));
    await within(panel).findByLabelText("Verbesserter Prompt");
    await userEvent.click(within(panel).getByRole("button", { name: /Abschicken/ }));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/message"))).toBe(true));
    expect(posts.find((p) => p.url.endsWith("/message"))?.body).toEqual({ text: RESULT.prompt, attachments: [] });
    expect(await screen.findByTestId("chat-pending")).toHaveTextContent("Ziel: Chat-Eingabe");
  });

  it("Session arbeitet gerade → erst Bestätigung, dann Abschicken", async () => {
    const posts: Post[] = [];
    setup({ session: makeSession({ state: "running" }), chat: { canSend: true, reason: null, message: null, busy: true }, onPost: withAssist(posts) });
    const panel = await openAssist("fertig machen");
    await userEvent.click(within(panel).getByRole("button", { name: /^Verbessern/ }));
    await within(panel).findByLabelText("Verbesserter Prompt");
    await userEvent.click(within(panel).getByRole("button", { name: /Abschicken/ }));
    expect(await within(panel).findByRole("alertdialog")).toHaveTextContent(/arbeitet gerade/);
    expect(posts.some((p) => p.url.endsWith("/message"))).toBe(false);
    await userEvent.click(within(panel).getByRole("button", { name: "Trotzdem abschicken" }));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/message"))).toBe(true));
  });

  it("Nyx darf „Abschicken“/„Trotzdem abschicken“ selbst klicken, wenn du es willst (Senden steht nicht auf der Freigabe-Liste)", async () => {
    const posts: Post[] = [];
    setup({ session: makeSession({ state: "running" }), chat: { canSend: true, reason: null, message: null, busy: true }, onPost: withAssist(posts) });
    const panel = await openAssist("fertig machen");
    await userEvent.click(within(panel).getByRole("button", { name: /^Verbessern/ }));
    await within(panel).findByLabelText("Verbesserter Prompt");
    const send = within(panel).getByRole("button", { name: /Abschicken/ });
    expect(isRiskyElement(send)).toBe(false);
    await userEvent.click(send);
    expect(isRiskyElement(await within(panel).findByRole("button", { name: "Trotzdem abschicken" }))).toBe(false);
  });

  it("Kopieren legt den Prompt in die Zwischenablage; „In Eingabefeld übernehmen“ füllt die Eingabezeile", async () => {
    const posts: Post[] = [];
    setup({ onPost: withAssist(posts) });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const panel = await openAssist("fertig machen");
    await userEvent.click(within(panel).getByRole("button", { name: /^Verbessern/ }));
    await within(panel).findByLabelText("Verbesserter Prompt");
    await userEvent.click(within(panel).getByRole("button", { name: "Kopieren" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RESULT.prompt));
    expect(await within(panel).findByText("Kopiert.")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "In Eingabefeld übernehmen" }));
    expect(screen.getByRole("textbox", { name: "Nachricht an Claude" })).toHaveValue(RESULT.prompt);
  });

  it("Fehler von Sonnet wird ehrlich angezeigt", async () => {
    setup({ onPost: (url) => (url.endsWith("/prompt-assist") ? jsonResponse({ error: "Sonnet hat keinen brauchbaren Prompt geliefert." }, { status: 502 }) : undefined) });
    const panel = await openAssist("x");
    await userEvent.click(within(panel).getByRole("button", { name: /^Verbessern/ }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Sonnet hat keinen brauchbaren Prompt geliefert.");
  });
});
