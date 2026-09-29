// Skills gegen den lokalen Stack (echte Skills über dessen Brücke, echte Nutzung aus den Verläufen):
//   1 · Tab „Skills“: Kacheln mit Herkunft, Nutzung, Mini-Verlauf; Kennzahlen oben
//   2 · Großansicht eines Skills: Inhalt, Nutzung, Vorschläge, Verlauf, Dateien
//   3 · „Neuer Skill“: Dialog zeigt fest Opus 5.5 (nicht wählbar). Es wird NICHTS gestartet (keine echte Opus-Session).
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/skills.spec.ts --project chromium-1440
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = resolve(process.cwd(), "../..");
const SHOTS = resolve(ROOT, ".probe/shots");
const shot = (name: string) => resolve(SHOTS, `skills-${name}.png`);

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("Kacheln: echte Skills mit Herkunft und Nutzung", async ({ page, request }) => {
  // Die Brücke des lokalen Stacks braucht nach dem Start einen Moment, bis sie die Skills gemeldet hat.
  await expect
    .poll(async () => ((await (await request.get("/api/skills")).json()) as { skills: unknown[] }).skills.length, { timeout: 90_000, intervals: [2000] })
    .toBeGreaterThan(0);
  await page.goto("/skills");
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  const grid = page.getByTestId("skills-grid");
  await expect(grid).toBeVisible({ timeout: 30_000 });
  const tiles = grid.locator("[data-skill-tile]");
  expect(await tiles.count()).toBeGreaterThan(0);
  // Jede Kachel sagt ehrlich, wie oft sie lief – nie leer.
  await expect(tiles.first()).toContainText(/genutzt/);
  await page.waitForTimeout(900); // Hochzählen der Kennzahlen abwarten
  await page.screenshot({ path: shot("kacheln"), fullPage: true });
});

test("Großansicht: Inhalt, Nutzung, Vorschläge, Verlauf, Dateien", async ({ page }) => {
  await page.goto("/skills");
  const first = page.getByTestId("skills-grid").locator("[data-skill-tile]").first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  const key = await first.getAttribute("data-skill-tile");
  await first.click();
  await expect(page).toHaveURL(new RegExp(`/skills/${encodeURIComponent(key ?? "")}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`/${key}`);
  for (const title of ["Inhalt (SKILL.md)", "Nutzung · 30 Tage", "Vorschläge von Nyx", "Verlauf der Verbesserungen", "Dateien"]) {
    await expect(page.getByRole("region", { name: title })).toBeVisible();
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: shot("detail"), fullPage: true });
});

test("Neuer Skill: immer Opus 5.5, nicht wählbar", async ({ page }) => {
  await page.goto("/skills");
  await page.getByRole("button", { name: /Neuer Skill/ }).click();
  const dialog = page.getByTestId("skill-job-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Opus 5.5");
  await expect(dialog.getByRole("combobox")).toHaveCount(0); // keine Modell-Auswahl
  await expect(dialog.getByRole("button", { name: "Mit Opus 5.5 erstellen" })).toBeDisabled();
  await dialog.getByPlaceholder("z. B. release-notizen").fill("Release Notizen");
  await expect(dialog.getByPlaceholder("z. B. release-notizen")).toHaveValue("release-notizen");
  await page.screenshot({ path: shot("neuer-skill") });
  await dialog.getByRole("button", { name: "Abbrechen" }).click(); // nichts starten
  await expect(dialog).toHaveCount(0);
});
