// UX-Paket „Anmeldung sichtbar machen": dritte Zeile im Leisten-Fuß (Server/Brücke/Anmeldung).
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "../src/components/ConnectionStatus";
import { LOGIN_EVENT } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

function stubRoutes(authenticated: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/health") return jsonResponse({ ok: true });
      if (url === "/api/machines") return jsonResponse([]);
      if (url === "/api/auth/status") return jsonResponse({ authenticated, csrf: authenticated ? "csrf-1" : null, hasPasskey: true, authReads: true });
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConnectionStatus – Anmelde-Zeile", () => {
  it("zeigt „Angemeldet“, wenn eine Passkey-Sitzung besteht", async () => {
    stubRoutes(true);
    renderWithClient(<ConnectionStatus />);
    await screen.findByText("Angemeldet");
  });

  it("zeigt „Nicht angemeldet“ klickbar und öffnet den Anmelde-Dialog per LOGIN_EVENT", async () => {
    stubRoutes(false);
    const handler = vi.fn();
    window.addEventListener(LOGIN_EVENT, handler);
    renderWithClient(<ConnectionStatus />);

    const button = await screen.findByRole("button", { name: "Nicht angemeldet" });
    await userEvent.setup().click(button);
    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener(LOGIN_EVENT, handler);
  });
});
