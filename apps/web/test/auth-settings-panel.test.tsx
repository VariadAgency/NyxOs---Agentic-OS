// UX-Paket „Anmeldung sichtbar machen": Abschnitt in den Einstellungen zeigt die drei Zustände aus
// `fetchAuthStatus` und löst mit seinen Knöpfen den vorhandenen Anmelde-Dialog über `LOGIN_EVENT` aus.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthSettingsPanel } from "../src/features/settings/AuthSettingsPanel";
import { LOGIN_EVENT } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

function stubAuthStatus(status: { authenticated: boolean; hasPasskey: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/status") {
        return jsonResponse({ authenticated: status.authenticated, csrf: status.authenticated ? "csrf-1" : null, hasPasskey: status.hasPasskey, authReads: true });
      }
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AuthSettingsPanel", () => {
  it("Angemeldet: zeigt den Status und einen Abmelden-Knopf, keinen Anmelden-Knopf", async () => {
    stubAuthStatus({ authenticated: true, hasPasskey: true });
    renderWithClient(<AuthSettingsPanel />);

    await screen.findByText("Angemeldet auf diesem Gerät");
    expect(screen.getByRole("button", { name: "Abmelden" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anmelden" })).not.toBeInTheDocument();
  });

  it("Nicht angemeldet mit Passkey: zeigt Anmelden- und Neues-Gerät-Knopf", async () => {
    stubAuthStatus({ authenticated: false, hasPasskey: true });
    renderWithClient(<AuthSettingsPanel />);

    await screen.findByText("Nicht angemeldet – ansehen geht, Aktionen brauchen die Anmeldung");
    expect(screen.getByRole("button", { name: "Anmelden" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Neues Gerät einrichten" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abmelden" })).not.toBeInTheDocument();
  });

  it("Ohne Passkey: zeigt „Noch kein Passkey eingerichtet“ mit Passkey-einrichten-Knopf", async () => {
    stubAuthStatus({ authenticated: false, hasPasskey: false });
    renderWithClient(<AuthSettingsPanel />);

    await screen.findByText("Noch kein Passkey eingerichtet");
    expect(screen.getByRole("button", { name: "Passkey einrichten" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Neues Gerät einrichten" })).not.toBeInTheDocument();
  });

  it("Anmelden-Knopf löst LOGIN_EVENT aus (öffnet den vorhandenen Dialog)", async () => {
    stubAuthStatus({ authenticated: false, hasPasskey: true });
    const handler = vi.fn();
    window.addEventListener(LOGIN_EVENT, handler);
    renderWithClient(<AuthSettingsPanel />);

    const button = await screen.findByRole("button", { name: "Anmelden" });
    await userEvent.setup().click(button);
    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener(LOGIN_EVENT, handler);
  });

  it("„Neues Gerät einrichten“ löst LOGIN_EVENT mit newDevice-Detail aus", async () => {
    stubAuthStatus({ authenticated: false, hasPasskey: true });
    const handler = vi.fn();
    window.addEventListener(LOGIN_EVENT, handler);
    renderWithClient(<AuthSettingsPanel />);

    const button = await screen.findByRole("button", { name: "Neues Gerät einrichten" });
    await userEvent.setup().click(button);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0]?.[0] as CustomEvent<{ newDevice?: boolean }>).detail?.newDevice).toBe(true);

    window.removeEventListener(LOGIN_EVENT, handler);
  });
});
