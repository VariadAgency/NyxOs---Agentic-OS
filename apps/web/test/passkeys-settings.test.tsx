// Passkeys verwalten in Einstellungen → Anmeldung. Liste auf Knopfdruck, der gerade benutzte
// Passkey lässt sich nicht entfernen, Entfernen erst nach Rückfrage und mit Token.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSettingsPanel } from "../src/features/settings/AuthSettingsPanel";
import { __resetAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

const creds = [
  { id: "cred-current", name: "MacBook", createdAt: "2026-09-20T10:00:00.000Z", lastUsedAt: "2026-09-25T10:00:00.000Z", current: true },
  { id: "cred-old", name: "Test-Passkey 1", createdAt: "2026-09-25T13:52:00.000Z", lastUsedAt: null, current: false },
];

beforeEach(() => __resetAuthForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stub() {
  let list = [...creds];
  const calls: { url: string; method: string; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, csrf: new Headers(init?.headers).get("x-nyxos-csrf") });
      if (url === "/api/auth/status") return jsonResponse({ authenticated: true, csrf: "csrf-1", hasPasskey: true, authReads: true });
      if (url === "/api/auth/credentials") return jsonResponse({ credentials: list });
      if (url === "/api/auth/credentials/cred-old" && method === "DELETE") {
        list = list.filter((c) => c.id !== "cred-old");
        return jsonResponse({ ok: true, sessions: 1 });
      }
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
  return calls;
}

describe("Passkeys verwalten", () => {
  it("zeigt die Liste; der gerade benutzte ist markiert und nicht entfernbar", async () => {
    const calls = stub();
    renderWithClient(<AuthSettingsPanel />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Passkeys anzeigen" }));

    const list = await screen.findByTestId("passkey-list");
    expect(within(list).getByText("dieses Gerät · gerade benutzt")).toBeInTheDocument();
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "Entfernen" })).toBeDisabled();
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: "Entfernen" })).toBeEnabled();
    expect(within(rows[1] as HTMLElement).getByText(/zuletzt benutzt noch nie/)).toBeInTheDocument();
    // Auch das Lesen trägt das Token.
    expect(calls.find((c) => c.url === "/api/auth/credentials")?.csrf).toBe("csrf-1");
  });

  it("Entfernen erst nach Rückfrage, mit Token; danach ist der Eintrag weg", async () => {
    const calls = stub();
    const user = userEvent.setup();
    renderWithClient(<AuthSettingsPanel />);
    await user.click(await screen.findByRole("button", { name: "Passkeys anzeigen" }));
    const list = await screen.findByTestId("passkey-list");
    const row = within(list).getAllByRole("listitem")[1] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Entfernen" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(within(row).getByRole("button", { name: "Ja, entfernen" }));
    await screen.findByText(/„Test-Passkey 1“ ist entfernt/);
    expect(calls.find((c) => c.method === "DELETE")?.csrf).toBe("csrf-1");
    expect(within(screen.getByTestId("passkey-list")).getAllByRole("listitem")).toHaveLength(1);
  });
});
