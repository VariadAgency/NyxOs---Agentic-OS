// Local mode („Dieser Rechner“, e.g. a fresh install on macOS): no container/Docker/Dozzle parts, no
// "still missing" box, no unconfigured terminal/files, no "measuring …"/"not available" rows for values this OS never reports — and the
// sidebar entry is called „Dieser Rechner“. Server mode stays as it is (server-page-layout.test.tsx).
import type { AppInfo, HostInfo, ServerSnapshot } from "@nyxos/shared";
import { screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/components/Sidebar";
import { Server } from "../src/features/server/Server";
import { pageTitle } from "../src/hooks/usePageTitle";
import { jsonResponse, renderWithClient } from "./helpers";

const now = Date.parse("2026-09-27T10:00:00Z");

const INFO: AppInfo = {
  name: "NyxOS",
  version: "0.1.0",
  mode: "local",
  demo: false,
  demoHomeUrl: null,
  demoEngine: null,
  repo: "acme/nyxos",
  settings: { lang: "de", userName: "", onboardingDone: true, autoUpdate: true },
  update: { latest: null, available: false, checkedAt: null, canInstall: true, installing: false, error: null },
  dataDir: null,
};

const snapshot: ServerSnapshot = {
  docker: { available: false, reason: "Der Docker-Lesezugang (Socket-Proxy) läuft noch nicht.", fix: null, command: "docker compose up -d socket-proxy dozzle", checkedAt: new Date(now).toISOString() },
  containers: [],
  deploys: [],
  nyxosHealthy: true,
  health: { ok: true, checks: { database: { ok: true, ms: 1 }, schema: { ok: true, ms: 1 }, archive: { ok: true, ms: 1 } } },
  runningRevision: null,
  dozzleUrl: null,
  sshHost: null,
  pending: [],
};

/** What the server reports on macOS (hostinfo.ts, local mode). */
const macHost: HostInfo = {
  checkedAt: new Date(now).toISOString(),
  hostname: "test-mac.local",
  os: "macOS 15.6",
  kernel: "Darwin 24.6.0",
  cpuModel: "Apple M2 Pro",
  cores: 10,
  cpuPercent: 21.5,
  load: [2.5, 2, 1.5],
  uptimeSeconds: 2 * 86_400,
  bootedAt: new Date(now - 2 * 86_400_000).toISOString(),
  memTotal: 16 * 1024 ** 3,
  memAvailable: 6 * 1024 ** 3,
  swapTotal: 2 * 1024 ** 3,
  swapFree: 1024 ** 3,
  temperatures: [],
  disks: [{ label: "Daten (NyxOS)", totalBytes: 1e12, usedBytes: 4e11, freeBytes: 6e11, inodesTotal: null, inodesUsed: null }],
  network: [{ iface: "en0", rxBytes: 1e9, txBytes: 5e8, rxRate: 10_000, txRate: 5_000 }],
  ports: [],
  containersRunning: null,
  containersTotal: null,
  dockerVersion: null,
  tailscale: null,
  cpuCores: [{ id: 0, percent: 30 }],
  cpuSplit: { user: 15, system: 6.5, iowait: 0, steal: 0 },
  cpuMHz: null,
  virtualization: { isVirtual: false, label: "eigene Hardware", vendor: "Apple", product: "Mac14,9" },
  processes: { running: null, blocked: null, threads: null, forkRate: null },
  contextSwitchRate: null,
  interruptRate: null,
  memDetail: null,
  swapInRate: null,
  swapOutRate: null,
  majorFaultRate: null,
  oomKills: null,
  diskIo: [],
  pressure: { cpu: null, memory: null, io: null },
  openFiles: { used: 17_000, max: 120_000 },
  history: [],
  docker: null,
  probe: null,
  missing: ["Temperatur, Engpässe (Druck) und Platten-Durchsatz meldet macOS ohne Zusatzrechte nicht – darum fehlen sie hier."],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/app/info") return jsonResponse(INFO);
      if (url === "/api/server/host") return jsonResponse(macHost);
      if (url === "/api/server/files/roots") return jsonResponse({ roots: [] });
      if (url.startsWith("/api/server")) return jsonResponse(snapshot);
      if (url.startsWith("/api/builds")) return jsonResponse({ recent: [], groups: [] });
      if (url.startsWith("/api/auth/status")) return jsonResponse({ authenticated: true, csrf: "t", hasPasskey: true, authReads: false });
      return Promise.reject(new Error(`kein Stub für ${url}`));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dieser Rechner (local mode, macOS)", () => {
  it("shows macOS and real values; no containers, Docker, Dozzle, deploys or 'still missing'", async () => {
    renderWithClient(
      <MemoryRouter>
        <Server />
      </MemoryRouter>,
    );
    const head = await screen.findByTestId("server-head");
    expect(await within(head).findByText("Dieser Rechner")).toBeTruthy();

    const tiles = await screen.findByTestId("host-tiles");
    const labels = [...tiles.querySelectorAll("[data-tile]")].map((t) => t.getAttribute("data-tile"));
    expect(labels).not.toContain("containers");
    expect(labels).not.toContain("troubled");
    expect(labels.length % 2).toBe(0);
    const system = tiles.querySelector('[data-tile="system"]');
    expect(system?.textContent).toContain("macOS 15.6");
    expect(system?.textContent).not.toContain("Linux");

    const names = [...document.querySelectorAll("[data-server-section]")].map((r) => r.getAttribute("aria-label"));
    expect(names).not.toContain("Container");
    expect(names).not.toContain("Deploys");
    // No SSH host, no host folders: no "terminal to the server" and no "next deploy mounts …".
    expect(names).not.toContain("Terminal");
    expect(names).not.toContain("Dateien");
    expect(screen.queryByTestId("server-pending")).toBeNull();

    // Detail cards: nothing macOS never reports.
    const cpu = await screen.findByTestId("host-cpu");
    expect(within(cpu).queryByText("Threads gesamt")).toBeNull();
    expect(within(cpu).queryByText("Kontextwechsel")).toBeNull();
    expect(within(cpu).getByText("2,50 · 2,00 · 1,50")).toBeTruthy();
    const mem = screen.getByTestId("host-mem");
    expect(within(mem).queryByText("Wegen Speichermangel beendet")).toBeNull();
    expect(within(mem).queryByText("nicht verfügbar")).toBeNull();
    expect(screen.queryByTestId("host-pressure")).toBeNull();
    const disks = screen.getByTestId("host-disks");
    expect(within(disks).getByText("Daten (NyxOS)")).toBeTruthy();
    expect(within(disks).queryByText("Durchsatz")).toBeNull();
    const sys = screen.getByTestId("host-system");
    expect(within(sys).queryByText("Docker")).toBeNull();
    const net = screen.getByTestId("host-ports");
    expect(within(net).getByText("Netz (en0)")).toBeTruthy();
    expect(net.textContent).not.toMatch(/Container|Ports/);

    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/misst …|socket-proxy|dozzle|Kein Ordner des Servers|Deploy/i);
  });

  it("sidebar and page title say „Dieser Rechner“ (route stays /server)", async () => {
    renderWithClient(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /Dieser Rechner/ });
    expect(link.getAttribute("href")).toBe("/server");
    expect(pageTitle("/server", null, true)).toBe("Dieser Rechner · NyxOS");
    expect(pageTitle("/server", null, false)).toBe("Server · NyxOS");
  });
});
