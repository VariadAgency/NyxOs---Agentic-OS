// Statuszeile unten links → „Alle Verbindungen ansehen“ → Einstellungen → Verbindungen (live vom Server,
// „Jetzt prüfen“ holt einen frischen Lauf).
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/connections-status.spec.ts --project chromium-1440
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOT = resolve(process.cwd(), "../../.probe/shots/connections.png");

test.describe.configure({ timeout: 90_000 });

test("Statuszeile verlinkt auf Einstellungen → Verbindungen, Prüfung live mit „Jetzt prüfen“", async ({ page }) => {
  await page.goto("/overview");
  await page.getByRole("link", { name: /Alle Verbindungen ansehen/ }).click();
  await expect(page).toHaveURL(/\/settings#verbindungen$/);

  const section = page.locator("section#verbindungen");
  await expect(section.getByRole("heading", { name: "Verbindungen" })).toBeVisible();
  const recheck = section.getByRole("button", { name: "Jetzt prüfen" });
  await expect(recheck).toBeVisible({ timeout: 30_000 });
  await recheck.click();
  await expect(section.getByRole("button", { name: "Jetzt prüfen" })).toBeEnabled({ timeout: 30_000 });
  // Alle Gruppen da, jede Prüfung mit Zustand und Antwortzeit.
  for (const g of ["Server & Datenbank", "Brücke", "Nyx", "Daten-Quellen", "Server-Betrieb", "Anmeldung & Schutz"]) {
    await expect(section.getByLabel(g, { exact: true })).toBeVisible();
  }
  await expect(section.getByText(/Geprüft um .* Verbindungen in \d+ ms/)).toBeVisible();
  // Die Seite scrollt in einem inneren Bereich — für das Bildschirmfoto das Fenster so hoch machen, dass
  // der ganze Abschnitt auf einmal gerendert ist.
  await page.setViewportSize({ width: 1440, height: 4200 });
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await section.screenshot({ path: SHOT });
});
