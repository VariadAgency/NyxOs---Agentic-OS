// Session-Chat: Eingabe mit Anhängen, Kopf mit genauem Modell + „Kontext komprimieren“ +
// „Session zusammenfassen & prüfen“, zusammenklappbare Info-Leiste, volle lange Nachrichten.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { initialChatAnchor } from "../src/components/sessions/ChatPanel";
import { ChatItem } from "../src/components/sessions/ChatItem";
import { __resetPendingForTests } from "../src/features/session-chat/pending";
import type { Session } from "../src/lib/api";
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

// Großzügige Zeit: die ganze App rendert je Test, auf einem ausgelasteten Rechner dauert das.
describe("Chat-Eingabe", { timeout: 20_000 }, () => {
  it("Enter sendet an die laufende Session (mit Anmelde-Token), Shift+Enter macht eine neue Zeile", async () => {
    const posts: { url: string; body: unknown; headers: Headers }[] = [];
    setup({
      onPost: (url, body, init) => {
        if (!url.endsWith("/message")) return undefined;
        posts.push({ url, body, headers: new Headers(init?.headers) });
        return jsonResponse({ sent: true, queued: false, attachments: [] });
      },
    });
    const box = await screen.findByRole("textbox", { name: "Nachricht an Claude" });
    await waitFor(() => expect(box).toBeEnabled(), { timeout: 5000 });
    await userEvent.type(box, "Zeile 1{Shift>}{Enter}{/Shift}Zeile 2");
    expect(box).toHaveValue("Zeile 1\nZeile 2");
    expect(posts).toHaveLength(0);
    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe("/api/sessions/claude:chat/message");
    expect(posts[0]?.body).toEqual({ text: "Zeile 1\nZeile 2", attachments: [] });
    expect(posts[0]?.headers.get("x-nyxos-csrf")).toBe("test-csrf");
    expect(box).toHaveValue("");
    // Bis die Antwort im Verlauf steht, zeigt der Chat die gesendete Nachricht mit Zustand.
    expect(await screen.findByTestId("chat-pending")).toHaveTextContent("Zeile 1");
  });

  it("Büroklammer: Datei anhängen, als Chip sichtbar, wird mit Base64 gesendet; Session arbeitet → „In der Warteschlange“", async () => {
    let sent: { text: string; attachments: { name: string; dataBase64: string }[] } | null = null;
    setup({
      session: makeSession({ state: "running" }),
      chat: { canSend: true, reason: null, message: null, busy: true },
      onPost: (url, body) => {
        if (!url.endsWith("/message")) return undefined;
        sent = body as typeof sent;
        return jsonResponse({ sent: true, queued: true, attachments: [{ name: "notiz.txt", path: "/x/notiz.txt", image: false }] });
      },
    });
    const input = await screen.findByTestId("chat-file-input");
    const file = new File(["Zauberwort"], "notiz.txt", { type: "text/plain" });
    await userEvent.upload(input as HTMLInputElement, file);
    expect(await screen.findByText("notiz.txt")).toBeInTheDocument();
    expect(screen.getByText(/arbeitet gerade/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Senden" }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({ text: "", attachments: [{ name: "notiz.txt", dataBase64: Buffer.from("Zauberwort").toString("base64") }] });
    expect(await screen.findByTestId("chat-pending")).toHaveTextContent("In der Warteschlange");
  });

  it("Drag-and-drop einer Bilddatei auf den Chat hängt sie an", async () => {
    setup();
    // Erst wenn feststeht, dass hier geschrieben werden darf, nimmt die Kachel Dateien an.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Nachricht an Claude" })).toBeEnabled(), { timeout: 5000 });
    const tile = await screen.findByTestId("session-main");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "bild.png", { type: "image/png" });
    fireEvent.dragEnter(tile, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(await screen.findByText("Dateien hier ablegen")).toBeInTheDocument();
    fireEvent.drop(tile, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(await screen.findByText("bild.png")).toBeInTheDocument();
  });

  it("nicht erlaubte Datei wird freundlich abgelehnt, nichts angehängt", async () => {
    setup();
    const input = await screen.findByTestId("chat-file-input");
    await userEvent.upload(input as HTMLInputElement, new File(["x"], "programm.exe"), { applyAccept: false });
    expect(await screen.findByRole("alert")).toHaveTextContent("programm.exe");
    expect(screen.queryByTestId("chat-attachment")).not.toBeInTheDocument();
  });

  it("gesperrt, wenn die Session nicht in der NyxOS läuft: Satz statt Eingabe, Senden aus", async () => {
    setup({
      session: makeSession({ attachable: false, tmuxName: null }),
      chat: { canSend: false, reason: "not_in_nyxos", message: "Diese Session läuft in einem eigenen Terminal-Fenster. Übernimm sie in NyxOS, dann kannst du hier schreiben.", busy: false },
    });
    const locked = await screen.findByTestId("chat-locked");
    expect(locked).toHaveTextContent("eigenen Terminal-Fenster");
    expect(locked.textContent ?? "").not.toMatch(/tmux|CSRF/);
    expect(screen.getByRole("textbox", { name: "Nachricht an Claude" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Senden" })).toBeDisabled();
  });
});

describe("Grenzfälle der Chat-Eingabe", { timeout: 20_000 }, () => {
  it("Brücke antwortet zu spät: Blase „unklar“, Text kommt NICHT zurück ins Feld (kein Doppelt-Senden)", async () => {
    setup({ onPost: (url) => (url.endsWith("/message") ? jsonResponse({ sent: true, queued: false, uncertain: true, attachments: [] }) : undefined) });
    const box = await screen.findByRole("textbox", { name: "Nachricht an Claude" });
    await waitFor(() => expect(box).toBeEnabled(), { timeout: 5000 });
    await userEvent.type(box, "Nur einmal bitte{Enter}");
    expect(await screen.findByTestId("chat-pending")).toHaveTextContent(/Unklar, ob sie angekommen ist/);
    expect(box).toHaveValue("");
  });

  it("solange der Zustand lädt: „Einen Moment …“, nie der falsche Satz „sobald die Session in der NyxOS läuft“", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = setup().fetchMock;
    const inner = fetchMock.getMockImplementation() as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/chat")) await gate;
      return inner(input, init);
    });
    const box = await screen.findByRole("textbox", { name: "Nachricht an Claude" });
    expect(box.getAttribute("placeholder") ?? "").not.toMatch(/sobald die Session in der NyxOS läuft/);
    release();
  });

  it("Einfügen mit Text UND Datei (z. B. aus dem Finder) schluckt den Text nicht", async () => {
    setup();
    const box = await screen.findByRole("textbox", { name: "Nachricht an Claude" });
    await waitFor(() => expect(box).toBeEnabled(), { timeout: 5000 });
    const file = new File(["x"], "bild.png", { type: "image/png" });
    const notPrevented = fireEvent.paste(box, { clipboardData: { files: [file], types: ["Files", "text/plain"], getData: () => "bild.png" } });
    expect(notPrevented).toBe(true);
  });

  it("leere Datei (0 Byte) wird mit passendem Satz abgelehnt", async () => {
    setup();
    const input = await screen.findByTestId("chat-file-input");
    await userEvent.upload(input as HTMLInputElement, new File([], "leer.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/leer\.txt.*leer/);
  });
});

describe("Startposition des Chats", () => {
  const items = [msg("a1", "assistant", "alt"), msg("u1", "user", "erste Frage"), msg("a2", "assistant", "Antwort 1"), msg("u2", "user", "zweite Frage"), msg("a3", "assistant", "Antwort 2")];

  it("ohne gemerkte Stelle: an deiner letzten Nachricht (oben ausgerichtet)", () => {
    expect(initialChatAnchor(items, null)).toEqual({ index: 3, align: "start", unreadFrom: null });
  });

  it("mit gemerkter Stelle und Neuem danach: am ersten Ungelesenen, mit Trenner", () => {
    expect(initialChatAnchor(items, "a2")).toEqual({ index: 3, align: "start", unreadFrom: 3 });
    expect(initialChatAnchor(items, "u1")).toEqual({ index: 2, align: "start", unreadFrom: 2 });
  });

  it("alles gelesen: wieder an deiner letzten Nachricht; ohne Nachricht von dir: ganz unten", () => {
    expect(initialChatAnchor(items, "a3")).toEqual({ index: 3, align: "start", unreadFrom: null });
    expect(initialChatAnchor([msg("x", "assistant", "nur Antwort")], null)).toEqual({ index: 0, align: "end", unreadFrom: null });
  });

  it("Trenner „Neu seit deinem letzten Besuch“ erscheint im echten Chat", async () => {
    localStorage.setItem("nyxos.chat.lastSeen.claude:chat", "a2");
    setup({ items });
    expect(await screen.findByText("Neu seit deinem letzten Besuch")).toBeInTheDocument();
  });
});

describe("Kopf: genaues Modell, Komprimieren, Prüfen", { timeout: 20_000 }, () => {
  // Der Kopf misst seinen Platz (jsdom hat kein Layout). Hier ein schmaler Kopf, der immer
  // überläuft, bis die Kopf-Knöpfe (Stufe 2) im Menü „⋯“ stehen — wie bei wenig Platz.
  let scrollWidth: PropertyDescriptor | undefined;
  beforeEach(() => {
    scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === "session-head" && Number(this.dataset.fitLevel) < 2 ? 5000 : 0;
      },
    });
  });
  afterEach(() => {
    if (scrollWidth) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
  });
  it("zeigt das AKTUELLE Modell (nicht das erste), bei Wechsel sind alle sichtbar", async () => {
    setup();
    const chip = await screen.findByTestId("session-model");
    expect(chip).toHaveTextContent("Opus 5.5"); // Kurzform, voller Name im Hinweis
    expect(chip).toHaveTextContent("+1");
    expect(chip).toHaveAccessibleDescription(/claude-opus-4-1.*claude-opus-5-5/);
  });

  it("ohne Nutzungs-Modell gilt das zuletzt gesehene", async () => {
    setup({ session: makeSession({ lastUsageModel: null, models: ["claude-sonnet-5", "claude-opus-5-5"] }) });
    expect(await screen.findByTestId("session-model")).toHaveTextContent("Opus 5.5");
  });

  it("„Kontext komprimieren“ nur, wenn die Session wartet – sonst gesperrt mit Grund", async () => {
    setup({ session: makeSession({ state: "running" }), guard: { sessionKey: "claude:chat", thresholds: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80, source: "default" }, pct: 42, hint: false, forced: false, attachable: true, state: "running" } });
    await userEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    const menu = await screen.findByRole("menu");
    const item = within(menu).getByRole("menuitem", { name: /Kontext komprimieren/ });
    expect(item).toBeDisabled();
    expect(within(menu).getByText(/arbeitet gerade/)).toBeInTheDocument();
  });

  it("wartet die Session: Klick schickt /compact über den Kontext-Wächter-Weg (nur wenn wartend)", async () => {
    const calls: { url: string; body: unknown }[] = [];
    setup({
      onPost: (url, body) => {
        if (!url.includes("compact-now")) return undefined;
        calls.push({ url, body });
        return jsonResponse({ sent: true });
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Kontext komprimieren/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/context-guard/sessions/claude%3Achat/compact-now", body: { onlyWhenWaiting: true } });
  });

  it("„Session zusammenfassen & prüfen“: ohne Haiku-Token sichtbar, aber gesperrt mit Erklärung", async () => {
    setup({ audits: { engine: { ready: false, state: "waiting_token", reason: "Wartet auf deinen Token." }, audits: [] } });
    await userEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Session zusammenfassen & prüfen/ })).toBeDisabled();
    expect(within(menu).getByText(/Wartet auf Nyx-Token/)).toBeInTheDocument();
  });

  it("Klick startet die Prüfung; das Ergebnis hängt an der Session und steht im Vollbild", async () => {
    const done = {
      id: 1,
      sessionKey: "claude:chat",
      status: "done",
      result: {
        zusammenfassung: "Die Chat-Eingabe ist gebaut.",
        gemacht: ["Route gebaut"],
        erledigt: ["Senden mit Anhang"],
        offen: ["Codex prüfen"],
        qualitaet: { note: "gut", text: "Tests zuerst." },
        risiken: ["Große Anhänge"],
      },
      error: null,
      itemsRead: 2,
      itemsTotal: 2,
      createdAt: iso(0),
      finishedAt: iso(0),
    };
    const running = { ...done, status: "running", result: null, finishedAt: null };
    // Server-Zustand: erst keine Prüfung, nach dem Start „läuft“, später „fertig“.
    let stored: Record<string, unknown>[] = [];
    let started = false;
    setup({
      audits: () => ({ engine: { ready: true, state: "ready", reason: null }, audits: stored }),
      onPost: (url) => {
        if (!url.endsWith("/audits")) return undefined;
        started = true;
        stored = [running];
        return jsonResponse(running, { status: 202 });
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Session zusammenfassen & prüfen/ }));
    await waitFor(() => expect(started).toBe(true));
    expect(await screen.findByTestId("session-audit")).toHaveTextContent(/prüft/);
    // Server meldet „fertig“ (`/live` bzw. Nachfragen alle 3 s, solange es läuft) → Ergebnis erscheint.
    stored = [done];
    await waitFor(() => expect(screen.getByTestId("session-audit")).toHaveTextContent("Die Chat-Eingabe ist gebaut."), { timeout: 6000 });
    const card = screen.getByTestId("session-audit");
    expect(card).toHaveTextContent("Codex prüfen");
    expect(card).toHaveTextContent("Große Anhänge");
  }, 15_000);
});

describe("Info-Leiste klappt zu einem dünnen Balken", { timeout: 20_000 }, () => {
  it("einklappen → schmaler Balken mit Mini-Werten, Zustand wird gemerkt, Klick klappt wieder auf", async () => {
    const first = setup();
    expect(await screen.findByTestId("session-info")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Infos einklappen" }));
    const rail = await screen.findByTestId("session-info-rail");
    expect(rail).toHaveTextContent("opus-5-5");
    expect(rail).toHaveTextContent("1,2 Mio");
    expect(rail).toHaveTextContent("42");
    expect(screen.queryByTestId("session-info")).not.toBeInTheDocument();
    first.view.unmount();

    setup();
    expect(await screen.findByTestId("session-info-rail")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Infos ausklappen" }));
    expect(await screen.findByTestId("session-info")).toBeInTheDocument();
  });
});

describe("lange Nachrichten", () => {
  const LONG = `ANFANG-${"z".repeat(3000 - 12)}-ENDE`;

  it("3.000 Zeichen: voller Text im Chat, eingeklappt mit „Ganze Nachricht zeigen“, Anfang und Ende da", async () => {
    renderWithClient(<ChatItem item={msg("l1", "user", LONG)} sessionId="claude:chat" />);
    const body = screen.getByTestId("chat-message-body");
    expect(body.textContent).toContain("ANFANG-");
    expect(body.textContent).toContain("-ENDE");
    expect(body.textContent?.length).toBeGreaterThanOrEqual(3000);
    const toggle = screen.getByRole("button", { name: /Ganze Nachricht zeigen/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: /Weniger zeigen/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("kurze Nachrichten haben keinen Aufklapp-Knopf", () => {
    renderWithClient(<ChatItem item={msg("k1", "assistant", "kurz")} sessionId="claude:chat" />);
    expect(screen.queryByRole("button", { name: /Ganze Nachricht zeigen/ })).not.toBeInTheDocument();
  });
});
