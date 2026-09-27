// Zustand des Nyx-Motors (Haiku) im Panel und in den Einstellungen, in zwei Modi (E2E_NYX_MODE):
//   „wartet“ (Server ohne Token):  NYXOS_HAIKU_REMOTE=1 pnpm dev
//     E2E_NYX_MODE=wartet pnpm --filter @nyxos/web exec playwright test e2e/nyx-engine-status.spec.ts --project chromium-1440
//   „bereit“ (echtes claude-CLI):   pnpm dev
//     E2E_NYX_MODE=bereit pnpm --filter @nyxos/web exec playwright test e2e/nyx-engine-status.spec.ts --project chromium-1440
// Bilder → `.probe/shots/` (Ordner per E2E_SHOT_DIR änderbar).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const shot = (name: string) => resolve(SHOTS, name);
const MODE = process.env.E2E_NYX_MODE ?? "wartet";
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeEach(async ({ context, baseURL }) => {
  if (!existsSync(LOGIN)) return;
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test.describe("wartet auf Token", () => {
  test.skip(MODE !== "wartet", "nur im Modus wartet");

  test("Panel: Zustand vor dem Schreiben, Eingabe gesperrt, Anleitung", async ({ page }) => {
    await page.goto("/git");
    await page.keyboard.press("ControlOrMeta+j");
    const panel = page.getByRole("dialog", { name: "Nyx" });
    await expect(panel.getByLabel("Frage an Haiku")).toBeDisabled({ timeout: 15_000 });
    await expect(panel.getByText("Wartet auf Token vom Nutzer").first()).toBeVisible();
    await panel.getByRole("button", { name: "Anleitung zeigen" }).click();
    await expect(panel.getByText("claude setup-token")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Senden" })).toBeDisabled();
    await page.screenshot({ path: shot("nyx-engine-waiting-panel.png") });
  });

  test("Einstellungen: ehrlicher Zustand + Max-Plan statt Dollar", async ({ page }) => {
    await page.goto("/einstellungen/haiku");
    await expect(page.getByText("Wartet auf Token vom Nutzer").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Max-Plan: kein Aufpreis/)).toBeVisible();
    await expect(page.getByText(/nicht gefunden|claude-CLI nicht/)).toHaveCount(0);
    await page.getByRole("button", { name: "Anleitung zeigen" }).click();
    await page.screenshot({ path: shot("nyx-engine-waiting-settings.png"), fullPage: true });
  });
});

test.describe("bereit (echtes claude-CLI)", () => {
  test.skip(MODE !== "bereit", "nur im Modus bereit");

  test("„Wer bist du?“ im Panel → Antwort", async ({ page }) => {
    await page.goto("/einstellungen");
    await page.keyboard.press("ControlOrMeta+j");
    const panel = page.getByRole("dialog", { name: "Nyx" });
    await expect(panel.getByText("Bereit")).toBeVisible({ timeout: 15_000 });
    const input = panel.getByLabel("Frage an Haiku");
    await expect(input).toBeEnabled();
    await input.fill("Wer bist du?");
    const started = Date.now();
    await input.press("Enter");
    // Antwort = das erste sichtbare Textstück im Assistenten-Bläschen (strömt danach weiter).
    await expect(panel.getByText(/Nyx/).nth(2)).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
    const ms = Date.now() - started;
    test.info().annotations.push({ type: "antwort-ms", description: String(ms) });
    console.log(`Nyx-Motor: Antwort fertig nach ${ms} ms`);
    await page.screenshot({ path: shot("nyx-engine-answer.png") });
  });

  test("Einstellungen: bereit + Motor testen", async ({ page }) => {
    await page.goto("/einstellungen/haiku");
    await expect(page.getByText("Bereit").first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Motor testen" }).click();
    await expect(page.getByText(/Antwort nach/)).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: shot("nyx-engine-ready-settings.png"), fullPage: true });
  });
});
