// Anmeldung bleibt erhalten: Eine Schreibaktion ohne Anmeldung zeigt „Bitte anmelden“ mit
// Touch-ID-Knopf statt eines Fehlertexts und läuft nach der Anmeldung weiter; ein veraltetes/fehlendes
// Sicherheits-Token wird einmal still erneuert; ein kurzer Verbindungsaussetzer macht aus
// „Angemeldet“ nicht „Nicht angemeldet“ (so ging die Anmeldung im Review scheinbar verloren).
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "../src/components/ConnectionStatus";
import { LoginDialog } from "../src/features/terminal/LoginDialog";
import { __resetAuthForTests, csrfHeader, fetchAuthStatus, LoginRequiredError, logoutEverywhere } from "../src/features/terminal/authClient";
import { writeJson } from "../src/lib/api";
import { jsonResponse, renderWithClient } from "./helpers";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(async () => ({ id: "cred-1", rawId: "cred-1", type: "public-key", response: {}, clientExtensionResults: {} })),
  startRegistration: vi.fn(),
}));

type Handler = (init?: RequestInit) => Promise<Response>;

/** fetch-Attrappe mit Protokoll: je URL eine Folge von Antworten (die letzte gilt danach weiter). */
function stubSequence(routes: Record<string, Handler[]>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const list = routes[url];
    if (!list || list.length === 0) return Promise.reject(new Error(`unerwartete URL ${url}`));
    const next = list.length > 1 ? list.shift() : list[0];
    return (next as Handler)(init);
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

const status = (authenticated: boolean, csrf: string | null = authenticated ? "csrf-alt" : null) => () =>
  jsonResponse({ authenticated, csrf, hasPasskey: true, authReads: false });
const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

beforeEach(() => __resetAuthForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Schreibaktion ohne Anmeldung → „Bitte anmelden“ → Aktion läuft weiter", () => {
  it("401 beim Session-Start öffnet den Dialog; nach Touch ID wird die Anfrage mit neuem Token wiederholt", async () => {
    const calls = stubSequence({
      "/api/auth/status": [status(false)],
      "/api/terminal/start": [() => jsonResponse({ error: "Bitte anmelden", code: "auth_required" }, { status: 401 }), () => jsonResponse({ tmuxName: "zc-1", tool: "claude", sessionId: "s1", startedMs: 5 })],
      "/api/auth/login/options": [() => jsonResponse({ options: { challenge: "c" }, challengeId: "ch1" })],
      "/api/auth/login/verify": [() => jsonResponse({ ok: true, csrf: "csrf-neu" })],
    });
    renderWithClient(<LoginDialog />);

    const pending = writeJson<{ tmuxName: string }>("POST", "/api/terminal/start", { tool: "claude" });
    const dlg = await screen.findByRole("dialog", { name: "Bitte anmelden" });
    expect(dlg).not.toHaveTextContent(/csrf|token/i);
    await userEvent.setup().click(screen.getByRole("button", { name: /Touch ID/ }));

    await expect(pending).resolves.toMatchObject({ tmuxName: "zc-1" });
    const starts = calls.filter((c) => c.url === "/api/terminal/start");
    expect(starts).toHaveLength(2);
    expect(header(starts[1]?.init, "x-nyxos-csrf")).toBe("csrf-neu");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Dialog geschlossen ohne Anmeldung → freundlicher Fehler statt Technik-Meldung", async () => {
    stubSequence({
      "/api/auth/status": [status(false)],
      "/api/terminal/start": [() => jsonResponse({ error: "Bitte anmelden", code: "auth_required" }, { status: 401 })],
    });
    renderWithClient(<LoginDialog />);
    const pending = writeJson("POST", "/api/terminal/start", {});
    const rejected = expect(pending).rejects.toBeInstanceOf(LoginRequiredError);
    await screen.findByRole("dialog", { name: "Bitte anmelden" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Später" }));
    await rejected;
    await expect(pending).rejects.toThrow(/anmelden/i);
  });

  it("mehrere gleichzeitige 401 öffnen EINEN Dialog und laufen alle weiter", async () => {
    const calls = stubSequence({
      "/api/auth/status": [status(false)],
      "/api/rules/1": [() => jsonResponse({ code: "auth_required" }, { status: 401 }), () => jsonResponse({ code: "auth_required" }, { status: 401 }), () => jsonResponse({ ok: true })],
      "/api/auth/login/options": [() => jsonResponse({ options: { challenge: "c" }, challengeId: "ch1" })],
      "/api/auth/login/verify": [() => jsonResponse({ ok: true, csrf: "csrf-neu" })],
    });
    renderWithClient(<LoginDialog />);
    const a = writeJson("PATCH", "/api/rules/1", { active: true });
    const b = writeJson("PATCH", "/api/rules/1", { active: false });
    await screen.findByRole("dialog", { name: "Bitte anmelden" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole("button", { name: /Touch ID/ }));
    await expect(Promise.all([a, b])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(calls.filter((c) => c.url === "/api/auth/login/verify")).toHaveLength(1);
  });
});

describe("Sicherheits-Token (CSRF) wird verlässlich mitgeschickt", () => {
  it("403 code csrf → Token einmal neu holen, Anfrage wiederholen — kein Dialog, kein Fehler", async () => {
    const calls = stubSequence({
      "/api/auth/status": [status(true, "csrf-alt"), status(true, "csrf-frisch")],
      "/api/terminal/start": [() => jsonResponse({ error: "Bitte noch einmal versuchen", code: "csrf" }, { status: 403 }), () => jsonResponse({ tmuxName: "zc-2" })],
    });
    await fetchAuthStatus(true);
    await expect(writeJson("POST", "/api/terminal/start", {})).resolves.toMatchObject({ tmuxName: "zc-2" });
    const starts = calls.filter((c) => c.url === "/api/terminal/start");
    expect(header(starts[0]?.init, "x-nyxos-csrf")).toBe("csrf-alt");
    expect(header(starts[1]?.init, "x-nyxos-csrf")).toBe("csrf-frisch");
  });

  it("ein fehlgeschlagener Status-Abruf (Verbindungsaussetzer) löscht das Token nicht", async () => {
    stubSequence({
      "/api/auth/status": [status(true, "csrf-gut"), () => Promise.reject(new TypeError("Load failed")), () => jsonResponse({}, { status: 502 })],
    });
    await fetchAuthStatus(true);
    await expect(fetchAuthStatus(true)).rejects.toThrow();
    await expect(fetchAuthStatus(true)).rejects.toThrow();
    expect(await csrfHeader()).toEqual({ "x-nyxos-csrf": "csrf-gut" });
  });

  it("ohne gemerktes Token holt der erste Schreibaufruf den Status frisch (nicht einen alten, gescheiterten Abruf)", async () => {
    const calls = stubSequence({
      "/api/auth/status": [() => Promise.reject(new TypeError("Load failed")), status(true, "csrf-da")],
      "/api/rules/1": [() => jsonResponse({ ok: true })],
    });
    await expect(fetchAuthStatus(true)).rejects.toThrow();
    await writeJson("PATCH", "/api/rules/1", { active: true });
    expect(header(calls.find((c) => c.url === "/api/rules/1")?.init, "x-nyxos-csrf")).toBe("csrf-da");
  });
});

describe("Abmelden mit veraltetem Token", () => {
  it("„Überall abmelden“: 403 code csrf → Token frisch holen, wiederholen — kein Fehler", async () => {
    const calls = stubSequence({
      "/api/auth/status": [status(true, "csrf-alt"), status(true, "csrf-frisch")],
      "/api/auth/logout-all": [() => jsonResponse({ code: "csrf" }, { status: 403 }), () => jsonResponse({ ok: true, revoked: 2 })],
    });
    await fetchAuthStatus(true);
    await expect(logoutEverywhere()).resolves.toBeUndefined();
    const hits = calls.filter((c) => c.url === "/api/auth/logout-all");
    expect(hits).toHaveLength(2);
    expect(header(hits[1]?.init, "x-nyxos-csrf")).toBe("csrf-frisch");
  });
});

describe("Statusanzeige zeigt den echten Zustand", () => {
  function stubStatus(seq: Handler[]) {
    return stubSequence({
      "/health": [() => jsonResponse({ ok: true })],
      "/api/machines": [() => jsonResponse([])],
      "/api/auth/status": seq,
    });
  }

  it("Verbindungsaussetzer beim Status-Abruf → bleibt „Angemeldet“ (letzter bestätigter Stand)", async () => {
    stubStatus([status(true), () => Promise.reject(new TypeError("Load failed"))]);
    renderWithClient(<ConnectionStatus />);
    await screen.findByText("Angemeldet");
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("Angemeldet")).toBeInTheDocument();
    expect(screen.queryByText("Nicht angemeldet")).not.toBeInTheDocument();
  });

  it("lädt bei Sichtbarkeitswechsel neu (abgemeldet auf anderem Gerät → „Nicht angemeldet“)", async () => {
    const calls = stubStatus([status(true), status(false)]);
    renderWithClient(<ConnectionStatus />);
    await screen.findByText("Angemeldet");
    const before = calls.filter((c) => c.url === "/api/auth/status").length;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await screen.findByText("Nicht angemeldet");
    expect(calls.filter((c) => c.url === "/api/auth/status").length).toBeGreaterThan(before);
  });

  it("nach einer 401 lädt die Anzeige neu", async () => {
    const calls = stubSequence({
      "/health": [() => jsonResponse({ ok: true })],
      "/api/machines": [() => jsonResponse([])],
      "/api/auth/status": [status(true), status(false)],
      "/api/rules/1": [() => jsonResponse({ code: "auth_required" }, { status: 401 })],
    });
    renderWithClient(
      <>
        <ConnectionStatus />
        <LoginDialog />
      </>,
    );
    await screen.findByText("Angemeldet");
    const p = writeJson("PATCH", "/api/rules/1", {}).catch(() => undefined);
    await screen.findByText("Nicht angemeldet");
    expect(calls.filter((c) => c.url === "/api/auth/status").length).toBeGreaterThanOrEqual(2);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Später" }));
    await p;
  });
});
