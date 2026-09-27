// Sessions-Tab: Screenshots von Übersicht, Vollbild, ⌘K bei 1440/1024 px + Tokens/Schriften per
// getComputedStyle. Läuft gegen den lokalen Stack (s. playwright.config.ts), kein Docker nötig.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/sessions.spec.ts
import { expect, test } from "@playwright/test";

test.describe("Sessions-Tab: Aussehen (Mockup-Abgleich)", () => {
  test("Übersicht: Tokens, Schriften, Screenshot", async ({ page }, testInfo) => {
    await page.goto("/sessions");
    await page.waitForSelector('[role="tablist"]');
    await page.waitForTimeout(200); // /health-Anfrage (Verbindungsstatus unten links) abwarten

    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(10, 13, 18)"); // #0A0D12

    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFont).toContain("IBM Plex Sans");

    const heading = page.locator("h4, h1").first();
    if (await heading.count()) {
      const headingFont = await heading.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(headingFont).toContain("Archivo");
    }

    await page.screenshot({ path: testInfo.outputPath(`overview-${testInfo.project.name}.png`), fullPage: true });
  });

  test("Vollbild: Screenshot", async ({ page }, testInfo) => {
    await page.goto("/sessions");
    await page.waitForSelector('[role="tablist"]');
    const sessionTab = page.getByRole("tab").nth(1);
    if ((await page.getByRole("tab").count()) > 3) {
      await sessionTab.click();
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: testInfo.outputPath(`fullscreen-${testInfo.project.name}.png`), fullPage: true });
  });

  test("⌘K: Screenshot", async ({ page }, testInfo) => {
    await page.goto("/sessions");
    await page.waitForSelector('[role="tablist"]');
    await page.keyboard.press("Meta+k");
    await page.waitForSelector('[role="dialog"]', { timeout: 3000 }).catch(() => page.keyboard.press("Control+k"));
    await page.screenshot({ path: testInfo.outputPath(`command-palette-${testInfo.project.name}.png`) });
  });
});
