// Aufgaben-Tab (Karten je Auftrag, Farben je Status/Projekt, Kennzahlen) und Agenten als Kacheln mit
// Großansicht — 1440 px und 1024 px, bei 390 px ohne seitliches Überlaufen.
// NUR LESEND: alle nicht-GET-Aufrufe werden hier abgewiesen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/tasks-agents-cards.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const OUT = join(process.cwd(), "..", "..", ".probe", "shots");
mkdirSync(OUT, { recursive: true });

async function readOnly(page: Page) {
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
}

// Der Inhalt scrollt in `<main>` (overflow-y-auto → auch x scrollbar), nicht im Dokument —
// ein seitliches Überlaufen zeigt sich also nur dort. Beides messen.
const sideOverflow = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const main = document.querySelector("main");
    return Math.max(doc, main ? main.scrollWidth - main.clientWidth : 0);
  });

test.describe("Aufgaben und Agenten als Karten", () => {
  test("Aufgaben: Karten je Auftrag, Kennzahlen, Schritte", async ({ page }) => {
    await readOnly(page);
    await page.goto("/tasks");
    await expect(page.getByRole("region", { name: "Kennzahlen" })).toBeVisible();
    const firstCard = page.getByRole("region", { name: "Aufträge" }).getByRole("article").first();
    await expect(firstCard).toBeVisible({ timeout: 20_000 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, "tasks-cards.png") });
    // Die Seite scrollt im Hauptbereich (nicht im Dokument) — daher Bildschirmfotos je Stelle.
    await firstCard.scrollIntoViewIfNeeded();
    await firstCard.getByRole("button", { name: /^Schritte von/ }).first().click();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, "tasks-cards-steps.png") });
    await page.getByRole("heading", { level: 1 }).first().scrollIntoViewIfNeeded();

    // Kleinste vorgesehene Breite (s. playwright.config): 1024 px.
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, "tasks-cards-1024.png") });

    // Handy-Breite: die Seitenleiste bleibt (App-Rahmen), aber nichts darf seitlich überlaufen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    expect(await sideOverflow(page)).toBeLessThanOrEqual(1);
  });

  test("Agenten: Kacheln und Großansicht", async ({ page }) => {
    await readOnly(page);
    await page.goto("/agents");
    const grid = page.getByRole("region", { name: "Alle Agenten" });
    await expect(grid.locator("[data-agent-tile]").first()).toBeVisible({ timeout: 20_000 });
    await grid.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, "agents-tiles.png") });

    // Ein Agent mit eigener Datei (Modell/Werkzeuge/Prompt), sonst der erste.
    const withFile = grid.locator('[data-agent-tile="scope-warden"]');
    await ((await withFile.count()) > 0 ? withFile : grid.locator("[data-agent-tile]").first()).click();
    const detail = page.getByTestId("agent-tile-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("list", { name: "Letzte Einsätze" })).toBeVisible();
    await detail.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, "agents-tile-detail.png") });
    await detail.getByRole("list", { name: "Letzte Einsätze" }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, "agents-tile-runs.png") });

    await page.setViewportSize({ width: 1024, height: 800 });
    await detail.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, "agents-tiles-1024.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    expect(await sideOverflow(page)).toBeLessThanOrEqual(1);
  });
});
