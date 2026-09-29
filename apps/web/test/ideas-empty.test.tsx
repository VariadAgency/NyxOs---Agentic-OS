// Ideen-Tab leer: ohne jede Idee „Noch keine Ideen.“ statt eines Filter-Texts — nur wenn es Ideen gibt und
// Suche/Filter keine trifft, ist es ein Filter-Ergebnis.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeasView } from "../src/features/ideas/IdeasView";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";
import { ideaEntry } from "./ideaFixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view() {
  renderWithClient(
    <MemoryRouter>
      <IdeasView />
    </MemoryRouter>,
  );
}

describe("IdeasView Leerzustand", () => {
  it("ohne Ideen: 'Noch keine Ideen.' statt Filter-Text", async () => {
    stubFetchRoutes({});
    view();
    expect(await screen.findByText("Noch keine Ideen.")).toBeInTheDocument();
    expect(screen.queryByText("Keine Idee passt zu diesem Filter.")).toBeNull();
  });

  it("Ideen da, Suche trifft keine: Filter-Text mit „Filter zurücksetzen“", async () => {
    const calls: string[] = [];
    stubFetchRoutes({
      entries: (url) => {
        calls.push(url);
        return jsonResponse({ entries: url.includes("q=") ? [] : [ideaEntry({})] });
      },
    });
    view();
    fireEvent.change(await screen.findByPlaceholderText("Ideen durchsuchen (Titel und Text) …"), { target: { value: "xyz" } });
    expect(await screen.findByText("Keine Idee passt zu diesem Filter.")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((u) => u.includes("q=xyz") && u.includes("kind=idee"))).toBe(true));
    expect(screen.getByRole("button", { name: "Filter zurücksetzen" })).toBeInTheDocument();
  });

  it("Laden scheitert: ehrlicher Fehler mit „Noch einmal laden“", async () => {
    stubFetchRoutes({ entries: () => jsonResponse({ error: "kaputt" }, { status: 500 }) });
    view();
    expect(await screen.findByText("Die Ideen konnten nicht geladen werden.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Noch einmal laden" })).toBeInTheDocument();
  });
});
