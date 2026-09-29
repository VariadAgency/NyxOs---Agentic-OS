// Server-Tab mit echten Formen aus `GET /api/server` — Gruppen, Zustände, Logs per Klick, Deploys,
// und „Fehlt noch“ nur, wenn wirklich etwas fehlt (nie „wartet auf Freigabe“).
import type { ContainerInfo, ServerSnapshot } from "@nyxos/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "../src/features/server/Server";
import { containerStatus, groupContainers, isSteadyRunning, sumHistories, uptime } from "../src/features/server/serverView";
import { jsonResponse, renderWithClient } from "./helpers";

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ohne Speicher
  }
});

/** Container starten als kompakte Ampel-Kachel — für die Listen-Tests auf „Liste“ und jede Gruppe aufklappen. */
async function expandContainers() {
  const section = await screen.findByRole("region", { name: "Container" });
  fireEvent.click(within(section).getByRole("button", { name: "Liste" }));
  for (const b of within(section).getAllByRole("button", { expanded: false })) fireEvent.click(b);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const now = Date.parse("2026-09-25T10:00:00Z");
const c = (over: Partial<ContainerInfo>): ContainerInfo => ({
  id: "aaaaaaaaaaaa",
  name: "x",
  group: "andere",
  project: "shop",
  image: "img:1",
  imageTag: "1",
  imageVersion: null,
  imageCreatedAt: new Date(now - 3 * 86_400_000).toISOString(),
  state: "running",
  health: "healthy",
  createdAt: null,
  startedAt: new Date(now - 5 * 3_600_000).toISOString(),
  restartCount: 0,
  restartLoop: false,
  ports: [],
  cpuPercent: 3.2,
  memBytes: 120e6,
  memLimitBytes: 1e9,
  cpuHistory: [2, 3, 3.2],
  memHistory: [110e6, 115e6, 120e6],
  ...over,
});

const containers: ContainerInfo[] = [
  c({ id: "a1a1a1a1a1a1", name: "shop-postgres", image: "postgis/postgis:17-3.4-alpine", imageTag: "17-3.4-alpine" }),
  c({ id: "a2a2a2a2a2a2", name: "shop-media-service", health: "unhealthy" }),
  c({ id: "b1b1b1b1b1b1", name: "nyxos-api", group: "nyxos", project: "nyxos", ports: ["127.0.0.1:47800 → 8080/tcp"] }),
  c({ id: "c1c1c1c1c1c1", name: "demo-gateway", group: "andere", project: "demo", state: "restarting", health: "none", restartCount: 1432, restartLoop: true, cpuHistory: [], memHistory: [], cpuPercent: null, memBytes: null }),
  c({ id: "c2c2c2c2c2c2", name: "tracker-caddy-1", group: "andere", project: "tracker", state: "created", health: "none", startedAt: null, cpuHistory: [], memHistory: [], cpuPercent: null, memBytes: null }),
];

const base: ServerSnapshot = {
  docker: { available: true, reason: null, fix: null, command: null, checkedAt: new Date(now).toISOString() },
  containers,
  deploys: [{ id: 1, project: "nyxos", containerName: "nyxos-api", imageId: "x", createdAt: "2026-09-25T08:34:00Z", gitRev: "69e82dc", source: "deploy.sh" }],
  nyxosHealthy: true,
  health: { ok: true, checks: { database: { ok: true, ms: 1 }, schema: { ok: true, ms: 1 }, archive: { ok: true, ms: 1 } } },
  runningRevision: "69e82dc",
  dozzleUrl: "/dozzle/",
  sshHost: null,
  pending: [],
};

function stub(snapshot: ServerSnapshot) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("/api/server/containers/")) {
        return jsonResponse({
          id: "a1a1a1a1a1a1",
          name: "shop-postgres",
          tail: 200,
          lines: [
            { at: "2026-09-25T09:00:00.000Z", stream: "out", text: "LOG:  checkpoint starting" },
            { at: "2026-09-25T09:00:01.000Z", stream: "err", text: "FATAL:  password authentication failed" },
            { at: "2026-09-25T09:00:02.000Z", stream: "out", text: "LOG:  checkpoint complete" },
          ],
        });
      }
      if (url.startsWith("/api/server")) return jsonResponse(snapshot);
      if (url.startsWith("/api/builds")) return jsonResponse({ recent: [], groups: [] });
      if (url.startsWith("/api/auth/status")) return jsonResponse({ authenticated: true, csrf: "t", hasPasskey: true, authReads: false });
      return Promise.reject(new Error(`kein Stub für ${url}`));
    }),
  );
  return calls;
}

describe("Server-Tab", () => {
  it("zeigt ALLE Container getrennt nach NyxOS und jedem anderen Projekt, mit Zustand und Neustarts", async () => {
    stub(base);
    renderWithClient(
      <MemoryRouter>
        <Server />
      </MemoryRouter>,
    );
    await expandContainers();
    const cc = await screen.findByRole("region", { name: "Shop" });
    expect(within(cc).getByText("shop-postgres")).toBeInTheDocument();
    expect(within(cc).getByText("ungesund")).toBeInTheDocument();
    expect(within(cc).getByText("1 gestört")).toBeInTheDocument();
    const z = screen.getByRole("region", { name: "NyxOS" });
    expect(within(z).getByText("nyxos-api")).toBeInTheDocument();
    expect(within(z).getByText(/127\.0\.0\.1:47800 → 8080\/tcp/)).toBeInTheDocument();
    // Jedes andere Projekt ist eine eigene, einzeln aufklappbare Gruppe.
    const other = screen.getByRole("region", { name: "Demo" });
    expect(within(other).getByText("1432× neu gestartet")).toBeInTheDocument();
    expect(within(other).getByText("startet ständig neu")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Tracker" })).getByText("tracker-caddy-1")).toBeInTheDocument();
    expect(screen.queryByText(/wartet auf Freigabe/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("server-pending")).not.toBeInTheDocument();
  });

  it("Klick auf einen Container öffnet seine letzten Log-Zeilen, filterbar", async () => {
    const calls = stub(base);
    renderWithClient(
      <MemoryRouter>
        <Server />
      </MemoryRouter>,
    );
    await expandContainers();
    fireEvent.click(await screen.findByText("shop-postgres"));
    const logs = await screen.findByTestId("logs-shop-postgres");
    expect(await within(logs).findByText(/password authentication failed/)).toBeInTheDocument();
    expect(calls.some((u) => u.startsWith("/api/server/containers/a1a1a1a1a1a1/logs?tail=200"))).toBe(true);
    fireEvent.change(within(logs).getByRole("searchbox"), { target: { value: "checkpoint" } });
    expect(within(logs).getByText("2 von 3 Zeilen (gefiltert)")).toBeInTheDocument();
    fireEvent.click(within(logs).getByLabelText("nur Fehlerausgabe"));
    expect(within(logs).getByText("Keine Zeile passt zum Filter.")).toBeInTheDocument();
    expect(within(logs).getByRole("link", { name: /Live mitlesen/ })).toHaveAttribute("href", "/dozzle/show?name=shop-postgres");
  });

  it("Deploys: die laufende Revision ist markiert — keine NAS- oder Rückstands-Karte", async () => {
    stub(base);
    renderWithClient(
      <MemoryRouter>
        <Server />
      </MemoryRouter>,
    );
    expect(await screen.findByText("läuft jetzt")).toBeInTheDocument();
    expect(screen.queryByTestId("nas-card")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Server-Rückstand" })).not.toBeInTheDocument();
  });

  it("fehlt der Docker-Lesezugang: Satz + genauer Befehl, als „Fehlt noch“ — ohne Freigabe-Text", async () => {
    stub({
      ...base,
      docker: { available: false, reason: "Der Docker-Lesezugang (Socket-Proxy) läuft noch nicht – deshalb sieht NyxOS keine Container.", fix: "Deploy ausführen.", command: "scripts/deploy-all.sh", checkedAt: null },
      containers: [],
      pending: [{ id: "socket-proxy", title: "Container-Ansicht", sentence: "Der Docker-Lesezugang (Socket-Proxy) läuft noch nicht.", command: "scripts/deploy-all.sh" }],
    });
    renderWithClient(
      <MemoryRouter>
        <Server />
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("server-pending");
    expect(within(box).getByText("scripts/deploy-all.sh")).toBeInTheDocument();
    expect(screen.queryByText(/wartet auf Freigabe/)).not.toBeInTheDocument();
  });
});

describe("Neustart-Schleife", () => {
  it("zählt als gestört und nicht als laufend, auch wenn Docker gerade „running“ meldet", () => {
    const flapping = c({ id: "c1c1c1c1c1c1", name: "demo-gateway", group: "andere", state: "running", health: "none", restartCount: 20_499, restartLoop: true });
    expect(containerStatus(flapping)).toEqual({ label: "startet ständig neu", tone: "bad" });
    expect(isSteadyRunning(flapping)).toBe(false);
    const list = [...containers.filter((x) => x.name !== "demo-gateway" && x.project !== "shop"), flapping];
    const andere = groupContainers(list).find((s) => s.group === "andere");
    expect(andere?.troubled).toBe(1);
    expect(andere?.running).toBe(0);
    // Ein normaler Neustart-Zähler ohne Schleife bleibt gesund.
    expect(containerStatus(c({ restartCount: 3 })).tone).toBe("ok");
  });
});

describe("serverView (reine Helfer)", () => {
  it("Zustand, Gruppen, Summen, Laufzeit", () => {
    expect(containerStatus({ state: "running", health: "unhealthy" })).toEqual({ label: "ungesund", tone: "bad" });
    expect(containerStatus({ state: "exited", health: "none" }).tone).toBe("idle");
    expect(groupContainers(containers).map((s) => [s.group, s.containers.length, s.troubled])).toEqual([
      ["nyxos", 1, 0],
      ["andere", 4, 2],
    ]);
    expect(sumHistories([[1, 2, 3], [10]])).toEqual([1, 2, 13]);
    expect(uptime(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("3 T");
    expect(uptime(null, now)).toBeNull();
  });
});
