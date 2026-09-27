// Server-Seite neu geordnet — oben „Auf einen Blick“ mit Verlauf, dann die Maschine im Detail,
// Terminal/Dateien in der Mitte, GANZ UNTEN die Container: eingeklappt (nur Zusammenfassung + Gestörte),
// „Alle N Container anzeigen“ fährt aus, der Zustand bleibt gemerkt.
import type { ContainerInfo, HostInfo, ServerSnapshot } from "@nyxos/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "../src/features/server/Server";
import { jsonResponse, renderWithClient } from "./helpers";

const now = Date.parse("2026-09-26T10:00:00Z");
const c = (over: Partial<ContainerInfo>): ContainerInfo => ({
  id: "aaaaaaaaaaaa",
  name: "x",
  group: "andere",
  project: "shop",
  image: "img:1",
  imageTag: "1",
  imageVersion: null,
  imageCreatedAt: null,
  state: "running",
  health: "healthy",
  createdAt: null,
  startedAt: new Date(now - 3_600_000).toISOString(),
  restartCount: 0,
  restartLoop: false,
  ports: [],
  cpuPercent: 1,
  memBytes: 100e6,
  memLimitBytes: null,
  cpuHistory: [],
  memHistory: [],
  ...over,
});

const snapshot: ServerSnapshot = {
  docker: { available: true, reason: null, fix: null, command: null, checkedAt: new Date(now).toISOString() },
  containers: [
    c({ id: "a1a1a1a1a1a1", name: "shop-postgres" }),
    c({ id: "a2a2a2a2a2a2", name: "shop-media-service", health: "unhealthy" }),
    c({ id: "b1b1b1b1b1b1", name: "nyxos-api", group: "nyxos", project: "nyxos" }),
    c({ id: "c1c1c1c1c1c1", name: "tracker-caddy-1", group: "andere", project: "tracker", state: "exited", health: "none", cpuPercent: null, memBytes: null }),
  ],
  deploys: [],
  nyxosHealthy: true,
  health: { ok: true, checks: { database: { ok: true, ms: 1 }, schema: { ok: true, ms: 1 }, archive: { ok: true, ms: 1 } } },
  runningRevision: "abc1234",
  dozzleUrl: "/dozzle/",
  sshHost: null,
  pending: [],
};

const pts = [10, 20, 30, 40].map((v, i) => ({ at: new Date(now - (4 - i) * 10_000).toISOString(), cpu: v, memUsed: v * 1e9, load1: v / 10, diskRead: v * 1e5, diskWrite: v * 2e5 }));

const host: HostInfo = {
  checkedAt: new Date(now).toISOString(),
  hostname: "myserver",
  os: "Ubuntu 24.04.1 LTS",
  kernel: "6.8.0-45-generic",
  cpuModel: "AMD EPYC-Rome Processor",
  cores: 2,
  cpuPercent: 40,
  load: [0.5, 0.4, 0.3],
  uptimeSeconds: 3 * 86_400 + 2 * 3600,
  bootedAt: new Date(now - (3 * 86_400 + 2 * 3600) * 1000).toISOString(),
  memTotal: 16e9,
  memAvailable: 6e9,
  swapTotal: 0,
  swapFree: 0,
  temperatures: [],
  disks: [{ label: "/home/user", totalBytes: 1e12, usedBytes: 4e11, freeBytes: 6e11, inodesTotal: 1000, inodesUsed: 100 }],
  network: [],
  ports: [],
  containersRunning: 3,
  containersTotal: 3,
  dockerVersion: "27.3.1",
  tailscale: null,
  cpuCores: [
    { id: 0, percent: 93 },
    { id: 1, percent: 28 },
  ],
  cpuSplit: { user: 30, system: 8, iowait: 1, steal: 1 },
  cpuMHz: 2445,
  virtualization: { isVirtual: true, label: "virtuelle Maschine (KVM/QEMU)", vendor: "example-host", product: "vps" },
  processes: { running: 3, blocked: 0, threads: 345, forkRate: 2 },
  contextSwitchRate: 5000,
  interruptRate: 1200,
  memDetail: { free: 2e9, buffers: 0.5e9, cached: 3e9, reclaimable: 0.5e9, shmem: 0.1e9, dirty: 1e6 },
  swapInRate: 0,
  swapOutRate: 0,
  majorFaultRate: 0,
  oomKills: 0,
  diskIo: [{ device: "sda", readRate: 1e6, writeRate: 2e6, readIops: 10, writeIops: 30, busyPercent: 20 }],
  pressure: { cpu: { some10: 2, some60: 1, full10: null }, memory: { some10: 0, some60: 0, full10: 0 }, io: { some10: 12, some60: 5, full10: 3 } },
  openFiles: { used: 1500, max: 100000 },
  history: pts,
  docker: { version: "27.3.1", images: 42, storageDriver: "overlay2", rootDir: "/var/lib/docker", architecture: "x86_64" },
  probe: null,
  missing: ["Temperatur: Der Server meldet keine Sensoren (typisch für eine virtuelle Maschine)."],
};

let hostOverride: HostInfo | null = null;

beforeEach(() => {
  hostOverride = null;
  try {
    window.localStorage.clear();
  } catch {
    // ohne Speicher
  }
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/server/host") return jsonResponse(hostOverride ?? host);
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

function renderServer() {
  return renderWithClient(
    <MemoryRouter>
      <Server />
    </MemoryRouter>,
  );
}

describe("Server-Seite", () => {
  it("Reihenfolge: Serverdaten ganz oben (Kacheln, Maschine), DANACH die Container, dann Terminal/Dateien/Betrieb", async () => {
    renderServer();
    await screen.findByTestId("host-tiles");
    const names = [...document.querySelectorAll("[data-server-section]")].map((r) => r.getAttribute("aria-label"));
    expect(names.indexOf("Auf einen Blick")).toBe(0);
    expect(names.indexOf("Maschine im Detail")).toBe(1);
    expect(names.indexOf("Container")).toBe(2);
    expect(names.indexOf("Terminal")).toBeGreaterThan(names.indexOf("Container"));
    expect(names.indexOf("Dateien")).toBeGreaterThan(names.indexOf("Terminal"));
    expect(names.indexOf("Deploys")).toBeGreaterThan(names.indexOf("Dateien"));
    // Eigentümer-spezifische Abschnitte gibt es nicht mehr.
    expect(names).not.toContain("NAS-Sicherung");
    expect(names).not.toContain("Server-Rückstand");
  });

  it("Kopf: Hostname, Status, Laufzeit", async () => {
    renderServer();
    const head = await screen.findByTestId("server-head");
    expect(await within(head).findByText("myserver")).toBeTruthy();
    expect(within(head).getByText(/läuft seit 3 T 2 Std/)).toBeTruthy();
  });

  it("Kachel-Raster oben: viele echte Kennzahlen in zwei vollen Reihen, KEINE Temperatur-Kachel ohne Sensoren", async () => {
    renderServer();
    const tiles = await screen.findByTestId("host-tiles");
    const labels = [...tiles.querySelectorAll("[data-tile]")].map((t) => t.getAttribute("data-tile"));
    for (const l of ["cpu", "load", "mem", "swap", "uptime", "disk", "diskio", "procs", "pressure", "containers", "troubled", "system"]) expect(labels, l).toContain(l);
    expect(labels).not.toContain("temp");
    expect(labels).not.toContain("probe");
    expect(labels.length % 2).toBe(0);
    expect(tiles.style.getPropertyValue("--cols")).toBe(String(labels.length / 2));
    expect(within(tiles).getByText("40,0 %")).toBeTruthy();
    expect(screen.queryByTestId("host-temp")).toBeNull();
  });

  it("mit Sensoren gibt es die Temperatur-Kachel", async () => {
    hostOverride = { ...host, temperatures: [{ label: "coretemp · Package id 0", celsius: 51.5 }] };
    renderServer();
    const temp = await screen.findByTestId("host-temp");
    expect(within(temp).getByText("51,5 °C")).toBeTruthy();
    const tiles = screen.getByTestId("host-tiles");
    expect(tiles.querySelectorAll("[data-tile]").length % 2).toBe(0);
  });

  it("Maschine im Detail: Kerne, Speicher-Aufteilung, Druck, Platten-Durchsatz", async () => {
    renderServer();
    const cpu = await screen.findByTestId("host-cpu");
    expect(within(cpu).getByText("Kern 1")).toBeTruthy();
    expect(within(cpu).getByText("93 %")).toBeTruthy();
    const mem = screen.getByTestId("host-mem");
    expect(within(mem).getByText(/Programme/)).toBeTruthy();
    expect(within(mem).getByText(/Cache/)).toBeTruthy();
    expect(within(screen.getByTestId("host-pressure")).getByText("hoch")).toBeTruthy();
    expect(within(screen.getByTestId("host-disks")).getByText("sda")).toBeTruthy();
  });

  it("Container kompakt: EINE Kachel, jeder Container ein farbiges Kästchen (grün/gelb/rot), nach Gruppe", async () => {
    renderServer();
    const box = await screen.findByTestId("containers-compact");
    const light = (name: string) => within(box).getByRole("button", { name: new RegExp(`^${name}:`) }).getAttribute("data-light");
    expect(light("shop-postgres")).toBe("green");
    expect(light("shop-media-service")).toBe("yellow");
    expect(light("tracker-caddy-1")).toBe("red");
    expect(within(box).getByText("Shop")).toBeTruthy();
    expect(within(box).getByText("Tracker")).toBeTruthy();
    // Keine lange Liste im Kompakt-Modus
    expect(screen.queryByText("postgis/postgis")).toBeNull();
    expect(document.querySelector("[data-container]")).toBeNull();
  });

  it("Liste: jede Gruppe klappt einzeln mit Pfeil auf — und bleibt gemerkt", async () => {
    const view = renderServer();
    const section = await screen.findByRole("region", { name: "Container" });
    fireEvent.click(within(section).getByRole("button", { name: "Liste" }));
    const cc = within(section).getByRole("button", { name: /Shop/ });
    expect(cc.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-container="shop-postgres"]')).toBeNull();
    fireEvent.click(cc);
    expect(document.querySelector('[data-container="shop-postgres"]')).toBeTruthy();
    // Andere Gruppe bleibt zu
    expect(document.querySelector('[data-container="nyxos-api"]')).toBeNull();
    view.unmount();
    renderServer();
    await screen.findByRole("region", { name: "Container" });
    expect(await screen.findByText("shop-postgres")).toBeTruthy();
    expect(document.querySelector('[data-container="nyxos-api"]')).toBeNull();
  });

  it("Klick auf ein Kästchen: Liste, Gruppe auf, Container markiert", async () => {
    renderServer();
    const box = await screen.findByTestId("containers-compact");
    fireEvent.click(within(box).getByRole("button", { name: /^nyxos-api:/ }));
    const row = document.querySelector('[data-container="nyxos-api"]');
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-focused")).toBe("true");
  });
});

describe("Überlauf: Text geht nie über die Kachel hinaus", () => {
  // jsdom kann kein Layout — geprüft wird, dass die Zellen umbrechen DÜRFEN statt überzulaufen/abzuschneiden.
  it("Label/Wert-Zeilen der Karten brechen um: Wert mit min-w-0 + overflow-wrap, Beschriftung nie abgeschnitten", async () => {
    hostOverride = { ...host, os: "Ubuntu 24.04.4 LTS", virtualization: { isVirtual: true, label: "virtuelle Maschine (KVM/QEMU)", vendor: "QEMU", product: "Standard PC (i440FX + PIIX, 1996)" } };
    renderServer();
    const system = await screen.findByTestId("host-system");
    const rows = [...document.querySelectorAll("[data-row]")];
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(r.className, r.textContent ?? "").toMatch(/flex-wrap/);
      const [label, value] = [...r.children];
      expect(label?.className ?? "").not.toMatch(/truncate/);
      expect(value?.className ?? "").toMatch(/min-w-0/);
      expect(value?.className ?? "").toMatch(/overflow-wrap:anywhere/);
    }
    // „Maschine“ trägt nur die Art, Hersteller/Modell stehen in einer eigenen Zeile.
    expect(within(system).getByText("virtuelle Maschine (KVM/QEMU)")).toBeTruthy();
    expect(within(system).getByText("QEMU · Standard PC (i440FX + PIIX, 1996)")).toBeTruthy();
    // Die API-Prüfung eines bestimmten Projekts gibt es nicht mehr.
    expect(screen.queryByTestId("host-probe")).toBeNull();
  });

  it("Kacheln: kurze Beschriftungen, Last kompakt, System kurz, keine abgeschnittenen Köpfe", async () => {
    hostOverride = { ...host, os: "Ubuntu 24.04.4 LTS", network: [{ iface: "eth0", rxBytes: 1, txBytes: 2, rxRate: 2000, txRate: 1000 }] };
    renderServer();
    const tiles = await screen.findByTestId("host-tiles");
    const label = (key: string) => tiles.querySelector(`[data-tile="${key}"] [data-tile-label]`);
    expect(label("net")?.textContent).toBe("Netz");
    expect(label("swap")?.textContent).toBe("Swap");
    expect(label("load")?.textContent).toBe("Last");
    for (const l of tiles.querySelectorAll("[data-tile-label]")) expect(l.className).not.toMatch(/truncate/);
    const load = tiles.querySelector('[data-tile="load"]');
    expect(load?.querySelector("[data-tile-value]")?.textContent).toBe("0,50");
    expect(load?.textContent).toMatch(/5 Min 0,40 · 15 Min 0,30/);
    expect(tiles.querySelector('[data-tile="system"] [data-tile-value]')?.textContent).toBe("Ubuntu 24.04");
    for (const v of tiles.querySelectorAll("[data-tile-value]")) expect(v.className).toMatch(/overflow-wrap:anywhere/);
  });

  it("Gestört-Kachel: Anzahl groß, Namen als kurze Liste mit Ellipse und Tooltip", async () => {
    renderServer();
    const tile = (await screen.findByTestId("host-tiles")).querySelector('[data-tile="troubled"]');
    expect(tile?.querySelector("[data-tile-value]")?.textContent).toBe("1");
    const item = tile?.querySelector("li");
    expect(item?.textContent).toBe("shop-media-service");
    expect(item?.getAttribute("title")).toMatch(/shop-media-service/);
    expect(item?.className).toMatch(/truncate/);
  });
});
