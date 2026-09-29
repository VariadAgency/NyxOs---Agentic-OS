import { expect, type Page } from "@playwright/test";

/**
 * Die Steuer-Leiste rechts im Gehirn (Filter, Gruppen, Darstellung, Kräfte) startet immer
 * zugeklappt. Vor jedem Zugriff auf ihre Elemente über den Griff „Steuerung öffnen“ ausfahren.
 * Ist sie schon offen, passiert nichts.
 */
export async function openBrainPanel(page: Page): Promise<void> {
  const panel = page.getByTestId("brain-panel");
  await panel.waitFor({ state: "attached", timeout: 30_000 });
  if ((await panel.getAttribute("data-open")) === "1") return;
  await page.getByRole("button", { name: "Steuerung öffnen" }).click();
  await expect(panel).toHaveAttribute("data-open", "1");
}
