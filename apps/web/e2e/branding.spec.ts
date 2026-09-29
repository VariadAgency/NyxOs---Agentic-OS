// Branding: Seitentitel, Logo und Assistent heißen NyxOS/Nyx.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/branding.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOT = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots", "branding");

test("NyxOS: Titel, Logo und Nyx-Knopf", async ({ page }) => {
  mkdirSync(resolve(SHOT, ".."), { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overview");
  await expect(page).toHaveTitle(/NyxOS/);
  await expect(page.getByRole("link", { name: /NyxOS.*Überblick/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Nyx öffnen/ })).toBeVisible();
  await page.screenshot({ path: `${SHOT}-ueberblick.png` });
  await page.getByRole("button", { name: /^Nyx öffnen/ }).click();
  await expect(page.getByRole("dialog", { name: "Nyx" })).toBeVisible();
  await page.screenshot({ path: `${SHOT}-panel.png` });
});
