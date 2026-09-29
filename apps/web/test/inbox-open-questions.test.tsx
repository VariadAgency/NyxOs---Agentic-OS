// Entscheidungen zählen offene Konflikt-Fragen mit — dieselbe Zahl wie die Überblick-Kachel
// „Offene Fragen“ (Server `/api/open-questions`). Vorher: „Nichts zu entscheiden“ neben „38 offene Fragen“.
import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxNavBadge } from "../src/features/inbox/InboxNavBadge";
import { InboxView } from "../src/features/inbox/InboxView";
import { jsonResponse, renderWithClient } from "./helpers";

function stub(conflicts: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/approvals")) return jsonResponse({ approvals: [] });
      if (url.startsWith("/api/inbox")) return jsonResponse({ items: [] });
      if (url === "/api/open-questions") return jsonResponse({ approvals: 0, inbox: 0, conflicts, total: conflicts });
      return Promise.reject(new Error(`unerwartet ${url}`));
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Entscheidungen und Konflikte widersprechen sich nicht", () => {
  it("offene Konflikt-Fragen erscheinen als Karte und im Zähler, nicht „Nichts zu entscheiden“", async () => {
    stub(2);
    renderWithClient(
      <MemoryRouter>
        <InboxView />
        <InboxNavBadge />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("inbox-conflicts")).toHaveTextContent("2 Konflikt-Fragen");
    expect(screen.getByRole("link", { name: "Zu den Konflikten" })).toHaveAttribute("href", "/conflicts");
    expect(await screen.findByText("2 offen")).toBeInTheDocument();
    expect(await screen.findByLabelText("2 offen")).toBeInTheDocument();
    expect(screen.queryByText("Nichts zu entscheiden.")).toBeNull();
  });

  it("ohne Konflikt-Fragen bleibt es bei „Nichts zu entscheiden“", async () => {
    stub(0);
    renderWithClient(
      <MemoryRouter>
        <InboxView />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Nichts zu entscheiden.")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-conflicts")).toBeNull();
  });
});
