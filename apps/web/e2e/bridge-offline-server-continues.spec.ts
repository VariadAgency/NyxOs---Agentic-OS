// „Mac zu“: Brücke des lokalen Stacks gestoppt → Briefing, Panel (echter Haiku) und Inbox laufen weiter.
// Vorher nur die Brücken-Prozesse von `pnpm dev` (die eigenen PIDs) beenden, der Server läuft weiter.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/bridge-offline-server-continues.spec.ts --project chromium-1440
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = resolve(process.cwd(), process.env.E2E_SHOT_DIR ?? "../../.probe/shots");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeEach(async ({ context, baseURL }) => {
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Mac zu: Briefing neu erzeugen, Panel antwortet, Inbox da", async ({ page }) => {
  await page.goto("/briefing");
  // Leiste unten links: Zustand vom Server (erst 90 s „verbindet neu …", dann „offline · Dienst gestoppt").
  await expect(page.getByText("Brücke offline", { exact: false }).last()).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: /(Jetzt neu erstellen|Briefing jetzt erstellen)/ }).first().click();
  await expect(page.getByText(/Nyx schreibt/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Nyx schreibt/)).toBeHidden({ timeout: 150_000 });
  await expect(page.getByRole("heading", { name: /^(Guten (Morgen|Tag|Abend)|Noch wach)/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(SHOTS, "mac-closed-briefing.png"), fullPage: true });

  await page.keyboard.press("ControlOrMeta+j");
  const input = page.getByLabel("Frage an Haiku");
  await input.fill("Was liegt gerade in der Entscheidungs-Inbox? Kurz, mit Quellen.");
  await input.press("Enter");
  const panel = page.getByLabel("Nyx", { exact: true });
  await expect(panel.locator('ul[aria-label="Quellen"] a').first()).toBeVisible({ timeout: 150_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(SHOTS, "mac-closed-panel.png") });

  await page.keyboard.press("Escape");
  await page.goto("/inbox");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(SHOTS, "mac-closed-inbox.png"), fullPage: true });
});
