// Aufgabe per Nyx-Panel starten (echter Haiku, echte Start-Kette auf dem lokalen Stack). Der Satz kommt aus
// E2E_START_TEXT und muss eine vorhandene Aufgabe nennen, z. B. „Starte T-01“; ohne ihn wird übersprungen.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   E2E_START_TEXT="Starte T-01" pnpm --filter @nyxos/web exec playwright test e2e/nyx-panel-start-task.spec.ts --project chromium-1440
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.describe.configure({ timeout: 240_000 });

test.beforeEach(async ({ context, baseURL }) => {
  // Probe-Anmeldung (dev.ts schreibt sie, 0600) statt Passkey – nur auf der Probe.
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Aufgabe per Panel starten", async ({ page }) => {
  test.skip(!process.env.E2E_START_TEXT, "E2E_START_TEXT fehlt (Satz, der eine vorhandene Aufgabe startet)");
  await page.goto("/tasks");
  await page.waitForTimeout(1500);
  await page.keyboard.press("ControlOrMeta+j");
  const input = page.getByLabel("Frage an Haiku");
  await expect(input).toBeVisible();
  await input.fill(process.env.E2E_START_TEXT ?? "");
  await input.press("Enter");
  await expect(page.getByLabel("Nyx", { exact: true }).locator('ul[aria-label="Quellen"] a').first()).toBeVisible({ timeout: 180_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(SHOTS, "nyx-panel-start-task.png") });
});
