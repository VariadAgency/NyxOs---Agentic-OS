import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Breadcrumbs } from "../src/components/Breadcrumbs";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

// Brotkrümel je Tab: Aufgaben/Ideen/Audits/Agenten/Nutzung zeigten
// vorher "Sessions", weil `TOP_LEVEL_LABELS` von Hand gepflegt wurde und diese fünf Tabs vergaß.
// Jetzt aus `nav.ts` abgeleitet — dieser Test hält jeden aktiven Ein-Ebenen-Tab fest.
describe("Breadcrumbs: Tab-Name je Route", () => {
  it.each([
    ["/overview", "Überblick"],
    ["/tasks", "Aufgaben"],
    ["/ideas", "Ideen"],
    ["/audits", "Audits"],
    ["/agents", "Agenten"],
    ["/usage", "Nutzung"],
    ["/git", "Git"],
    ["/conflicts", "Konflikte"],
    ["/server", "Server"],
    ["/settings", "Einstellungen"],
  ])("%s → %s", (path, label) => {
    renderWithClient(
      <MemoryRouter initialEntries={[path]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Brotkrümel" })).toHaveTextContent(label);
  });

  it("Session-Vollbild: letzter Krümel zeigt den Titel, nicht die rohe ID", async () => {
    stubFetchRoutes({
      fallback: (url) => (url.includes("/api/sessions/abc-123") ? jsonResponse({ session: { id: "abc-123", title: "Ein sehr aussagekräftiger Titel" }, files: [], archive: [], events: [] }) : undefined),
    });
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_/abc-123"]}>
        <Breadcrumbs />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Ein sehr aussagekräftiger Titel")).toBeInTheDocument();
    expect(screen.queryByText("abc-123")).not.toBeInTheDocument();
  });
});
