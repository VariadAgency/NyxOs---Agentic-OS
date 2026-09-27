// Haiku-Motor-Zustand: kein totes „einschalten“. Panel und Einstellungen zeigen den Motor-Zustand BEVOR man
// schreibt; solange der Motor nicht bereit ist, ist die Eingabe gesperrt – mit Hinweis und passendem Knopf.
import type { HaikuEngineState, HaikuStatus } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaikuRoot } from "../src/features/haiku/HaikuRoot";
import { HaikuSettingsPanel } from "../src/features/haiku/HaikuSettingsPanel";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REASON: Record<HaikuEngineState, string | null> = {
  ready: null,
  waiting_token: "Das Claude-Programm ist auf diesem Rechner nicht installiert.",
  off: "Nyx ist ausgeschaltet.",
  error: "Der Nyx-Motor auf dem Server läuft gerade nicht. Claude startet ihn beim nächsten Deploy neu.",
};

function status(state: HaikuEngineState, over: Partial<HaikuStatus["today"]> = {}): HaikuStatus {
  const kind = state === "off" ? "off" : "claude-cli";
  return {
    settings: { engine: kind, dailyBudgetUsd: 2, briefingTime: "07:00", recapTime: "21:30", rundgangMinutes: 15, timeoutSeconds: 90, ideaLinkBudgetPercent: 20, ideaLinkIdeasPerLinkDay: 10, ideaLinkIdeasPerDay: 30 },
    engine: { kind, state, available: state === "ready", reason: REASON[state], model: state === "ready" ? "haiku" : null },
    reserve: { configured: false, baseUrl: null, model: null },
    today: { day: "2026-09-25", calls: 3, inputTokens: 4000, outputTokens: 300, costUsd: 0.5, budgetUsd: 2, ...over },
    queue: { running: 0, waiting: 0 },
    lastRundgang: null,
  };
}

function stub(state: HaikuEngineState) {
  const chat = vi.fn();
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/haiku/status") return jsonResponse(status(state));
    if (url.startsWith("/api/haiku/calls")) return jsonResponse({ calls: [] });
    if (url.startsWith("/api/inbox")) return jsonResponse({ items: [] });
    if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
    if (url === "/api/haiku/threads") return jsonResponse({ threads: [] });
    if (url === "/api/context-guard/settings") return jsonResponse({ default: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, haiku: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80 }, models: [], sessions: [] });
    if (url === "/api/haiku/chat" && init?.method === "POST") {
      chat();
      return Promise.resolve(new Response("", { status: 200 }));
    }
    return Promise.reject(new Error(`unerwartet ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return { chat, impl };
}

async function openPanel() {
  const user = userEvent.setup();
  renderWithClient(
    <MemoryRouter initialEntries={["/sessions"]}>
      <HaikuRoot />
    </MemoryRouter>,
  );
  await user.keyboard("{Meta>}j{/Meta}");
  const panel = await screen.findByRole("dialog", { name: "Nyx" });
  return { user, panel };
}

describe("Haiku-Panel zeigt den Motor-Zustand vor dem Schreiben", () => {
  it("noch keine KI verbunden: Eingabe + Senden gesperrt, Anleitung in drei Schritten, „Erneut prüfen“ fragt neu", async () => {
    const { chat, impl } = stub("waiting_token");
    const { user, panel } = await openPanel();
    const input = within(panel).getByRole("textbox", { name: "Frage an Nyx" });
    await waitFor(() => expect(input).toBeDisabled());
    expect(within(panel).getByRole("button", { name: "Senden" })).toBeDisabled();
    expect(within(panel).getAllByText("Noch keine KI verbunden").length).toBeGreaterThan(0);
    expect(within(panel).getByText(REASON.waiting_token as string)).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Anleitung zeigen" }));
    const guide = within(panel).getByRole("list", { name: "Anleitung KI verbinden" });
    expect(within(guide).getAllByRole("listitem")).toHaveLength(3);
    expect(within(guide).getByText(/Claude-Programm installieren/)).toBeInTheDocument();
    expect(within(guide).getByText("curl -fsSL https://claude.ai/install.sh | bash")).toBeInTheDocument();
    expect(within(guide).getByText("claude")).toBeInTheDocument();
    expect(within(guide).getByText(/API-Schlüssel/)).toBeInTheDocument();

    const before = impl.mock.calls.filter(([u]) => String(u) === "/api/haiku/status").length;
    await user.click(within(panel).getByRole("button", { name: "Erneut prüfen" }));
    await waitFor(() => expect(impl.mock.calls.filter(([u]) => String(u) === "/api/haiku/status").length).toBeGreaterThan(before));
    expect(chat).not.toHaveBeenCalled();
  });

  it("aus: gesperrt, Knopf „In Einstellungen einschalten“ führt zu den Nyx-Einstellungen", async () => {
    stub("off");
    const { panel } = await openPanel();
    await waitFor(() => expect(within(panel).getByRole("textbox", { name: "Frage an Nyx" })).toBeDisabled());
    expect(within(panel).getByRole("link", { name: "In Einstellungen einschalten" })).toHaveAttribute("href", "/einstellungen/haiku");
  });

  it("Fehler: Grund in einfachen Worten + „Erneut prüfen“, keine Technik-Meldung", async () => {
    const { impl } = stub("error");
    const { user, panel } = await openPanel();
    await waitFor(() => expect(within(panel).getByRole("textbox", { name: "Frage an Nyx" })).toBeDisabled());
    expect(within(panel).getByText(REASON.error as string)).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/nicht gefunden|CLI|ENOENT/);
    const before = impl.mock.calls.filter(([u]) => String(u) === "/api/haiku/status").length;
    await user.click(within(panel).getByRole("button", { name: "Erneut prüfen" }));
    await waitFor(() => expect(impl.mock.calls.filter(([u]) => String(u) === "/api/haiku/status").length).toBeGreaterThan(before));
  });

  it("Chat meldet „nicht bereit“ → Panel fragt den Zustand sofort neu und sperrt die Eingabe", async () => {
    let state: HaikuEngineState = "ready";
    const { impl } = stub("ready");
    const base = impl.getMockImplementation();
    impl.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/haiku/status") return jsonResponse(status(state));
      if (url === "/api/haiku/chat" && init?.method === "POST") {
        state = "waiting_token"; // Motor fiel zwischen letzter Abfrage und Senden weg
        const body = `${JSON.stringify({ type: "thread", threadId: 1 })}\n${JSON.stringify({ type: "error", code: "not_ready", message: REASON.waiting_token })}\n`;
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return (base as NonNullable<typeof base>)(input, init);
    });
    const { user, panel } = await openPanel();
    expect(await within(panel).findByText("bereit")).toBeInTheDocument();
    await user.type(within(panel).getByRole("textbox", { name: "Frage an Nyx" }), "Hallo");
    await user.click(within(panel).getByRole("button", { name: "Senden" }));
    expect(await within(panel).findByText("Nyx ist gerade nicht bereit.")).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByRole("textbox", { name: "Frage an Nyx" })).toBeDisabled(), { timeout: 2000 });
  });

  it("bereit: Eingabe offen, Zustand „Bereit“ sichtbar", async () => {
    stub("ready");
    const { panel } = await openPanel();
    expect(await within(panel).findByText("bereit")).toBeInTheDocument();
    expect(within(panel).getByRole("textbox", { name: "Frage an Nyx" })).toBeEnabled();
    expect(within(panel).queryByRole("button", { name: "Anleitung zeigen" })).not.toBeInTheDocument();
  });
});

describe("Nyx-Einstellungen: ehrlicher Zustand + Max-Plan statt Dollar-Warnung", () => {
  it("noch keine KI verbunden: gleicher Hinweis mit Anleitung, kein „claude-CLI nicht gefunden“", async () => {
    stub("waiting_token");
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <HaikuSettingsPanel />
      </MemoryRouter>,
    );
    expect((await screen.findAllByText("Noch keine KI verbunden")).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/nicht gefunden|claude-CLI/);
    await user.click(screen.getByRole("button", { name: "Anleitung zeigen" }));
    expect(screen.getByRole("list", { name: "Anleitung KI verbinden" })).toBeInTheDocument();
    expect(screen.getByText("curl -fsSL https://claude.ai/install.sh | bash")).toBeInTheDocument();
  });

  it("„Motor testen“ stellt „Wer bist du?“ und zeigt Antwort + Dauer", async () => {
    const { impl } = stub("ready");
    impl.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/haiku/selftest" && init?.method === "POST") return jsonResponse({ ok: true, state: "ready", reason: null, text: "Ich bin Haiku.", ms: 2300 });
      if (url === "/api/haiku/status") return jsonResponse(status("ready"));
      if (url.startsWith("/api/haiku/calls")) return jsonResponse({ calls: [] });
      return Promise.reject(new Error(`unerwartet ${url}`));
    });
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <HaikuSettingsPanel />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole("button", { name: "Motor testen" }));
    expect(await screen.findByText(/Antwort nach 2,3 s: „Ich bin Haiku\.“/)).toBeInTheDocument();
  });

  it("„Motor testen“ zeigt lange Antworten ohne Markdown-Sternchen und nie mitten im Wort abgeschnitten", async () => {
    const { impl } = stub("ready");
    const long = `Hallo Alex! Ich bin **Haiku**, dein Helfer in der **NyxOS**. ${"Ich kümmere mich um Sessions, Aufgaben und Ideen. ".repeat(6)}Ende.`;
    impl.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/haiku/selftest" && init?.method === "POST") return jsonResponse({ ok: true, state: "ready", reason: null, text: long, ms: 4600, firstTextMs: 900 });
      if (url === "/api/haiku/status") return jsonResponse(status("ready"));
      if (url.startsWith("/api/haiku/calls")) return jsonResponse({ calls: [] });
      return Promise.reject(new Error(`unerwartet ${url}`));
    });
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter>
        <HaikuSettingsPanel />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole("button", { name: "Motor testen" }));
    const line = await screen.findByText(/Antwort nach 4,6 s/);
    expect(line.textContent).not.toContain("**");
    expect(line.textContent).toContain("Ich bin Haiku, dein Helfer");
    // gekürzt nur an einer Wortgrenze und sichtbar mit „…“
    expect(line.textContent).toMatch(/\p{L}… ?“$/u);
    expect(line.textContent).not.toMatch(/Kü“$|Aufg“$/);
  });

  it("Max-Plan: „kein Aufpreis · Gegenwert ca. X USD“, keine Warnfarbe bei 80 %", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/haiku/status") return jsonResponse(status("ready", { costUsd: 1.7 }));
        if (url.startsWith("/api/haiku/calls")) return jsonResponse({ calls: [] });
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    renderWithClient(
      <MemoryRouter>
        <HaikuSettingsPanel />
      </MemoryRouter>,
    );
    const card = await screen.findByRole("region", { name: "Verbrauch heute" });
    expect(within(card).getByText(/Max-Plan: kein Aufpreis/)).toBeInTheDocument();
    expect(within(card).getByText(/Gegenwert ca\. 1,70\s\$/)).toBeInTheDocument();
    const ring = within(card).getByRole("img");
    expect(ring.innerHTML).not.toMatch(/var\(--a-wait\)|var\(--a-bad\)/);
  });
});
