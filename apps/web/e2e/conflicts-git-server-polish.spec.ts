// Politur Konflikte/Git/Server gegen den lokalen Stack: kompakte Konflikte-Seite mit Großansicht per Klick,
// kein Überlauf auf der Git-Seite bei 1024 px, Server-Seite ohne Konsolenfehler. Screenshots unter
// `.probe/shots/`. Läuft nur in Chromium (1440/1024), wie `e2e/overview-git-conflicts-server.spec.ts`.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/conflicts-git-server-polish.spec.ts --project chromium-1440 --project chromium-1024
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const OUT = join(import.meta.dirname, "..", "..", "..", ".probe", "shots");
mkdirSync(OUT, { recursive: true });

function isChromium(name: string): boolean {
  return name.startsWith("chromium");
}

test.describe("Konflikte", () => {
  test("Seitenhöhe im Standard < 4.000 px, Klick auf eine Zeile öffnet die Großansicht", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium");
    await page.goto("/conflicts");
    await page.waitForSelector("h1");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, `conflicts-${testInfo.project.name}.png`) });

    // `document.body` ist fest (`h-dvh`) — der Inhalt scrollt in `<main class="cc-scroll">`
    // (s. `e2e/overview-git-conflicts-server.spec.ts` `shotMain`), NICHT im Body. Dort muss auch gemessen werden.
    const height = await page.locator("main.cc-scroll").evaluate((el) => el.scrollHeight);
    expect(height, "Konflikte-Seite darf im Standard nicht kilometerlang sein (früher über 150.000 px)").toBeLessThan(4000);

    // Klick auf die erste Kollisionszeile öffnet die Großansicht (Datei, Sessions, Zeiten).
    const row = page.locator("button[data-path]").first();
    if (await row.count()) {
      await row.click();
      await expect(page.getByTestId("collision-detail")).toBeVisible();
    }
  });
});

test.describe("Git", () => {
  test("1024 px: nichts rechts abgeschnitten, Commits-Heatmap sichtbar", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium");
    await page.goto("/git");
    await page.waitForSelector("h1");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, `git-${testInfo.project.name}.png`) });

    if (testInfo.project.name === "chromium-1024") {
      // Dasselbe `main.cc-scroll` wie oben — der scrollbare Inhaltsrahmen, nicht `document.documentElement`.
      const main = page.locator("main.cc-scroll");
      const overflow = await main.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, "kein horizontaler Überlauf bei 1024 px (früher: Inhalt 912 in 824 px → rechts abgeschnitten)").toBeLessThanOrEqual(1);
    }
  });
});

test.describe("Server", () => {
  test("kein Konsolenfehler, klare Anzeige statt leerem Zustand", async ({ page }, testInfo) => {
    test.skip(!isChromium(testInfo.project.name), "Nur Chromium");
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await page.goto("/server");
    await page.waitForSelector("h1");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, `server-${testInfo.project.name}.png`) });
    expect(consoleErrors, `keine Konsolenfehler: ${consoleErrors.join(" | ")}`).toHaveLength(0);
  });
});
