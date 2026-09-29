// W-1 · Kontext-Wächter — Web: Doppel-Regler rendert, Standard-Speichern schickt PUT mit CSRF.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextGuardSettings } from "../src/features/context-guard/ContextGuardSettings";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

const SNAPSHOT = {
  default: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80, updatedAt: "2026-09-25T00:00:00Z" },
  haiku: { hinweisPct: 60, erzwingenEnabled: true, erzwingenPct: 80, updatedAt: "2026-09-25T00:00:00Z" },
  models: [{ model: "opus", hinweisPct: 55, erzwingenEnabled: true, erzwingenPct: 85, updatedAt: "2026-09-25T00:00:00Z" }],
  sessions: [],
};

describe("ContextGuardSettings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rendert Standard/Haiku/Modell-Doppel-Regler mit den geladenen Werten", async () => {
    __primeAuthForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(SNAPSHOT)),
    );
    renderWithClient(<ContextGuardSettings />);
    await waitFor(() => expect(screen.getByText(/Standard \(alle Sessions/)).toBeInTheDocument());
    expect(screen.getByText(/Nyx. eigene Sessions/)).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    // Zwei Griffe für Standard (Hinweis 60 %, Erzwingen 80 %) — je Regler zwei <input type="range">.
    const sliders = screen.getAllByRole("slider") as HTMLInputElement[];
    expect(sliders.length).toBeGreaterThanOrEqual(2);
  });

  it("Standard ändern + Speichern schickt PUT /api/context-guard/settings/default mit CSRF-Kopf", async () => {
    __primeAuthForTests();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init });
        if (init?.method === "PUT") return jsonResponse({ ...SNAPSHOT.default, hinweisPct: 55 });
        return jsonResponse(SNAPSHOT);
      }),
    );
    renderWithClient(<ContextGuardSettings />);
    await waitFor(() => expect(screen.getByText(/Standard \(alle Sessions/)).toBeInTheDocument());

    const hinweisSlider = screen.getAllByLabelText("Hinweis-Schwelle")[0] as HTMLInputElement;
    fireEvent.change(hinweisSlider, { target: { value: "55" } });

    const [saveButton] = screen.getAllByText("Speichern");
    if (!saveButton) throw new Error("Speichern-Knopf nicht gefunden");
    fireEvent.click(saveButton);

    await waitFor(() => expect(calls.some((c) => c.url === "/api/context-guard/settings/default" && c.init?.method === "PUT")).toBe(true));
    const putCall = calls.find((c) => c.url === "/api/context-guard/settings/default" && c.init?.method === "PUT");
    expect(new Headers(putCall?.init?.headers).get("x-nyxos-csrf")).toBe("test-csrf");
    expect(JSON.parse(String(putCall?.init?.body))).toMatchObject({ hinweisPct: 55 });
  });
});
