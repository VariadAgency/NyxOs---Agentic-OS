// Server-SSH im Server-Tab: Karte „Terminal zum Server öffnen“ startet erst auf Klick (kein Autostart),
// dann eingebettetes Terminal über `/terminal/ssh/<name>`; „Trennen“ nur mit kurzer Bestätigung.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRiskyElement } from "../src/features/nyx/uiExecutor";
import { ServerTerminal } from "../src/features/server/ServerTerminal";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const NAME = "zc-ssh-a1b2c3d4";

function stub(o: { status?: Record<string, unknown> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const sockets: string[] = [];
  let running = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      if (url.startsWith("/api/auth/status")) return jsonResponse({ authenticated: true, csrf: "csrf-123", hasPasskey: true, authReads: false });
      if (url === "/api/server/ssh") return jsonResponse(o.status ?? { bridgeOnline: true, supported: true, running, tmuxName: running ? NAME : null, code: null, message: null });
      if (url === "/api/server/ssh/start") {
        running = true;
        return jsonResponse({ tmuxName: NAME, reused: false });
      }
      if (url === "/api/server/ssh/stop") {
        running = false;
        return jsonResponse({ stopped: 1 });
      }
      return Promise.reject(new Error(`keine Antwort für ${url}`));
    }),
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      constructor(url: string) {
        sockets.push(url);
      }
      close() {}
      send() {}
    },
  );
  const posts = (path: string) => calls.filter((c) => c.url === path && c.init?.method === "POST");
  return { calls, sockets, posts };
}

describe("ServerTerminal", { timeout: 20_000 }, () => {
  it("startet erst auf Klick – beim Seitenaufruf kein Start und kein Terminal-Kanal", async () => {
    const s = stub();
    renderWithClient(<ServerTerminal />);
    expect(await screen.findByRole("button", { name: "Terminal zum Server öffnen" })).toBeEnabled();
    expect(screen.getByText("Echte Shell auf dem Server – Befehle wirken sofort.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.posts("/api/server/ssh/start")).toHaveLength(0);
    expect(s.sockets).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Terminal zum Server öffnen" }));
    await waitFor(() => expect(s.posts("/api/server/ssh/start")).toHaveLength(1));
    const start = s.posts("/api/server/ssh/start")[0];
    expect(new Headers(start?.init?.headers).get("x-nyxos-csrf")).toBe("csrf-123");
    // Nur die Feldgröße, nie ein Befehl oder Host.
    expect(Object.keys(JSON.parse(String(start?.init?.body)) as object).sort()).toEqual(["cols", "rows"]);
    await waitFor(() => expect(s.sockets.some((u) => u.includes(`/terminal/ssh/${NAME}?`) && u.includes("mode=rw"))).toBe(true));
    expect(screen.getByTestId("server-terminal-view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Vollbild/ })).toBeInTheDocument();
  });

  it("Nyx öffnet das Server-Terminal nie selbst und tippt nie hinein", async () => {
    stub();
    renderWithClient(<ServerTerminal />);
    const open = await screen.findByRole("button", { name: "Terminal zum Server öffnen" });
    expect(isRiskyElement(open)).toBe(true);
    await userEvent.click(open);
    const view = await screen.findByTestId("server-terminal-view");
    // Alles im Terminal (auch das versteckte Eingabefeld von xterm) gilt für Nyx als riskant.
    expect(isRiskyElement(view)).toBe(true);
    for (const field of view.querySelectorAll("textarea,input")) expect(isRiskyElement(field)).toBe(true);
    expect(isRiskyElement(screen.getByRole("button", { name: "Trennen" }))).toBe(true);
  });

  it("Trennen fragt kurz nach und beendet dann die Sitzung", async () => {
    const s = stub();
    renderWithClient(<ServerTerminal />);
    await userEvent.click(await screen.findByRole("button", { name: "Terminal zum Server öffnen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Trennen" }));
    expect(s.posts("/api/server/ssh/stop")).toHaveLength(0);
    await userEvent.click(await screen.findByRole("button", { name: "Ja, trennen" }));
    await waitFor(() => expect(s.posts("/api/server/ssh/stop")).toHaveLength(1));
    expect(JSON.parse(String(s.posts("/api/server/ssh/stop")[0]?.init?.body))).toEqual({ confirm: true });
    expect(await screen.findByRole("button", { name: "Terminal zum Server öffnen" })).toBeInTheDocument();
  });

  it("Brücke offline → ehrlicher Satz, Knopf gesperrt", async () => {
    stub({ status: { bridgeOnline: false, supported: false, running: false, tmuxName: null, code: "bridge_offline", message: "Dein Rechner ist gerade nicht verbunden." } });
    renderWithClient(<ServerTerminal />);
    expect(await screen.findByText(/Dein Rechner ist gerade nicht verbunden/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal zum Server öffnen" })).toBeDisabled();
  });

  it("kein SSH-Host eingerichtet → Hinweis, Knopf gesperrt", async () => {
    stub({ status: { bridgeOnline: true, supported: false, running: false, tmuxName: null, code: "not_configured", message: null, configured: false } });
    renderWithClient(<ServerTerminal />);
    expect(await screen.findByText(/NYXOS_SERVER_SSH_HOST/)).toBeInTheDocument();
    expect(screen.getByText("nicht eingerichtet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal zum Server öffnen" })).toBeDisabled();
  });

  it("zeigt den eingerichteten SSH-Host", async () => {
    stub({ status: { bridgeOnline: true, supported: true, running: false, tmuxName: null, code: null, message: null, host: "meinserver" } });
    renderWithClient(<ServerTerminal />);
    expect(await screen.findByText("ssh meinserver")).toBeInTheDocument();
  });

  it("läuft schon eine Sitzung → „Wieder verbinden“ statt Neustart, verbindet trotzdem erst auf Klick", async () => {
    const s = stub({ status: { bridgeOnline: true, supported: true, running: true, tmuxName: NAME, code: null, message: null } });
    renderWithClient(<ServerTerminal />);
    const btn = await screen.findByRole("button", { name: "Wieder verbinden" });
    expect(s.sockets).toHaveLength(0);
    await userEvent.click(btn);
    await waitFor(() => expect(s.sockets.some((u) => u.includes(`/terminal/ssh/${NAME}?`))).toBe(true));
  });
});
