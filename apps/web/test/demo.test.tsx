// Demo: „Demo ansehen“ im Onboarding, die Demo-Leiste unten (zurück zur eigenen Installation bzw. Installationsbefehl),
// die ruhige Nur-ansehen-Meldung aus `authFetch` und die Nyx-Fragen in der Demo.
import type { AppInfo } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoNav } from "../src/features/demo/demoApi";
import { DemoShell } from "../src/features/demo/DemoShell";
import { ChatPanel } from "../src/features/nyx/tab/panels/ChatPanel";
import type { NyxConversation } from "../src/features/nyx/tab/useNyxConversation";
import { StepWelcome } from "../src/features/onboarding/StepWelcome";
import { __primeAuthForTests, __resetAuthForTests, authFetch } from "../src/features/terminal/authClient";
import { DemoReadonlyError } from "../src/lib/demoReadonly";
import { friendlyError } from "../src/lib/friendlyError";
import { jsonResponse, renderWithClient } from "./helpers";

const INFO: AppInfo = {
  name: "NyxOS",
  version: "0.1.0",
  mode: "local",
  demo: false,
  demoHomeUrl: null,
  demoEngine: null,
  repo: "acme/nyxos",
  settings: { lang: "de", userName: "", onboardingDone: false, autoUpdate: true },
  update: { latest: null, available: false, checkedAt: null, canInstall: true, installing: false, error: null },
  dataDir: null,
};

type Handler = (init?: RequestInit) => Promise<Response>;

function stubServer(routes: Record<string, Handler>) {
  __primeAuthForTests();
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const handler = routes[url];
    return handler ? handler(init) : Promise.reject(new Error(`keine Antwort für ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAuthForTests();
  document.documentElement.style.removeProperty("--a-demo-bar-h");
});

describe("Demo · Onboarding „Demo ansehen“", () => {
  function renderWelcome() {
    return renderWithClient(
      <MemoryRouter>
        <StepWelcome name="" onName={() => undefined} onSubmit={() => undefined} beforeReload={() => undefined} />
      </MemoryRouter>,
    );
  }

  it("startet die Demo ohne Namen: Ladezustand, dann Wechsel zur Anmelde-Adresse der Demo", async () => {
    let release: (r: Response) => void = () => undefined;
    const fetchMock = stubServer({
      "/api/app/info": () => jsonResponse(INFO),
      "/api/demo/start": () => new Promise<Response>((r) => (release = r)),
    });
    const go = vi.spyOn(demoNav, "go").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWelcome();

    expect(screen.getByText("Die komplette App mit erfundenen Daten – nichts wird verändert.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Demo ansehen" }));
    expect(await screen.findByRole("button", { name: /Demo wird vorbereitet/ })).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/demo/start");
    expect(call?.[1]?.method).toBe("POST");
    expect(new Headers(call?.[1]?.headers).get("x-nyxos-csrf")).toBe("test-csrf");

    release(new Response(JSON.stringify({ url: "http://localhost:4401/api/demo/enter?t=abc" }), { status: 200, headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("http://localhost:4401/api/demo/enter?t=abc"));
  });

  it("zeigt einen Fehler vom Server freundlich direkt darunter", async () => {
    stubServer({
      "/api/app/info": () => jsonResponse(INFO),
      "/api/demo/start": () => jsonResponse({ error: "Die Demo läuft schon in einem anderen Fenster." }, { status: 409 }),
    });
    const go = vi.spyOn(demoNav, "go").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWelcome();
    await user.click(screen.getByRole("button", { name: "Demo ansehen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Die Demo läuft schon in einem anderen Fenster.");
    expect(screen.getByRole("button", { name: "Demo ansehen" })).toBeInTheDocument();
    expect(go).not.toHaveBeenCalled();
  });
});

describe("Demo · Leiste unten", () => {
  it("mit eigener Installation: großer Knopf „Jetzt einrichten“ führt dorthin zurück", async () => {
    stubServer({ "/api/app/info": () => jsonResponse({ ...INFO, demo: true, demoHomeUrl: "http://localhost:4400/onboarding", demoEngine: "ai" }) });
    const go = vi.spyOn(demoNav, "go").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWithClient(<DemoShell />);
    const bar = await screen.findByTestId("demo-bar");
    expect(within(bar).getByText(/Du siehst eine Demo mit erfundenen Daten/)).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Jetzt einrichten" }));
    expect(go).toHaveBeenCalledWith("http://localhost:4400/onboarding");
    expect(screen.queryByText(/raw.githubusercontent.com/)).toBeNull();
  });

  it("ohne Installation (eigenständige Demo): der Knopf zeigt den Installationsbefehl zum Kopieren", async () => {
    stubServer({ "/api/app/info": () => jsonResponse({ ...INFO, demo: true, demoHomeUrl: null, demoEngine: "scripted" }) });
    const go = vi.spyOn(demoNav, "go").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWithClient(<DemoShell />);
    const button = within(await screen.findByTestId("demo-bar")).getByRole("button", { name: "Jetzt einrichten" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("curl -fsSL https://raw.githubusercontent.com/acme/nyxos/main/install.sh | bash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Befehl kopieren/ })).toBeInTheDocument();
    expect(go).not.toHaveBeenCalled();
  });

  it("außerhalb der Demo gibt es keine Leiste", async () => {
    const fetchMock = stubServer({ "/api/app/info": () => jsonResponse(INFO) });
    renderWithClient(<DemoShell />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("demo-bar")).toBeNull();
  });
});

describe("Demo · nur umsehen", () => {
  it("authFetch: 403 demo_readonly → eine ruhige Meldung, kein zweiter Versuch, kein roter Fehlertext", async () => {
    const fetchMock = stubServer({
      "/api/app/info": () => jsonResponse({ ...INFO, demo: true, demoHomeUrl: "http://localhost:4400/onboarding" }),
      "/api/entries": () => jsonResponse({ error: "In der Demo nicht möglich.", code: "demo_readonly" }, { status: 403 }),
    });
    const go = vi.spyOn(demoNav, "go").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWithClient(<DemoShell />);
    await screen.findByTestId("demo-bar");

    const err = await authFetch("/api/entries", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DemoReadonlyError);
    expect(friendlyError(err)).toBe("");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/entries")).toHaveLength(1);

    const notice = await screen.findByTestId("demo-notice");
    expect(notice).toHaveTextContent("In der Demo kannst du dich nur umsehen – richte NyxOS ein, um loszulegen.");
    // Zwei Ablehnungen hintereinander → trotzdem nur eine Meldung.
    await authFetch("/api/entries", { method: "POST", body: "{}" }).catch(() => undefined);
    expect(screen.getAllByTestId("demo-notice")).toHaveLength(1);

    await user.click(within(notice).getByRole("button", { name: "Jetzt einrichten" }));
    expect(go).toHaveBeenCalledWith("http://localhost:4400/onboarding");
    expect(screen.queryByTestId("demo-notice")).toBeNull();
  });
});

describe("Demo · Nyx-Fragen", () => {
  function conversation(ask = vi.fn(() => Promise.resolve())): NyxConversation {
    return { threadId: null, title: null, messages: [], busy: false, loading: false, tool: null, ask, interrupt: vi.fn(), newThread: vi.fn() } as unknown as NyxConversation;
  }

  it("zeigt in der Demo die Fragen als Knöpfe; ein Klick schickt die Frage ab, mit Hinweis auf Demo-Antworten", async () => {
    stubServer({
      "/api/app/info": () => jsonResponse({ ...INFO, demo: true, demoHomeUrl: null, demoEngine: "scripted" }),
      "/api/demo/questions": () => jsonResponse({ questions: ["Was wartet gerade auf mich?", "Wie viel habe ich diese Woche ausgegeben?"] }),
    });
    const ask = vi.fn(() => Promise.resolve());
    const onSent = vi.fn();
    const user = userEvent.setup();
    renderWithClient(<ChatPanel conversation={conversation(ask)} gifts={[]} onClearGifts={() => undefined} onSent={onSent} />);

    const chip = await screen.findByRole("button", { name: "Wie viel habe ich diese Woche ausgegeben?" });
    expect(screen.getByText("Demo-Antworten – nach dem Einrichten beantwortet Nyx alles mit deiner KI.")).toBeInTheDocument();
    await user.click(chip);
    expect(ask).toHaveBeenCalledWith("Wie viel habe ich diese Woche ausgegeben?", "web", {}, []);
    expect(onSent).toHaveBeenCalledWith("Wie viel habe ich diese Woche ausgegeben?");
  });

  it("außerhalb der Demo keine Fragen-Knöpfe und kein Abruf", async () => {
    const fetchMock = stubServer({ "/api/app/info": () => jsonResponse(INFO) });
    renderWithClient(<ChatPanel conversation={conversation()} gifts={[]} onClearGifts={() => undefined} onSent={() => undefined} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/app/info", expect.anything()));
    expect(screen.queryByTestId("demo-questions")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/demo/questions")).toBe(false);
  });
});
