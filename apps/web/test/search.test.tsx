import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATEGORIES = [{ art: "coding", count: 0, baustellen: [] }];

const HIT = {
  sessionKey: "claude:found",
  sessionId: "found",
  tool: "claude" as const,
  title: "Gefundene Session",
  art: "coding",
  baustelle: { slug: "nyxos", label: "NyxOS" },
  state: "idle" as const,
  closed: false,
  field: "chat" as const,
  snippet: "Text mit <mark>Treffer</mark> drin",
  position: 17,
};

function setupFetch() {
  return stubFetchRoutes({
    health: () => jsonResponse({ ok: true }),
    machines: () => jsonResponse([]),
    sessions: () => jsonResponse({ sessions: [] }),
    categories: () => jsonResponse({ categories: CATEGORIES }),
    search: () => jsonResponse({ hits: [HIT], tookMs: 12 }),
  });
}

describe("Suche", () => {
  it("zeigt Treffer im Suchfeld und springt zur Fundstelle", async () => {
    setupFetch();
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_"]}>
        <App />
      </MemoryRouter>,
    );

    const input = await screen.findByRole("combobox");
    await user.type(input, "Treffer");

    const option = await screen.findByRole("option", { name: /Gefundene Session/ });
    expect(within(option).getByText("Chat")).toBeInTheDocument();
    await user.click(option);

    const crumbs = screen.getByRole("navigation", { name: "Brotkrümel" });
    // Der Brotkrümel zeigt nie die Kennung, sondern den Namen (während des Ladens „Session“).
    expect(await within(crumbs).findByText(/^(Gefundene Session|Session)$/)).toBeInTheDocument();
  });

  // ⌘K sucht über `/api/search/all` (gruppiert) statt nur Sessions.
  const ALL = {
    q: "Treffer",
    groups: [
      { kind: "session", label: "Sessions", hits: [{ kind: "session", title: "Gefundene Session", snippet: "Text mit Treffer drin", path: "/sessions/coding/nyxos/found?at=17" }] },
      { kind: "gedaechtnis", label: "Nyx-Gedächtnis", hits: [{ kind: "gedaechtnis", title: "Vorlieben", snippet: "Ein Treffer im Gedächtnis", path: "/nyx?r=gedaechtnis" }] },
    ],
    tookMs: 3,
  };

  async function openPalette() {
    const user = userEvent.setup();
    renderWithClient(
      <MemoryRouter initialEntries={["/sessions/coding/_"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("combobox");
    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await screen.findByRole("dialog");
    return { user, dialog, input: within(dialog).getByPlaceholderText(/Suche alles/) };
  }

  it("⌘K zeigt Treffer aus /api/search/all gruppiert, mit hervorgehobenem Suchbegriff", async () => {
    stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      machines: () => jsonResponse([]),
      sessions: () => jsonResponse({ sessions: [] }),
      categories: () => jsonResponse({ categories: CATEGORIES }),
      searchAll: () => jsonResponse(ALL),
    });
    const { user, dialog, input } = await openPalette();
    await user.type(input, "Treffer");

    expect(await within(dialog).findByText("Gefundene Session")).toBeInTheDocument();
    expect(within(dialog).getByText("Vorlieben")).toBeInTheDocument();
    const mark = dialog.querySelector("mark");
    expect(mark).toHaveTextContent("Treffer");
    expect(within(dialog).getByText(/Nyx fragen: „Treffer“/)).toBeInTheDocument();
    expect(await within(dialog).findByRole("status")).toHaveTextContent("2 Treffer in 2 Gruppen");
  });

  it("⌘K: kommen die Treffer erst nach dem Tippen, öffnet Enter den obersten Treffer (nicht „Nyx fragen“)", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    stubFetchRoutes({
      health: () => jsonResponse({ ok: true }),
      machines: () => jsonResponse([]),
      sessions: () => jsonResponse({ sessions: [] }),
      categories: () => jsonResponse({ categories: CATEGORIES }),
      searchAll: () =>
        new Promise<Response>((resolve) => {
          gate.release = () => resolve(new Response(JSON.stringify(ALL), { status: 200, headers: { "content-type": "application/json" } }));
        }),
    });
    const { user, dialog, input } = await openPalette();
    await user.type(input, "Treffer");
    // Solange nichts da ist, steht die Auswahl auf „Nyx fragen“.
    const ask = within(dialog).getByText(/Nyx fragen: „Treffer“/).closest("[cmdk-item]");
    await waitFor(() => expect(ask).toHaveAttribute("data-selected", "true"));
    await waitFor(() => expect(gate.release).not.toBeNull());
    gate.release?.();
    const hit = (await within(dialog).findByText("Gefundene Session")).closest("[cmdk-item]");
    await waitFor(() => expect(hit).toHaveAttribute("data-selected", "true"));
    await user.keyboard("{Enter}");

    const crumbs = await screen.findByRole("navigation", { name: "Brotkrümel" });
    // Der Brotkrümel zeigt nie die Kennung, sondern den Namen (während des Ladens „Session“).
    expect(await within(crumbs).findByText(/^(Gefundene Session|Session)$/)).toBeInTheDocument();
  });
});
