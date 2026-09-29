// Einstellungen → „Verbindungen“ zeigt die Server-Prüfung gruppiert und bunt, mit
// Antwortzeit, Ursache und Lösung; Punkte „nur du“ mit Befehl zum Kopieren; „Jetzt prüfen“ holt einen
// frischen Lauf. Die Statuszeile unten links verlinkt dorthin.
import type { ConnectionsReport } from "@nyxos/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "../src/components/ConnectionStatus";
import { ConnectionsPanel } from "../src/features/settings/ConnectionsPanel";
import { jsonResponse, renderWithClient } from "./helpers";

function reportWith(overrides: Partial<ConnectionsReport> = {}): ConnectionsReport {
  return {
    checkedAt: "2026-09-25T09:30:00.000Z",
    ms: 412,
    cached: false,
    summary: { ok: 2, warn: 1, fail: 1, user: 1, idle: 0 },
    checks: [
      { id: "db", group: "server", label: "Datenbank „nyxos“", expected: "antwortet, Sessions lesbar", ok: true, state: "ok", ms: 4, result: "812 Sessions" },
      { id: "bridge-channel", group: "bruecke", label: "Kanal zur Brücke", expected: "verbunden", ok: false, state: "fail", ms: 1, cause: "Die Brücke hat gerade keine Verbindung zum Server.", fix: "Brücke neu starten.", command: "launchctl kickstart -k gui/$(id -u)/app.nyxos.bridge" },
      { id: "bridge-buffer", group: "bruecke", label: "Puffer der Brücke", expected: "leer oder klein", ok: true, state: "warn", ms: 3000, cause: "Die installierte Brücke ist eine ältere Fassung.", fix: "Beim nächsten Deploy neu installieren." },
      { id: "haiku-token", group: "haiku", label: "Nyx-Token (Max-Plan)", expected: "gesetzt", ok: false, state: "user", ms: 0, cause: "Der Token fehlt auf dem Server.", fix: "Einmal im eigenen Terminal ausführen.", command: "claude setup-token && scripts/set-haiku-token.sh" },
      { id: "csrf", group: "zugang", label: "Schutz schreibender Aufrufe (CSRF)", expected: "401 · 403 · durch", ok: true, state: "ok", ms: 12, result: "401 · 403 · durchgelassen (404)" },
    ],
    ...overrides,
  };
}

function stub(handler: (url: string) => Promise<Response>) {
  const fn = vi.fn((input: RequestInfo | URL) => handler(typeof input === "string" ? input : input.toString()));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderPanel() {
  return renderWithClient(
    <MemoryRouter initialEntries={["/settings#verbindungen"]}>
      <ConnectionsPanel />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConnectionsPanel", () => {
  it("zeigt die Prüfungen gruppiert, mit Zustand, Antwortzeit, Ursache und Lösung", async () => {
    stub((url) => (url === "/api/connections" ? jsonResponse(reportWith()) : Promise.reject(new Error(url))));
    renderPanel();

    const bruecke = await screen.findByRole("generic", { name: "Brücke" });
    expect(within(bruecke).getByText("2 von 2 brauchen Aufmerksamkeit")).toBeInTheDocument();
    const channel = within(bruecke).getByRole("listitem", { name: "Kanal zur Brücke: gestört" });
    expect(within(channel).getByText("Die Brücke hat gerade keine Verbindung zum Server.")).toBeInTheDocument();
    expect(within(channel).getByText("Brücke neu starten.")).toBeInTheDocument();
    expect(within(channel).getByText("1 ms")).toBeInTheDocument();

    const server = screen.getByRole("generic", { name: "Server & Datenbank" });
    expect(within(server).getByText("alles in Ordnung")).toBeInTheDocument();
    expect(within(server).getByText(/812 Sessions/)).toBeInTheDocument();
    expect(screen.getByText(/Geprüft um .* · 5 Verbindungen in 412 ms/)).toBeInTheDocument();
    // Zusammenfassung: je Zustand eine bunte Zahl
    expect(screen.getByText("1 nur du")).toBeInTheDocument();
    expect(screen.getByText("1 gestört")).toBeInTheDocument();
    expect(screen.getByText("2 läuft")).toBeInTheDocument();
  });

  it("Farben nur aus den Tokens: keine festen Hex-Farben, jede Gruppe mit eigenem Punkt", async () => {
    stub((url) => (url === "/api/connections" ? jsonResponse(reportWith()) : Promise.reject(new Error(url))));
    const { container } = renderPanel();
    await screen.findByRole("generic", { name: "Brücke" });
    // Nur die eigenen Punkte/Pillen dieser Seite (Card/Button sind gemeinsame Bausteine).
    const own = [...container.querySelectorAll("h3 > span, li span.rounded-full")].map((el) => el.getAttribute("class") ?? "");
    expect(own.length).toBeGreaterThan(4);
    expect(own.filter((c) => /\[#[0-9a-f]{3,8}\]/i.test(c))).toEqual([]);
    const dots = ["Server & Datenbank", "Brücke", "Nyx", "Anmeldung & Schutz"].map((name) => screen.getByRole("generic", { name }).querySelector("h3 > span")?.getAttribute("class") ?? "");
    expect(new Set(dots).size).toBe(dots.length);
  });

  it("„Nur du“-Punkt zeigt den fertigen Befehl, „Kopieren“ legt ihn in die Zwischenablage", async () => {
    stub((url) => (url === "/api/connections" ? jsonResponse(reportWith()) : Promise.reject(new Error(url))));
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    renderPanel();

    const token = await screen.findByRole("listitem", { name: "Nyx-Token (Max-Plan): nur du" });
    expect(within(token).getByText("claude setup-token && scripts/set-haiku-token.sh")).toBeInTheDocument();
    await user.click(within(token).getByRole("button", { name: /Befehl kopieren/ }));
    expect(writeText).toHaveBeenCalledWith("claude setup-token && scripts/set-haiku-token.sh");
    expect(await within(token).findByText("Kopiert")).toBeInTheDocument();
  });

  it("„Jetzt prüfen“ holt einen frischen Lauf (?fresh=1) und zeigt ihn sofort", async () => {
    const fresh = reportWith({
      summary: { ok: 5, warn: 0, fail: 0, user: 0, idle: 0 },
      checks: reportWith().checks.map((c) => ({ ...c, state: "ok" as const, ok: true, cause: undefined, fix: undefined, command: undefined })),
    });
    const fetchFn = stub((url) => {
      if (url === "/api/connections") return jsonResponse(reportWith());
      if (url === "/api/connections?fresh=1") return jsonResponse(fresh);
      return Promise.reject(new Error(url));
    });
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("1 gestört");
    await user.click(screen.getByRole("button", { name: "Jetzt prüfen" }));
    expect(await screen.findByText("5 läuft")).toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalledWith("/api/connections?fresh=1");
    expect(screen.getByText("0 gestört")).toBeInTheDocument();
  });

  it("lokaler Modus: „wartet“ ist ruhig (grau, zählt nicht als Aufmerksamkeit), Gruppen ohne Server-Worte", async () => {
    const local = reportWith({
      mode: "local",
      summary: { ok: 1, warn: 0, fail: 0, user: 0, idle: 2 },
      checks: [
        { id: "db", group: "server", label: "Datenbank „nyxos“", expected: "antwortet, Sessions lesbar", ok: true, state: "ok", ms: 4, result: "0 Sessions" },
        { id: "bridge-ingest", group: "bruecke", label: "Ingest (Session-Ereignisse)", expected: "Ereignisse kommen an", ok: true, state: "idle", ms: 2, result: "noch keine Session", cause: "Kommt, sobald du eine Claude-Session startest." },
        { id: "bridge-watcher", group: "bruecke", label: "Datei-Wächter (Verläufe)", expected: "Verläufe werden archiviert", ok: true, state: "idle", ms: 2, cause: "Kommt, sobald du eine Claude-Session startest." },
      ],
    });
    stub((url) => (url === "/api/connections" ? jsonResponse(local) : Promise.reject(new Error(url))));
    renderPanel();

    const bridge = await screen.findByRole("generic", { name: "Brücke" });
    expect(screen.queryByText(/Mac-Brücke/)).toBeNull();
    expect(screen.getByRole("generic", { name: "Datenbank & Archiv" })).toBeInTheDocument();
    expect(within(bridge).getByText("alles in Ordnung")).toBeInTheDocument();
    const ingest = within(bridge).getByRole("listitem", { name: "Ingest (Session-Ereignisse): wartet" });
    expect(ingest).toHaveAttribute("data-state", "idle");
    expect(within(ingest).getByText("Kommt, sobald du eine Claude-Session startest.")).toHaveClass("text-a-mut");
    expect(screen.getByText("2 wartet")).toBeInTheDocument();
    expect(screen.getByText("0 gestört")).toBeInTheDocument();
  });

  it("Server-Modus: kein „wartet“-Zähler, solange es keinen solchen Punkt gibt", async () => {
    stub((url) => (url === "/api/connections" ? jsonResponse(reportWith()) : Promise.reject(new Error(url))));
    renderPanel();
    await screen.findByText("1 gestört");
    expect(screen.queryByText(/\d wartet/)).toBeNull();
  });

  it("Server kennt die Prüfung noch nicht (404): ehrlicher Hinweis statt Fehlertext", async () => {
    stub(() => Promise.resolve(new Response(JSON.stringify({ error: "Nicht gefunden" }), { status: 404 })));
    renderPanel();
    expect(await screen.findByText(/noch nicht eingespielt/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });
});

describe("ConnectionStatus → Verbindungen", () => {
  it("die Statuszeile unten links verlinkt auf /settings#verbindungen", async () => {
    stub((url) => {
      if (url === "/health") return jsonResponse({ ok: true });
      if (url === "/api/machines") return jsonResponse([]);
      if (url === "/api/auth/status") return jsonResponse({ authenticated: true, csrf: "c", hasPasskey: true, authReads: false });
      return Promise.reject(new Error(url));
    });
    renderWithClient(
      <MemoryRouter>
        <ConnectionStatus />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /Alle Verbindungen ansehen/ });
    expect(link).toHaveAttribute("href", "/settings#verbindungen");
  });
});
