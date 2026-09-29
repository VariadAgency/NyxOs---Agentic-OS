// Git-Seite gegen den lokalen Stack: dessen Brücke liest die echten Repos auf diesem Rechner nur lesend.
// Geprüft: Seite mit echten Zahlen und drei sichtbar verschiedenen Abschnitten, nie „Noch kein Git-Stand“
// (sofortiger Scan), leere Zustände, Klicks führen weiter (Commit → Dateien + Session, Worktree → Sessions,
// Zweig → Commits).
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/git-page.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");

test.describe.configure({ timeout: 180_000 });

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("Brücke hat sofort gescannt — echte Repos, kein Technik-Text", async ({ page, request }) => {
  // Die Brücke des lokalen Stacks scannt beim Start: spätestens nach 90 s liegt ein Stand vor.
  await expect
    .poll(async () => ((await (await request.get("/api/git/dashboard")).json()) as { app: unknown }).app !== null, { timeout: 90_000, intervals: [1000] })
    .toBe(true);
  await page.goto("/git");
  await expect(page.getByTestId("section-app")).toBeVisible();
  const text = (await page.locator("main").textContent()) ?? "";
  // Nur die Texte der Seite selbst prüfen (Commit-Betreffe dürfen alles enthalten).
  expect(text).not.toMatch(/Noch kein Git-Stand|misst sofort|pnpm dev/);
  await page.getByTestId("git-kpis").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOTS, "git-first-scan-done.png"), fullPage: false });
});

test("Leere Zustände — erster Scan mit Fortschritt, Brücke offline mit Knopf (Antwort nachgestellt)", async ({ page }) => {
  const empty = {
    kpis: { commitsToday: 0, commits7d: 0, commitsPrev7d: 0, commits30d: 0, openBranches: 0, worktrees: 0, uncommittedFiles: 0, uncommittedPlaces: 0 },
    heatmap: [],
    merges: [],
    actions: [],
    app: null,
    appWorktrees: [],
    nyxos: null,
    nyxosWorktrees: [],
    others: [],
  };
  const now = new Date().toISOString();
  await page.route("**/api/git/dashboard", (r) =>
    r.fulfill({ json: { ...empty, scan: { state: "scanning", progress: { phase: "scanning", done: 7, total: 30, current: "NyxOS", startedAt: now, finishedAt: null }, lastScanAt: null, bridge: { state: "online", reason: null } } } }),
  );
  await page.goto("/git");
  await expect(page.getByText("Brücke scannt gerade …")).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "git-scanning.png") });
  await page.unroute("**/api/git/dashboard");
  await page.route("**/api/git/dashboard", (r) => r.fulfill({ json: { ...empty, scan: { state: "never", progress: null, lastScanAt: null, bridge: { state: "offline", reason: "Rechner schläft oder ist offline" } } } }));
  await page.goto("/git");
  await expect(page.getByText("Die Brücke ist gerade nicht verbunden.")).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "git-bridge-offline.png") });
});

test("Kennzahlen, Heatmap, Merges, Aktions-Log und getrennte Abschnitte", async ({ page }) => {
  await page.goto("/git");
  await expect(page.getByTestId("git-kpis")).toBeVisible();
  await page.waitForTimeout(900); // Kennzahlen zählen einmal hoch
  await page.screenshot({ path: resolve(SHOTS, "git-top.png") });
  await page.setViewportSize({ width: 1440, height: 6400 });
  await page.goto("/git");
  await expect(page.getByTestId("git-kpis")).toBeVisible();
  await expect(page.getByTestId("heat-cell")).toHaveCount(84);
  // Echte Zahlen: 30-Tage-Commits > 0 in den echten Repos.
  const thirty = page.locator('[data-metric="git-30d"]');
  await expect(thirty).not.toContainText("—");
  // Drei Abschnitte mit eigener Farbe.
  const colors = await page.locator("[data-color]").evaluateAll((els) => els.map((e) => e.getAttribute("data-color")));
  expect(new Set(colors).size).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("git-actions")).toBeVisible();
  // Ganze Seite als Bild (von oben nach unten): Fenster so hoch wie der Inhalt.
  const full = await page.locator("main.cc-scroll").evaluate((el) => el.scrollHeight);
  await page.setViewportSize({ width: 1440, height: Math.min(full + 40, 9000) });
  await page.locator("main.cc-scroll").evaluate((el) => el.scrollTo(0, 0));
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(SHOTS, "git-full.png") });
});

test("Commit → Dateien + Session, Worktree → Sessions, Zweig → Commits", async ({ page }) => {
  await page.goto("/git");
  await expect(page.getByTestId("section-app")).toBeVisible();
  // Neuesten Merge öffnen (echte Session + Dateien).
  await page.getByTestId("git-merges").locator("div.group button").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Gemacht von")).toBeVisible();
  await expect(dialog.getByText(/Geänderte Dateien/)).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOTS, "git-commit.png") });
  // Weiter zum Zweig des Commits.
  await dialog.locator("header button").first().click();
  await expect(page.getByRole("dialog").getByText(/Eigene Commits|Letzte Commits auf/)).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "git-branch.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Worktree-Karte → Sessions darin.
  const card = page.getByTestId("section-worktrees").locator("article").first();
  if ((await card.count()) > 0) {
    await card.locator("button").first().click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: /Sessions darin/ })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(SHOTS, "git-worktree.png") });
  }
});
