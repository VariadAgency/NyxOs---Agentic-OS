// Kleine Bedienwege gegen den lokalen Stack: (a) Menü „⋯“ am Nyx-Faden mit Karte „Aufgabe“ im Faden, (b) Status-Punkt
// im Session-Tab lang gedrückt → ✕ → Rückfrage, (c) Nutzung → Verlauf mit beiden Linien.
// „In Obsidian ablegen“ wird hier NICHT geklickt: die Brücke des lokalen Stacks zeigt auf den echten Vault.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/thread-menu-status-usage.spec.ts --project chromium-1440
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.describe.configure({ mode: "serial", timeout: 240_000 });

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Menü „⋯“ am Faden, Aufgabe als Karte im Faden", async ({ page }) => {
  await page.goto("/sessions");
  await page.waitForTimeout(1500);
  await page.keyboard.press("ControlOrMeta+j");
  const panel = page.getByRole("dialog", { name: "Nyx" });
  await expect(panel).toHaveAttribute("data-state", "open");
  // Einen Faden brauchen wir – gibt es noch keinen, einen mit einer kurzen Frage anlegen (echter Motor).
  const list = panel.getByRole("list", { name: "Fäden" });
  if ((await list.count()) === 0) {
    await panel.getByLabel("Frage an Haiku").fill("Wie viele Sessions warten gerade? Nur die Zahl.");
    await panel.getByLabel("Frage an Haiku").press("Enter");
    await expect(list).toBeVisible({ timeout: 120_000 });
    await expect(panel.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 120_000 });
  }
  const first = list.locator("li").first();
  const title = (await first.locator("button").first().locator("span").first().textContent())?.trim() ?? "";
  await first.getByRole("button", { name: /^Aktionen für/ }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "Zu Auftrag machen" }).click();
  await expect(panel.getByRole("note", { name: "Aufgabe" }).last()).toBeVisible({ timeout: 20_000 });
  // Menü für das Bild noch einmal offen lassen.
  await first.getByRole("button", { name: /^Aktionen für/ }).click();
  await expect(page.getByRole("menuitem", { name: "Löschen …" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOTS, "thread-menu.png") });
  // Löschen fragt im Tab nach – hier nur abbrechen.
  await page.getByRole("menuitem", { name: "Löschen …" }).click();
  await expect(page.getByRole("alertdialog", { name: new RegExp(`löschen`) })).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "thread-menu-question.png") });
  await page.getByRole("button", { name: "Abbrechen" }).click();
  expect(title.length).toBeGreaterThan(0);
});

test("Status-Punkt lang drücken → ✕ → Rückfrage", async ({ page }) => {
  await page.goto("/sessions");
  const tabs = page.getByRole("tablist", { name: "Sessions" });
  const dot = tabs.locator('[data-testid^="tab-dot-"]').first();
  await expect(dot).toBeVisible({ timeout: 30_000 });
  const box = await dot.boundingBox();
  if (!box) throw new Error("kein Punkt");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(dot).toHaveAttribute("data-phase", "armed");
  await page.mouse.up();
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(SHOTS, "status-dot-close.png") });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const ask = page.getByRole("alertdialog", { name: /endgültig schließen\?/ });
  await expect(ask).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, "status-dot-question.png") });
  await ask.getByRole("button", { name: "Abbrechen" }).click();
  await expect(ask).toBeHidden();
});

test("Nutzung → Verlauf: Claude- und Codex-Linie", async ({ page }) => {
  await page.goto("/usage?range=30d");
  const chart = page.locator("[data-chart='area']").first();
  await expect(chart).toBeVisible({ timeout: 30_000 });
  await expect(chart.locator("path[data-role='line']")).toHaveCount(2);
  await chart.scrollIntoViewIfNeeded();
  const panel = chart.locator("xpath=ancestor::section[1]");
  await page.waitForTimeout(900);
  await (await panel.count() ? panel : chart).screenshot({ path: resolve(SHOTS, "usage-history-lines.png") });
});
