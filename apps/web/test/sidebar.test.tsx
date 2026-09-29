import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "../src/components/ConnectionStatus";
import { jsonResponse, presenceBody, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectionStatus", () => {
  // Der Zustand kommt fertig vom Server (/api/bridge/presence). Ein altes lastSeenAt aus
  // /api/machines macht die Anzeige nicht mehr rot, solange der Kanal offen ist.
  it("zeigt „Brücke online“, auch wenn /api/machines ein 5 Minuten altes lastSeenAt liefert", async () => {
    const lastSeenAt = new Date(Date.now() - 5 * 60_000).toISOString();
    stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      machines: () => jsonResponse([{ id: "m1", name: "MacBook Pro", lastSeenAt }]),
      bridgePresence: () => jsonResponse(presenceBody({ machine: { id: "m1", name: "MacBook Pro" } })),
    });

    renderWithClient(<ConnectionStatus />);

    expect(await screen.findByText(/Brücke online/)).toBeInTheDocument();
    expect(screen.getByText(/MacBook Pro/)).toBeInTheDocument();
    expect(screen.queryByText(/offline/)).not.toBeInTheDocument();
  });

  // Ein /health-Fehler ist zuerst ein kurzer Aussetzer (gelb), rot erst nach 90 s (s. server-status-grace.test.tsx).
  it("zeigt bei einem /health-Fehler zuerst gelb „Verbindung wird neu aufgebaut …“", async () => {
    stubFetchRoutes({
      health: () => Promise.resolve(new Response("boom", { status: 500 })),
      machines: () => jsonResponse([]),
    });

    renderWithClient(<ConnectionStatus />);

    expect(await screen.findByText("Verbindung wird neu aufgebaut …")).toBeInTheDocument();
    expect(screen.queryByText("Server nicht erreichbar")).not.toBeInTheDocument();
  });

  it("zeigt „Server verbunden“, wenn /health ok meldet", async () => {
    stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      machines: () => jsonResponse([]),
    });

    renderWithClient(<ConnectionStatus />);

    expect(await screen.findByText("Server verbunden")).toBeInTheDocument();
  });

  // "unbekannt ≠ online": solange die erste Antwort noch aussteht, darf weder
  // Zeile "online" behaupten — vorher fiel `bridgeOnline` beim Laden einfach auf `false`, optisch
  // nicht von einer echten Offline-Prüfung zu unterscheiden.
  it("zeigt „unbekannt“ statt „online“, solange /health noch lädt", () => {
    stubFetchRoutes({
      health: () => new Promise(() => {}), // hängt bewusst — simuliert "noch keine Antwort"
      machines: () => new Promise(() => {}),
      bridgePresence: () => new Promise(() => {}),
    });

    renderWithClient(<ConnectionStatus />);

    expect(screen.getByText(/prüfe/)).toBeInTheDocument();
    expect(screen.getByText(/Brücke unbekannt/)).toBeInTheDocument();
    expect(screen.queryByText(/Brücke online/)).not.toBeInTheDocument();
  });

  it("Brücke bleibt „unbekannt“ (nicht „online“), wenn der Server selbst nicht erreichbar ist", async () => {
    stubFetchRoutes({
      health: () => Promise.resolve(new Response("boom", { status: 500 })),
      bridgePresence: () => jsonResponse(presenceBody()), // frisch, aber ohne Belang
    });

    renderWithClient(<ConnectionStatus />);

    expect(await screen.findByText("Verbindung wird neu aufgebaut …")).toBeInTheDocument();
    expect(screen.queryByText(/Brücke online/)).not.toBeInTheDocument();
  });
});
