// Focus button against a real local server: button at the bottom left, menu, "do not disturb" until I turn it off →
// the button shows it, the settings show it; back to auto. 390 px: in the "More" drawer, sheet from the bottom, no
// horizontal scrolling, tap targets ≥ 44 px. E.g.:
//   NYXOS_HOME=<tmp> PORT=47921 pnpm exec tsx apps/server/src/local.ts
//   (cd apps/web && NYXOS_API=http://127.0.0.1:47921 pnpm exec vite --port 5221 --strictPort --host 127.0.0.1)
//   E2E_BASE_URL=http://127.0.0.1:5221 E2E_NYXOS_API=http://127.0.0.1:47921 E2E_NYXOS_HOME=<tmp> \
//     pnpm --filter @nyxos/web exec playwright test e2e/focus.spec.ts --project chromium-1440
import { expect, type Page, test } from "@playwright/test";
import { prepare } from "./helpers/localStack";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, baseURL }) => {
  await prepare(page, baseURL);
});

async function openMenu(page: Page) {
  const btn = page.getByTestId("focus-button");
  await expect(btn).toBeVisible({ timeout: 30_000 });
  await btn.click();
  await expect(page.getByTestId("focus-menu")).toBeVisible();
}

test("Desktop: Nicht stören an, Einstellungen zeigen es, zurück auf Automatisch", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overview");
  await openMenu(page);
  await page.getByTestId("focus-mode-dnd").click();
  await page.getByTestId("focus-duration-manual").click();
  await expect(page.getByRole("status").filter({ hasText: "Nicht stören" })).toBeVisible();
  await expect(page.getByTestId("focus-menu")).toBeHidden({ timeout: 5000 });
  await expect(page.getByTestId("focus-button")).toHaveAttribute("data-mode", "dnd");

  await page.goto("/settings/mitteilungen");
  await expect(page.getByTestId("focus-panel")).toContainText("Fokus: Nicht stören · bis du es ausschaltest");
  await expect(page.getByTestId("focus-panel")).toContainText("Rechner und Browser");

  await openMenu(page);
  await page.getByTestId("focus-mode-auto").click();
  await expect(page.getByTestId("focus-button")).toHaveAttribute("data-mode", "auto");
});

test("390 px: Knopf in der Mehr-Schublade, Blatt von unten, kein waagerechtes Scrollen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/overview");
  await page.getByRole("button", { name: /Mehr/ }).click();
  await openMenu(page);
  await page.getByTestId("focus-mode-away").click();
  const menu = await page.getByTestId("focus-menu").boundingBox();
  expect(menu?.width).toBeGreaterThanOrEqual(388); // sheet over the full width
  expect((menu?.y ?? 0) + (menu?.height ?? 0)).toBeGreaterThanOrEqual(843); // anchored at the bottom
  for (const id of ["focus-mode-auto", "focus-mode-away", "focus-mode-dnd", "focus-duration-1h", "focus-duration-manual"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByTestId("focus-duration-1h").click();
  await expect(page.getByRole("status").filter({ hasText: "Ich bin weg" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("focus-menu")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("focus-button")).toHaveAttribute("data-mode", "away");
  await expect(page.getByTestId("focus-button")).toContainText("Weg");
  // clean up
  await page.getByTestId("focus-button").click();
  await page.getByTestId("focus-mode-auto").click();
  await expect(page.getByTestId("focus-button")).toHaveAttribute("data-mode", "auto");
});
