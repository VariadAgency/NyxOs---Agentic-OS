// Server-Tab — Maschine (mehr Daten), Verbindung, Dateien auf dem Server (nur lesen).
import { fireEvent, screen, within } from "@testing-library/react";
import type { HostInfo } from "@nyxos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionSection, MachineSection, ServerMoreSections } from "../src/features/server/ServerMore";
import { jsonResponse, renderWithClient } from "./helpers";

// Absichtlich die ALTE Antwort-Form (ohne die neueren Felder): die Seite muss damit weiter laufen (normalizeHost).
const host: Partial<HostInfo> = {
  checkedAt: "2026-09-26T10:00:00.000Z",
  hostname: "myserver",
  os: "Ubuntu 24.04.1 LTS",
  kernel: "6.8.0-45-generic",
  cpuModel: "AMD Ryzen 7 3700X",
  cores: 16,
  cpuPercent: 12.5,
  load: [0.5, 0.4, 0.3],
  uptimeSeconds: 3 * 86_400 + 2 * 3600,
  bootedAt: "2026-09-23T08:00:00.000Z",
  memTotal: 64e9,
  memAvailable: 40e9,
  swapTotal: 0,
  swapFree: 0,
  temperatures: [],
  disks: [{ label: "/home/user", totalBytes: 1e12, usedBytes: 4e11, freeBytes: 6e11, inodesTotal: 1000, inodesUsed: 100 }],
  network: [{ iface: "eth0", rxBytes: 1, txBytes: 2, rxRate: 2000, txRate: 1000 }],
  ports: [{ port: 443, bind: "alle", proto: "tcp", target: 443, container: "shop-caddy" }, { port: 47800, bind: "lokal", proto: "tcp", target: 8080, container: "nyxos-api" }],
  containersRunning: 20,
  containersTotal: 22,
  dockerVersion: "27.3.1",
  tailscale: false,
  missing: ["Temperatur: Der Server meldet keine Sensoren (typisch für eine virtuelle Maschine)."],
};

function stub(opts: { unauthorized?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (opts.unauthorized && url.startsWith("/api/server/")) return jsonResponse({ code: "auth_required" }, { status: 401 });
      if (url === "/api/server/host") return jsonResponse(host);
      if (url === "/api/server/files/roots") return jsonResponse({ roots: [{ id: "home", label: "Home (user)", hostPath: "/home/user", exists: true }] });
      if (url.startsWith("/api/server/files/list")) {
        return jsonResponse({
          root: "home",
          rel: "",
          truncated: false,
          entries: [
            { name: "Projekt", rel: "Projekt", isDir: true, size: 0, mtimeMs: 1, locked: false, link: false },
            { name: ".env", rel: ".env", isDir: false, size: 10, mtimeMs: 1, locked: true, link: false },
            { name: "notiz.txt", rel: "notiz.txt", isDir: false, size: 12, mtimeMs: 1, locked: false, link: false },
          ],
        });
      }
      if (url.startsWith("/api/server/files/text")) return jsonResponse({ root: "home", rel: "notiz.txt", name: "notiz.txt", content: "Hallo Server", size: 12, mtimeMs: 1 });
      return Promise.reject(new Error(`kein Stub für ${url}`));
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("Server-Tab: mehr Daten, Verbindung, Server-Finder", () => {
  it("Maschine im Detail: CPU, Last, Laufzeit, Platten, Ports, keine Temperatur ohne Sensoren — auch mit der alten Antwort-Form", async () => {
    stub();
    renderWithClient(
      <>
        <MachineSection />
        <ServerMoreSections />
      </>,
    );
    const cpu = await screen.findByTestId("host-cpu");
    expect(within(cpu).getByText("12,5 %")).toBeTruthy();
    expect(within(cpu).getByText("0,50 · 0,40 · 0,30")).toBeTruthy();
    // Ohne Sensoren keine Temperatur-Karte, nur der Satz in „Was NyxOS nicht sehen kann“.
    expect(screen.queryByTestId("host-temp")).toBeNull();
    expect(within(screen.getByTestId("host-missing")).getByText(/Temperatur/)).toBeTruthy();
    expect(within(screen.getByTestId("host-system")).getByText("3 T 2 Std")).toBeTruthy();
    expect(within(screen.getByTestId("host-disks")).getByText("/home/user")).toBeTruthy();
    const ports = screen.getByTestId("host-ports");
    expect(within(ports).getByText(/Veröffentlichte Ports/)).toBeTruthy();
    expect(within(ports).getByText("443")).toBeTruthy();
    expect(within(ports).getByText(/nyxos-api/)).toBeTruthy();
    expect(within(ports).getByText(/Netz · NyxOS-Container/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Terminal" })).toBeTruthy();
  });

  it("Verbindung mit SSH-Host: kopierbare Befehle, Link zu NyxOS und Dozzle", async () => {
    stub();
    renderWithClient(<ConnectionSection sshHost="meinserver" dozzleUrl="/dozzle/" />);
    const card = screen.getByTestId("server-connection");
    expect(within(card).getByText("ssh meinserver")).toBeTruthy();
    expect(within(card).getByText("ssh -N -L 127.0.0.1:47801:127.0.0.1:47800 meinserver")).toBeTruthy();
    expect(card.querySelector(`a[href="${window.location.origin}"]`)).toBeTruthy();
    expect(card.querySelector('a[href="/dozzle/"]')).toBeTruthy();
  });

  it("Verbindung ohne SSH-Host: keine SSH-Befehle, nur der Hinweis auf NYXOS_SERVER_SSH_HOST", async () => {
    stub();
    renderWithClient(<ConnectionSection />);
    const card = screen.getByTestId("server-connection");
    expect(within(card).queryByText(/^ssh /)).toBeNull();
    expect(within(card).getByText(/NYXOS_SERVER_SSH_HOST/)).toBeTruthy();
  });

  it("Server-Finder (Finder des Dateien-Tabs): Spalten, Gesperrtes zeigt nur den Hinweis, Datei zeigt ihren Inhalt in der Vorschau", async () => {
    const calls = stub();
    renderWithClient(<ServerMoreSections />);
    const finder = await screen.findByTestId("server-finder");
    fireEvent.click(within(finder).getByRole("checkbox", { name: /Versteckte/ }));
    fireEvent.click(await within(finder).findByText(".env"));
    expect(await within(finder).findByText(/Gesperrt, weil hier ein Geheimnis liegen kann/)).toBeTruthy();
    expect(calls.some((u) => u.includes("files/text") && u.includes(".env"))).toBe(false);
    fireEvent.click(within(finder).getByText("notiz.txt"));
    const preview = await within(finder).findByRole("region", { name: "Vorschau" });
    expect(await within(preview).findByText("Hallo Server")).toBeTruthy();
  });

  it("ohne Anmeldung: kein Absturz, ein ruhiger Satz mit „Anmelden“", async () => {
    stub({ unauthorized: true });
    renderWithClient(<ServerMoreSections />);
    expect(await screen.findByText("Die Dateien auf dem Server siehst du nach der Anmeldung.")).toBeTruthy();
    expect(screen.getAllByText("Anmelden").length).toBeGreaterThan(0);
  });
});
