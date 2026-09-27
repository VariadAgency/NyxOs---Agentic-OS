// Verbindung kurz weg → gelb „Verbindung wird neu aufgebaut …“, nie rot, und wieder grün, sobald der Server
// antwortet. Nur /health wird für ein paar Sekunden „abgeschnitten“ (wie ein Brücken-Neustart mit
// Tunnel-Neuaufbau).
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/connection-reconnecting-status.spec.ts --project chromium-1440
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOT = resolve(process.cwd(), "../../.probe/shots/connection-reconnecting.png");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.beforeEach(async ({ context, baseURL }) => {
  if (!existsSync(LOGIN)) return;
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Tunnel kurz weg: gelb statt rot, danach wieder grün", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/overview");
  const line = page.getByTestId("server-status");
  await expect(line).toHaveAttribute("data-tone", "ok", { timeout: 20_000 });
  await page.route("**/health", (route) => route.abort("connectionrefused"));
  await expect(line).toHaveAttribute("data-tone", "wait", { timeout: 15_000 });
  await expect(line).toContainText("Verbindung wird neu aufgebaut …");
  await expect(page.getByText("Server nicht erreichbar")).toHaveCount(0);
  await page.locator("aside").screenshot({ path: SHOT });
  await page.unroute("**/health");
  await expect(line).toHaveAttribute("data-tone", "ok", { timeout: 10_000 });
});
