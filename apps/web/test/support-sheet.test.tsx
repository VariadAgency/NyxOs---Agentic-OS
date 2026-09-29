// Feedback & Unterstützen: Einstieg in der Statuszeile, Blatt mit drei Reitern, Diagnose-Vorschau ohne persönliche
// Daten, Spende ohne Meldestelle gesperrt, Bezahlseite reagiert nur auf Nachrichten der Support-Herkunft.
import type { SupportState } from "@nyxos/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "../src/components/ConnectionStatus";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { __resetErrorLog, buildDiagnostics, installErrorLog } from "../src/features/support/diagnostics";
import { DonationFrame } from "../src/features/support/DonationFrame";
import { SupportSheet } from "../src/features/support/SupportSheet";
import { parseEuroAmount } from "../src/features/support/TokensTab";
import { jsonResponse } from "./helpers";

const ORIGIN = "https://support.example.org";

function supportState(over: Partial<SupportState> = {}): SupportState {
  return {
    configured: false,
    origin: null,
    source: "none",
    settingUrl: "",
    envLocked: false,
    problem: null,
    outbox: { waiting: 0, items: [] },
    drafts: { bug: null, idea: null },
    diagnostics: { version: "0.1.0", mode: "local", errors: [{ source: "server", at: "2026-09-28T10:00:00.000Z", message: "telegram-start-fehler: boom" }] },
    ...over,
  };
}

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

function renderShell(state: SupportState, onPost?: (url: string, body: unknown) => Promise<Response>) {
  __primeAuthForTests("csrf-1");
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/health") return jsonResponse({ ok: true });
      if (url === "/api/auth/status") return jsonResponse({ authenticated: true, csrf: "csrf-1", hasPasskey: true, authReads: false });
      if (url.startsWith("/api/bridge/presence")) return jsonResponse({ state: "online", machines: [], serverNow: new Date().toISOString() });
      if (url === "/api/app/info") return jsonResponse({ name: "NyxOS", version: "0.1.0", mode: "local", settings: { lang: "de", userName: "Alexandra", onboardingDone: true, autoUpdate: true } });
      if (url === "/api/support/state") return jsonResponse(state);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as unknown;
        posts.push({ url, body });
        if (onPost) return onPost(url, body);
      }
      return jsonResponse({});
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/sessions/coding/secret-project/abc"]}>
        <ConnectionStatus />
        <SupportSheet />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, posts };
}

beforeEach(() => __resetErrorLog());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Feedback & Unterstützen · Blatt", () => {
  it("Knopf in der Statuszeile öffnet das Blatt (in der Adresse), Escape schließt es", async () => {
    renderShell(supportState());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Feedback & Unterstützen" }));
    const sheet = await screen.findByRole("dialog", { name: "Feedback & Unterstützen" });
    expect(screen.getByTestId("where").textContent).toBe("/sessions/coding/secret-project/abc?support=bug");
    expect(within(sheet).getByRole("tab", { name: "Fehler melden" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(sheet).getByRole("tab", { name: "Buy me Tokens" }));
    expect(screen.getByTestId("where").textContent).toContain("support=tokens");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where").textContent).toBe("/sessions/coding/secret-project/abc");
  });

  it("Fehler ohne Meldestelle: „In den Postausgang legen“, Ergebnis „wartet“", async () => {
    const { posts } = renderShell(supportState(), () =>
      jsonResponse(
        { status: "queued", item: { id: 1, kind: "bug", title: "x", status: "waiting", createdAt: "", sentAt: null, attempts: 0, lastError: null, reference: null }, message: "Gespeichert im Postausgang – geht raus, sobald die Meldestelle eingerichtet ist." },
        { status: 202 },
      ),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Feedback & Unterstützen" }));
    const what = await screen.findByLabelText("Was ist passiert?");
    await user.type(what, "Der Knopf reagiert nicht");
    await user.click(screen.getByRole("button", { name: "In den Postausgang legen" }));
    const result = await screen.findByTestId("support-result");
    expect(result).toHaveAttribute("data-status", "queued");
    expect(result.textContent).toContain("Gespeichert im Postausgang");
    expect(posts[0]?.url).toBe("/api/support/bug");
    const sent = posts[0]?.body as { diagnostics: { page: string; errors: { message: string }[] } };
    expect(sent.diagnostics.page).toBe("/sessions/…");
  });

  it("Spende ohne Meldestelle: ehrlicher Hinweis, Knopf gesperrt", async () => {
    renderShell(supportState());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Feedback & Unterstützen" }));
    await user.click(await screen.findByRole("tab", { name: "Buy me Tokens" }));
    expect(await screen.findByText("Bezahlen wird gerade eingerichtet – danke, dass du helfen willst!")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Weiter zur Bezahlung/ })).toBeDisabled();
  });

  it("wartende Meldungen sind sichtbar", async () => {
    const item = { id: 3, kind: "idea" as const, title: "Heller Modus", status: "waiting" as const, createdAt: "", sentAt: null, attempts: 0, lastError: "Die Meldestelle ist noch nicht eingerichtet.", reference: null };
    renderShell(supportState({ outbox: { waiting: 2, items: [item, { ...item, id: 4 }] } }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Feedback & Unterstützen" }));
    expect((await screen.findByTestId("support-outbox-waiting")).textContent).toBe("2 Meldungen warten – gehen raus, sobald die Meldestelle eingerichtet ist.");
  });
});

describe("Diagnose", () => {
  it("Vorschau = Gesendetes, ohne Pfade, Hosts, E-Mails, Tokens und Namen", () => {
    installErrorLog(window);
    window.dispatchEvent(new ErrorEvent("error", { message: "boom in /Users/alexandra/work/app.ts for alexandra@example.com token=abcd1234efgh via mac.tail1234.ts.net" }));
    const d = buildDiagnostics({
      server: { version: "0.1.0", mode: "local", errors: [] },
      version: "0.1.0",
      mode: "local",
      pathname: "/sessions/coding/secret-project/abc",
      userName: "Alexandra",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    });
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/Users|alexandra|example\.com|abcd1234efgh|tail1234|secret-project/i);
    expect(d).toMatchObject({ os: "macOS", browser: "Chrome 140", page: "/sessions/…", mode: "local" });
    expect(d.errors[0]?.message).toContain("boom in [path]");
  });

  it("Eigener Betrag", () => {
    expect(parseEuroAmount("12,50")).toBe(1250);
    expect(parseEuroAmount("3 €")).toBe(300);
    expect(parseEuroAmount("0,50")).toBeNull();
    expect(parseEuroAmount("abc")).toBeNull();
    expect(parseEuroAmount("2000")).toBeNull();
  });
});

describe("Bezahlseite (iframe)", () => {
  it("abgesichert und nur Nachrichten der Support-Herkunft aus genau diesem Rahmen zählen", async () => {
    const onPaid = vi.fn();
    const onCancel = vi.fn();
    render(<DonationFrame session={{ embedUrl: `${ORIGIN}/embed/donate?s=1`, origin: ORIGIN }} onPaid={onPaid} onCancel={onCancel} />);
    const frame = screen.getByTitle("Bezahlseite") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");

    const send = (origin: string, data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { origin, data, source }));
      });
    send("https://evil.example.net", { type: "nyxos-support:paid" });
    send(ORIGIN, { type: "nyxos-support:paid" }, window);
    send(ORIGIN, "nyxos-support:paid");
    expect(onPaid).not.toHaveBeenCalled();
    send(ORIGIN, { type: "nyxos-support:resize", height: 720 });
    expect(frame.style.height).toBe("720px");
    send(ORIGIN, { type: "nyxos-support:paid", reference: "D-1" });
    expect(onPaid).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
