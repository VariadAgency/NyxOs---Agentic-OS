// Statuszeile der Brücke: der Zustand kommt vom Server, ein Klick zeigt den Verlauf der letzten 24 h.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/bridge-status-history.spec.ts --project chromium-1440
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOT = resolve(process.cwd(), process.env.E2E_SHOT ?? "../../.probe/shots/bridge-status.png");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.beforeEach(async ({ context, baseURL }) => {
  if (!existsSync(LOGIN)) return;
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Brücke: online, Klick zeigt Verlauf mit Dauer", async ({ page }) => {
  await page.goto("/");
  const line = page.getByRole("button", { name: /Brücke online/ });
  await expect(line).toBeVisible({ timeout: 60_000 });
  await line.click();
  const dialog = page.getByRole("dialog", { name: "Verbindung der Brücke" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("läuft")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: SHOT });
});
