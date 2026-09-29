import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setupFetch() {
  return stubFetchRoutes({
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    sessions: () => jsonResponse({ sessions: [] }),
  });
}

describe("Routing", () => {
  it("leitet / auf /overview weiter (Überblick ist die Startseite)", async () => {
    setupFetch();
    renderWithClient(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    const crumbs = await screen.findByRole("navigation", { name: "Brotkrümel" });
    expect(within(crumbs).getByText("Überblick")).toBeInTheDocument();
  });

  it("leitet /sessions weiterhin auf die erste Art weiter (ohne Sessions: „coding“)", async () => {
    setupFetch();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions"]}>
        <App />
      </MemoryRouter>,
    );

    const crumbs = await screen.findByRole("navigation", { name: "Brotkrümel" });
    expect(within(crumbs).getByText("Sessions")).toBeInTheDocument();
    expect(await within(crumbs).findByText("Coding")).toBeInTheDocument();
  });

  // der letzte Krümel ist der Session-NAME (`sessionLabel`), nie die Kennung – solange er lädt „Session“.
  it("zeigt Art, Baustelle und die Session (ohne rohe Kennung) als Brotkrümel aus der URL", async () => {
    setupFetch();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/webshop/claude%3Aabc"]}>
        <App />
      </MemoryRouter>,
    );

    const crumbs = await screen.findByRole("navigation", { name: "Brotkrümel" });
    expect(within(crumbs).getByText("Coding")).toBeInTheDocument();
    expect(within(crumbs).getByText("webshop")).toBeInTheDocument();
    expect(within(crumbs).getByTestId("crumb-title")).not.toHaveTextContent("claude:abc");
  });

  it("führt über den Brotkrümel zurück zu /sessions", async () => {
    setupFetch();
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/webshop"]}>
        <App />
      </MemoryRouter>,
    );

    const crumbs = await screen.findByRole("navigation", { name: "Brotkrümel" });
    expect(within(crumbs).getByText("webshop")).toBeInTheDocument();

    await user.click(within(crumbs).getByText("Sessions"));

    expect(within(crumbs).queryByText("webshop")).not.toBeInTheDocument();
  });

  // „Dateien“ war der letzte ausgegraute Reiter — jetzt gebaut, also kein toter Tab mehr.
  it("kein Reiter der Leiste ist mehr ausgegraut; „Dateien“ führt nach /files", async () => {
    stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      machines: () => jsonResponse([]),
      sessions: () => jsonResponse({ sessions: [] }),
      files: () => jsonResponse({ total: 0, sessions: 0, truncated: false, areas: [], files: [] }),
    });
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions"]}>
        <App />
      </MemoryRouter>,
    );
    const files = await screen.findByText("Dateien");
    expect(document.querySelector("[aria-disabled='true']")).toBeNull();
    expect(files.closest("a")).not.toBeNull();
    await user.click(files);
    const crumbs = screen.getByRole("navigation", { name: "Brotkrümel" });
    expect(await within(crumbs).findByText("Dateien")).toBeInTheDocument();
    // /files ist jetzt der Finder; die Liste „von Sessions angefasst“ liegt dort unter „Von Sessions“.
    expect(await screen.findByRole("navigation", { name: "Favoriten" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Von Sessions/ })).toHaveAttribute("href", "/files?smart=sessions");
  });

  // Aufgaben/Ideen/Audits sind jetzt echte, navigierbare Tabs (Registrierung in nav.ts).
  it("Aufgaben-Tab ist aktiv und navigierbar", async () => {
    stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      machines: () => jsonResponse([]),
      sessions: () => jsonResponse({ sessions: [] }),
      entries: () => jsonResponse({ entries: [] }),
    });
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions"]}>
        <App />
      </MemoryRouter>,
    );

    const tasks = await screen.findByText("Aufgaben");
    expect(tasks.closest("a")).not.toBeNull();
    await user.click(tasks);
    expect(await screen.findByText("Offen gesamt")).toBeInTheDocument();
  });
});
