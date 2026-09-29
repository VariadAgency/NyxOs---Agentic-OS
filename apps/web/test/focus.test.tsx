// Focus button: shows the active mode (auto only the icon), menu with three modes + one sentence each, duration →
// PUT /api/focus (with the end computed in the viewer's time zone), short confirmation; Escape closes; settings row.
import type { FocusPut, FocusResponse, FocusState } from "@nyxos/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusControl, FocusSettingsPanel } from "../src/features/focus/FocusControl";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

function stubFocus(initial: FocusState) {
  let state = initial;
  const puts: FocusPut[] = [];
  __primeAuthForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/focus" && (init?.method ?? "GET") === "PUT") {
        const body = JSON.parse(String(init?.body)) as FocusPut;
        puts.push(body);
        state = body.mode === "auto" ? { mode: "auto", until: null, since: null, setBy: "user" } : { mode: body.mode, until: body.until ?? null, since: new Date().toISOString(), setBy: "user" };
        return jsonResponse({ state, now: new Date().toISOString() } satisfies FocusResponse);
      }
      if (url === "/api/focus") return jsonResponse({ state, now: new Date().toISOString() } satisfies FocusResponse);
      if (url === "/api/app/info") return Promise.reject(new Error("offline"));
      return Promise.reject(new Error(`unerwartete URL ${url}`));
    }),
  );
  return puts;
}

const AUTO: FocusState = { mode: "auto", until: null, since: null, setBy: null };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Fokus-Knopf", () => {
  it("Automatisch zeigt nur das Symbol; Menü mit drei Modi und je einem Satz", async () => {
    stubFocus(AUTO);
    renderWithClient(<FocusControl />);
    const btn = await screen.findByTestId("focus-button");
    await waitFor(() => expect(btn).toHaveAttribute("aria-label", "Fokus: Automatisch"));
    expect(btn.textContent).toBe("◐");
    await userEvent.click(btn);
    const menu = await screen.findByTestId("focus-menu");
    for (const name of ["Automatisch", "Ich bin weg", "Nicht stören"]) expect(within(menu).getByRole("radio", { name: new RegExp(name) })).toBeInTheDocument();
    expect(within(menu).getByText(/Keine Mitteilungen auf Rechner und Browser/)).toBeInTheDocument();
    expect(within(menu).getByTestId("focus-mode-auto")).toHaveAttribute("aria-checked", "true");
  });

  it("„Nicht stören“ → Dauer „Bis ich es ausschalte“ → PUT, Bestätigung, Knopf zeigt den Modus", async () => {
    const puts = stubFocus(AUTO);
    renderWithClient(<FocusControl />);
    await userEvent.click(await screen.findByTestId("focus-button"));
    await userEvent.click(screen.getByTestId("focus-mode-dnd"));
    await userEvent.click(screen.getByTestId("focus-duration-manual"));
    await waitFor(() => expect(puts).toEqual([{ mode: "dnd", duration: "manual" }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Nicht stören · bis du es ausschaltest – an.");
    const btn = screen.getByTestId("focus-button");
    expect(btn).toHaveAttribute("data-mode", "dnd");
    expect(btn).toHaveTextContent("Nicht stören");
  });

  it("„Ich bin weg“ 1 Stunde; Escape schließt das Menü", async () => {
    const puts = stubFocus(AUTO);
    renderWithClient(<FocusControl />);
    await userEvent.click(await screen.findByTestId("focus-button"));
    await userEvent.click(screen.getByTestId("focus-mode-away"));
    await userEvent.click(screen.getByTestId("focus-duration-1h"));
    await waitFor(() => expect(puts).toEqual([{ mode: "away", duration: "1h", until: expect.any(String) as string }]));
    const end = Date.parse(puts[0]?.until ?? "");
    expect(Math.abs(end - (Date.now() + 3_600_000))).toBeLessThan(60_000);
    await waitFor(() => expect(screen.getByTestId("focus-button")).toHaveTextContent(/Weg · bis/));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("focus-menu")).not.toBeInTheDocument());
  });

  it("Einstellungen: Zeile „Fokus: …“ mit Satz und „Ändern“; zurück auf Automatisch", async () => {
    const puts = stubFocus({ mode: "away", until: null, since: null, setBy: "nyx" });
    renderWithClient(<FocusSettingsPanel />);
    expect(await screen.findByText("Fokus: Ich bin weg · bis du es ausschaltest")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Ändern" }));
    await userEvent.click(screen.getByTestId("focus-mode-auto"));
    await waitFor(() => expect(puts).toEqual([{ mode: "auto" }]));
  });
});
