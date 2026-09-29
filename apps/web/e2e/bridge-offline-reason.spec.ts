// Brücke offline in der 200 px schmalen Leiste: Grund und Dauer müssen lesbar sein (eigene Zeile, bricht
// um statt abgeschnitten zu werden). Der lokale Stack hat immer eine Brücke, darum wird hier nur die Antwort
// von /api/bridge/presence ersetzt — reiner Layout-Test, keine Zustandslogik.
//   pnpm dev                     (lokaler Stack; oder Playwright startet ihn selbst)
//   pnpm --filter @nyxos/web exec playwright test e2e/bridge-offline-reason.spec.ts --project chromium-1440
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const SHOT = resolve(process.cwd(), process.env.E2E_SHOT ?? "../../.probe/shots/bridge-offline.png");
const LOGIN = resolve(process.cwd(), "../../.probe/probe-login.json");

test.beforeEach(async ({ context, baseURL }) => {
  if (!existsSync(LOGIN)) return;
  const login = JSON.parse(readFileSync(LOGIN, "utf8")) as { token: string };
  await context.addCookies([{ name: "nyxos_session", value: login.token, url: baseURL ?? "http://127.0.0.1:47890" }]);
});

test("Brücke offline: Grund und Dauer vollständig sichtbar", async ({ page }) => {
  await page.route("**/api/bridge/presence", async (route) => {
    const now = Date.now();
    await route.fulfill({
      json: {
        state: "offline",
        reason: "Rechner schläft oder ist offline",
        since: new Date(now - 17 * 60_000).toISOString(),
        heartbeatAgeMs: 17 * 60_000,
        channelOpen: false,
        machine: { id: "dev", name: "dev" },
        serverNow: new Date(now).toISOString(),
      },
    });
  });
  await page.goto("/");
  await expect(page.getByText("Brücke offline", { exact: true })).toBeVisible({ timeout: 30_000 });
  const detail = page.getByText("Rechner schläft oder ist offline · seit 17 min");
  await expect(detail).toBeVisible();
  // nicht abgeschnitten: der Text passt vollständig in seine Box
  expect(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.locator("aside").screenshot({ path: SHOT });
});
