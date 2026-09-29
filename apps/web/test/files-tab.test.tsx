// Reiter „Dateien“ ist aktiv (nicht mehr ausgegraut), gruppiert nach Bereich/Ordner, Suche,
// Klick auf eine Datei zeigt die Sessions, jede Session ist ein Link.
import type { FileSessions, FilesOverview } from "@nyxos/shared";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesView } from "../src/features/files/FilesView";
import { NAV_ITEMS } from "../src/nav";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OVERVIEW: FilesOverview = {
  total: 2,
  sessions: 2,
  truncated: false,
  areas: [
    { id: "projekte", label: "Projekte", files: 1, changed: 1, lastAt: "2026-09-25T11:00:00.000Z" },
    { id: "worktrees", label: "Worktrees", files: 1, changed: 0, lastAt: "2026-09-25T08:00:00.000Z" },
  ],
  files: [
    { path: "/home/me/projekt/App/ios/Heatmap.swift", area: "projekte", rel: "ios/Heatmap.swift", folder: "ios", name: "Heatmap.swift", changed: true, read: true, sessions: 2, lastAt: "2026-09-25T11:00:00.000Z" },
    { path: "/home/me/projekt/NyxOS/README.md", area: "worktrees", rel: "README.md", folder: "", name: "README.md", changed: false, read: true, sessions: 1, lastAt: "2026-09-25T08:00:00.000Z" },
  ],
};

const SESSIONS: FileSessions = {
  path: "/home/me/projekt/App/ios/Heatmap.swift",
  sessions: [
    { key: "claude:a", title: "Heatmap bauen", tool: "claude", modes: ["write"], firstSeenAt: "2026-09-25T09:00:00.000Z", lastActivityAt: "2026-09-25T10:00:00.000Z", state: "wartet", closed: false, href: "/sessions/coding/heatmap/a" },
  ],
};

describe("Dateien", () => {
  it("ist in der Leiste aktiv und hat eine Adresse", () => {
    const item = NAV_ITEMS.find((i) => i.id === "dateien");
    expect(item?.status).toBe("active");
    expect(item && "path" in item ? item.path : null).toBe("/files");
  });

  it("zeigt Bereiche, Ordner und Dateien; Klick zeigt die Sessions mit Link", async () => {
    const urls: string[] = [];
    stubFetchRoutes({
      files: (url) => {
        urls.push(url);
        return jsonResponse(url.startsWith("/api/files/sessions") ? SESSIONS : OVERVIEW);
      },
    });
    renderWithClient(
      <MemoryRouter>
        <FilesView />
      </MemoryRouter>,
    );
    const app = await screen.findByRole("region", { name: "Projekte" });
    expect(within(app).getByText("ios")).toBeInTheDocument();
    expect(within(app).getByText("Heatmap.swift")).toBeInTheDocument();
    expect(within(app).getByText("geändert")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Worktrees" })).toHaveTextContent("README.md");

    fireEvent.click(within(app).getByRole("button", { name: /Heatmap\.swift/ }));
    const link = await screen.findByRole("link", { name: /Heatmap bauen/ });
    expect(link).toHaveAttribute("href", "/sessions/coding/heatmap/a");
    expect(urls.some((u) => u.startsWith("/api/files/sessions?path=%2Fhome%2Fme%2Fprojekt%2FApp%2Fios%2FHeatmap.swift"))).toBe(true);
  });

  it("Suche geht an den Server", async () => {
    const urls: string[] = [];
    stubFetchRoutes({
      files: (url) => {
        urls.push(url);
        return jsonResponse(OVERVIEW);
      },
    });
    renderWithClient(
      <MemoryRouter>
        <FilesView />
      </MemoryRouter>,
    );
    await screen.findByRole("region", { name: "Projekte" });
    fireEvent.change(screen.getByPlaceholderText("Dateien suchen …"), { target: { value: "heat" } });
    await waitFor(() => expect(urls.some((u) => u.includes("q=heat"))).toBe(true));
  });

  it("leer: erklärt, woher die Liste kommt", async () => {
    stubFetchRoutes({ files: () => jsonResponse({ total: 0, sessions: 0, truncated: false, areas: [], files: [] }) });
    renderWithClient(
      <MemoryRouter>
        <FilesView />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Noch keine Dateien.")).toBeInTheDocument();
    expect(screen.getByText(/Sobald eine Session eine Datei liest oder ändert/)).toBeInTheDocument();
  });
});
