// Fehlertexte: Das Briefing zeigte früher „Failed to fetch“. Keine Technik-Texte in
// der Oberfläche — EINE Funktion (`friendlyError`) macht daraus einen einfachen Satz, dazu „Erneut versuchen“.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Briefing } from "../src/features/haiku/Briefing";
import { ContainerLogView } from "../src/features/server/ContainerLogView";
import { LOGIN_EVENT } from "../src/features/terminal/authClient";
import { ApiError } from "../src/lib/http";
import { DEFAULT_TEXT, friendlyError, OFFLINE_TEXT, SERVER_TROUBLE_TEXT } from "../src/lib/friendlyError";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("friendlyError", () => {
  it.each([
    [new TypeError("Failed to fetch"), OFFLINE_TEXT],
    [new TypeError("NetworkError when attempting to fetch resource."), OFFLINE_TEXT],
    [new TypeError("Load failed"), OFFLINE_TEXT],
    [new ApiError("Server antwortet mit 500", 500), SERVER_TROUBLE_TEXT],
    [new Error("HTTP 503"), DEFAULT_TEXT],
    [new Error("spawn tmux ENOENT"), DEFAULT_TEXT],
    [new Error("CSRF-Token fehlt"), DEFAULT_TEXT],
  ])("%s → einfacher Satz", (e, want) => {
    expect(friendlyError(e)).toBe(want);
  });

  it("lässt deutsche Sätze vom Server stehen", () => {
    expect(friendlyError(new ApiError("Die Session arbeitet gerade – versuch es, sobald sie wartet.", 409))).toBe("Die Session arbeitet gerade – versuch es, sobald sie wartet.");
  });

  it("nimmt den Satz der Stelle als Rückfall", () => {
    expect(friendlyError(new Error("Unexpected token < in JSON"), "Speichern hat nicht geklappt.")).toBe("Speichern hat nicht geklappt.");
  });
});

describe("Briefing – Neuschreiben scheitert am Netz", () => {
  // Tageszeit festlegen: ab 18 Uhr zeigt das Briefing den Abend-Rückblick – die Tests meinen das Tages-Briefing.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T08:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("zeigt einen einfachen Satz und „Erneut versuchen“, nie „Failed to fetch“", async () => {
    const report = { id: 1, kind: "briefing", day: "2026-09-25", createdAt: "2026-09-25T05:00:00.000Z", greeting: "x", lage: "Lage.", sections: [], runsWithoutYou: [], needsYou: [], mode: "ok", callId: 1, stale: true };
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/haiku/report") && !init?.method) return jsonResponse({ report });
        if (url === "/api/haiku/report" && init?.method === "POST") {
          posts++;
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        if (url === "/api/haiku/light-day") return jsonResponse({ items: [], deferred: 0 });
        if (url === "/api/auth/status") return jsonResponse({ authenticated: true, csrf: "c", hasPasskey: true, authReads: true });
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    renderWithClient(
      <MemoryRouter>
        <Briefing />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Keine Verbindung zum Server/)).toBeInTheDocument();
    // Der Originaltext steht höchstens EINGEKLAPPT unter „Details“, nie sichtbar.
    const raw = screen.queryByText(/Failed to fetch/);
    if (raw) expect(raw.closest("details")?.open).toBe(false);
    const retry = screen.getByRole("button", { name: "Erneut versuchen" });
    const before = posts;
    await userEvent.click(retry);
    await vi.waitFor(() => expect(posts).toBeGreaterThan(before));
  });
});

describe("Server-Logs ohne Anmeldung", () => {
  it("zeigt „Bitte anmelden“ mit Touch-ID-Knopf statt ewig „Lädt …“", async () => {
    const logCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/auth/status") return jsonResponse({ authenticated: false, csrf: null, hasPasskey: true, authReads: false });
        if (url.includes("/logs")) {
          logCalls.push(url);
          return Promise.resolve(new Response(JSON.stringify({ error: "Bitte anmelden" }), { status: 401 }));
        }
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    const handler = vi.fn();
    window.addEventListener(LOGIN_EVENT, handler);
    renderWithClient(<ContainerLogView id="abc" name="nyxos-api" dozzleUrl={null} />);
    expect(await screen.findByText(/Bitte anmelden/)).toBeInTheDocument();
    expect(screen.queryByText(/Lädt die letzten Zeilen/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Mit Touch ID anmelden" }));
    expect(handler).toHaveBeenCalled();
    expect(logCalls).toEqual([]);
    window.removeEventListener(LOGIN_EVENT, handler);
  });
});
