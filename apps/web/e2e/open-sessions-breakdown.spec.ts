// Nur lesend: Überblick „Sessions offen“ aufgeschlüsselt und ohne Test-Sessions, Sessions-Liste mit
// „Temporäre zeigen“ (Test-Sessions standardmäßig aus), Aufgaben-Kopf mit stimmiger Summe.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/open-sessions-breakdown.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? join(ROOT, ".probe", "shots");
const shot = (n: string) => join(SHOT_DIR, n);

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(({ browserName }) => browserName !== "chromium", "ein Browser genügt");
test.beforeAll(() => mkdirSync(SHOT_DIR, { recursive: true }));

test("Überblick: „Sessions offen“ aufgeschlüsselt, keine Test-Session unter „Zuletzt fertig“", async ({ page }) => {
  await page.goto("/overview");
  const caption = page.getByText(/\d+ arbeiten · \d+ warten · \d+ ruhen/);
  await expect(caption).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500); // Zahlen zählen hoch und Kacheln blenden ein
  await page.screenshot({ path: shot("open-sessions-overview.png") });
});

test("Sessions: Test-Sessions standardmäßig aus, Chip „Temporäre zeigen“", async ({ page }) => {
  await page.goto("/sessions/unsortiert/_");
  const chip = page.getByRole("switch", { name: /Temporäre zeigen/ });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: shot("open-sessions-list.png") });
});

test("Aufgaben: „Offen gesamt“ = Summe der Unterzeile", async ({ page }) => {
  await page.goto("/tasks");
  const tile = page.getByText("Offen gesamt").locator("..");
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500); // Zahlen zählen hoch
  await page.screenshot({ path: shot("open-sessions-tasks.png") });
});
