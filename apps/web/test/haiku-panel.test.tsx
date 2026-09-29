import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** NDJSON-Strom, den der Test Stück für Stück füttert (auch mitten in einer Zeile). */
function controlledStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const enc = new TextEncoder();
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    push: (text: string) => controller?.enqueue(enc.encode(text)),
    close: () => controller?.close(),
  };
}

interface Setup {
  chat?: () => Promise<Response>;
  inbox?: unknown[];
  /** Kontext-Wächter-Schwellen für die Haiku-Zeile im Panel-Kopf. */
  contextGuard?: { default: { hinweisPct: number; erzwingenEnabled: boolean; erzwingenPct: number | null }; haiku: { hinweisPct: number; erzwingenEnabled: boolean; erzwingenPct: number | null } };
}

function stubFetch({ chat, inbox = [], contextGuard }: Setup) {
  const chatBodies: unknown[] = [];
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // FAB/Leiste zählen „offene Fragen“ aus einer Server-Quelle.
    if (url === "/api/open-questions") return jsonResponse({ approvals: 0, inbox: inbox.length, conflicts: 0, total: inbox.length });
    if (url.startsWith("/api/inbox")) return jsonResponse({ items: inbox });
    if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
    if (url === "/api/haiku/threads") return jsonResponse({ threads: [] });
    if (url === "/api/context-guard/settings") {
      return contextGuard
        ? jsonResponse(contextGuard)
        : jsonResponse({ default: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, haiku: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, models: [], sessions: [] });
    }
    if (url === "/api/haiku/chat" && init?.method === "POST") {
      chatBodies.push(JSON.parse(String(init.body)));
      if (chat) return chat();
    }
    return Promise.reject(new Error(`Test hat keine Antwort für ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return { impl, chatBodies };
}

function renderAt(path: string) {
  return renderWithClient(
    <MemoryRouter initialEntries={[path]}>
      <HaikuRoot />
    </MemoryRouter>,
  );
}

async function openWithShortcut(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Meta>}j{/Meta}");
  return screen.findByRole("dialog", { name: "Nyx" });
}

describe("Haiku-Panel", () => {
  it("⌘J öffnet das Panel, Fokus im Eingabefeld, Esc schließt", async () => {
    stubFetch({});
    const user = userEvent.setup();
    renderAt("/sessions/coding/nyxos");

    expect(screen.queryByRole("dialog", { name: "Nyx" })).not.toBeInTheDocument();
    const panel = await openWithShortcut(user);
    const input = within(panel).getByRole("textbox", { name: "Frage an Nyx" });
    await waitFor(() => expect(input).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nyx" })).not.toBeInTheDocument());
  });

  // Die technische Wächter-Zeile gehört in die Einstellungen
  // (/einstellungen/nyx/motor, `ContextGuardSettings`), nicht in den Kopf des Nyx-Zentrums.
  it("zeigt die Kontext-Wächter-Schwelle NICHT mehr im Kopf des Zentrums", async () => {
    stubFetch({ contextGuard: { default: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, haiku: { hinweisPct: 55, erzwingenEnabled: true, erzwingenPct: 75 } } });
    const user = userEvent.setup();
    renderAt("/sessions/coding/nyxos");
    const panel = await openWithShortcut(user);
    expect(within(panel).queryByText(/Kontext-Wächter/)).toBeNull();
  });

  it("zeigt, was Haiku sieht (Tab › Art › Baustelle) und schickt den Kontext mit", async () => {
    const stream = controlledStream();
    const { chatBodies } = stubFetch({ chat: () => Promise.resolve(stream.response) });
    const user = userEvent.setup();
    renderAt("/sessions/coding/nyxos?tool=claude");

    const panel = await openWithShortcut(user);
    expect(within(panel).getByText("Sieht: Sessions › Coding › nyxos")).toBeInTheDocument();

    await user.type(within(panel).getByRole("textbox", { name: "Frage an Nyx" }), "Was läuft?{Enter}");
    await waitFor(() => expect(chatBodies).toHaveLength(1));
    const body = chatBodies[0] as { message: string; threadId: number | null; context: { tab: string; filters: Record<string, string>; openSessionId: string | null } };
    expect(body.message).toBe("Was läuft?");
    expect(body.threadId ?? null).toBeNull();
    expect(body.context.tab).toBe("sessions");
    expect(body.context.filters).toEqual({ art: "coding", baustelle: "nyxos", tool: "claude" });
    expect(body.context.openSessionId).toBeNull();
    stream.close();
  });

  it("liest den NDJSON-Strom in Stücken: Tipp-Indikator, Text wächst, Quellen verlinken", async () => {
    const stream = controlledStream();
    stubFetch({ chat: () => Promise.resolve(stream.response) });
    const user = userEvent.setup();
    renderAt("/sessions/coding/nyxos/abc");

    const panel = await openWithShortcut(user);
    await user.type(within(panel).getByRole("textbox", { name: "Frage an Nyx" }), "Was läuft?{Enter}");
    expect(await within(panel).findByText("Was läuft?")).toBeInTheDocument();

    await act(async () => stream.push('{"type":"thread","threadId":7}\n{"type":"status","status":"thinking"}\n'));
    expect(await within(panel).findByText("Nyx denkt …")).toBeInTheDocument();

    await act(async () => stream.push('{"type":"status","status":"tool","tool":"sessions_lesen"}\n{"type":"del'));
    expect(await within(panel).findByText("liest Sessions …")).toBeInTheDocument();

    await act(async () => stream.push('ta","text":"Zwei Sessions "}\n'));
    expect(await within(panel).findByText("Zwei Sessions")).toBeInTheDocument();

    await act(async () => stream.push('{"type":"delta","text":"laufen gerade."}\n'));
    expect(await within(panel).findByText("Zwei Sessions laufen gerade.")).toBeInTheDocument();

    const done = {
      type: "done",
      messageId: 11,
      text: "Zwei Sessions laufen gerade.",
      sources: [{ kind: "session", id: "claude:abc", label: "Session Leitplanken", href: "/sessions/coding/nyxos/abc" }],
      estimate: false,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, durationMs: 800 },
    };
    await act(async () => {
      stream.push(`${JSON.stringify(done)}\n`);
      stream.close();
    });

    const chip = await within(panel).findByRole("link", { name: /Session Leitplanken/ });
    expect(chip).toHaveAttribute("href", "/sessions/coding/nyxos/abc");
    expect(within(panel).queryByText("Nyx denkt …")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Einschätzung (ohne Quelle)")).not.toBeInTheDocument();
  });

  it("markiert Antworten ohne Quelle als Einschätzung", async () => {
    const lines = [
      { type: "thread", threadId: 3 },
      { type: "done", messageId: 4, text: "Vermutlich morgen fertig.", sources: [], estimate: true, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    stubFetch({ chat: () => Promise.resolve(new Response(`${lines}\n`, { status: 200 })) });
    const user = userEvent.setup();
    renderAt("/sessions");

    const panel = await openWithShortcut(user);
    await user.type(within(panel).getByRole("textbox", { name: "Frage an Nyx" }), "Wann fertig?{Enter}");
    expect(await within(panel).findByText("Vermutlich morgen fertig.")).toBeInTheDocument();
    expect(within(panel).getByText("Einschätzung (ohne Quelle)")).toBeInTheDocument();
  });

  it("übersetzt Fehler-Codes in verständlichen Text", async () => {
    stubFetch({ chat: () => Promise.resolve(new Response('{"type":"error","code":"disabled","message":"engine off"}\n', { status: 200 })) });
    const user = userEvent.setup();
    renderAt("/sessions");

    const panel = await openWithShortcut(user);
    await user.type(within(panel).getByRole("textbox", { name: "Frage an Nyx" }), "Hallo{Enter}");
    expect(await within(panel).findByText("Nyx ist ausgeschaltet.")).toBeInTheDocument();
    // kein totes „einschalten“ – der Link führt wirklich in die Haiku-Einstellungen.
    expect(within(panel).getByRole("link", { name: "In Einstellungen einschalten" })).toHaveAttribute("href", "/einstellungen/nyx/motor");
  });

  it("FAB zeigt die Zahl offener Punkte, Plan-Karte gibt frei", async () => {
    const plan = {
      id: 5,
      kind: "plan",
      title: "Heute Nacht A02 starten",
      body: "1. Worktree anlegen\n2. Opus starten",
      options: [
        { id: "freigeben", label: "Freigeben" },
        { id: "aendern", label: "Ändern" },
      ],
      status: "open",
      answer: null,
      sessionKey: null,
      entryId: null,
      baustelle: null,
      decisionFile: null,
      sources: [],
      createdBy: "haiku",
      estimateMinutes: 1,
      yesNo: false,
      escalation: null,
      delivery: null,
      createdAt: new Date().toISOString(),
      answeredAt: null,
    };
    const { impl } = stubFetch({ inbox: [plan] });
    impl.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/inbox/5/answer") return jsonResponse({ item: { ...plan, status: "answered", answer: JSON.parse(String(init?.body)) } });
      if (url === "/api/open-questions") return jsonResponse({ approvals: 0, inbox: 1, conflicts: 0, total: 1 });
      if (url.startsWith("/api/inbox")) return jsonResponse({ items: [plan] });
      if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
      if (url === "/api/haiku/threads") return jsonResponse({ threads: [] });
      return Promise.reject(new Error(`unerwartet ${url}`));
    });
    const user = userEvent.setup();
    renderAt("/sessions");

    const fab = await screen.findByRole("button", { name: /Nyx öffnen/ });
    await waitFor(() => expect(within(fab).getByText("1")).toBeInTheDocument());
    await user.click(fab);
    const panel = await screen.findByRole("dialog", { name: "Nyx" });
    expect(await within(panel).findByText("Heute Nacht A02 starten")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Freigeben" }));
    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u) === "/api/inbox/5/answer")).toBe(true));
    const call = impl.mock.calls.find(([u]) => String(u) === "/api/inbox/5/answer");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ optionId: "freigeben" });
  });
});
