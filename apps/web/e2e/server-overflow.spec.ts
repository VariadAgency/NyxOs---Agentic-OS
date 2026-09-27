// Server-Seite ohne Überlauf: lange Werte (QEMU-Modell, Ubuntu-Punkt-Version, lange Container-Namen) bei
// 390/1000/1280/1512 px. Prüft im echten Browser-Layout: kein Kind ragt über seine Kachel/Karte hinaus, keine
// waagrechte Scrollleiste. Alle /api-Antworten kommen aus page.route — jede Instanz der Web-App genügt:
//   pnpm --filter @nyxos/web exec playwright test e2e/server-overflow.spec.ts --project chromium-1440
//   (oder ohne Server-Stack: `pnpm --filter @nyxos/web exec vite --port 5199` und E2E_BASE_URL=http://127.0.0.1:5199)
import { expect, test, type Page } from "@playwright/test";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

const container = (over: Record<string, unknown>) => ({
  id: Math.random().toString(16).slice(2, 14).padEnd(12, "0"),
  name: "x",
  group: "atlas",
  project: "backend",
  image: "registry.example.com/atlas/very-long-image-name-for-testing:2026.09.26-build.1234",
  imageTag: "2026.09.26-build.1234",
  imageVersion: null,
  imageCreatedAt: iso(3 * 86_400_000),
  state: "running",
  health: "healthy",
  createdAt: null,
  startedAt: iso(5 * 3_600_000),
  restartCount: 0,
  restartLoop: false,
  ports: ["0.0.0.0:443 → 443/tcp", "127.0.0.1:47800 → 8080/tcp", "9000/tcp (intern)"],
  cpuPercent: 3.2,
  memBytes: 120e6,
  memLimitBytes: 1e9,
  cpuHistory: [2, 3, 3.2],
  memHistory: [110e6, 115e6, 120e6],
  ...over,
});

const snapshot = {
  docker: { available: true, reason: null, fix: null, command: null, checkedAt: iso(0) },
  containers: [
    container({ name: "atlas-postgres" }),
    container({ name: "atlas-media-service-with-a-really-long-name", health: "unhealthy" }),
    container({ name: "nyxos-api", group: "nyxos", project: "nyxos" }),
    container({ name: "gateway-main-with-a-long-name", group: "andere", project: "gateway", state: "restarting", health: "none", restartCount: 20_499, restartLoop: true, cpuHistory: [], memHistory: [], cpuPercent: null, memBytes: null }),
    container({ name: "gateway-sandbox", group: "andere", project: "gateway-sandbox", state: "running", health: "unhealthy" }),
    container({ name: "tracker-caddy-1", group: "andere", project: "tracker", state: "exited", health: "none", cpuHistory: [], memHistory: [], cpuPercent: null, memBytes: null }),
  ],
  deploys: [{ id: 1, project: "nyxos", containerName: "nyxos-api", imageId: "x", createdAt: iso(3_600_000), gitRev: "69e82dc", source: "deploy.sh" }],
  nyxosHealthy: true,
  health: { ok: true, checks: { database: { ok: true, ms: 1 }, schema: { ok: true, ms: 1 }, archive: { ok: true, ms: 1 } } },
  runningRevision: "69e82dc",
  backlog: {
    nyxos: { label: "NyxOS", state: "behind", serverRev: "69e82dc", repoRev: "f5a7bdf", against: "main", behind: 12, ahead: null, sentence: "12 Commits auf main sind noch nicht deployt." },
    atlas: { label: "Atlas-Backend", state: "ok", serverRev: "1e67737", repoRev: "1e67737", against: "origin/feature/messenger-e2ee-with-long-branch-name", behind: 0, ahead: 0, sentence: "Das Backend auf dem Server steht auf feature/messenger-e2ee (1e67737)." },
  },
  nasBackup: { state: "bad", lastSnapshotAt: iso(19 * 86_400_000), lastSnapshotName: "atlas-snapshot_20260906_021519.tar.gz", sizeBytes: null, sizeNote: "Größe unbekannt.", ageHours: 463.7, lastAttemptAt: iso(8 * 3_600_000), lastAttemptOk: false, lastError: null, failedCount: 19, failedSince: iso(19 * 86_400_000), sentence: "Letzte gültige Sicherung vor 19 Tagen.", fix: "Grenze prüfen." },
  dozzleUrl: "/dozzle/",
  pending: [],
};

const hist = Array.from({ length: 30 }, (_, i) => ({ at: iso((30 - i) * 10_000), cpu: 20 + (i % 7) * 5, memUsed: 5e9 + i * 1e7, load1: 1.5 + (i % 5) / 10, diskRead: 1e5 * i, diskWrite: 2e5 * i }));

const host = {
  checkedAt: iso(0),
  hostname: "atlas-production-vps",
  os: "Ubuntu 24.04.4 LTS",
  kernel: "6.8.0-45-generic",
  cpuModel: "AMD EPYC-Rome Processor with a very long model name",
  cores: 2,
  cpuPercent: 43.2,
  load: [1.8, 2.09, 2.31],
  uptimeSeconds: 13 * 86_400 + 22 * 3600,
  bootedAt: iso((13 * 86_400 + 22 * 3600) * 1000),
  memTotal: 7.7e9,
  memAvailable: 2.1e9,
  swapTotal: 0,
  swapFree: 0,
  temperatures: [],
  disks: [
    { label: "Archiv (NyxOS)", totalBytes: 150e9, usedBytes: 120e9, freeBytes: 30e9, inodesTotal: 1000, inodesUsed: 100 },
    { label: "/home/alex/some/very/long/mounted/path/on/the/server", totalBytes: 1e12, usedBytes: 4e11, freeBytes: 6e11, inodesTotal: 1000, inodesUsed: 800 },
  ],
  network: [{ iface: "eth0", rxBytes: 1, txBytes: 2, rxRate: 123_456, txRate: 98_765 }],
  ports: [
    { port: 443, bind: "alle", proto: "tcp", target: 443, container: "atlas-caddy" },
    { port: 47800, bind: "lokal", proto: "tcp", target: 8080, container: "nyxos-api-with-a-really-long-container-name" },
  ],
  containersRunning: 20,
  containersTotal: 22,
  dockerVersion: "27.3.1",
  tailscale: null,
  cpuCores: [
    { id: 0, percent: 93 },
    { id: 1, percent: 28 },
  ],
  cpuSplit: { user: 30, system: 8, iowait: 1, steal: 4 },
  cpuMHz: 2445,
  virtualization: { isVirtual: true, label: "virtuelle Maschine (KVM/QEMU)", vendor: "QEMU", product: "Standard PC (i440FX + PIIX, 1996)" },
  processes: { running: 3, blocked: 0, threads: 1345, forkRate: 12 },
  contextSwitchRate: 15_000,
  interruptRate: 8_200,
  memDetail: { free: 0.4e9, buffers: 0.1e9, cached: 1.9e9, reclaimable: 0.3e9, shmem: 0.2e9, dirty: 3e6 },
  swapInRate: 0,
  swapOutRate: 0,
  majorFaultRate: 2,
  oomKills: 3,
  diskIo: [{ device: "sda", readRate: 1.23e6, writeRate: 4.56e6, readIops: 12.3, writeIops: 45.6, busyPercent: 21 }],
  pressure: { cpu: { some10: 12.5, some60: 9.1, full10: null }, memory: { some10: 0.4, some60: 0.2, full10: 0.1 }, io: { some10: 3.2, some60: 2.1, full10: 1.1 } },
  openFiles: { used: 12_345, max: 9_223_372 },
  history: hist,
  docker: { version: "27.3.1", images: 142, storageDriver: "overlay2", rootDir: "/var/lib/docker", architecture: "x86_64" },
  probe: { host: "api.atlas.example.com", checkedAt: iso(0), ok: true, ms: 38, certValidTo: iso(-54 * 86_400_000), certDaysLeft: 54, issuer: "Let's Encrypt", error: null },
  missing: ["Temperatur: Der Server meldet keine Sensoren (typisch für eine virtuelle Maschine)."],
};

async function mockApi(page: Page) {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/server/host") return json(host);
    if (url.pathname === "/api/server") return json(snapshot);
    if (url.pathname === "/api/server/files/roots") return json({ roots: [] });
    if (url.pathname.startsWith("/api/auth/status")) return json({ authenticated: true, csrf: "t", hasPasskey: true, authReads: false });
    if (url.pathname.startsWith("/api/builds")) return json({ recent: [], groups: [] });
    return json({ error: "im Test nicht nachgebaut" }, 404);
  });
}

/** Alle Kinder einer Kachel/Karte, die rechts oder links über deren Rand ragen (1 px Toleranz). */
async function overflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const boxes = document.querySelectorAll<HTMLElement>('[data-tile], [data-slot="card"], [data-testid="containers-summary"]');
    for (const box of boxes) {
      const b = box.getBoundingClientRect();
      if (b.width === 0) continue;
      for (const el of box.querySelectorAll<HTMLElement>("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Absichtlich abgeschnittene Zeilen (truncate) zählen nicht — dort ragt nur das innere Textfeld.
        if (getComputedStyle(el).overflow === "hidden" && getComputedStyle(el).textOverflow === "ellipsis") continue;
        if (r.right > b.right + 1 || r.left < b.left - 1) {
          out.push(`${box.getAttribute("data-tile") ?? box.getAttribute("data-testid") ?? "karte"}: <${el.tagName.toLowerCase()}> „${(el.textContent ?? "").trim().slice(0, 50)}“ ragt ${Math.round(r.right - b.right)} px hinaus`);
          break;
        }
      }
    }
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`Seite scrollt waagrecht (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
    return out;
  });
}

for (const width of [390, 1000, 1280, 1512]) {
  test(`Server-Seite ohne Überlauf bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockApi(page);
    await page.goto("/server");
    await page.getByTestId("host-tiles").waitFor();
    await page.getByTestId("host-cpu").waitFor();
    // Optional: Bilder zum Anschauen (E2E_SHOT_DIR=<Ordner>).
    if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/server-${width}.png`, fullPage: true });
    expect(await overflows(page)).toEqual([]);
    // Liste mit allen Gruppen offen ebenfalls prüfen.
    const section = page.getByRole("region", { name: "Container" });
    await section.getByRole("button", { name: "Liste" }).click();
    for (const b of await section.locator('button[aria-expanded="false"]').all()) await b.click();
    expect(await overflows(page)).toEqual([]);
  });
}
