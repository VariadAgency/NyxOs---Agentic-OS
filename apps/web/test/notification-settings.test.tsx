// Page „Mitteilungen“: honest Nyx state (no model → hint, notifications still go out), a level change is sent as
// PATCH, the preview follows the chosen style, and the page speaks the chosen language.
import { DEFAULT_AWAY_SETTINGS, DEFAULT_NOTIFY_RULES, setLang, type NotifyHistoryItem, type NotifySettingsResponse } from "@nyxos/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import { NotificationHistory } from "../src/features/notifications/NotificationHistory";
import { NotificationNyxPanel, NotificationSettings, NotificationStylePanel } from "../src/features/notifications/NotificationSettings";
import { jsonResponse, renderWithClient } from "./helpers";

function settings(over: Partial<NotifySettingsResponse> = {}): NotifySettingsResponse {
  return {
    rules: DEFAULT_NOTIFY_RULES,
    push: {
      quietStart: "22:00",
      quietEnd: "08:00",
      bundleWindowSeconds: 120,
      waitingAfterSeconds: 120,
      publicBaseUrl: "http://127.0.0.1:47800",
      enabledKinds: {},
      channels: { mac: true, browser: true, ntfy: true },
      ntfyTarget: "own",
    } as NotifySettingsResponse["push"],
    away: DEFAULT_AWAY_SETTINGS,
    presence: { away: false, lastSeenAt: null },
    sample: { session: "Rework sign-in", baustelle: "Webshop" },
    nyxReady: false,
    ...over,
  };
}

function stub(body: NotifySettingsResponse, patches: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/notifications/settings" && init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as { rules?: { when?: Record<string, string> } };
        patches.push(patch);
        return jsonResponse({ ...body, rules: { ...body.rules, when: { ...body.rules.when, ...(patch.rules?.when ?? {}) } } });
      }
      if (url === "/api/notifications/settings") return jsonResponse(body);
      if (url.startsWith("/api/notifications/history")) return jsonResponse({ items: [], suggestions: [] });
      if (url === "/api/telegram/status") return jsonResponse({ paired: null });
      if (url === "/api/push/subscribe") return jsonResponse({ target: "own", reachable: false, serverUrl: null, topic: "nyxos-secret", note: "Noch keine Adresse" });
      if (url === "/api/auth/status") return jsonResponse({ authenticated: true, csrf: "c" });
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
}

function renderPage(Page: ComponentType = NotificationSettings) {
  return renderWithClient(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  setLang("de");
});

describe("NotificationSettings", () => {
  it("ohne Modell: ehrlicher Hinweis zu Nyx, Seite sonst vollständig", async () => {
    stub(settings({ nyxReady: false }));
    const main = renderPage();
    expect(await screen.findByRole("heading", { name: "Wann?" })).toBeInTheDocument();
    for (const name of ["Wege", "Verlauf"]) expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    // Style and Nyx are own subpages – here only one row each with the current setting.
    expect(screen.getByTestId("notify-row-style")).toHaveAttribute("href", "/settings/mitteilungen-stil");
    expect(screen.getByTestId("notify-row-style")).toHaveTextContent("Stil: Mit Zusammenhang");
    expect(screen.getByTestId("notify-row-nyx")).toHaveTextContent("Nyx prüft: aus");
    expect(screen.getByRole("switch", { name: "Rechner" })).toBeInTheDocument();
    expect(screen.queryByText(/nyxos-secret/)).not.toBeInTheDocument();
    main.unmount();
    renderPage(NotificationNyxPanel);
    expect(await screen.findByTestId("nyx-unavailable")).toHaveTextContent("Nyx ist gerade nicht erreichbar");
    expect(screen.getByRole("switch", { name: "Wichtiges kommt immer durch" })).toBeInTheDocument();
  });

  it("mit Modell: kein Hinweis; Stufe ändern schickt PATCH und zeigt die neue Stufe", async () => {
    const patches: unknown[] = [];
    stub(settings({ nyxReady: true }), patches);
    renderPage();
    const row = await screen.findByTestId("when-context_guard_hinweis");
    expect(screen.queryByTestId("nyx-unavailable")).not.toBeInTheDocument();
    await userEvent.setup().click(within(row).getByRole("radio", { name: "Nie" }));
    await waitFor(() => expect(patches).toEqual([{ rules: { when: { context_guard_hinweis: "never" } } }]));
    await waitFor(() => expect(within(screen.getByTestId("when-context_guard_hinweis")).getByRole("radio", { name: "Nie" })).toHaveAttribute("aria-checked", "true"));
  });

  it("Vorschau im gewählten Stil mit der Beispiel-Session; auf Englisch englische Texte", async () => {
    setLang("en");
    stub(settings());
    renderPage(NotificationStylePanel);
    expect(await screen.findByRole("radiogroup", { name: "Style of the notifications" })).toBeInTheDocument();
    const body = screen.getByTestId("notify-preview").querySelector('[data-part="body"]');
    expect(body?.textContent).toMatch(/^“Rework sign-in” has been waiting for you since \d{1,2}:\d{2}( [AP]M)?\.$/);
  });
});

describe("Mitteilungen entschlackt", () => {
  it("Sessions-Anlässe stehen offen, der Rest steckt unter „Weitere Anlässe“", async () => {
    stub(settings());
    renderPage();
    const more = await screen.findByTestId("when-more");
    expect(more).not.toHaveAttribute("open");
    expect(within(more).getByText(/^Weitere Anlässe \(\d+\)$/)).toBeInTheDocument();
    expect(screen.getByTestId("when-session_waiting").closest("details")).toBeNull();
    expect(screen.getByTestId("when-approval_needed").closest("details")).toBeNull();
  });
});

const historyItem = (i: number, delivered = true): NotifyHistoryItem => ({
  id: i,
  at: new Date(Date.now() - i * 60_000).toISOString(),
  kind: "session_waiting",
  kindLabel: "Session wartet",
  title: `Mitteilung ${i}`,
  message: "„Probe“ wartet auf dich.",
  decision: delivered ? "sent" : "quiet_hours",
  reason: delivered ? "Gesendet" : "Ruhezeit",
  delivered,
  bundle: false,
  channels: [],
  nyx: null,
  feedback: null,
});

describe("Verlauf", () => {
  it("zeigt erst die neuesten 5, „Ältere zeigen“ holt 10 weitere, Filter beginnt wieder bei 5", async () => {
    const items = Array.from({ length: 22 }, (_, i) => historyItem(i + 1, i % 2 === 0));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ items, suggestions: [] })),
    );
    renderWithClient(<NotificationHistory save={() => undefined} />);
    const list = await screen.findByTestId("history-list");
    expect(within(list).getAllByTestId("history-item")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Ältere zeigen (17)" }));
    expect(within(screen.getByTestId("history-list")).getAllByTestId("history-item")).toHaveLength(15);
    fireEvent.click(screen.getByRole("radio", { name: "Gesendet" }));
    expect(within(screen.getByTestId("history-list")).getAllByTestId("history-item")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Ältere zeigen (6)" })).toBeInTheDocument();
  });

  it("wenige Einträge: kein „Ältere zeigen“", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ items: [historyItem(1), historyItem(2)], suggestions: [] })),
    );
    renderWithClient(<NotificationHistory save={() => undefined} />);
    await screen.findByTestId("history-list");
    expect(screen.queryByTestId("history-more")).toBeNull();
  });
});
