// friendlyError macht aus Technik einen einfachen Satz — der Originaltext darf dabei aber nicht
// VERLOREN gehen. Der Nutzer (oder ein Agent, dem er es zeigt) braucht ihn zur Fehlersuche. Er steht deshalb
// eingeklappt unter „Details“ (nicht im Blickfeld, aber aufklappbar).
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainerLogView } from "../src/features/server/ContainerLogView";
import { ApiError } from "../src/lib/http";
import { errorDetail } from "../src/lib/friendlyError";
import { jsonResponse, renderWithClient } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("errorDetail", () => {
  it("liefert den Originaltext, wenn der Satz ihn ersetzt hat", () => {
    expect(errorDetail(new TypeError("Failed to fetch"))).toContain("Failed to fetch");
    expect(errorDetail(new ApiError("Server antwortet mit 502", 502))).toContain("502");
    expect(errorDetail(new Error("spawn tmux ENOENT"))).toContain("ENOENT");
  });
  it("nichts, wenn der Satz schon der Originaltext ist", () => {
    expect(errorDetail(new ApiError("Die Session arbeitet gerade – versuch es, sobald sie wartet.", 409))).toBeNull();
    expect(errorDetail(null)).toBeNull();
  });
});

describe("Server-Logs: Fehler mit aufklappbaren Details", () => {
  it("einfacher Satz sichtbar, Technik erst unter „Details“", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/auth/status") return jsonResponse({ authenticated: true, csrf: "c", hasPasskey: true, authReads: false });
        if (url.includes("/logs")) return Promise.resolve(new Response(JSON.stringify({ error: "docker socket proxy: connect ECONNREFUSED" }), { status: 502 }));
        return Promise.reject(new Error(`unerwartet ${url}`));
      }),
    );
    renderWithClient(<ContainerLogView id="abc" name="nyxos-api" dozzleUrl={null} />);
    const summary = await screen.findByText("Details");
    expect(screen.getByText(/nicht erreichbar|nicht lesbar|Problem/)).toBeInTheDocument();
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    await userEvent.click(summary);
    expect(details?.textContent).toMatch(/502/);
  });
});
