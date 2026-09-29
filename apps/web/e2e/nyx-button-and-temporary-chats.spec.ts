// Nyx-Knopf mit Panel in der Kopfzeile und temporäre Sessions (Wegwerf-Chats) gegen den lokalen Stack.
//   pnpm dev                     (echtes claude-CLI, falls lokal angemeldet – sonst „wartet“)
//   pnpm --filter @nyxos/web exec playwright test e2e/nyx-button-and-temporary-chats.spec.ts --project chromium-1440
// Bilder → `.probe/shots/` (Ordner per E2E_SHOT_DIR änderbar).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const shot = (name: string) => resolve(SHOTS, name);
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");
// Gebaut ist die Variante mit Befehlsleiste in der Kopfzeile + Seitenblatt.

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeEach(async ({ context, baseURL }) => {
  if (!existsSync(LOGIN)) return;
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

async function openHaiku(page: Page) {
  const launcher = page.getByRole("button", { name: /^Haiku öffnen/ });
  await expect(launcher).toHaveAttribute("data-engine-state", /ready|waiting_token|off|error/, { timeout: 15_000 });
  await launcher.click();
  const panel = page.getByRole("dialog", { name: "Nyx" });
  await expect(panel).toBeVisible();
  return { launcher, panel };
}

test("Nyx-Knopf: Zustand am Knopf, letzter Faden kommt nach Neuladen zurück, Fadenliste mit Suche", async ({ page }) => {
  await page.goto("/usage");
  const launcher = page.getByRole("button", { name: /^Haiku öffnen/ });
  await expect(launcher).toHaveAttribute("data-engine-state", /ready|waiting_token|off|error/, { timeout: 15_000 });
  // Knopf sitzt in der Kopfzeile – nichts vom Inhalt liegt darunter (eine schwebende Kugel verdeckte früher die Heatmap).
  const box = await launcher.boundingBox();
  const header = await page.locator(`#cc-haiku-slot`).boundingBox();
  expect(box && header && box.y >= header.y - 1 && box.y + box.height <= header.y + header.height + 1).toBe(true);
  await page.screenshot({ path: shot("nyx-button.png") });
  const { panel } = await openHaiku(page);
  const list = panel.getByRole("list", { name: "Fäden" });
  await expect(list).toBeVisible();
  const items = list.getByRole("listitem");
  expect(await items.count()).toBeGreaterThan(1);
  // Einen älteren Faden wählen (nicht den jüngsten) …
  const older = items.nth(1);
  const title = ((await older.locator("span").first().textContent()) ?? "").trim();
  await older.getByRole("button").click();
  await expect(list.locator('[aria-current="true"]')).toContainText(title.slice(0, 20));
  // … neu laden: derselbe Faden ist wieder da, samt Verlauf.
  await page.reload();
  const again = await openHaiku(page);
  await expect(again.panel.getByRole("list", { name: "Fäden" }).locator('[aria-current="true"]')).toContainText(title.slice(0, 20), { timeout: 15_000 });
  await expect(again.panel.locator(".cc-rise").first()).toBeVisible();
  await expect(page.getByText("Server verbunden")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot("nyx-panel.png") });
  // Suche
  await again.panel.getByRole("searchbox", { name: "Fäden durchsuchen" }).fill("Test");
  await expect(again.panel.getByRole("list", { name: "Fäden" }).getByText(/⏳/).first()).toBeVisible();
  await page.screenshot({ path: shot("nyx-thread-search.png") });
});

test("Temporäre Sessions: ⏳-Marken, Filter „Temporäre zeigen“, Schalter im Dialog, Einstellung", async ({ page }) => {
  await page.goto("/sessions/unsortiert/_");
  const list = page.getByRole("list", { name: /Sessions in/ });
  await expect(list).toBeVisible({ timeout: 20_000 });
  // Automatisch erkannte Test-Sessions sind standardmäßig ausgeblendet; „Temporäre zeigen“ holt sie.
  const chip = page.getByRole("switch", { name: /Temporäre zeigen/ });
  await expect(chip).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: shot("temporary-sessions.png") });
  const before = await list.locator("[data-session-id]").count();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-checked", "true");
  await expect(list.getByText(/⏳/).first()).toBeVisible();
  expect(await list.locator("[data-session-id]").count()).toBeGreaterThan(before);
  await page.screenshot({ path: shot("temporary-sessions-shown.png") });
  await chip.click();

  await page.evaluate(() => window.dispatchEvent(new Event("nyxos:new-session")));
  const dlg = page.getByRole("dialog", { name: "Neue Session" });
  if (await dlg.isVisible().catch(() => false)) {
    const sw = dlg.getByRole("switch", { name: /Temporär/ });
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await page.waitForTimeout(300); // Schalter-Übergang (150 ms) abwarten
    await page.screenshot({ path: shot("temporary-sessions-dialog.png") });
    await dlg.getByRole("button", { name: "Abbrechen" }).click();
  }

  await page.goto("/settings/sessions");
  const hours = page.getByRole("spinbutton", { name: /Stunden/ });
  await expect(hours).toHaveValue("6", { timeout: 15_000 });
  await hours.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot("temporary-sessions-setting.png") });
});
