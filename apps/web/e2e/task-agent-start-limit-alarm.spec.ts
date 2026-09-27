// „Agent starten“ an einer Aufgabe öffnet „Neue Session“ vorbelegt; Limit-Wecker zeigt die Hochrechnung auf
// /usage. NUR LESEND: alle nicht-GET-Aufrufe werden abgewiesen — der Dialog wird vorbelegt gezeigt, aber nie
// gestartet.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/task-agent-start-limit-alarm.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const OUT = join(process.cwd(), "..", "..", ".probe", "shots");
mkdirSync(OUT, { recursive: true });

async function readOnly(page: Page) {
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
}

test.describe("Agent starten und Limit-Wecker", () => {
  // Ein Bild reicht: `--project=chromium-1440`.

  test("Aufgabe → Agent starten öffnet „Neue Session“ vorbelegt", async ({ page }) => {
    await readOnly(page);
    await page.goto("/tasks");
    const btn = page.getByRole("button", { name: /^Agent starten für / }).first();
    await expect(btn).toBeVisible({ timeout: 30_000 });
    await expect(btn).toBeEnabled({ timeout: 20_000 });
    await btn.click();
    const dlg = page.getByRole("dialog", { name: "Neue Session" });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByLabel("Modell")).toHaveValue("opus");
    await expect(dlg.getByLabel("Erste Nachricht (optional)")).toHaveValue(/\S/);
    await expect(dlg.getByText(/Für den Auftrag/)).toBeVisible();
    await page.screenshot({ path: join(OUT, "task-agent-start.png") });
  });

  test("Limit-Wecker: Hochrechnung unter den Fenstern auf /usage", async ({ page }) => {
    await readOnly(page);
    await page.goto("/usage");
    const claude = page.locator('[data-window="claude"]');
    await expect(claude).toBeVisible({ timeout: 30_000 });
    await expect(claude.getByRole("list", { name: "Hochrechnung" })).toBeVisible({ timeout: 20_000 });
    await page.getByText("Fenster und Limits", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, "usage-limit-alarm.png") });
  });
});
