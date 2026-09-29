import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeaLinksPanel } from "../src/features/idealink/IdeaLinksPanel";
import type { IdeaLink } from "@nyxos/shared";
import { jsonResponse, renderWithClient } from "./helpers";

const existing: IdeaLink = {
  id: 1,
  name: "Lena",
  createdAt: "2026-09-20T10:00:00.000Z",
  expiresAt: "2026-10-20T10:00:00.000Z",
  revokedAt: null,
  ratePerHour: 10,
  uses: 4,
  ideasCreated: 2,
  lastUsedAt: "2026-09-24T18:00:00.000Z",
  active: true,
};

function stubFetch() {
  let links: IdeaLink[] = [existing];
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/idealinks" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; expiresInDays: number; ratePerHour: number };
      const link = { ...existing, id: 2, name: body.name, ratePerHour: body.ratePerHour, uses: 0, ideasCreated: 0, lastUsedAt: null };
      links = [...links, link];
      return jsonResponse({ link, url: "http://nyxos.tail1234.ts.net/i/geheimtoken123", path: "/i/geheimtoken123" });
    }
    if (url === "/api/idealinks/1/revoke") {
      const link = { ...existing, revokedAt: new Date().toISOString(), active: false };
      links = links.map((l) => (l.id === 1 ? link : l));
      return jsonResponse({ link });
    }
    if (url === "/api/idealinks") return jsonResponse({ links });
    return Promise.reject(new Error(`unerwartet ${url}`));
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function renderPanel() {
  return renderWithClient(
    <MemoryRouter>
      <IdeaLinksPanel />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Ideen-Links", () => {
  it("nennt das Ablaufdatum eindeutig („gültig bis“, nicht „läuft ab <Datum>“ = klingt nach Startdatum)", async () => {
    stubFetch();
    renderPanel();
    expect(await screen.findByText(/gültig bis 20\. Okt\. 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/läuft ab/)).toBeNull();
  });

  it("legt einen Link an und zeigt die URL genau einmal", async () => {
    const impl = stubFetch();
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText("Lena")).toBeInTheDocument();
    expect(screen.getByText(/funktioniert im Tailnet/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "Max");
    await user.selectOptions(screen.getByLabelText("Ablauf"), "30");
    await user.selectOptions(screen.getByLabelText("Anfragen pro Stunde"), "5");
    await user.click(screen.getByRole("button", { name: "Link anlegen" }));

    await waitFor(() => expect(impl.mock.calls.some(([u, i]) => String(u) === "/api/idealinks" && i?.method === "POST")).toBe(true));
    const call = impl.mock.calls.find(([u, i]) => String(u) === "/api/idealinks" && i?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: "Max", expiresInDays: 30, ratePerHour: 5 });

    const created = await screen.findByRole("region", { name: "Neuer Link" });
    expect(within(created).getByText("http://nyxos.tail1234.ts.net/i/geheimtoken123")).toBeInTheDocument();
    expect(within(created).getByText(/Jetzt kopieren – später nicht mehr sichtbar/)).toBeInTheDocument();
    expect(within(created).getByRole("button", { name: "Kopieren" })).toBeInTheDocument();
    expect(await screen.findByText("Max")).toBeInTheDocument();

    await user.click(within(created).getByRole("button", { name: "Ausblenden" }));
    expect(screen.queryByText("http://nyxos.tail1234.ts.net/i/geheimtoken123")).not.toBeInTheDocument();
  });

  it("widerruft nach Bestätigung", async () => {
    const impl = stubFetch();
    const user = userEvent.setup();
    renderPanel();

    const row = (await screen.findByText("Lena")).closest("li");
    expect(row).not.toBeNull();
    const scoped = within(row as HTMLElement);
    expect(scoped.getByText("aktiv")).toBeInTheDocument();
    await user.click(scoped.getByRole("button", { name: "Widerrufen" }));
    expect(impl.mock.calls.some(([u]) => String(u) === "/api/idealinks/1/revoke")).toBe(false);
    await user.click(scoped.getByRole("button", { name: "Ja, widerrufen" }));

    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u) === "/api/idealinks/1/revoke")).toBe(true));
    expect(await scoped.findByText("widerrufen")).toBeInTheDocument();
  });
});
